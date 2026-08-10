import { Injectable } from '@nestjs/common';
import { AgentConfigService } from '../config/agent-config.service';
import {
  ApprovalHandler,
  CodexService,
  ProgressHandler,
} from '../codex/codex.service';
import { DatabaseService } from '../database/database.service';

interface ActiveTask {
  abortController: AbortController;
  startedAt: number;
  repositoryKey: string;
}

export interface TaskStatus {
  running: boolean;
  repositoryKey: string;
  elapsedSeconds?: number;
}

@Injectable()
export class TaskService {
  private readonly active = new Map<number, ActiveTask>();

  constructor(
    private readonly config: AgentConfigService,
    private readonly database: DatabaseService,
    private readonly codex: CodexService,
  ) {}

  session(chatId: number) {
    return this.database.getOrCreateSession(
      chatId,
      this.config.defaultRepository,
    );
  }

  selectRepository(chatId: number, key: string): boolean {
    if (this.active.has(chatId) || !this.config.repository(key)) return false;
    this.session(chatId);
    this.database.selectRepository(chatId, key);
    return true;
  }

  newThread(chatId: number): boolean {
    if (this.active.has(chatId)) return false;
    this.session(chatId);
    this.database.clearThread(chatId);
    return true;
  }

  resumeThread(chatId: number, repositoryKey: string, threadId: string): boolean {
    if (this.active.has(chatId)) return false;
    const session = this.session(chatId);
    if (session.repositoryKey !== repositoryKey) return false;
    this.database.saveThread(chatId, threadId);
    return true;
  }

  status(chatId: number): TaskStatus {
    const session = this.session(chatId);
    const active = this.active.get(chatId);
    return active
      ? {
          running: true,
          repositoryKey: active.repositoryKey,
          elapsedSeconds: Math.floor((Date.now() - active.startedAt) / 1000),
        }
      : { running: false, repositoryKey: session.repositoryKey };
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
    const auditId = this.database.startAudit(chatId, repository.key, prompt);

    try {
      const result = await this.codex.run(
        repository,
        prompt,
        session.threadId,
        abortController.signal,
        onProgress,
        onApproval,
      );
      this.database.saveThread(chatId, result.threadId);
      this.database.finishAudit(auditId, 'completed', result.response);
      return result.response;
    } catch (error) {
      const aborted = abortController.signal.aborted;
      const message = aborted
        ? 'Task cancelled or timed out.'
        : error instanceof Error
          ? error.message
          : 'Unknown Codex error';
      this.database.finishAudit(auditId, aborted ? 'cancelled' : 'failed', message);
      throw new Error(message, { cause: error });
    } finally {
      clearTimeout(timeout);
      this.active.delete(chatId);
    }
  }
}
