import { resolve } from 'node:path';
import { ApprovalRequest } from '../codex/codex.service';
import { ClaudeService } from './claude.service';

describe('ClaudeService CLI integration', () => {
  const service = new ClaudeService({
    claudePath: resolve('test/fixtures/fake-claude-cli.sh'),
    claudeModel: undefined,
    codexAllowSecretFileAccess: false,
  } as never);

  const run = (
    threadId: string | null,
    commands: string[] = [],
    requests: ApprovalRequest[] = [],
  ) =>
    service.run(
      { key: 'test', path: '/tmp' },
      'run tests',
      threadId,
      new AbortController().signal,
      () => Promise.resolve(),
      (request) => {
        requests.push(request);
        commands.push(request.command ?? '');
        return Promise.resolve('accept');
      },
    );

  it('streams a turn, forwards approval, and returns the session ID', async () => {
    const commands: string[] = [];

    const result = await run(null, commands);

    expect(commands).toEqual(['npm test']);
    expect(result).toEqual({
      response: 'completed',
      threadId: 'claude-session',
    });
  });

  it('labels non-file tools as tool approvals and shows their input', async () => {
    const requests: ApprovalRequest[] = [];

    await expect(run('webfetch', [], requests)).resolves.toMatchObject({
      response: 'fetched',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].type).toBe('tool');
    expect(requests[0].grantRoot).toBeUndefined();
    expect(requests[0].reason).toContain('WebFetch');
    expect(requests[0].reason).toContain('https://example.com');
  });

  it('grants access to additional workspace repositories', async () => {
    await expect(
      service.run(
        { key: 'test', path: '/tmp' },
        'run tests',
        'multi-repo',
        new AbortController().signal,
        () => Promise.resolve(),
        () => Promise.resolve('decline'),
        [
          { key: 'web', path: '/tmp/web' },
          { key: 'docs', path: '/tmp/docs' },
        ],
      ),
    ).resolves.toEqual({ response: 'multi', threadId: 'claude-session' });
  });

  it('reports a missing session so the task can start a new thread', async () => {
    await expect(run('missing-session')).rejects.toThrow(
      'No conversation found with session ID: missing-session',
    );
  });

  it('treats an error result as a failure even when the CLI exits 0', async () => {
    await expect(run('error-result')).rejects.toThrow(
      'Claude CLI failed: API Error: overloaded',
    );
  });

  it('rejects instead of crashing when the CLI closes stdin and dies', async () => {
    await expect(run('dead')).rejects.toThrow('Claude CLI exited (3)');
  });
});
