import { Injectable, Logger } from '@nestjs/common';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AgentConfigService, RepositoryConfig } from '../config/agent-config.service';
import {
  ApprovalDecision,
  ApprovalHandler,
  CodexRunResult,
  CodexThreadSummary,
  ProgressHandler,
  secretFileInstructions,
} from '../codex/codex.service';

const FILE_CHANGE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

interface ClaudeMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  errors?: unknown[];
  request_id?: string;
  request?: Record<string, unknown>;
  message?: { content?: Array<Record<string, unknown>> };
}

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);

  constructor(private readonly config: AgentConfigService) {}

  run(
    repository: RepositoryConfig,
    prompt: string,
    existingThreadId: string | null,
    signal: AbortSignal,
    onProgress: ProgressHandler,
    onApproval: ApprovalHandler,
  ): Promise<CodexRunResult> {
    const client = new ClaudeCliClient(
      this.config.claudePath,
      this.config.claudeModel,
      this.config.codexAllowSecretFileAccess,
      repository,
      onProgress,
      onApproval,
      this.logger,
    );
    return client.run(prompt, existingThreadId, signal);
  }

  // Claude Code can resume a known session ID, but its CLI does not expose a
  // machine-readable session-list command. The current session remains usable.
  listThreads(
    repository: RepositoryConfig,
    limit = 10,
  ): Promise<CodexThreadSummary[]> {
    void repository;
    void limit;
    return Promise.resolve([]);
  }
}

class ClaudeCliClient {
  private child?: ChildProcessWithoutNullStreams;
  private readonly stderr: string[] = [];
  private sessionId?: string;
  private finalResponse = '';
  private resultError?: string;
  private settled = false;

  constructor(
    private readonly claudePath: string,
    private readonly model: string | undefined,
    private readonly allowSecretFileAccess: boolean,
    private readonly repository: RepositoryConfig,
    private readonly onProgress: ProgressHandler,
    private readonly onApproval: ApprovalHandler,
    private readonly logger: Logger,
  ) {}

  run(
    prompt: string,
    existingThreadId: string | null,
    signal: AbortSignal,
  ): Promise<CodexRunResult> {
    const args = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'manual',
      '--permission-prompts',
      'host',
      // Without this the CLI never sends can_use_tool requests over stdio and
      // denies every prompting tool on its own.
      '--permission-prompt-tool',
      'stdio',
      '--append-system-prompt',
      secretFileInstructions(this.allowSecretFileAccess),
    ];
    if (this.model) args.push('--model', this.model);
    if (existingThreadId) args.push('--resume', existingThreadId);

    this.child = spawn(this.claudePath, args, {
      cwd: this.repository.path,
      env: this.safeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return new Promise<CodexRunResult>((resolve, reject) => {
      const abort = (): void => {
        this.child?.kill('SIGTERM');
      };
      signal.addEventListener('abort', abort, { once: true });
      // EPIPE after the CLI dies must not crash the service; exit reports it.
      this.child!.stdin.on('error', (error) => {
        this.logger.warn(`Claude CLI stdin error: ${error.message}`);
      });
      createInterface({ input: this.child!.stdout }).on('line', (line) => {
        void this.handleLine(line).catch(reject);
      });
      this.child!.stderr.on('data', (chunk: Buffer) => {
        const value = chunk.toString();
        this.stderr.push(value);
        this.logger.debug(value.trim());
      });
      this.child!.once('error', (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });
      this.child!.once('exit', (code, processSignal) => {
        signal.removeEventListener('abort', abort);
        if (this.settled) return;
        this.settled = true;
        if (signal.aborted) {
          reject(new Error('Task cancelled or timed out.'));
          return;
        }
        if (this.resultError) {
          reject(new Error(`Claude CLI failed: ${this.resultError}`));
          return;
        }
        if (code !== 0) {
          const detail = this.stderr.join('').trim();
          reject(
            new Error(
              `Claude CLI exited (${code ?? processSignal ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
            ),
          );
          return;
        }
        if (!this.sessionId) {
          reject(new Error('Claude CLI completed without a session ID'));
          return;
        }
        resolve({
          response: this.finalResponse || 'Task completed without a text response.',
          threadId: this.sessionId,
        });
      });
      try {
        this.write({
          type: 'user',
          message: { role: 'user', content: prompt },
        });
      } catch (error) {
        this.child!.kill('SIGTERM');
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async handleLine(line: string): Promise<void> {
    let event: ClaudeMessage;
    try {
      event = JSON.parse(line) as ClaudeMessage;
    } catch {
      this.logger.warn(`Ignored invalid Claude JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (event.session_id) this.sessionId = event.session_id;
    if (event.type === 'control_request') {
      await this.handlePermission(event);
      return;
    }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      const text = event.message.content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('');
      if (text) this.finalResponse = text;
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          await this.onProgress(`Using ${block.name}…`);
        }
      }
    }
    if (event.type === 'result') {
      if (event.is_error === true || (event.subtype && event.subtype !== 'success')) {
        this.resultError = this.resultErrorMessage(event);
      } else if (typeof event.result === 'string') {
        this.finalResponse = event.result;
      }
      // In stream-json input mode the CLI waits for more input until stdin closes.
      this.child?.stdin.end();
    }
  }

  private async handlePermission(event: ClaudeMessage): Promise<void> {
    const request = event.request ?? {};
    if (request.subtype !== 'can_use_tool' || !event.request_id) return;
    const toolName = this.string(request.tool_name, 'Claude tool');
    const input = this.record(request.input);
    const type =
      toolName === 'Bash'
        ? 'command'
        : FILE_CHANGE_TOOLS.has(toolName)
          ? 'file-change'
          : 'tool';
    let decision: ApprovalDecision = 'decline';
    try {
      decision = await this.onApproval({
        type,
        threadId: this.sessionId ?? '',
        turnId: this.sessionId ?? '',
        itemId: event.request_id,
        command: type === 'command' ? this.optionalString(input.command) : undefined,
        cwd: this.optionalString(input.cwd),
        // Other tools (WebFetch, MCP, …) have no command or path, so show what
        // they were called with.
        reason:
          type === 'tool'
            ? `Claude requests permission to use ${toolName}: ${this.compact(JSON.stringify(input), 400)}`
            : `Claude requests permission to use ${toolName}.`,
        grantRoot:
          type === 'file-change'
            ? this.optionalString(input.file_path) ??
              this.optionalString(input.notebook_path) ??
              this.optionalString(input.path)
            : undefined,
      });
    } catch {
      decision = 'decline';
    }
    const allowed = decision === 'accept' || decision === 'acceptForSession';
    const response: Record<string, unknown> = allowed
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'Permission denied by the Telegram user.' };
    if (decision === 'acceptForSession' && Array.isArray(request.permission_suggestions)) {
      response.updatedPermissions = request.permission_suggestions;
    }
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: event.request_id,
        response,
      },
    });
  }

  private write(value: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error('Claude CLI is not writable');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private resultErrorMessage(event: ClaudeMessage): string {
    const errors = (event.errors ?? []).filter(
      (error): error is string => typeof error === 'string' && error.length > 0,
    );
    if (errors.length) return errors.join('; ');
    if (typeof event.result === 'string' && event.result) return event.result;
    return event.subtype ?? 'unknown error';
  }

  private safeEnvironment(): NodeJS.ProcessEnv {
    const allowed = [
      'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
      'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
      'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
      'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION',
    ];
    return Object.fromEntries(
      allowed.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    );
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private string(value: unknown, fallback: string): string {
    return typeof value === 'string' && value ? value : fallback;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
  }

  private compact(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
  }
}
