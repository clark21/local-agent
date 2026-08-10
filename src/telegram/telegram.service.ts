import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Context, Telegraf } from 'telegraf';
import { randomBytes } from 'node:crypto';
import {
  ApprovalDecision,
  ApprovalRequest,
  CodexService,
} from '../codex/codex.service';
import { AgentConfigService } from '../config/agent-config.service';
import { DatabaseService } from '../database/database.service';
import { TaskService } from '../tasks/task.service';

const HELP = `Local Codex agent commands:
/repo - list repositories
/repo <name> - select a repository and start a fresh thread
/threads - list and resume recent threads for the current repository
/new - start a fresh thread in the current repository
/status - show current repository and task status
/cancel - cancel the active task
/help - show this help

Send a normal text message to run a task.`;

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
    private readonly codex: CodexService,
  ) {
    this.bot = new Telegraf(config.telegramToken);
    this.registerHandlers();
  }

  async onModuleInit(): Promise<void> {
    await this.bot.telegram.setMyCommands([
      { command: 'repo', description: 'List or select a repository' },
      { command: 'threads', description: 'List and resume recent threads' },
      { command: 'new', description: 'Start a fresh Codex thread' },
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
      await ctx.reply(`Selected ${requested}. A fresh Codex thread will be used.`);
    });

    this.bot.command('new', async (ctx) => {
      await ctx.reply(
        this.tasks.newThread(ctx.chat.id)
          ? 'A fresh Codex thread will be used for the next message.'
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
        const threads = await this.codex.listThreads(repository, 10);
        if (threads.length === 0) {
          await ctx.reply(`No saved Codex threads found for ${repository.key}.`);
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
          ? `Running in ${status.repositoryKey} for ${status.elapsedSeconds}s.`
          : `Idle. Current repository: ${status.repositoryKey}.`,
      );
    });

    this.bot.command('cancel', async (ctx) => {
      await ctx.reply(
        this.tasks.cancel(ctx.chat.id)
          ? 'Cancellation requested.'
          : 'No task is currently running.',
      );
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

    this.bot.catch((error, ctx) => {
      this.logger.error(`Telegram update ${ctx.update.update_id} failed`, error);
    });
  }

  private async handleTask(ctx: Context, prompt: string): Promise<void> {
    if (!ctx.chat) return;
    const progressMessage = await ctx.reply('Codex is working…');
    let lastProgressAt = 0;
    const progress = async (message: string): Promise<void> => {
      const now = Date.now();
      if (now - lastProgressAt < 2_500) return;
      lastProgressAt = now;
      try {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          progressMessage.message_id,
          undefined,
          `Codex is working…\n${message}`,
        );
      } catch {
        // Telegram rejects no-op or stale edits; the final response still gets sent.
      }
    };

    try {
      const response = await this.tasks.execute(
        ctx.chat.id,
        prompt,
        progress,
        (request) => this.requestApproval(ctx, request),
      );
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        progressMessage.message_id,
        undefined,
        'Task completed.',
      );
      for (const chunk of this.chunk(response, 4_000)) await ctx.reply(chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        progressMessage.message_id,
        undefined,
        `Task failed: ${message}`,
      );
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
    const title =
      request.type === 'command'
        ? '⚠️ Codex requests command approval'
        : '⚠️ Codex requests file-change approval';
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
      acceptForSession: 'Approved for this Codex session',
      decline: 'Rejected',
      cancel: 'Cancelled',
    };
    return labels[decision];
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
