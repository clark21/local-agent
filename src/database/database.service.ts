import { Injectable, OnModuleDestroy } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- package exports a CommonJS constructor
import Database = require('better-sqlite3');
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AgentConfigService } from '../config/agent-config.service';

export interface ChatSession {
  chatId: number;
  repositoryKey: string;
  threadId: string | null;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly database: Database.Database;

  constructor(config: AgentConfigService) {
    mkdirSync(dirname(config.databasePath), { recursive: true });
    this.database = new Database(config.databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        chat_id INTEGER PRIMARY KEY,
        repository_key TEXT NOT NULL,
        thread_id TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS task_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        repository_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS approval_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        action_type TEXT NOT NULL,
        action_summary TEXT NOT NULL,
        decision TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  getOrCreateSession(chatId: number, defaultRepository: string): ChatSession {
    this.database
      .prepare(
        `INSERT INTO chat_sessions (chat_id, repository_key)
         VALUES (?, ?) ON CONFLICT(chat_id) DO NOTHING`,
      )
      .run(chatId, defaultRepository);
    return this.getSession(chatId)!;
  }

  getSession(chatId: number): ChatSession | undefined {
    const row = this.database
      .prepare(
        'SELECT chat_id, repository_key, thread_id FROM chat_sessions WHERE chat_id = ?',
      )
      .get(chatId) as
      | { chat_id: number; repository_key: string; thread_id: string | null }
      | undefined;
    return row
      ? {
          chatId: row.chat_id,
          repositoryKey: row.repository_key,
          threadId: row.thread_id,
        }
      : undefined;
  }

  selectRepository(chatId: number, repositoryKey: string): void {
    this.database
      .prepare(
        `UPDATE chat_sessions
         SET repository_key = ?, thread_id = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE chat_id = ?`,
      )
      .run(repositoryKey, chatId);
  }

  saveThread(chatId: number, threadId: string): void {
    this.database
      .prepare(
        `UPDATE chat_sessions
         SET thread_id = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?`,
      )
      .run(threadId, chatId);
  }

  clearThread(chatId: number): void {
    this.database
      .prepare(
        `UPDATE chat_sessions
         SET thread_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?`,
      )
      .run(chatId);
  }

  startAudit(chatId: number, repositoryKey: string, prompt: string): number {
    return Number(
      this.database
        .prepare(
          `INSERT INTO task_audit (chat_id, repository_key, prompt, status)
           VALUES (?, ?, ?, 'running')`,
        )
        .run(chatId, repositoryKey, prompt).lastInsertRowid,
    );
  }

  finishAudit(id: number, status: string, result?: string): void {
    this.database
      .prepare(
        `UPDATE task_audit SET status = ?, result = ?, finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(status, result?.slice(0, 100_000) ?? null, id);
  }

  recordApproval(
    chatId: number,
    userId: number,
    actionType: string,
    actionSummary: string,
    decision: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO approval_audit
           (chat_id, user_id, action_type, action_summary, decision)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(chatId, userId, actionType, actionSummary.slice(0, 10_000), decision);
  }

  onModuleDestroy(): void {
    this.database.close();
  }
}
