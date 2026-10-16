import { TaskService } from './task.service';

describe('TaskService', () => {
  const config = {
    defaultRepository: 'app',
    maxMessageLength: 100,
    taskTimeoutMs: 10_000,
    repository: (key: string) =>
      key === 'app' ? { key: 'app', path: '/tmp/app' } : undefined,
  };
  const session = {
    chatId: 1,
    repositoryKey: 'app',
    threadId: null,
    provider: 'codex' as const,
    extraRepositoryKeys: [] as string[],
  };
  const workspaceConfig = {
    ...config,
    repository: (key: string) =>
      ['app', 'web'].includes(key) ? { key, path: `/tmp/${key}` } : undefined,
  };
  let database: {
    getOrCreateSession: jest.Mock;
    startAudit: jest.Mock;
    finishAudit: jest.Mock;
    saveThread: jest.Mock;
    clearThread: jest.Mock;
    selectRepository: jest.Mock;
    selectProvider: jest.Mock;
    selectWorkspace: jest.Mock;
  };

  beforeEach(() => {
    database = {
      getOrCreateSession: jest.fn().mockReturnValue(session),
      startAudit: jest.fn().mockReturnValue(1),
      finishAudit: jest.fn(),
      saveThread: jest.fn(),
      clearThread: jest.fn(),
      selectRepository: jest.fn(),
      selectProvider: jest.fn(),
      selectWorkspace: jest.fn(),
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
      'codex',
      expect.anything(),
      'fix it',
      'thread-missing',
      expect.anything(),
      progress,
      expect.anything(),
      [],
    );
    expect(codex.run).toHaveBeenNthCalledWith(
      2,
      'codex',
      expect.anything(),
      'fix it',
      'thread-missing',
      expect.anything(),
      progress,
      expect.anything(),
      [],
    );
    expect(codex.run).toHaveBeenNthCalledWith(
      3,
      'codex',
      expect.anything(),
      'fix it',
      null,
      expect.anything(),
      progress,
      expect.anything(),
      [],
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

  it('starts a new thread when a saved Claude session no longer exists', async () => {
    const missingSession = new Error(
      'Claude CLI failed: No conversation found with session ID: session-missing',
    );
    const agents = {
      run: jest
        .fn()
        .mockRejectedValueOnce(missingSession)
        .mockRejectedValueOnce(missingSession)
        .mockResolvedValueOnce({ response: 'recovered', threadId: 'session-new' }),
    };
    database.getOrCreateSession.mockReturnValue({
      ...session,
      provider: 'claude',
      threadId: 'session-missing',
    });
    const service = new TaskService(config as never, database as never, agents as never);

    await expect(
      service.execute(
        1,
        'fix it',
        () => Promise.resolve(),
        () => Promise.resolve('decline'),
      ),
    ).resolves.toBe('recovered');

    expect(agents.run).toHaveBeenCalledTimes(3);
    expect(agents.run).toHaveBeenLastCalledWith(
      'claude',
      expect.anything(),
      'fix it',
      null,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      [],
    );
    expect(database.saveThread).toHaveBeenCalledWith(1, 'session-new');
    expect(database.startAudit).toHaveBeenCalledWith(1, 'app', 'claude', 'fix it');
  });

  it('runs in every workspace repository and tells the agent about them', async () => {
    const agents = {
      run: jest.fn().mockResolvedValue({ response: 'done', threadId: 'thread-1' }),
    };
    database.getOrCreateSession.mockReturnValue({
      ...session,
      extraRepositoryKeys: ['web'],
    });
    const service = new TaskService(
      workspaceConfig as never,
      database as never,
      agents as never,
    );

    await service.execute(
      1,
      'fix it',
      () => Promise.resolve(),
      () => Promise.resolve('decline'),
    );

    const [, , prompt, , , , , additional] = agents.run.mock.calls[0] as unknown[];
    expect(additional).toEqual([{ key: 'web', path: '/tmp/web' }]);
    expect(prompt).toContain('Main repository (current working directory): app: /tmp/app');
    expect(prompt).toContain('- web: /tmp/web');
    expect(prompt).toMatch(/\n\nfix it$/);
    // The audit keeps what the user asked for, not the workspace preamble.
    expect(database.startAudit).toHaveBeenCalledWith(1, 'app', 'codex', 'fix it');
  });

  it('selects a workspace only from distinct, configured repositories', () => {
    const service = new TaskService(
      workspaceConfig as never,
      database as never,
      { run: jest.fn() } as never,
    );

    expect(service.selectWorkspace(1, [])).toBe(false);
    expect(service.selectWorkspace(1, ['app', 'app'])).toBe(false);
    expect(service.selectWorkspace(1, ['app', 'missing'])).toBe(false);
    expect(database.selectWorkspace).not.toHaveBeenCalled();

    expect(service.selectWorkspace(1, ['web', 'app'])).toBe(true);
    expect(database.selectWorkspace).toHaveBeenCalledWith(1, 'web', ['app']);
  });

  it('switches providers and starts a fresh provider thread', () => {
    const service = new TaskService(
      { ...config, defaultAgent: 'codex' } as never,
      database as never,
      { run: jest.fn() } as never,
    );

    expect(service.selectAgent(1, 'claude')).toBe(true);
    expect(database.selectProvider).toHaveBeenCalledWith(1, 'claude');
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

    expect(service.resumeThread(1, 'other', 'codex', 'thread-x')).toBe(false);
    expect(service.resumeThread(1, 'app', 'claude', 'thread-x')).toBe(false);
    expect(service.resumeThread(1, 'app', 'codex', 'thread-x')).toBe(true);
    expect(database.saveThread).toHaveBeenCalledWith(1, 'thread-x');
  });
});
