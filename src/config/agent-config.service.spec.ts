import { ConfigService } from '@nestjs/config';
import { AgentConfigService } from './agent-config.service';

function config(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as ConfigService;
}

describe('AgentConfigService', () => {
  it('parses an allowlist and repository map', () => {
    const service = new AgentConfigService(
      config({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_ALLOWED_USER_IDS: '123,456',
        REPOSITORIES_JSON: '{"app":"/tmp/app"}',
      }),
    );

    expect(service.allowedUserIds.has(123)).toBe(true);
    expect(service.repository('app')).toEqual({ key: 'app', path: '/tmp/app' });
    expect(service.defaultRepository).toBe('app');
    expect(service.codexNetworkAccess).toBe(false);
  });

  it('enables Codex network access only when explicitly set to true', () => {
    const service = new AgentConfigService(
      config({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_ALLOWED_USER_IDS: '123',
        REPOSITORIES_JSON: '{"app":"/tmp/app"}',
        CODEX_NETWORK_ACCESS: 'true',
      }),
    );

    expect(service.codexNetworkAccess).toBe(true);
  });

  it('rejects an invalid Codex network access value', () => {
    expect(
      () =>
        new AgentConfigService(
          config({
            TELEGRAM_BOT_TOKEN: 'token',
            TELEGRAM_ALLOWED_USER_IDS: '123',
            REPOSITORIES_JSON: '{"app":"/tmp/app"}',
            CODEX_NETWORK_ACCESS: 'yes',
          }),
        ),
    ).toThrow('CODEX_NETWORK_ACCESS must be true or false');
  });

  it('rejects relative repository paths', () => {
    expect(
      () =>
        new AgentConfigService(
          config({
            TELEGRAM_BOT_TOKEN: 'token',
            TELEGRAM_ALLOWED_USER_IDS: '123',
            REPOSITORIES_JSON: '{"app":"./app"}',
          }),
        ),
    ).toThrow('must use an absolute path');
  });

  it('rejects a default repository that is not allowlisted', () => {
    expect(
      () =>
        new AgentConfigService(
          config({
            TELEGRAM_BOT_TOKEN: 'token',
            TELEGRAM_ALLOWED_USER_IDS: '123',
            REPOSITORIES_JSON: '{"app":"/tmp/app"}',
            DEFAULT_REPOSITORY: 'other',
          }),
        ),
    ).toThrow('is not in REPOSITORIES_JSON');
  });
});
