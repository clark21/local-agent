import { resolve } from 'node:path';
import { CodexService } from './codex.service';

describe('CodexService app-server integration', () => {
  it('forwards command approvals and resumes the turn', async () => {
    const service = new CodexService({
      codexPath: resolve('test/fixtures/fake-app-server.sh'),
      codexModel: undefined,
      codexApprovalPolicy: 'on-request',
      codexSandboxMode: 'workspace-write',
      codexNetworkAccess: false,
    } as never);
    const commands: string[] = [];

    const result = await service.run(
      { key: 'test', path: '/tmp' },
      'run tests',
      null,
      new AbortController().signal,
      () => Promise.resolve(),
      (request) => {
        commands.push(request.command ?? '');
        return Promise.resolve('accept');
      },
    );

    expect(commands).toEqual(['npm test']);
    expect(result).toEqual({ response: 'completed', threadId: 'thread-test' });
  });

  it('lists threads for a repository', async () => {
    const service = new CodexService({
      codexPath: resolve('test/fixtures/fake-app-server.sh'),
      codexModel: undefined,
    } as never);

    await expect(
      service.listThreads({ key: 'test', path: '/tmp' }),
    ).resolves.toEqual([
      {
        id: 'thread-old',
        preview: 'Fix the tests',
        name: undefined,
        updatedAt: 1786291200,
      },
    ]);
  });
});
