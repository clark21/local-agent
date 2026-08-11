import { Injectable, Logger } from '@nestjs/common';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  AgentConfigService,
  CodexApprovalPolicy,
  CodexSandboxMode,
  RepositoryConfig,
} from '../config/agent-config.service';

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export interface ApprovalRequest {
  type: 'command' | 'file-change';
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string;
  cwd?: string;
  reason?: string;
  grantRoot?: string;
}

export interface CodexRunResult {
  response: string;
  threadId: string;
}

export interface CodexThreadSummary {
  id: string;
  preview: string;
  name?: string;
  updatedAt: number;
}

export type ProgressHandler = (message: string) => Promise<void>;
export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ThreadResponse {
  thread: { id: string };
}

interface TurnResponse {
  turn: { id: string };
}

type AppServerApprovalPolicy = 'unlessTrusted' | 'onRequest' | 'never';
type AppServerSandboxMode = 'readOnly' | 'workspaceWrite' | 'dangerFullAccess';

@Injectable()
export class CodexService {
  private readonly logger = new Logger(CodexService.name);

  constructor(private readonly config: AgentConfigService) {}

  async run(
    repository: RepositoryConfig,
    prompt: string,
    existingThreadId: string | null,
    signal: AbortSignal,
    onProgress: ProgressHandler,
    onApproval: ApprovalHandler,
  ): Promise<CodexRunResult> {
    const client = new AppServerClient(
      this.config.codexPath,
      repository,
      this.config.codexModel,
      this.config.codexNetworkAccess,
      this.config.codexSandboxMode,
      this.config.codexApprovalPolicy,
      onProgress,
      onApproval,
      this.logger,
    );

    try {
      await client.initialize();
      const threadId = await client.openThread(existingThreadId);
      const response = await client.runTurn(threadId, prompt, signal);
      return { response, threadId };
    } finally {
      client.close();
    }
  }

  async listThreads(
    repository: RepositoryConfig,
    limit = 10,
  ): Promise<CodexThreadSummary[]> {
    const client = new AppServerClient(
      this.config.codexPath,
      repository,
      this.config.codexModel,
      this.config.codexNetworkAccess,
      this.config.codexSandboxMode,
      this.config.codexApprovalPolicy,
      () => Promise.resolve(),
      () => Promise.resolve('decline'),
      this.logger,
    );
    try {
      await client.initialize();
      return await client.listThreads(limit);
    } finally {
      client.close();
    }
  }
}

class AppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly stderr: string[] = [];
  private nextId = 1;
  private finalResponse = '';
  private activeThreadId?: string;
  private activeTurnId?: string;
  private turnCompletion?: PendingRpc;
  private closed = false;

  constructor(
    codexPath: string,
    private readonly repository: RepositoryConfig,
    private readonly model: string | undefined,
    private readonly networkAccess: boolean,
    private readonly sandboxMode: CodexSandboxMode,
    private readonly approvalPolicy: CodexApprovalPolicy,
    private readonly onProgress: ProgressHandler,
    private readonly onApproval: ApprovalHandler,
    private readonly logger: Logger,
  ) {
    this.child = spawn(codexPath, ['app-server', '--listen', 'stdio://'], {
      cwd: repository.path,
      env: this.safeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      void this.handleLine(line);
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderr.push(text);
      this.logger.debug(text.trim());
    });
    this.child.once('error', (error) => this.rejectAll(error));
    this.child.once('exit', (code, processSignal) => {
      if (this.closed) return;
      const detail = this.stderr.join('').trim();
      this.rejectAll(
        new Error(
          `Codex app-server exited (${code ?? processSignal ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'telegram_codex_agent',
        title: 'Telegram Codex Agent',
        version: '0.2.0',
      },
    });
    this.notify('initialized', {});
  }

  async openThread(existingThreadId: string | null): Promise<string> {
    const common = {
      cwd: this.repository.path,
      approvalPolicy: this.appServerApprovalPolicy(),
      sandbox: this.appServerSandboxMode(),
      developerInstructions:
        'Security policy: do not read, print, summarize, copy, or expose .env files, credentials, private keys, tokens, or secret stores. Ask the user to perform secret-dependent operations manually.',
      ...(this.model ? { model: this.model } : {}),
    };
    const response = existingThreadId
      ? await this.request<ThreadResponse>('thread/resume', {
          threadId: existingThreadId,
          ...common,
        })
      : await this.request<ThreadResponse>('thread/start', {
          ...common,
          serviceName: 'telegram_codex_agent',
        });
    this.activeThreadId = response.thread.id;
    return response.thread.id;
  }

  async listThreads(limit: number): Promise<CodexThreadSummary[]> {
    const response = await this.request<{
      data?: Array<Record<string, unknown>>;
    }>('thread/list', {
      limit,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      cwd: this.repository.path,
      archived: false,
    });
    if (!Array.isArray(response.data)) return [];
    return response.data.flatMap((thread) => {
      if (typeof thread.id !== 'string') return [];
      return [
        {
          id: thread.id,
          preview: this.stringValue(thread.preview, 'Untitled thread'),
          name:
            typeof thread.name === 'string' && thread.name
              ? thread.name
              : undefined,
          updatedAt:
            typeof thread.updatedAt === 'number'
              ? thread.updatedAt
              : typeof thread.createdAt === 'number'
                ? thread.createdAt
                : 0,
        },
      ];
    });
  }

  async runTurn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    this.finalResponse = '';
    const completion = new Promise<unknown>((resolve, reject) => {
      this.turnCompletion = { resolve, reject };
    });
    const abort = (): void => {
      if (this.activeTurnId) {
        void this.request('turn/interrupt', {
          threadId,
          turnId: this.activeTurnId,
        }).catch(() => this.child.kill('SIGTERM'));
      } else {
        this.child.kill('SIGTERM');
      }
    };
    signal.addEventListener('abort', abort, { once: true });

    try {
      const started = await this.request<TurnResponse>('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd: this.repository.path,
        approvalPolicy: this.appServerApprovalPolicy(),
        sandboxPolicy: this.sandboxPolicy(),
        ...(this.model ? { model: this.model } : {}),
      });
      this.activeTurnId = started.turn.id;
      await completion;
      if (signal.aborted) throw new Error('Task cancelled or timed out.');
      return this.finalResponse || 'Task completed without a text response.';
    } finally {
      signal.removeEventListener('abort', abort);
      this.turnCompletion = undefined;
      this.activeTurnId = undefined;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill('SIGTERM');
  }

  private request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
    this.write({ id, method, params });
    return promise;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  private write(message: RpcMessage): void {
    if (this.closed || !this.child.stdin.writable) {
      throw new Error('Codex app-server is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.logger.warn(`Ignored invalid app-server JSON: ${line.slice(0, 200)}`);
      return;
    }

    if (message.method && message.id !== undefined) {
      await this.handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'Codex RPC request failed'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) await this.handleNotification(message);
  }

  private async handleServerRequest(message: RpcMessage): Promise<void> {
    const params = message.params ?? {};
    if (
      message.method !== 'item/commandExecution/requestApproval' &&
      message.method !== 'item/fileChange/requestApproval'
    ) {
      this.write({
        id: message.id,
        error: { code: -32601, message: `Unsupported request: ${message.method}` },
      });
      return;
    }

    const type =
      message.method === 'item/commandExecution/requestApproval'
        ? 'command'
        : 'file-change';
    try {
      const decision = await this.onApproval({
        type,
        threadId: this.stringValue(params.threadId),
        turnId: this.stringValue(params.turnId),
        itemId: this.stringValue(params.itemId),
        command: this.optionalString(params.command),
        cwd: this.optionalPath(params.cwd),
        reason: this.optionalString(params.reason),
        grantRoot: this.optionalString(params.grantRoot),
      });
      this.write({ id: message.id, result: { decision } });
    } catch {
      this.write({ id: message.id, result: { decision: 'decline' } });
    }
  }

  private async handleNotification(message: RpcMessage): Promise<void> {
    const params = message.params ?? {};
    if (message.method === 'item/completed') {
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        this.finalResponse = item.text;
      } else if (item?.type === 'commandExecution') {
        await this.onProgress(
          `Command ${this.stringValue(item.status, 'finished')}: ${this.compact(this.stringValue(item.command), 180)}`,
        );
      } else if (item?.type === 'fileChange') {
        const changes = Array.isArray(item.changes)
          ? item.changes
              .map((entry) => {
                const change = entry as Record<string, unknown>;
                return this.stringValue(change.path, 'file');
              })
              .join(', ')
          : 'files';
        await this.onProgress(`Files updated: ${this.compact(changes, 220)}`);
      }
    } else if (message.method === 'turn/completed') {
      const turn = params.turn as Record<string, unknown> | undefined;
      const status = this.stringValue(turn?.status, 'failed');
      if (status === 'failed') {
        const error = turn?.error as Record<string, unknown> | undefined;
        this.turnCompletion?.reject(
          new Error(this.stringValue(error?.message, 'Codex turn failed')),
        );
      } else {
        this.turnCompletion?.resolve(undefined);
      }
    } else if (message.method === 'error') {
      const error = params.error as Record<string, unknown> | undefined;
      this.turnCompletion?.reject(
        new Error(this.stringValue(error?.message, 'Codex app-server error')),
      );
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.turnCompletion?.reject(error);
  }

  private appServerApprovalPolicy(): AppServerApprovalPolicy {
    if (this.approvalPolicy === 'untrusted') return 'unlessTrusted';
    if (this.approvalPolicy === 'on-request') return 'onRequest';
    return 'never';
  }

  private appServerSandboxMode(): AppServerSandboxMode {
    if (this.sandboxMode === 'read-only') return 'readOnly';
    if (this.sandboxMode === 'workspace-write') return 'workspaceWrite';
    return 'dangerFullAccess';
  }

  private sandboxPolicy(): Record<string, unknown> {
    const type = this.appServerSandboxMode();
    if (type === 'workspaceWrite') {
      return {
        type,
        writableRoots: [this.repository.path],
        networkAccess: this.networkAccess,
      };
    }
    return { type };
  }

  private safeEnvironment(): NodeJS.ProcessEnv {
    const safeNames = [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'SHELL',
      'TMPDIR',
      'TEMP',
      'TMP',
      'LANG',
      'TERM',
      'COLORTERM',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'CODEX_HOME',
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const name of safeNames) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    for (const [name, value] of Object.entries(process.env)) {
      if (name.startsWith('LC_') && value !== undefined) env[name] = value;
    }
    return env;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
  }

  private stringValue(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
  }

  private optionalPath(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'path' in value) {
      const path = (value as { path?: unknown }).path;
      return typeof path === 'string' ? path : undefined;
    }
    return undefined;
  }

  private compact(value: string, max: number): string {
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
  }
}
