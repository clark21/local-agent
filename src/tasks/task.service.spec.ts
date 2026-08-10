import { TaskService } from './task.service';

describe('TaskService', () => {
  const config = {
    defaultRepository: 'app',
    maxMessageLength: 100,
    taskTimeoutMs: 10_000,
    repository: (key: string) =>
      key === 'app' ? { key: 'app', path: '/tmp/app' } : undefined,
  };
  const session = { chatId: 1, repositoryKey: 'app', threadId: null };
  let database: {
    getOrCreateSession: jest.Mock;
    startAudit: jest.Mock;
    finishAudit: jest.Mock;
    saveThread: jest.Mock;
    clearThread: jest.Mock;
    selectRepository: jest.Mock;
  };

  beforeEach(() => {
    database = {
      getOrCreateSession: jest.fn().mockReturnValue(session),
      startAudit: jest.fn().mockReturnValue(1),
      finishAudit: jest.fn(),
      saveThread: jest.fn(),
      clearThread: jest.fn(),
      selectRepository: jest.fn(),
    };
  });

  it('persists the returned Codex thread', async () => {
    const codex = {
      run: jest.fn().mockResolvedValue({ response: 'done', threadId: 'thread-1' }),
    };
    const service = new TaskService(config as never, database as never, codex as never);

    await expect(
      service.execute(
        1,
        'fix it',
        () => Promise.resolve(),
        () => Promise.resolve('decline'),
      ),
    ).resolves.toBe('done');
    expect(database.saveThread).toHaveBeenCalledWith(1, 'thread-1');
    expect(database.finishAudit).toHaveBeenCalledWith(1, 'completed', 'done');
  });

  it('prevents concurrent tasks in one chat', async () => {
    let finish!: (value: { response: string; threadId: string }) => void;
    const codex = {
      run: jest.fn().mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      ),
    };
    const service = new TaskService(config as never, database as never, codex as never);
    const first = service.execute(
      1,
      'first',
      () => Promise.resolve(),
      () => Promise.resolve('decline'),
    );

    await expect(
      service.execute(
        1,
        'second',
        () => Promise.resolve(),
        () => Promise.resolve('decline'),
      ),
    ).rejects.toThrow('already running');
    finish({ response: 'done', threadId: 'thread-1' });
    await first;
  });

  it('resumes a thread only for the currently selected repository', () => {
    const service = new TaskService(
      config as never,
      database as never,
      { run: jest.fn() } as never,
    );

    expect(service.resumeThread(1, 'other', 'thread-x')).toBe(false);
    expect(service.resumeThread(1, 'app', 'thread-x')).toBe(true);
    expect(database.saveThread).toHaveBeenCalledWith(1, 'thread-x');
  });
});
