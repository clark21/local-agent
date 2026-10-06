import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Context, Telegraf } from 'telegraf';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import {
  ApprovalDecision,
  ApprovalRequest,
} from '../codex/codex.service';
import { AgentProvider } from '../config/agent-config.service';
import { AgentConfigService } from '../config/agent-config.service';
import { DatabaseService } from '../database/database.service';
import { TaskService } from '../tasks/task.service';

const HELP = `Local coding agent commands:
/agent - show or select Codex/Claude
/agent <codex|claude> - select an agent and start a fresh thread
/repo - list repositories
/repo <name> - select a repository and start a fresh thread
/threads - list and resume recent threads for the current repository
/new - start a fresh thread in the current repository
/status - show current repository and task status
/cancel - cancel the active task
/help - show this help

Send a normal text message to run a task.`;

const ALLOWED_DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.mdx', '.json', '.yaml', '.yml', '.csv', '.tsv', '.log',
  '.xml', '.html', '.htm', '.pdf', '.docx', '.xlsx', '.pptx',
]);

interface PendingApproval {
  chatId: number;
  userId: number;
  messageId: number;
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

interface PendingThreadSelection {
  chatId: number;
  userId: number;
  repositoryKey: string;
  provider: AgentProvider;
  threadId: string;
  timer: NodeJS.Timeout;
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly bot: Telegraf;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingThreadSelections = new Map<
    string,
    PendingThreadSelection
  >();

  constructor(
    private readonly config: AgentConfigService,
    private readonly tasks: TaskService,
    private readonly database: DatabaseService,
  ) {
    this.bot = new Telegraf(config.telegramToken);
    this.registerHandlers();
  }

  async onModuleInit(): Promise<void> {
    await this.bot.telegram.setMyCommands([
      { command: 'repo', description: 'List or select a repository' },
      { command: 'agent', description: 'Show or select Codex/Claude' },
      { command: 'threads', description: 'List and resume recent threads' },
      { command: 'new', description: 'Start a fresh agent thread' },
      { command: 'status', description: 'Show task status' },
      { command: 'cancel', description: 'Cancel the active task' },
      { command: 'help', description: 'Show help' },
    ]);
    await this.bot.launch();
    this.logger.log('Telegram long polling started');
  }

  onModuleDestroy(): void {
    for (const [token] of this.pendingApprovals) {
      this.resolveApproval(token, 'decline', 'Application shutting down.');
    }
    for (const selection of this.pendingThreadSelections.values()) {
      clearTimeout(selection.timer);
    }
    this.pendingThreadSelections.clear();
    this.bot.stop('application shutdown');
  }

