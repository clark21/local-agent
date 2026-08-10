import { resolve } from 'node:path';
import { CodexService } from './codex.service';

describe('CodexService app-server integration', () => {
  it('forwards command approvals and resumes the turn', async () => {
    const service = new CodexService({
      codexPath: resolve('test/fixtures/fake-app-server.sh'),
      codexModel: undefined,
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
});
