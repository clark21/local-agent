import { Injectable } from '@nestjs/common';
import { AgentConfigService } from '../config/agent-config.service';
import {
  ApprovalHandler,
  ProgressHandler,
} from '../codex/codex.service';
import { DatabaseService } from '../database/database.service';
import { AgentProvider, RepositoryConfig } from '../config/agent-config.service';
import { AgentService } from '../agent/agent.service';

interface ActiveTask {
  abortController: AbortController;
  startedAt: number;
  repositoryKey: string;
}

export interface TaskStatus {
  running: boolean;
  repositoryKey: string;
  extraRepositoryKeys: string[];
  provider: AgentProvider;
  elapsedSeconds?: number;
}

@Injectable()
export class TaskService {
  private readonly active = new Map<number, ActiveTask>();

  constructor(
    private readonly config: AgentConfigService,
    private readonly database: DatabaseService,
    private readonly agents: AgentService,
  ) {}

  session(chatId: number) {
    return this.database.getOrCreateSession(
      chatId,
      this.config.defaultRepository,
      this.config.defaultAgent,
    );
  }

  selectAgent(chatId: number, provider: AgentProvider): boolean {
    if (this.active.has(chatId)) return false;
    this.session(chatId);
    this.database.selectProvider(chatId, provider);
    return true;
  }

  selectRepository(chatId: number, key: string): boolean {
    if (this.active.has(chatId) || !this.config.repository(key)) return false;
    this.session(chatId);
    this.database.selectRepository(chatId, key);
    return true;
  }

  /**
   * Selects a main repository plus additional ones the agent may work in, and
   * starts a fresh thread. Keys must be distinct, configured repositories.
   */
  selectWorkspace(chatId: number, repositoryKeys: string[]): boolean {
    const [main, ...extras] = repositoryKeys;
    if (
      this.active.has(chatId) ||
      !main ||
      new Set(repositoryKeys).size !== repositoryKeys.length ||
      repositoryKeys.some((key) => !this.config.repository(key))
    ) {
      return false;
    }
    this.session(chatId);
    this.database.selectWorkspace(chatId, main, extras);
    return true;
  }

  newThread(chatId: number): boolean {
    if (this.active.has(chatId)) return false;
    this.session(chatId);
    this.database.clearThread(chatId);
    return true;
  }

  resumeThread(
    chatId: number,
    repositoryKey: string,
    provider: AgentProvider,
    threadId: string,
  ): boolean {
    if (this.active.has(chatId)) return false;
    const session = this.session(chatId);
    if (
      session.repositoryKey !== repositoryKey ||
      session.provider !== provider
    ) return false;
    this.database.saveThread(chatId, threadId);
    return true;
  }

  status(chatId: number): TaskStatus {
    const session = this.session(chatId);
    const active = this.active.get(chatId);
    // The workspace cannot change while a task runs, so the session is current.
    return active
      ? {
          running: true,
          repositoryKey: active.repositoryKey,
          extraRepositoryKeys: session.extraRepositoryKeys,
          provider: session.provider,
          elapsedSeconds: Math.floor((Date.now() - active.startedAt) / 1000),
        }
      : {
          running: false,
          repositoryKey: session.repositoryKey,
          extraRepositoryKeys: session.extraRepositoryKeys,
          provider: session.provider,
        };
  }

  listThreads(chatId: number, limit = 10) {
    const session = this.session(chatId);
    const repository = this.config.repository(session.repositoryKey);
    if (!repository) throw new Error('The selected repository is no longer configured.');
    return this.agents.listThreads(session.provider, repository, limit);
  }

  cancel(chatId: number): boolean {
    const task = this.active.get(chatId);
    if (!task) return false;
    task.abortController.abort();
    return true;
  }

  async execute(
    chatId: number,
    prompt: string,
    onProgress: ProgressHandler,
    onApproval: ApprovalHandler,
  ): Promise<string> {
    if (this.active.has(chatId)) {
      throw new Error('A task is already running. Use /status or /cancel.');
    }
    if (prompt.length > this.config.maxMessageLength) {
      throw new Error(
        `Message is too long (${prompt.length}/${this.config.maxMessageLength}).`,
      );
    }

    const session = this.session(chatId);
    const repository = this.config.repository(session.repositoryKey);
    if (!repository) throw new Error('The selected repository is no longer configured.');
    const additionalRepositories = session.extraRepositoryKeys.map((key) => {
      const extra = this.config.repository(key);
      if (!extra) throw new Error(`Repository ${key} is no longer configured.`);
      return extra;
    });
    const agentPrompt = additionalRepositories.length
      ? `${this.workspaceNote(repository, additionalRepositories)}\n\n${prompt}`
      : prompt;

    const abortController = new AbortController();
    this.active.set(chatId, {
      abortController,
      startedAt: Date.now(),
      repositoryKey: repository.key,
    });
    const timeout = setTimeout(
      () => abortController.abort(),
      this.config.taskTimeoutMs,
    );
    const auditId = this.database.startAudit(
      chatId,
      repository.key,
      session.provider,
      prompt,
    );

    try {
      const run = (threadId: string | null) =>
        this.agents.run(
          session.provider,
          repository,
          agentPrompt,
          threadId,
          abortController.signal,
          onProgress,
          onApproval,
          additionalRepositories,
        );

      let result;
      try {
        result = await run(session.threadId);
      } catch (error) {
        if (
          !session.threadId ||
          abortController.signal.aborted ||
          !this.isMissingThreadError(error)
        ) {
          throw error;
        }

        await onProgress('Saved thread was not found. Retrying once…');
        try {
          result = await run(session.threadId);
        } catch (retryError) {
          if (
            abortController.signal.aborted ||
            !this.isMissingThreadError(retryError)
          ) {
            throw retryError;
          }

          await onProgress('Saved thread is unavailable. Starting a new thread…');
          result = await run(null);
        }
      }
      this.database.saveThread(chatId, result.threadId);
      this.database.finishAudit(auditId, 'completed', result.response);
      return result.response;
    } catch (error) {
      const aborted = abortController.signal.aborted;
      const message = aborted
        ? 'Task cancelled or timed out.'
        : error instanceof Error
          ? error.message
          : 'Unknown agent error';
      this.database.finishAudit(auditId, aborted ? 'cancelled' : 'failed', message);
      throw new Error(message, { cause: error });
    } finally {
      clearTimeout(timeout);
      this.active.delete(chatId);
    }
  }

  private workspaceNote(
    main: RepositoryConfig,
    additional: RepositoryConfig[],
  ): string {
    const extras = additional.map((repo) => `- ${repo.key}: ${repo.path}`).join('\n');
    return `This task spans multiple repositories. You may read and modify files in all of them.\nMain repository (current working directory): ${main.key}: ${main.path}\nAdditional repositories:\n${extras}`;
  }

  private isMissingThreadError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (/no rollout found for thread id\b/i.test(error.message) ||
        /no conversation found with session id\b/i.test(error.message))
    );
  }
}