  private registerHandlers(): void {
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.config.allowedUserIds.has(userId)) {
        this.logger.warn(`Rejected Telegram user ${userId ?? 'unknown'}`);
        return;
      }
      await next();
    });

    this.bot.start((ctx) => ctx.reply(HELP));
    this.bot.help((ctx) => ctx.reply(HELP));

    this.bot.command('agent', async (ctx) => {
      const requested = ctx.message.text
        .replace(/^\/agent(?:@\w+)?\s*/i, '')
        .trim()
        .toLowerCase();
      const current = this.tasks.session(ctx.chat.id).provider;
      if (!requested) {
        await ctx.reply(`Current agent: ${this.agentName(current)}.\n\nChoose an agent:`, {
          reply_markup: {
            inline_keyboard: [[
              { text: current === 'codex' ? '✓ Codex' : 'Codex', callback_data: `agent:codex:${ctx.from.id}` },
              { text: current === 'claude' ? '✓ Claude' : 'Claude', callback_data: `agent:claude:${ctx.from.id}` },
            ]],
          },
        });
        return;
      }
      if (requested !== 'codex' && requested !== 'claude') {
        await ctx.reply('Unknown agent. Use /agent codex or /agent claude.');
        return;
      }
      await this.selectAgent(ctx, requested);
    });

    this.bot.action(/^agent:(codex|claude):(\d+)$/, async (ctx) => {
      const provider = ctx.match[1] as AgentProvider;
      if (ctx.from.id !== Number(ctx.match[2])) {
        await ctx.answerCbQuery('Only the user who opened this menu can select an agent.', {
          show_alert: true,
        }).catch(() => undefined);
        return;
      }
      if (!ctx.chat) return;
      if (!this.tasks.selectAgent(ctx.chat.id, provider)) {
        await ctx.answerCbQuery('Cannot switch agents while a task is running.', {
          show_alert: true,
        }).catch(() => undefined);
        return;
      }
      await ctx.answerCbQuery(`${this.agentName(provider)} selected.`).catch(() => undefined);
      await ctx.editMessageText(
        `${this.agentName(provider)} selected. A fresh thread will be used for the next message.`,
      ).catch(() => undefined);
    });

    this.bot.command('repo', async (ctx) => {
      const requested = ctx.message.text.replace(/^\/repo(?:@\w+)?\s*/i, '').trim();
      if (!requested) {
        const current = this.tasks.session(ctx.chat.id).repositoryKey;
        const list = [...this.config.repositories.keys()]
          .map((key) => `${key === current ? '•' : '◦'} ${key}`)
          .join('\n');
        await ctx.reply(`Repositories:\n${list}\n\nUse /repo <name> to select one.`);
        return;
      }
      if (!this.config.repository(requested)) {
        await ctx.reply(`Unknown repository: ${requested}`);
        return;
      }
      if (!this.tasks.selectRepository(ctx.chat.id, requested)) {
        await ctx.reply('Cannot switch repositories while a task is running.');
        return;
      }
      const provider = this.tasks.session(ctx.chat.id).provider;
      await ctx.reply(`Selected ${requested}. A fresh ${this.agentName(provider)} thread will be used.`);
    });

    this.bot.command('new', async (ctx) => {
      await ctx.reply(
        this.tasks.newThread(ctx.chat.id)
          ? `A fresh ${this.agentName(this.tasks.session(ctx.chat.id).provider)} thread will be used for the next message.`
          : 'Cannot reset the thread while a task is running.',
      );
    });

    this.bot.command('threads', async (ctx) => {
      const status = this.tasks.status(ctx.chat.id);
      if (status.running) {
        await ctx.reply('Wait for the active task to finish or use /cancel first.');
        return;
      }
      const repository = this.config.repository(status.repositoryKey);
      if (!repository) {
        await ctx.reply('The selected repository is no longer configured.');
        return;
      }
      await ctx.reply(`Loading recent threads for ${repository.key}…`);
      try {
        const provider = this.tasks.session(ctx.chat.id).provider;
        const threads = await this.tasks.listThreads(ctx.chat.id, 10);
        if (threads.length === 0) {
          const detail = provider === 'claude'
            ? 'Claude CLI does not currently expose a machine-readable session list; the active saved session still resumes automatically.'
            : `No saved Codex threads found for ${repository.key}.`;
          await ctx.reply(detail);
          return;
        }
        this.clearThreadSelectionsForChat(ctx.chat.id);
        const rows = threads.map((thread) => {
          const token = randomBytes(6).toString('hex');
          const timer = setTimeout(
            () => this.expireThreadSelection(token),
            this.config.approvalTimeoutMs,
          );
          this.pendingThreadSelections.set(token, {
            chatId: ctx.chat.id,
            userId: ctx.from.id,
            repositoryKey: repository.key,
            provider,
            threadId: thread.id,
            timer,
          });
          const date = thread.updatedAt
            ? new Date(thread.updatedAt * 1_000).toLocaleString('en-PH', {
                timeZone: 'Asia/Manila',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })
            : 'Unknown date';
          const title = thread.name || thread.preview || 'Untitled thread';
          return [
            {
              text: this.limit(`${date} · ${title.replace(/\s+/g, ' ')}`, 60),
              callback_data: `thread:${token}`,
            },
          ];
        });
        await ctx.reply(
          `Recent threads for ${repository.key}:\nSelect one to resume. Buttons expire in ${Math.ceil(this.config.approvalTimeoutMs / 60_000)} minutes.`,
          { reply_markup: { inline_keyboard: rows } },
        );
      } catch (error) {
        await ctx.reply(
          `Could not list threads: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    });

    this.bot.command('status', async (ctx) => {
      const status = this.tasks.status(ctx.chat.id);
      await ctx.reply(
        status.running
          ? `${this.agentName(status.provider)} running in ${status.repositoryKey} for ${status.elapsedSeconds}s.`
          : `Idle. Agent: ${this.agentName(status.provider)}. Repository: ${status.repositoryKey}.`,
      );
    });

    this.bot.command('cancel', async (ctx) => {
      await ctx.reply(
        this.tasks.cancel(ctx.chat.id)
          ? 'Cancellation requested.'
          : 'No task is currently running.',
      );
    });

    this.bot.action(/^task:cancel:(\d+)$/, async (ctx) => {
      const taskOwnerId = Number(ctx.match[1]);
      if (ctx.from.id !== taskOwnerId) {
        await ctx.answerCbQuery('Only the user who started this task can cancel it.', {
          show_alert: true,
        }).catch(() => undefined);
        return;
      }

      const cancelled = ctx.chat ? this.tasks.cancel(ctx.chat.id) : false;
      await ctx
        .answerCbQuery(cancelled ? 'Cancellation requested.' : 'This task has already ended.')
        .catch(() => undefined);
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => undefined);
    });

    this.bot.action(/^approval:([a-f0-9]+):(once|session|reject|cancel)$/, async (ctx) => {
      const [, token, action] = ctx.match;
      const pending = this.pendingApprovals.get(token);
      if (!pending) {
        await ctx
          .answerCbQuery('This approval has expired.')
          .catch(() => undefined);
        return;
      }
      if (ctx.chat?.id !== pending.chatId || ctx.from.id !== pending.userId) {
        await ctx
          .answerCbQuery('Only the user who started this task can decide.', {
            show_alert: true,
          })
          .catch(() => undefined);
        return;
      }
      const decisions: Record<string, ApprovalDecision> = {
        once: 'accept',
        session: 'acceptForSession',
        reject: 'decline',
        cancel: 'cancel',
      };
      const decision = decisions[action];
      // Resume Codex before acknowledging Telegram. Telegram may reject an old
      // callback-query acknowledgement; that must not strand the Codex turn.
      this.resolveApproval(token, decision, this.decisionLabel(decision));
      await ctx
        .answerCbQuery(this.decisionLabel(decision))
        .catch((error: unknown) => {
          this.logger.debug(
            `Approval ${token} was delivered, but Telegram callback acknowledgement failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        });
    });

    this.bot.action(/^thread:([a-f0-9]+)$/, async (ctx) => {
      const token = ctx.match[1];
      const selection = this.pendingThreadSelections.get(token);
      if (!selection) {
        await ctx.answerCbQuery('This thread selection has expired.').catch(() => undefined);
        return;
      }
      if (ctx.chat?.id !== selection.chatId || ctx.from.id !== selection.userId) {
        await ctx
          .answerCbQuery('Only the user who opened this list can select a thread.', {
            show_alert: true,
          })
          .catch(() => undefined);
        return;
      }
      this.expireThreadSelection(token);
      const resumed = this.tasks.resumeThread(
        selection.chatId,
        selection.repositoryKey,
        selection.provider,
        selection.threadId,
      );
      if (!resumed) {
        await ctx.answerCbQuery('Repository changed or a task is running.', {
          show_alert: true,
        }).catch(() => undefined);
        return;
      }
      await ctx.answerCbQuery('Thread resumed.').catch(() => undefined);
      await ctx
        .editMessageText(
          `Resumed thread ${selection.threadId.slice(0, 8)}… in ${selection.repositoryKey}.\nSend a normal message to continue.`,
        )
        .catch(() => undefined);
      this.clearThreadSelectionsForChat(selection.chatId);
    });

    this.bot.on('text', (ctx) => {
      if (ctx.message.text.startsWith('/')) return;
      // Do not await a long-running Codex turn inside Telegraf's update
      // middleware. The polling loop must remain free to process approval-button
      // callback queries while this task is paused waiting for a decision.
      void this.handleTask(ctx, ctx.message.text).catch((error: unknown) => {
        this.logger.error(
          `Detached Telegram task failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
    });

    this.bot.on('document', (ctx) => {
      // As with text updates, keep polling available for approval callbacks.
      void this.handleDocument(ctx).catch((error: unknown) => {
        this.logger.error(
          `Detached Telegram document task failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
    });

    this.bot.catch((error, ctx) => {
      this.logger.error(`Telegram update ${ctx.update.update_id} failed`, error);
    });
  }

  private async handleDocument(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!ctx.chat || !ctx.from || !message || !('document' in message)) return;
    const document = message.document;
    const filename = this.safeDocumentName(document.file_name);
    const extension = extname(filename).toLowerCase();
    if (!ALLOWED_DOCUMENT_EXTENSIONS.has(extension)) {
      await ctx.reply(
        `Unsupported document type. Allowed: ${[...ALLOWED_DOCUMENT_EXTENSIONS].join(', ')}`,
      );
      return;
    }
    if (!document.file_size || document.file_size > this.config.maxDocumentBytes) {
      await ctx.reply(
        `Document is too large. The limit is ${this.formatBytes(this.config.maxDocumentBytes)}.`,
      );
      return;
    }

    const repository = this.config.repository(this.tasks.session(ctx.chat.id).repositoryKey);
    if (!repository) {
      await ctx.reply('The selected repository is no longer configured.');
      return;
    }

    const uploadDirectory = resolve(repository.path, '.codex-agent', 'uploads');
    const uploadPath = join(uploadDirectory, `${randomBytes(12).toString('hex')}-${filename}`);
    try {
      await mkdir(uploadDirectory, { recursive: true });
      const fileUrl = await ctx.telegram.getFileLink(document.file_id);
      const response = await fetch(fileUrl.href);
      if (!response.ok || !response.body) {
        throw new Error(`Telegram download failed (${response.status})`);
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > this.config.maxDocumentBytes) {
        throw new Error('Telegram download exceeded the configured document limit');
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > this.config.maxDocumentBytes) {
        throw new Error('Telegram download exceeded the configured document limit');
      }
      await writeFile(uploadPath, bytes, { flag: 'wx' });
    } catch (error) {
      await rm(uploadPath, { force: true }).catch(() => undefined);
      throw error;
    }

    const prompt = this.documentPrompt(
      relative(repository.path, uploadPath),
      filename,
      message.caption,
    );
    try {
      await this.handleTask(ctx, prompt);
    } finally {
      await rm(uploadPath, { force: true }).catch((error: unknown) => {
        this.logger.warn(
          `Could not remove temporary upload ${filename}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
    }
  }

  private safeDocumentName(name: string | undefined): string {
    const value = basename(name ?? 'document');
    return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'document';
  }

  private documentPrompt(path: string, filename: string, caption: string | undefined): string {
    const request = caption?.trim() || 'Inspect the uploaded document and help with it.';
    return `The user uploaded "${filename}" for this task. It is temporarily available inside the current repository at "${path}". Read it only as needed; do not copy it into tracked project files unless the user asks.\n\nUser request: ${request}`;
  }

  private formatBytes(bytes: number): string {
    return `${Math.ceil(bytes / (1024 * 1024))} MB`;
  }

  private async handleTask(ctx: Context, prompt: string): Promise<void> {
    if (!ctx.chat || !ctx.from) return;
    const cancelMarkup = {
      inline_keyboard: [
        [{ text: '✕ Cancel task', callback_data: `task:cancel:${ctx.from.id}` }],
      ],
    };
    const provider = this.tasks.session(ctx.chat.id).provider;
    const agentName = this.agentName(provider);
    let activeStatusMessage = await ctx.reply(`${agentName} is working…`, {
      reply_markup: cancelMarkup,
    });
    let lastProgressAt = 0;
    let lastProgress = '';

    const clearActiveCancel = async (): Promise<void> => {
      await ctx.telegram
        .editMessageReplyMarkup(
          ctx.chat!.id,
          activeStatusMessage.message_id,
          undefined,
          { inline_keyboard: [] },
        )
        .catch(() => undefined);
    };

    const progress = async (message: string): Promise<void> => {
      const now = Date.now();
      if (message === lastProgress || now - lastProgressAt < 2_500) return;
      lastProgressAt = now;
      lastProgress = message;

      await clearActiveCancel();
      activeStatusMessage = await ctx.reply(
        this.limit(`${agentName} is working…\n${message}`, 4_000),
        { reply_markup: cancelMarkup },
      );
    };

    try {
      const response = await this.tasks.execute(
        ctx.chat.id,
        prompt,
        progress,
        (request) => this.requestApproval(ctx, request),
      );
      await clearActiveCancel();
      for (const chunk of this.chunk(response, 4_000)) await ctx.reply(chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await clearActiveCancel();
      await ctx.reply(`Task failed: ${message}`);
    } finally {
      this.clearApprovalsForChat(ctx.chat.id, 'Task ended before a decision was made.');
    }
  }

  private async requestApproval(
    ctx: Context,
    request: ApprovalRequest,
  ): Promise<ApprovalDecision> {
    if (!ctx.chat || !ctx.from) return 'decline';
    const token = randomBytes(6).toString('hex');
    const summary = this.approvalSummary(request);
    const message = await ctx.reply(summary, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve once', callback_data: `approval:${token}:once` },
            { text: '🔁 Approve session', callback_data: `approval:${token}:session` },
          ],
          [
            { text: '❌ Reject', callback_data: `approval:${token}:reject` },
            { text: '🛑 Cancel action', callback_data: `approval:${token}:cancel` },
          ],
        ],
      },
    });

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.resolveApproval(token, 'decline', 'Approval expired and was rejected.');
      }, this.config.approvalTimeoutMs);
      this.pendingApprovals.set(token, {
        chatId: ctx.chat!.id,
        userId: ctx.from!.id,
        messageId: message.message_id,
        request,
        resolve,
        timer,
      });
    });
  }

  private resolveApproval(
    token: string,
    decision: ApprovalDecision,
    label: string,
  ): void {
    const pending = this.pendingApprovals.get(token);
    if (!pending) return;
    this.pendingApprovals.delete(token);
    clearTimeout(pending.timer);
    const summary =
      pending.request.command ??
      pending.request.grantRoot ??
      pending.request.reason ??
      pending.request.itemId;
    this.database.recordApproval(
      pending.chatId,
      pending.userId,
      pending.request.type,
      summary,
      decision,
    );
    void this.bot.telegram
      .editMessageText(
        pending.chatId,
        pending.messageId,
        undefined,
        `${this.approvalSummary(pending.request)}\n\nDecision: ${label}`,
      )
      .catch(() => undefined);
    pending.resolve(decision);
  }

  private clearApprovalsForChat(chatId: number, label: string): void {
    for (const [token, pending] of this.pendingApprovals) {
      if (pending.chatId === chatId) this.resolveApproval(token, 'decline', label);
    }
  }

  private expireThreadSelection(token: string): void {
    const selection = this.pendingThreadSelections.get(token);
    if (!selection) return;
    clearTimeout(selection.timer);
    this.pendingThreadSelections.delete(token);
  }

  private clearThreadSelectionsForChat(chatId: number): void {
    for (const [token, selection] of this.pendingThreadSelections) {
      if (selection.chatId === chatId) this.expireThreadSelection(token);
    }
  }

  private approvalSummary(request: ApprovalRequest): string {
    const titles: Record<ApprovalRequest['type'], string> = {
      command: '⚠️ Agent requests command approval',
      'file-change': '⚠️ Agent requests file-change approval',
      tool: '⚠️ Agent requests tool approval',
    };
    const title = titles[request.type];
    const details = [
      request.command ? `Command:\n${this.limit(request.command, 1_500)}` : undefined,
      request.cwd ? `Directory: ${request.cwd}` : undefined,
      request.grantRoot ? `Requested write root: ${request.grantRoot}` : undefined,
      request.reason ? `Reason: ${this.limit(request.reason, 600)}` : undefined,
    ].filter((value): value is string => Boolean(value));
    return `${title}\n\n${details.join('\n\n') || 'No additional details were provided.'}`;
  }

  private decisionLabel(decision: ApprovalDecision): string {
    const labels: Record<ApprovalDecision, string> = {
      accept: 'Approved once',
      acceptForSession: 'Approved for this agent session',
      decline: 'Rejected',
      cancel: 'Cancelled',
    };
    return labels[decision];
  }

  private async selectAgent(ctx: Context, provider: AgentProvider): Promise<void> {
    if (!ctx.chat) return;
    if (!this.tasks.selectAgent(ctx.chat.id, provider)) {
      await ctx.reply('Cannot switch agents while a task is running.');
      return;
    }
    await ctx.reply(
      `${this.agentName(provider)} selected. A fresh thread will be used for the next message.`,
    );
  }

  private agentName(provider: AgentProvider): string {
    return provider === 'claude' ? 'Claude' : 'Codex';
  }

  private limit(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
  }

  private chunk(value: string, size: number): string[] {
    if (!value) return ['Task completed without a text response.'];
    const chunks: string[] = [];
    for (let index = 0; index < value.length; index += size) {
      chunks.push(value.slice(index, index + size));
    }
    return chunks;
  }
}
