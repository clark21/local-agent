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

  it('retries a missing rollout once, then starts and persists a new thread', async () => {
    const missingRollout = new Error(
      'Task failed: no rollout found for thread id thread-missing',
    );
    const codex = {
      run: jest
        .fn()
        .mockRejectedValueOnce(missingRollout)
        .mockRejectedValueOnce(missingRollout)
        .mockResolvedValueOnce({ response: 'recovered', threadId: 'thread-new' }),
    };
    const progress = jest.fn().mockResolvedValue(undefined);
    database.getOrCreateSession.mockReturnValue({
      ...session,
      threadId: 'thread-missing',
    });
    const service = new TaskService(config as never, database as never, codex as never);

    await expect(
      service.execute(
        1,
        'fix it',
        progress,
        () => Promise.resolve('decline'),
      ),
    ).resolves.toBe('recovered');

    expect(codex.run).toHaveBeenCalledTimes(3);
    expect(codex.run).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'fix it',
      'thread-missing',
      expect.anything(),
      progress,
      expect.anything(),
    );
    expect(codex.run).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'fix it',
      'thread-missing',
      expect.anything(),
      progress,
      expect.anything(),
    );
    expect(codex.run).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      'fix it',
      null,
      expect.anything(),
      progress,
      expect.anything(),
    );
    expect(progress).toHaveBeenNthCalledWith(
      1,
      'Saved thread was not found. Retrying once…',
    );
    expect(progress).toHaveBeenNthCalledWith(
      2,
      'Saved thread is unavailable. Starting a new thread…',
    );
    expect(database.saveThread).toHaveBeenCalledWith(1, 'thread-new');
    expect(database.finishAudit).toHaveBeenCalledWith(
      1,
      'completed',
      'recovered',
    );
  });

  it('does not replace a thread for unrelated failures', async () => {
    const codex = {
      run: jest.fn().mockRejectedValue(new Error('Codex app-server exited')),
    };
    database.getOrCreateSession.mockReturnValue({ ...session, threadId: 'thread-1' });
    const service = new TaskService(config as never, database as never, codex as never);

    await expect(
      service.execute(
        1,
        'fix it',
        () => Promise.resolve(),
        () => Promise.resolve('decline'),
      ),
    ).rejects.toThrow('Codex app-server exited');

    expect(codex.run).toHaveBeenCalledTimes(1);
    expect(database.saveThread).not.toHaveBeenCalled();
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
