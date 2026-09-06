import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Multiplexer } from '../types';
import { CmuxClosePolicy } from './close-policy';
import { CmuxSessionLifecycle } from './session-lifecycle';
import { CmuxSessionStore } from './session-state';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function multiplexer() {
  return {
    type: 'cmux',
    isAvailable: async () => true,
    isInsideSession: () => true,
    spawnPane: mock(async () => ({ success: true, paneId: 'pane' })),
    closePane: mock(async () => true),
    applyLayout: async () => {},
  } satisfies Multiplexer;
}

describe('CmuxSessionLifecycle races', () => {
  const store = new CmuxSessionStore();
  beforeEach(() => store.resetForTests());

  test('coordinator completion still requires lifetime and three stable idle polls', async () => {
    const mux = multiplexer();
    let now = 0;
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        now: () => now,
        isServerRunning: async () => true,
        fetchStatuses: async () => ({ s: { type: 'idle' } }),
      },
    );
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 's', parentID: 'p' } },
    });
    await lifecycle.closeSessionFromCoordinator('s');
    await lifecycle.pollOnce();
    expect(mux.closePane).not.toHaveBeenCalled();
    now = 10_000;
    await lifecycle.pollOnce();
    await lifecycle.pollOnce();
    expect(mux.closePane).not.toHaveBeenCalled();
    await lifecycle.pollOnce();
    expect(mux.closePane).toHaveBeenCalledTimes(1);
    await lifecycle.cleanup();
  });

  test('status absence never confirms deletion or closes a cmux pane', async () => {
    const mux = multiplexer();
    let now = 0;
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        now: () => now,
        isServerRunning: async () => true,
        fetchStatuses: async () => ({}),
      },
    );

    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'missing', parentID: 'p' } },
    });
    for (let index = 0; index < 5; index++) {
      now += 60_000;
      await lifecycle.pollOnce();
    }

    expect(mux.closePane).not.toHaveBeenCalled();
    await lifecycle.cleanup();
  });

  test('false cmux close keeps the record and retries after settlement', async () => {
    const mux = multiplexer();
    const retry = deferred<void>();
    mux.closePane.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        delay: () => retry.promise,
        isServerRunning: async () => true,
      },
    );

    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'false-close', parentID: 'p' } },
    });
    await lifecycle.onSessionDeleted({
      type: 'session.deleted',
      properties: { sessionID: 'false-close' },
    });

    expect(mux.closePane).toHaveBeenCalledTimes(1);
    expect(store.get('false-close')?.paneId).toBe('pane');
    retry.resolve();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(mux.closePane).toHaveBeenCalledTimes(2);
    expect(store.get('false-close')).toBeUndefined();
  });

  test('thrown cmux close keeps the record and retries after settlement', async () => {
    const mux = multiplexer();
    const retry = deferred<void>();
    mux.closePane
      .mockRejectedValueOnce(new Error('socket'))
      .mockResolvedValueOnce(true);
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        delay: () => retry.promise,
        isServerRunning: async () => true,
      },
    );

    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'thrown-close', parentID: 'p' } },
    });
    await lifecycle.onSessionDeleted({
      type: 'session.deleted',
      properties: { sessionID: 'thrown-close' },
    });

    expect(mux.closePane).toHaveBeenCalledTimes(1);
    expect(store.get('thrown-close')?.paneId).toBe('pane');
    retry.resolve();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(mux.closePane).toHaveBeenCalledTimes(2);
    expect(store.get('thrown-close')).toBeUndefined();
  });

  test('dispose gate closes a late successful spawn and never marks it active', async () => {
    const mux = multiplexer();
    const spawn = deferred<{ success: true; paneId: string }>();
    mux.spawnPane.mockImplementationOnce(() => spawn.promise);
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        delay: async () => {},
        shutdownTimeoutMs: 1,
        isServerRunning: async () => true,
      },
    );
    const creating = lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'late', parentID: 'p' } },
    });
    await Promise.resolve();
    await lifecycle.cleanup();
    spawn.resolve({ success: true, paneId: 'late-pane' });
    await creating;
    expect(mux.closePane).toHaveBeenCalledWith('late-pane');
    expect(store.get('late')).toBeUndefined();
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'blocked', parentID: 'p' } },
    });
    expect(mux.spawnPane).toHaveBeenCalledTimes(1);
  });

  test('new same-directory lifecycle takes over orphan with bounded attempts', async () => {
    store.claimCreated({
      session: 'orphan',
      owner: 'old',
      parent: 'p',
      title: 'agent',
      directory: '/repo',
      serverUrl: 'http://server/',
      paneId: 'orphan-pane',
      spawnState: 'attached',
      lifecycle: 'orphaned',
      lastActivityAt: 0,
      activityVersion: 0,
      idleConsecutive: 0,
    });
    const mux = multiplexer();
    mux.closePane.mockResolvedValue(false);
    const lifecycle = new CmuxSessionLifecycle(
      'new',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        closeRetryMaxAttempts: 1,
      },
    );
    await lifecycle.onSessionStatus({ type: 'session.status' });
    await Promise.resolve();
    await Promise.resolve();
    expect(mux.closePane).toHaveBeenCalledTimes(1);
    expect(store.get('orphan')).toMatchObject({
      owner: 'new',
      lifecycle: 'orphaned',
      paneId: 'orphan-pane',
    });
  });

  test('defers initial orphan recovery until the first poll', async () => {
    let serverUrl = 'http://server';
    let getterCalls = 0;
    for (const [session, scope] of [
      ['lazy-orphan', 'http://server/'],
      ['later-orphan', 'http://other/'],
    ] as const) {
      store.claimCreated({
        session,
        owner: 'old',
        parent: 'p',
        title: 'agent',
        directory: '/repo',
        serverUrl: scope,
        paneId: `${session}-pane`,
        spawnState: 'attached',
        lifecycle: 'orphaned',
        lastActivityAt: 0,
        activityVersion: 0,
        idleConsecutive: 0,
      });
    }

    const close = deferred<boolean>();
    const mux = multiplexer();
    mux.closePane.mockImplementation(() => close.promise);
    const lifecycle = new CmuxSessionLifecycle(
      'new',
      mux,
      () => {
        getterCalls += 1;
        return serverUrl;
      },
      '/repo',
      undefined,
      { fetchStatuses: async () => ({}) },
    );

    expect(getterCalls).toBe(0);
    await lifecycle.pollOnce();
    expect(getterCalls).toBeGreaterThan(0);
    expect(store.get('lazy-orphan')).toMatchObject({ owner: 'new' });
    expect(mux.closePane).toHaveBeenCalledWith('lazy-orphan-pane');

    const callsAfterFirstPoll = getterCalls;
    serverUrl = 'http://other';
    await lifecycle.pollOnce();
    expect(getterCalls).toBe(callsAfterFirstPoll + 1);
    expect(store.get('later-orphan')).toMatchObject({ owner: 'old' });

    close.resolve(true);
    for (let index = 0; index < 8; index++) await Promise.resolve();
    await lifecycle.cleanup();
  });

  test('terminal tracked orphan gets a fresh close budget when claimed', async () => {
    const policy = new CmuxClosePolicy(1, 1);
    let intent = policy.request('cleanup', 0, 0);
    intent = policy.failed(intent, 1);
    intent = policy.failed(policy.resume(intent, 30_001), 30_002);
    intent = policy.failed(policy.resume(intent, 90_002), 90_003);
    store.claimCreated({
      session: 'spent',
      owner: 'old',
      parent: 'p',
      title: 'agent',
      directory: '/repo',
      serverUrl: 'http://server/',
      paneId: 'pane',
      spawnState: 'attached',
      lifecycle: 'orphaned',
      lastActivityAt: 0,
      activityVersion: 0,
      idleConsecutive: 0,
      closeIntent: intent,
    });
    const mux = multiplexer();
    mux.closePane.mockResolvedValue(false);
    const lifecycle = new CmuxSessionLifecycle(
      'new',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        closeRetryMaxAttempts: 1,
      },
    );
    await lifecycle.onSessionStatus({ type: 'session.status' });
    await Promise.resolve();
    expect(mux.closePane).toHaveBeenCalledTimes(1);
    expect(store.get('spent')?.owner).toBe('new');
    expect(store.get('spent')?.closeIntent?.nextAttemptAt).not.toBe(Infinity);
  });

  test('busy activity cancels idle close during the first cooldown', async () => {
    let now = 0;
    const mux = multiplexer();
    mux.closePane.mockResolvedValue(false);
    const lifecycle = new CmuxSessionLifecycle(
      'owner',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        now: () => now,
        delay: () => new Promise(() => {}),
        closeRetryMaxAttempts: 1,
        isServerRunning: async () => true,
        fetchStatuses: async () => ({ active: { type: 'idle' } }),
      },
    );
    await lifecycle.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'active', parentID: 'p' } },
    });
    now = 10_000;
    await lifecycle.pollOnce();
    await lifecycle.pollOnce();
    await lifecycle.pollOnce();
    expect(store.get('active')).toMatchObject({
      lifecycle: 'active',
      closeIntent: { phase: 'cooldown', cooldowns: 1 },
    });
    await lifecycle.onSessionStatus({
      type: 'session.status',
      properties: { sessionID: 'active', status: { type: 'busy' } },
    });
    expect(store.get('active')).toMatchObject({ lifecycle: 'active' });
    expect(store.get('active')?.closeIntent).toBeUndefined();
    expect(store.get('active')?.closeTimer).toBeUndefined();
  });

  for (const result of [true, false]) {
    test(`old owner close ${result ? 'success' : 'failure'} cannot mutate a claimed orphan`, async () => {
      store.claimCreated({
        session: 'race',
        owner: 'old',
        parent: 'p',
        title: 'agent',
        directory: '/repo',
        serverUrl: 'http://server/',
        paneId: 'pane',
        spawnState: 'attached',
        lifecycle: 'orphaned',
        lastActivityAt: 0,
        activityVersion: 0,
        idleConsecutive: 0,
      });
      const oldMux = multiplexer();
      const close = deferred<boolean>();
      oldMux.closePane.mockImplementationOnce(() => close.promise);
      const old = new CmuxSessionLifecycle(
        'old',
        oldMux,
        () => 'http://server',
        '/repo',
      );
      await old.onSessionStatus({ type: 'session.status' });
      await Promise.resolve();
      const newMux = multiplexer();
      newMux.closePane.mockResolvedValue(false);
      const next = new CmuxSessionLifecycle(
        'new',
        newMux,
        () => 'http://server',
        '/repo',
        undefined,
        {
          closeRetryMaxAttempts: 1,
        },
      );
      await next.onSessionStatus({ type: 'session.status' });
      await Promise.resolve();
      const currentIntent = store.get('race')?.closeIntent;
      close.resolve(result);
      await Promise.resolve();
      await Promise.resolve();
      expect(store.get('race')).toMatchObject({ owner: 'new', paneId: 'pane' });
      expect(store.get('race')?.closeIntent).toBe(currentIntent);
    });
  }

  for (const result of [true, false]) {
    test(`cleanup close ${result ? 'success' : 'failure'} cannot mutate a newly claimed record`, async () => {
      store.claimCreated({
        session: 'cleanup-race',
        owner: 'old',
        parent: 'p',
        title: 'agent',
        directory: '/repo',
        serverUrl: 'http://server/',
        paneId: 'pane',
        spawnState: 'attached',
        lifecycle: 'active',
        lastActivityAt: 0,
        activityVersion: 0,
        idleConsecutive: 0,
      });
      const oldMux = multiplexer();
      const close = deferred<boolean>();
      oldMux.closePane.mockImplementationOnce(() => close.promise);
      const old = new CmuxSessionLifecycle(
        'old',
        oldMux,
        () => 'http://server',
        '/repo',
        undefined,
        { delay: async () => {} },
      );
      const cleaning = old.cleanup();
      await Promise.resolve();
      store.markOrphaned('cleanup-race');
      const newMux = multiplexer();
      newMux.closePane.mockResolvedValue(false);
      const next = new CmuxSessionLifecycle(
        'new',
        newMux,
        () => 'http://server',
        '/repo',
        undefined,
        { closeRetryMaxAttempts: 1 },
      );
      await next.onSessionStatus({ type: 'session.status' });
      await Promise.resolve();
      const currentIntent = store.get('cleanup-race')?.closeIntent;
      expect(newMux.closePane).not.toHaveBeenCalled();
      close.resolve(result);
      await cleaning;
      for (let index = 0; index < 8; index++) await Promise.resolve();
      if (result) {
        expect(store.get('cleanup-race')).toBeUndefined();
      } else {
        expect(store.get('cleanup-race')).toMatchObject({
          owner: 'new',
          paneId: 'pane',
          closeIntent: { phase: 'cooldown' },
        });
        expect(store.get('cleanup-race')?.closeIntent).not.toBe(currentIntent);
        expect(newMux.closePane).toHaveBeenCalledWith('pane');
      }
    });
  }

  test('late spawn does not overwrite a record claimed by a new owner', async () => {
    const oldMux = multiplexer();
    const spawn = deferred<{ success: true; paneId: string }>();
    oldMux.spawnPane.mockImplementationOnce(() => spawn.promise);
    oldMux.closePane.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const old = new CmuxSessionLifecycle(
      'old',
      oldMux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        delay: async () => {},
        isServerRunning: async () => true,
      },
    );
    const creating = old.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'late-race', parentID: 'p' } },
    });
    await Promise.resolve();
    await old.cleanup();
    store.markOrphaned('late-race');
    const existing = store.get('late-race');
    if (existing) existing.paneId = 'new-pane';
    const newMux = multiplexer();
    newMux.closePane.mockResolvedValue(false);
    const next = new CmuxSessionLifecycle(
      'new',
      newMux,
      () => 'http://server',
      '/repo',
      undefined,
      { closeRetryMaxAttempts: 1 },
    );
    await next.onSessionStatus({ type: 'session.status' });
    await Promise.resolve();
    const currentIntent = store.get('late-race')?.closeIntent;
    spawn.resolve({ success: true, paneId: 'old-late-pane' });
    await creating;
    expect(store.get('late-race')).toMatchObject({
      owner: 'new',
      paneId: 'new-pane',
    });
    expect(store.get('late-race')?.closeIntent).toBe(currentIntent);
    expect(oldMux.closePane).toHaveBeenCalledWith('old-late-pane');
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(oldMux.closePane).toHaveBeenCalledTimes(1);
    expect(
      store.ownedBy('old').some((record) => record.paneId === 'old-late-pane'),
    ).toBe(false);
    expect(store.get('late-race')).toMatchObject({
      owner: 'new',
      paneId: 'new-pane',
    });
    expect(newMux.closePane).toHaveBeenCalledWith('new-pane');
  });

  test('new owner retries a failed late cleanup after disposed owner cooldown', async () => {
    let now = 0;
    const oldMux = multiplexer();
    const spawn = deferred<{ success: true; paneId: string }>();
    oldMux.spawnPane.mockImplementationOnce(() => spawn.promise);
    oldMux.closePane.mockResolvedValue(false);
    const old = new CmuxSessionLifecycle(
      'old',
      oldMux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        closeRetryMaxAttempts: 1,
        delay: async () => {},
        isServerRunning: async () => true,
        now: () => now,
        shutdownTimeoutMs: 1,
      },
    );
    const creating = old.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'disposed-late', parentID: 'p' } },
    });
    await Promise.resolve();
    await old.cleanup();

    const cooldowns: Array<() => void> = [];
    const newMux = multiplexer();
    newMux.closePane.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const next = new CmuxSessionLifecycle(
      'new',
      newMux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        closeRetryMaxAttempts: 1,
        delay: () =>
          new Promise<void>((resolve) => {
            cooldowns.push(resolve);
          }),
        isServerRunning: async () => true,
        now: () => now,
      },
    );

    spawn.resolve({ success: true, paneId: 'old-late-pane' });
    await creating;

    const lateSession = 'disposed-late\0late\0old-late-pane';
    expect(oldMux.closePane).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 8; index++) await Promise.resolve();

    expect(store.get(lateSession)).toMatchObject({
      owner: 'new',
      paneId: 'old-late-pane',
      closeIntent: { phase: 'cooldown', cooldowns: 1 },
    });
    expect(store.get(lateSession)?.closeTimer).toBeDefined();
    expect(cooldowns).toHaveLength(1);

    now = 30_000;
    cooldowns.shift()?.();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(newMux.closePane).toHaveBeenCalledTimes(1);
    expect(newMux.closePane).toHaveBeenCalledWith('old-late-pane');
    expect(store.get(lateSession)).toMatchObject({
      owner: 'new',
      closeIntent: { phase: 'cooldown', cooldowns: 2 },
    });
    expect(store.get(lateSession)?.closeTimer).toBeDefined();
    expect(cooldowns).toHaveLength(1);

    now = 150_000;
    cooldowns.shift()?.();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(newMux.closePane).toHaveBeenCalledTimes(2);
    expect(store.get(lateSession)).toBeUndefined();
    await next.cleanup();
  });

  test('late orphan observer does not claim a pane while its close is pending', async () => {
    const oldMux = multiplexer();
    const spawn = deferred<{ success: true; paneId: string }>();
    const close = deferred<boolean>();
    oldMux.spawnPane.mockImplementationOnce(() => spawn.promise);
    oldMux.closePane.mockImplementationOnce(() => close.promise);
    const old = new CmuxSessionLifecycle(
      'old',
      oldMux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        closeRetryMaxAttempts: 1,
        delay: async () => {},
        isServerRunning: async () => true,
        shutdownTimeoutMs: 1,
      },
    );
    const creating = old.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'pending-late', parentID: 'p' } },
    });
    await Promise.resolve();
    await old.cleanup();

    const newMux = multiplexer();
    newMux.closePane.mockResolvedValue(true);
    const next = new CmuxSessionLifecycle(
      'new',
      newMux,
      () => 'http://server',
      '/repo',
      undefined,
      { isServerRunning: async () => true },
    );

    spawn.resolve({ success: true, paneId: 'pending-late-pane' });
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(oldMux.closePane).toHaveBeenCalledTimes(1);
    expect(newMux.closePane).not.toHaveBeenCalled();
    expect(store.get('pending-late\0late\0pending-late-pane')).toMatchObject({
      owner: 'old',
    });
    expect(
      store.get('pending-late\0late\0pending-late-pane')?.closePromise,
    ).toBeDefined();

    close.resolve(false);
    await creating;
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(newMux.closePane).not.toHaveBeenCalled();
    expect(store.get('pending-late\0late\0pending-late-pane')).toMatchObject({
      owner: 'new',
      closeIntent: { phase: 'cooldown' },
    });
    await next.cleanup();
  });

  test('late orphan observer keeps directory and server fences', async () => {
    const mux = multiplexer();
    for (const [session, directory, serverUrl] of [
      ['wrong-directory', '/other', 'http://server/'],
      ['wrong-server', '/repo', 'http://other/'],
    ] as const) {
      store.claimCreated({
        session,
        owner: 'old',
        parent: 'p',
        title: 'agent',
        directory,
        serverUrl,
        paneId: `${session}-pane`,
        spawnState: 'attached',
        lifecycle: 'orphaned',
        lastActivityAt: 0,
        activityVersion: 0,
        idleConsecutive: 0,
        latePaneCleanup: true,
      });
    }
    const lifecycle = new CmuxSessionLifecycle(
      'new',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      { isServerRunning: async () => true },
    );
    await lifecycle.onSessionStatus({ type: 'session.status' });
    for (let index = 0; index < 8; index++) await Promise.resolve();

    expect(store.get('wrong-directory')?.owner).toBe('old');
    expect(store.get('wrong-server')?.owner).toBe('old');
    expect(mux.closePane).not.toHaveBeenCalled();
    await lifecycle.cleanup();
  });

  test('new owner claims an existing late cooldown without an event', async () => {
    let now = 0;
    const policy = new CmuxClosePolicy(1, 1);
    const closeIntent = policy.failed(policy.request('cleanup', 0, now), now);
    store.claimCreated({
      session: 'existing-late',
      owner: 'old',
      parent: 'p',
      title: 'agent',
      directory: '/repo',
      serverUrl: 'http://server/',
      paneId: 'existing-late-pane',
      spawnState: 'attached',
      lifecycle: 'orphaned',
      lastActivityAt: 0,
      activityVersion: 0,
      idleConsecutive: 0,
      closeIntent,
      latePaneCleanup: true,
    });

    const cooldowns: Array<() => void> = [];
    const mux = multiplexer();
    mux.closePane.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const lifecycle = new CmuxSessionLifecycle(
      'new',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        closeRetryMaxAttempts: 1,
        delay: () =>
          new Promise<void>((resolve) => {
            cooldowns.push(resolve);
          }),
        isServerRunning: async () => true,
        now: () => now,
      },
    );
    await lifecycle.onSessionStatus({ type: 'session.status' });

    expect(store.get('existing-late')).toMatchObject({
      owner: 'new',
      closeIntent: { phase: 'cooldown', cooldowns: 1 },
    });
    expect(cooldowns).toHaveLength(1);

    now = 30_000;
    cooldowns.shift()?.();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(mux.closePane).toHaveBeenCalledTimes(1);
    expect(mux.closePane).toHaveBeenCalledWith('existing-late-pane');

    now = 150_000;
    cooldowns.shift()?.();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(mux.closePane).toHaveBeenCalledTimes(2);
    expect(store.get('existing-late')).toBeUndefined();
    await lifecycle.cleanup();
  });

  for (const result of [true, false]) {
    test(`session.created handoff consumes settled ${result ? 'success' : 'failure'}`, async () => {
      const session = `settled-handoff-${result}`;
      const oldMux = multiplexer();
      const close = deferred<boolean>();
      oldMux.closePane.mockImplementationOnce(() => close.promise);
      store.claimCreated({
        session,
        owner: 'old',
        parent: 'p',
        title: 'agent',
        directory: '/repo',
        serverUrl: 'http://server/',
        paneId: `pane-${result}`,
        spawnState: 'attached',
        lifecycle: 'orphaned',
        lastActivityAt: 0,
        activityVersion: 0,
        idleConsecutive: 0,
      });
      const old = new CmuxSessionLifecycle(
        'old',
        oldMux,
        () => 'http://server',
        '/repo',
        undefined,
        { closeRetryMaxAttempts: 1, isServerRunning: async () => true },
      );
      await old.onSessionStatus({ type: 'session.status' });
      for (let index = 0; index < 8; index++) await Promise.resolve();
      const pending = store.get(session)?.closePromise;
      if (!pending) throw new Error('expected pending close');

      let next!: CmuxSessionLifecycle;
      const created = pending.then(() =>
        next.onSessionCreated({
          type: 'session.created',
          properties: { info: { id: session, parentID: 'p' } },
        }),
      );
      const newMux = multiplexer();
      newMux.closePane.mockResolvedValue(false);
      next = new CmuxSessionLifecycle(
        'new',
        newMux,
        () => 'http://server',
        '/repo',
        undefined,
        { closeRetryMaxAttempts: 1, isServerRunning: async () => true },
      );
      await next.onSessionStatus({ type: 'session.status' });
      expect(newMux.closePane).not.toHaveBeenCalled();

      close.resolve(result);
      await created;
      for (let index = 0; index < 8; index++) await Promise.resolve();
      expect(oldMux.closePane).toHaveBeenCalledTimes(1);
      if (result) {
        expect(newMux.closePane).not.toHaveBeenCalled();
        expect(store.get(session)).toBeUndefined();
      } else {
        expect(newMux.closePane).toHaveBeenCalledTimes(1);
        expect(newMux.closePane).toHaveBeenCalledWith(`pane-${result}`);
        expect(store.get(session)).toMatchObject({
          owner: 'new',
          paneId: `pane-${result}`,
          closeIntent: { phase: 'cooldown' },
        });
      }
      await next.cleanup();
      await old.cleanup();
    });
  }

  test('older observer cannot claim a newer owner late pane', async () => {
    const oldMux = multiplexer();
    oldMux.closePane.mockResolvedValue(false);
    const old = new CmuxSessionLifecycle(
      'old',
      oldMux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        closeRetryMaxAttempts: 1,
        delay: async () => {},
        isServerRunning: async () => true,
      },
    );

    const spawn = deferred<{ success: true; paneId: string }>();
    const newMux = multiplexer();
    newMux.spawnPane.mockImplementationOnce(() => spawn.promise);
    newMux.closePane.mockResolvedValue(false);
    const next = new CmuxSessionLifecycle(
      'new',
      newMux,
      () => 'http://server',
      '/repo',
      undefined,
      {
        isServerRunning: async () => true,
        shutdownTimeoutMs: 1,
      },
    );
    const creating = next.onSessionCreated({
      type: 'session.created',
      properties: { info: { id: 'new-late-owner', parentID: 'p' } },
    });

    await Promise.resolve();
    await next.cleanup();
    spawn.resolve({ success: true, paneId: 'new-owner-pane' });
    await creating;
    for (let index = 0; index < 16; index++) await Promise.resolve();

    expect(newMux.closePane).toHaveBeenCalledWith('new-owner-pane');
    expect(oldMux.closePane).not.toHaveBeenCalled();
    expect(store.get('new-late-owner\0late\0new-owner-pane')).toMatchObject({
      owner: 'new',
      lifecycle: 'orphaned',
    });

    await old.cleanup();
  });

  test('ordinary orphan takeover requires the matching server scope', async () => {
    store.claimCreated({
      session: 'wrong-scope-orphan',
      owner: 'old',
      parent: 'p',
      title: 'agent',
      directory: '/repo',
      serverUrl: 'http://other/',
      paneId: 'wrong-scope-pane',
      spawnState: 'attached',
      lifecycle: 'orphaned',
      lastActivityAt: 0,
      activityVersion: 0,
      idleConsecutive: 0,
    });
    const mux = multiplexer();
    const lifecycle = new CmuxSessionLifecycle(
      'new',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      { isServerRunning: async () => true },
    );
    await lifecycle.onSessionStatus({ type: 'session.status' });
    for (let index = 0; index < 8; index++) await Promise.resolve();

    expect(store.get('wrong-scope-orphan')).toMatchObject({
      owner: 'old',
      paneId: 'wrong-scope-pane',
    });
    expect(mux.closePane).not.toHaveBeenCalled();
    await lifecycle.cleanup();
  });

  test('busy does not clear a claimed orphan close before it settles', async () => {
    const policy = new CmuxClosePolicy(1, 1);
    let exhausted = policy.request('cleanup', 0, 0);
    exhausted = policy.failed(exhausted, 1);
    exhausted = policy.failed(policy.resume(exhausted, 30_001), 30_002);
    exhausted = policy.failed(policy.resume(exhausted, 90_002), 90_003);

    store.claimCreated({
      session: 'busy-orphan',
      owner: 'old',
      parent: 'p',
      title: 'agent',
      directory: '/repo',
      serverUrl: 'http://server/',
      paneId: 'busy-orphan-pane',
      spawnState: 'attached',
      lifecycle: 'orphaned',
      lastActivityAt: 0,
      activityVersion: 0,
      idleConsecutive: 0,
      closeIntent: exhausted,
    });

    const close = deferred<boolean>();
    const mux = multiplexer();
    mux.closePane.mockImplementationOnce(() => close.promise);
    const lifecycle = new CmuxSessionLifecycle(
      'new',
      mux,
      () => 'http://server',
      '/repo',
      undefined,
      { isServerRunning: async () => true },
    );
    await lifecycle.onSessionStatus({ type: 'session.status' });
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(mux.closePane).toHaveBeenCalledTimes(1);

    await lifecycle.onSessionStatus({
      type: 'session.status',
      properties: { sessionID: 'busy-orphan', status: { type: 'busy' } },
    });
    expect(store.get('busy-orphan')).toMatchObject({
      owner: 'new',
      lifecycle: 'orphaned',
      paneId: 'busy-orphan-pane',
    });
    expect(store.get('busy-orphan')?.closeIntent).toMatchObject({
      reason: 'cleanup',
      phase: 'pending',
    });

    close.resolve(false);
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(mux.closePane).toHaveBeenCalledTimes(1);
    expect(store.get('busy-orphan')).toMatchObject({
      lifecycle: 'orphaned',
      paneId: 'busy-orphan-pane',
    });
    await lifecycle.cleanup();
  });

  for (const result of [true, false]) {
    test(`cleanup close timeout retains an existing close until ${result ? 'success' : 'retry'}`, async () => {
      const mux = multiplexer();
      const close = deferred<boolean>();
      mux.closePane.mockImplementationOnce(() => close.promise);
      const lifecycle = new CmuxSessionLifecycle(
        'owner',
        mux,
        () => 'http://server',
        '/repo',
        undefined,
        {
          closeRetryMs: 0,
          isServerRunning: async () => true,
          shutdownTimeoutMs: 1,
        },
      );

      await lifecycle.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'cleanup-existing', parentID: 'p' } },
      });
      const deleting = lifecycle.onSessionDeleted({
        type: 'session.deleted',
        properties: { sessionID: 'cleanup-existing' },
      });
      for (let index = 0; index < 8; index++) await Promise.resolve();

      const beforeCleanup = store.get('cleanup-existing');
      const closePromise = beforeCleanup?.closePromise;
      expect(closePromise).toBeDefined();
      expect(mux.closePane).toHaveBeenCalledTimes(1);

      await lifecycle.cleanup();

      const retained = store.get('cleanup-existing');
      expect(retained).toBe(beforeCleanup);
      expect(retained).toMatchObject({ paneId: 'pane' });
      expect(retained?.closePromise).toBe(closePromise);
      expect(mux.closePane).toHaveBeenCalledTimes(1);

      close.resolve(result);
      await deleting;
      if (result) {
        expect(store.get('cleanup-existing')).toBeUndefined();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(mux.closePane).toHaveBeenCalledTimes(2);
        expect(store.get('cleanup-existing')).toBeUndefined();
      }
    });
  }

  for (const settlement of ['false', 'reject'] as const) {
    test(`cleanup timeout retries a cleanup-started close after ${settlement}`, async () => {
      const mux = multiplexer();
      const close = deferred<boolean>();
      mux.closePane
        .mockImplementationOnce(() => close.promise)
        .mockResolvedValueOnce(true);
      const lifecycle = new CmuxSessionLifecycle(
        'owner',
        mux,
        () => 'http://server',
        '/repo',
        undefined,
        {
          closeRetryMs: 0,
          isServerRunning: async () => true,
          shutdownTimeoutMs: 1,
        },
      );
      const session = `cleanup-pending-${settlement}`;

      await lifecycle.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: session, parentID: 'p' } },
      });
      await lifecycle.cleanup();

      const retained = store.get(session);
      expect(mux.closePane).toHaveBeenCalledTimes(1);
      expect(retained).toMatchObject({
        paneId: 'pane',
        lifecycle: 'orphaned',
      });
      expect(retained?.closePromise).toBeDefined();

      if (settlement === 'false') close.resolve(false);
      else close.reject(new Error('cleanup socket'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mux.closePane).toHaveBeenCalledTimes(2);
      expect(mux.closePane).toHaveBeenLastCalledWith('pane');
      expect(store.get(session)).toBeUndefined();
    });
  }

  for (const result of [true, false]) {
    test(`late cleanup ${result ? 'success' : 'failure'} cannot close a new owner twice`, async () => {
      store.claimCreated({
        session: 'cleanup-handoff',
        owner: 'old',
        parent: 'p',
        title: 'agent',
        directory: '/repo',
        serverUrl: 'http://server/',
        paneId: 'shared-pane',
        spawnState: 'attached',
        lifecycle: 'active',
        lastActivityAt: 0,
        activityVersion: 0,
        idleConsecutive: 0,
      });
      const oldMux = multiplexer();
      const close = deferred<boolean>();
      oldMux.closePane.mockImplementationOnce(() => close.promise);
      const old = new CmuxSessionLifecycle(
        'old',
        oldMux,
        () => 'http://server',
        '/repo',
        undefined,
        { shutdownTimeoutMs: 1 },
      );

      await old.cleanup();
      const pending = store.get('cleanup-handoff');
      expect(pending).toMatchObject({
        owner: 'old',
        paneId: 'shared-pane',
        lifecycle: 'orphaned',
      });
      expect(oldMux.closePane).toHaveBeenCalledTimes(1);

      const newMux = multiplexer();
      newMux.closePane.mockResolvedValue(true);
      const next = new CmuxSessionLifecycle(
        'new',
        newMux,
        () => 'http://server',
        '/repo',
      );
      await next.onSessionStatus({ type: 'session.status' });
      await next.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'cleanup-handoff', parentID: 'p' },
        },
      });

      expect(store.get('cleanup-handoff')).toBe(pending);
      expect(store.get('cleanup-handoff')).toMatchObject({
        owner: 'new',
        paneId: 'shared-pane',
      });
      expect(newMux.closePane).not.toHaveBeenCalled();

      close.resolve(result);
      for (let index = 0; index < 16; index++) await Promise.resolve();

      expect(oldMux.closePane).toHaveBeenCalledTimes(1);
      if (result) {
        expect(store.get('cleanup-handoff')).toBeUndefined();
      } else {
        expect(newMux.closePane).toHaveBeenCalledTimes(1);
        expect(newMux.closePane).toHaveBeenCalledWith('shared-pane');
        expect(store.get('cleanup-handoff')).toBeUndefined();
      }
      await next.cleanup();
    });
  }
});
