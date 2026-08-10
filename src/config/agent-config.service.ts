import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAbsolute, resolve } from 'node:path';

export interface RepositoryConfig {
  key: string;
  path: string;
}

@Injectable()
export class AgentConfigService {
  readonly telegramToken: string;
  readonly allowedUserIds: ReadonlySet<number>;
  readonly repositories: ReadonlyMap<string, string>;
  readonly defaultRepository: string;
  readonly databasePath: string;
  readonly codexModel?: string;
  readonly codexPath: string;
  readonly taskTimeoutMs: number;
  readonly approvalTimeoutMs: number;
  readonly maxMessageLength: number;

  constructor(config: ConfigService) {
    this.telegramToken = this.required(config, 'TELEGRAM_BOT_TOKEN');
    this.allowedUserIds = this.parseUserIds(
      this.required(config, 'TELEGRAM_ALLOWED_USER_IDS'),
    );
    this.repositories = this.parseRepositories(
      this.required(config, 'REPOSITORIES_JSON'),
    );
    this.defaultRepository =
      config.get<string>('DEFAULT_REPOSITORY') ??
      this.repositories.keys().next().value!;

    if (!this.repositories.has(this.defaultRepository)) {
      throw new Error(
        `DEFAULT_REPOSITORY "${this.defaultRepository}" is not in REPOSITORIES_JSON`,
      );
    }

    this.databasePath = resolve(
      config.get<string>('DATABASE_PATH') ?? './data/agent.db',
    );
    this.codexModel = config.get<string>('CODEX_MODEL') || undefined;
    this.codexPath = config.get<string>('CODEX_PATH')?.trim() || 'codex';
    this.taskTimeoutMs = this.positiveInteger(
      config.get<string>('TASK_TIMEOUT_MS') ?? '1800000',
      'TASK_TIMEOUT_MS',
    );
    this.maxMessageLength = this.positiveInteger(
      config.get<string>('MAX_MESSAGE_LENGTH') ?? '12000',
      'MAX_MESSAGE_LENGTH',
    );
    this.approvalTimeoutMs = this.positiveInteger(
      config.get<string>('APPROVAL_TIMEOUT_MS') ?? '300000',
      'APPROVAL_TIMEOUT_MS',
    );
  }

  repository(key: string): RepositoryConfig | undefined {
    const path = this.repositories.get(key);
    return path ? { key, path } : undefined;
  }

  private required(config: ConfigService, key: string): string {
    const value = config.get<string>(key)?.trim();
    if (!value) throw new Error(`${key} is required`);
    return value;
  }

  private parseUserIds(value: string): ReadonlySet<number> {
    const ids = value.split(',').map((item) => Number(item.trim()));
    if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id))) {
      throw new Error('TELEGRAM_ALLOWED_USER_IDS must contain numeric user IDs');
    }
    return new Set(ids);
  }

  private parseRepositories(value: string): ReadonlyMap<string, string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('REPOSITORIES_JSON must be valid JSON');
    }

    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('REPOSITORIES_JSON must be a JSON object');
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) throw new Error('At least one repository is required');

    const repositories = new Map<string, string>();
    for (const [key, path] of entries) {
      if (!/^[a-zA-Z0-9_-]+$/.test(key) || typeof path !== 'string') {
        throw new Error(`Invalid repository entry: ${key}`);
      }
      if (!isAbsolute(path)) {
        throw new Error(`Repository "${key}" must use an absolute path`);
      }
      repositories.set(key, resolve(path));
    }
    return repositories;
  }

  private positiveInteger(value: string, key: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    return parsed;
  }
}
