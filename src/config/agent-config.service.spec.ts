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
    expect(service.codexAllowSecretFileAccess).toBe(false);
    expect(service.codexSandboxMode).toBe('read-only');
    expect(service.codexApprovalPolicy).toBe('untrusted');
    expect(service.defaultAgent).toBe('codex');
    expect(service.claudePath).toBe('claude');
    expect(service.maxDocumentBytes).toBe(10_485_760);
  });

  it('configures Claude as the default agent', () => {
    const service = new AgentConfigService(
      config({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_ALLOWED_USER_IDS: '123',
        REPOSITORIES_JSON: '{"app":"/tmp/app"}',
        DEFAULT_AGENT: 'claude',
        CLAUDE_PATH: '/usr/local/bin/claude',
        CLAUDE_MODEL: 'sonnet',
      }),
    );

    expect(service.defaultAgent).toBe('claude');
    expect(service.claudePath).toBe('/usr/local/bin/claude');
    expect(service.claudeModel).toBe('sonnet');
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

  it('disables Codex network access for an invalid value', () => {
    const service = new AgentConfigService(
      config({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_ALLOWED_USER_IDS: '123',
        REPOSITORIES_JSON: '{"app":"/tmp/app"}',
        CODEX_NETWORK_ACCESS: 'yes',
      }),
    );

    expect(service.codexNetworkAccess).toBe(false);
  });

  it('allows secret-file access only when explicitly set to true', () => {
    const enabled = new AgentConfigService(
      config({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_ALLOWED_USER_IDS: '123',
        REPOSITORIES_JSON: '{"app":"/tmp/app"}',
        CODEX_ALLOW_SECRET_FILE_ACCESS: 'true',
      }),
    );
    const invalid = new AgentConfigService(
      config({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_ALLOWED_USER_IDS: '123',
        REPOSITORIES_JSON: '{"app":"/tmp/app"}',
        CODEX_ALLOW_SECRET_FILE_ACCESS: 'yes',
      }),
    );

    expect(enabled.codexAllowSecretFileAccess).toBe(true);
    expect(invalid.codexAllowSecretFileAccess).toBe(false);
  });

  it('configures the Codex sandbox and approval policy', () => {
    const service = new AgentConfigService(
      config({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_ALLOWED_USER_IDS: '123',
        REPOSITORIES_JSON: '{"app":"/tmp/app"}',
        CODEX_SANDBOX_MODE: 'read-only',
        CODEX_APPROVAL_POLICY: 'on-request',
      }),
    );

    expect(service.codexSandboxMode).toBe('read-only');
    expect(service.codexApprovalPolicy).toBe('on-request');
  });

  it('uses conservative fallbacks for invalid Codex permission settings', () => {
    const service = new AgentConfigService(
      config({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_ALLOWED_USER_IDS: '123',
        REPOSITORIES_JSON: '{"app":"/tmp/app"}',
        CODEX_SANDBOX_MODE: 'everything',
        CODEX_APPROVAL_POLICY: 'always',
      }),
    );

    expect(service.codexSandboxMode).toBe('read-only');
    expect(service.codexApprovalPolicy).toBe('untrusted');
  });

  it('sets the Claude permission mode from CLAUDE_PERMISSION_MODE, or follows CODEX_APPROVAL_POLICY, failing closed', () => {
    const mode = (values: Record<string, string>) => new AgentConfigService(config({
      TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_ALLOWED_USER_IDS: '123', REPOSITORIES_JSON: '{"app":"/tmp/app"}', ...values,
    })).claudePermissionMode;

    expect(mode({})).toBe('manual');
    expect(mode({ CODEX_APPROVAL_POLICY: 'never' })).toBe('bypassPermissions');
    expect(mode({ CODEX_APPROVAL_POLICY: 'on-request' })).toBe('manual');
    expect(mode({ CODEX_APPROVAL_POLICY: 'never', CLAUDE_PERMISSION_MODE: 'acceptEdits' })).toBe('acceptEdits');
    expect(mode({ CLAUDE_PERMISSION_MODE: ' bypassPermissions ' })).toBe('bypassPermissions');
    expect(mode({ CODEX_APPROVAL_POLICY: 'never', CLAUDE_PERMISSION_MODE: 'yolo' })).toBe('manual');
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

  describe('Jira', () => {
    const base = {
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_ALLOWED_USER_IDS: '123',
      REPOSITORIES_JSON: '{"app":"/tmp/app"}',
    };

    it('is disabled when no Jira settings are present', () => {
      expect(new AgentConfigService(config(base)).jira).toBeUndefined();
    });

    it('normalizes the site URL to its origin', () => {
      const service = new AgentConfigService(
        config({
          ...base,
          JIRA_BASE_URL: 'https://acme.atlassian.net/jira/',
          JIRA_EMAIL: 'me@acme.test',
          JIRA_API_TOKEN: 'secret',
        }),
      );

      expect(service.jira).toEqual({
        baseUrl: 'https://acme.atlassian.net',
        email: 'me@acme.test',
        apiToken: 'secret',
      });
    });

    it('rejects partial or insecure settings', () => {
      expect(
        () => new AgentConfigService(config({ ...base, JIRA_BASE_URL: 'https://acme.atlassian.net' })),
      ).toThrow('must all be set');
      expect(
        () =>
          new AgentConfigService(
            config({
              ...base,
              JIRA_BASE_URL: 'http://acme.atlassian.net',
              JIRA_EMAIL: 'me@acme.test',
              JIRA_API_TOKEN: 'secret',
            }),
          ),
      ).toThrow('must use https');
    });
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
