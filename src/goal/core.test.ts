import { afterAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createGoalRuntime,
  type GoalCommands,
  GoalLifecycleError,
  type GoalRecord,
  GoalRevisionConflictError,
  type GoalRuntimeObserver,
  GoalStateCorruptError,
  GoalStateVersionConflictError,
  GoalStore,
  type RuntimeBindingIdentity,
} from './index';

const roots: string[] = [];

function testCore(sessionID = 'session-1'): {
  core: GoalCommands;
  observer: GoalRuntimeObserver;
  root: string;
  store: GoalStore;
} {
  const root = mkdtempSync(join(tmpdir(), 'omos-goal-'));
  roots.push(root);
  let nextID = 1;
  const runtime = createGoalRuntime(sessionID, {
    root,
    idGenerator: () => `goal-${nextID++}`,
  });
  return {
    core: runtime.commands,
    observer: runtime.observer,
    store: new GoalStore(sessionID, { root }),
    root,
  };
}

function binding(
  goal: GoalRecord,
  boardGeneration: number,
  taskID = 'task-1',
  boardRunID = 'run-1',
): RuntimeBindingIdentity {
  return {
    goalID: goal.id,
    sessionGeneration: goal.sessionGeneration,
    revision: goal.revision,
    boardRunID,
    taskID,
    boardGeneration,
  };
}

async function createGoal(core: GoalCommands): Promise<GoalRecord> {
  return core.create({
    objective: 'objective',
    requiredCriteria: ['criterion'],
  });
}

async function completeBinding(
  observer: GoalRuntimeObserver,
  identity: RuntimeBindingIdentity,
): Promise<void> {
  await startRun(observer, identity.boardRunID);
  await observer.bindRuntimeTask({ ...identity, status: 'running' });
  await observer.assignRuntimeVerification({
    ...identity,
    criterionID: 'criterion-1',
  });
  await observer.updateRuntimeBinding({ ...identity, status: 'completed' });
  await observer.reconcileRuntimeBinding(identity);
}

async function startRun(
  observer: GoalRuntimeObserver,
  boardRunID = 'run-1',
): Promise<void> {
  await observer.rehydrateBoardRun({
    boardRunID,
    expected: observer.boardRunFence(),
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for child process signal: ${path}`);
}

function writeLockDirectory(
  lockPath: string,
  metadata: { pid: number; acquiredAt: number; token: string },
  stale = false,
): void {
  mkdirSync(lockPath, { recursive: true });
  const ownerPath = join(lockPath, 'owner.json');
  writeFileSync(ownerPath, JSON.stringify(metadata));
  if (stale) {
    const staleAt = new Date(metadata.acquiredAt);
    utimesSync(ownerPath, staleAt, staleAt);
    utimesSync(lockPath, staleAt, staleAt);
  }
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe('GoalCore', () => {
  test('aborts a queued creation when its owning session is disposed', async () => {
    const { root, store } = testCore();
    const controller = new AbortController();
    const commands = createGoalRuntime('session-1', {
      root,
      signal: controller.signal,
    }).commands;
    const pending = commands.createIfAbsent({
      objective: 'late objective',
      requiredCriteria: ['verified'],
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(store.read().goal).toBeNull();
  });

  test('does not complete before a second assigned verifier verdict is consumed', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    await startRun(observer);
    const first = binding(goal, 1, 'first-verifier');
    const last = binding(goal, 1, 'last-verifier');
    for (const task of [first, last]) {
      await observer.bindRuntimeTask({ ...task, status: 'running' });
      await observer.assignRuntimeVerification({
        ...task,
        criterionID: 'criterion-1',
      });
    }
    await observer.updateRuntimeBinding({ ...first, status: 'completed' });
    await observer.reconcileRuntimeBinding(first);
    await observer.recordRuntimeEvidence({
      ...first,
      criterionID: 'criterion-1',
      passed: true,
    });
    await observer.updateRuntimeBinding({ ...last, status: 'completed' });
    await observer.reconcileRuntimeBinding(last);
    expect(core.status()?.status).toBe('active');
    await observer.recordRuntimeEvidence({
      ...last,
      criterionID: 'criterion-1',
      passed: false,
      contradicts: true,
    });
    expect(core.readSnapshot()).toMatchObject({
      goal: { status: 'active', progress: { verified: 0 } },
    });
  });

  test('audits paused evidence on resume and retains completion proof after restart', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    const task = binding(goal, 1);
    await completeBinding(observer, task);
    await core.pause();
    await observer.recordRuntimeEvidence({
      ...task,
      criterionID: 'criterion-1',
      passed: true,
    });
    expect(core.status()?.status).toBe('paused');
    await core.resume();
    expect(core.status()?.status).toBe('completed');
    await startRun(observer, 'run-2');
    expect(core.readSnapshot()).toMatchObject({
      goal: {
        status: 'completed',
        progress: { verified: 1, total: 1, percent: 100 },
      },
    });
    expect(core.renderGoalContext().continuation.reason).toBe('completed');
    await expect(
      observer.recordRuntimeEvidence({
        ...task,
        criterionID: 'criterion-1',
        passed: false,
      }),
    ).rejects.toThrow();
  });

  test('creates at most once across separate runtimes sharing one store', async () => {
    const { core, root } = testCore();
    const other = createGoalRuntime('session-1', { root }).commands;
    const results = await Promise.all(
      [core, other].map((commands, index) =>
        commands.createIfAbsent({
          objective: `objective ${index}`,
          requiredCriteria: ['verified'],
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(core.status()?.id).toBe(other.status()?.id);
  });

  test('rehydrates durable state and returns cloned reads', async () => {
    const { core, root } = testCore();
    await core.create({
      objective: 'Ship the feature',
      requiredCriteria: ['Tests pass'],
    });

    const first = core.status();
    expect(first?.objective).toBe('Ship the feature');
    if (first) first.objective = 'mutated in memory';

    const rehydrated = createGoalRuntime('session-1', { root }).commands;
    expect(rehydrated.status()?.objective).toBe('Ship the feature');
  });

  test('createIfAbsent does not overwrite any existing Goal lifecycle state', async () => {
    const input = {
      objective: 'Automatically created objective',
      requiredCriteria: ['Automatically created criterion'],
    };

    const active = testCore('create-if-absent-active');
    const activeGoal = await createGoal(active.core);

    const paused = testCore('create-if-absent-paused');
    const pausedGoal = await createGoal(paused.core);
    await paused.core.pause();

    const completed = testCore('create-if-absent-completed');
    const completedGoal = await createGoal(completed.core);
    const completedTask = binding(completedGoal, 1);
    await completeBinding(completed.observer, completedTask);
    await completed.observer.recordRuntimeEvidence({
      ...completedTask,
      criterionID: 'criterion-1',
      passed: true,
    });

    const cancelled = testCore('create-if-absent-cancelled');
    const cancelledGoal = await createGoal(cancelled.core);
    await cancelled.core.clear();

    for (const [core, goal] of [
      [active.core, activeGoal],
      [paused.core, pausedGoal],
      [completed.core, completedGoal],
      [cancelled.core, cancelledGoal],
    ] as const) {
      await expect(core.createIfAbsent(input)).resolves.toBeNull();
      expect(core.status()?.id).toBe(goal.id);
    }
  });

  test('createIfAbsent serializes concurrent callers to one creation', async () => {
    const { core } = testCore('create-if-absent-concurrent');
    const input = {
      objective: 'Automatically created objective',
      requiredCriteria: ['Automatically created criterion'],
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => core.createIfAbsent(input)),
    );
    const created = results.filter(
      (result): result is GoalRecord => result !== null,
    );

    expect(created).toHaveLength(1);
    expect(core.status()).toMatchObject({
      id: created[0]?.id,
      objective: input.objective,
    });
  });

  test('explicit create still replaces a terminal Goal after createIfAbsent declines', async () => {
    const { core } = testCore('create-if-absent-explicit-replacement');
    const original = await createGoal(core);
    await core.clear();

    await expect(
      core.createIfAbsent({
        objective: 'Automatic replacement',
        requiredCriteria: ['Automatic criterion'],
      }),
    ).resolves.toBeNull();

    const replacement = await core.create({
      objective: 'Explicit replacement',
      requiredCriteria: ['Explicit criterion'],
    });
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.objective).toBe('Explicit replacement');
  });

  test('fails closed for malformed and Zod-invalid durable data', () => {
    const { core, store } = testCore();
    mkdirSync(dirname(store.statePath), { recursive: true });
    writeFileSync(store.statePath, '{not-json');
    expect(() => core.status()).toThrow(GoalStateCorruptError);

    writeFileSync(
      store.statePath,
      '{"version":4,"sessionGeneration":0,"boardRunID":null,"boardRunGeneration":0,"retiredBoardRunIDs":[],"goal":{"objective":""}}',
    );
    expect(() => core.status()).toThrow(GoalStateCorruptError);
  });

  test('retires known pre-v4 state into a versioned backup without importing evidence', () => {
    const { store } = testCore();
    mkdirSync(dirname(store.statePath), { recursive: true });
    const legacy = JSON.stringify({
      version: 3,
      goal: { evidence: ['legacy'] },
    });
    writeFileSync(store.statePath, legacy, 'utf8');
    expect(store.read()).toMatchObject({ version: 4, goal: null });
    expect(readFileSync(`${store.statePath}.v3.backup`, 'utf8')).toBe(legacy);
  });

  test('fails closed without mutating legacy state when migration is disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-'));
    roots.push(root);

    for (const version of [1, 2, 3]) {
      const sessionID = `legacy-v${version}`;
      const store = new GoalStore(sessionID, { root });
      mkdirSync(dirname(store.statePath), { recursive: true });
      const legacy = JSON.stringify({
        version,
        goal: { evidence: [`legacy-v${version}`] },
      });
      writeFileSync(store.statePath, legacy, 'utf8');
      const entriesBefore = readdirSync(dirname(store.statePath)).sort();
      const runtime = createGoalRuntime(sessionID, {
        root,
        migrateLegacyOnRead: false,
      });

      expect(() => runtime.commands.readSnapshot()).toThrow(
        GoalStateCorruptError,
      );
      expect(readFileSync(store.statePath, 'utf8')).toBe(legacy);
      expect(existsSync(`${store.statePath}.v${version}.backup`)).toBe(false);
      expect(existsSync(`${store.statePath}.lock`)).toBe(false);
      expect(readdirSync(dirname(store.statePath)).sort()).toEqual(
        entriesBefore,
      );
    }
  });

  test('reads current state through a live lock without modifying files', async () => {
    const { core, root, store } = testCore('read-only-current');
    await createGoal(core);
    const lockPath = `${store.statePath}.lock`;
    const lock = JSON.stringify({
      pid: process.pid,
      acquiredAt: Date.now(),
      token: 'live-owner',
    });
    writeFileSync(lockPath, lock, 'utf8');
    const state = readFileSync(store.statePath, 'utf8');
    const entriesBefore = readdirSync(dirname(store.statePath)).sort();
    const runtime = createGoalRuntime('read-only-current', {
      root,
      migrateLegacyOnRead: false,
    });

    expect(runtime.commands.readSnapshot()).toMatchObject({ state: 'goal' });
    expect(readFileSync(store.statePath, 'utf8')).toBe(state);
    expect(readFileSync(lockPath, 'utf8')).toBe(lock);
    expect(readdirSync(dirname(store.statePath)).sort()).toEqual(entriesBefore);
  });

  test('reads missing state without creating storage directories', () => {
    const parent = mkdtempSync(join(tmpdir(), 'omos-goal-'));
    roots.push(parent);
    const root = join(parent, 'missing-data-root');
    const runtime = createGoalRuntime('read-only-missing', {
      root,
      migrateLegacyOnRead: false,
    });

    expect(runtime.commands.readSnapshot()).toEqual({
      apiVersion: 1,
      state: 'no-goal',
    });
    expect(existsSync(root)).toBe(false);
  });

  test('fails closed for malformed lock contents without reclaiming them', async () => {
    const { core, store } = testCore();
    const lockPath = `${store.statePath}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '{not-a-lock');

    await expect(createGoal(core)).rejects.toMatchObject({
      name: 'GoalStateLockError',
      reason: 'malformed',
    });
    expect(readFileSync(lockPath, 'utf8')).toBe('{not-a-lock');
  });

  test('safely recovers a demonstrably stale valid lock', async () => {
    const { core, store } = testCore();
    const lockPath = `${store.statePath}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    const staleAt = new Date(Date.now() - 60_000);
    writeLockDirectory(
      lockPath,
      {
        pid: 0,
        acquiredAt: staleAt.getTime(),
        token: 'dead-owner',
      },
      true,
    );

    await core.create({
      objective: 'recovered',
      requiredCriteria: ['criterion'],
    });
    expect(existsSync(lockPath)).toBe(false);
    expect(
      readdirSync(dirname(lockPath)).some((entry) => entry.includes('.stale.')),
    ).toBe(false);
  });

  test('recovers a stale recovery owner before reclaiming the primary lock', async () => {
    const { core, store } = testCore();
    const lockPath = `${store.statePath}.lock`;
    writeLockDirectory(
      lockPath,
      { pid: 2_147_483_647, acquiredAt: 1, token: 'stale-primary' },
      true,
    );
    writeLockDirectory(
      `${lockPath}.recovery`,
      { pid: 2_147_483_647, acquiredAt: 1, token: 'stale-recovery' },
      true,
    );

    await expect(createGoal(core)).resolves.toMatchObject({ status: 'active' });
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.recovery`)).toBe(false);
  });

  test('fails closed for malformed lock directories', async () => {
    const { core, store } = testCore();
    const lockPath = `${store.statePath}.lock`;
    mkdirSync(lockPath, { recursive: true });

    await expect(createGoal(core)).rejects.toMatchObject({
      name: 'GoalStateLockError',
      reason: 'malformed',
    });
    expect(existsSync(lockPath)).toBe(true);
  });

  test('does not reclaim a replacement while recovery authority is held', async () => {
    const { root } = testCore();
    const store = new GoalStore('session-1', { root, lockTimeoutMs: 50 });
    const lockPath = `${store.statePath}.lock`;
    const staleAt = Date.now() - 60_000;
    writeLockDirectory(
      lockPath,
      { pid: 0, acquiredAt: staleAt, token: 'stale-owner' },
      true,
    );
    mkdirSync(`${lockPath}.recovery`);
    rmSync(lockPath, { recursive: true });
    const replacement = {
      pid: process.pid,
      acquiredAt: Date.now(),
      token: 'fresh-owner',
    };
    writeLockDirectory(lockPath, replacement);

    await expect(store.update(undefined, () => {})).rejects.toMatchObject({
      name: 'GoalStateLockError',
      reason: 'timeout',
    });
    expect(readFileSync(join(lockPath, 'owner.json'), 'utf8')).toBe(
      JSON.stringify(replacement),
    );
  });

  test('does not write or unlink a replaced lock', async () => {
    const { store } = testCore();
    const lockPath = `${store.statePath}.lock`;
    const replacement = JSON.stringify({
      pid: process.pid,
      acquiredAt: Date.now(),
      token: 'replacement-owner',
    });

    await expect(
      store.update(undefined, () => {
        writeFileSync(lockPath, replacement);
      }),
    ).rejects.toMatchObject({
      name: 'GoalStateLockError',
      reason: 'ownership-lost',
    });
    expect(readFileSync(lockPath, 'utf8')).toBe(replacement);
    expect(existsSync(store.statePath)).toBe(false);
  });

  test('rejects empty objectives and criteria', async () => {
    const { core } = testCore();
    await expect(
      core.create({ objective: ' ', requiredCriteria: ['criterion'] }),
    ).rejects.toThrow();
    await expect(
      core.create({ objective: 'objective', requiredCriteria: [' '] }),
    ).rejects.toThrow();
  });

  test('persists and returns schema-normalized generated identifiers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-'));
    roots.push(root);
    const runtime = createGoalRuntime('session-normalized', {
      root,
      idGenerator: () => '  goal-normalized  ',
    });

    const created = await createGoal(runtime.commands);
    expect(created.id).toBe('goal-normalized');
    expect(runtime.commands.status()?.id).toBe('goal-normalized');
  });

  test('fences reused task IDs by board generation', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    const generationOne = binding(goal, 1);
    await completeBinding(observer, generationOne);

    const generationTwo = binding(goal, 2);
    await observer.bindRuntimeTask({ ...generationTwo, status: 'running' });

    const bindings = core.status()?.bindings ?? [];
    expect(bindings).toHaveLength(2);
    expect(bindings[0]?.superseded).toBe(true);
    expect(bindings[1]).toMatchObject({
      boardGeneration: 2,
      reconciled: false,
      superseded: false,
    });
    await expect(
      observer.updateRuntimeBinding({ ...generationOne, status: 'completed' }),
    ).rejects.toThrow(GoalRevisionConflictError);
    await expect(
      observer.bindRuntimeTask({ ...generationOne, status: 'running' }),
    ).rejects.toThrow(GoalRevisionConflictError);
    await expect(
      observer.recordRuntimeEvidence({
        ...generationOne,
        criterionID: 'criterion-1',
        passed: true,
      }),
    ).rejects.toThrow(GoalRevisionConflictError);
  });

  test('rejects stale session-incarnation runtime events without a CAS token', async () => {
    const { core, observer } = testCore();
    await createGoal(core);
    await startRun(observer);
    const current = await core.clear();
    const recreated = await createGoal(core);
    const staleSessionIdentity = {
      ...binding(recreated, 1),
      sessionGeneration: current.sessionGeneration,
    };

    await expect(
      observer.bindRuntimeTask({ ...staleSessionIdentity, status: 'running' }),
    ).rejects.toThrow(GoalRevisionConflictError);
  });

  test('invalidates prior board-run evidence and rebinds reused task generations', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    const priorRun = binding(goal, 1, 'task-1', 'run-1');
    await completeBinding(observer, priorRun);
    await observer.recordRuntimeEvidence({
      ...priorRun,
      criterionID: 'criterion-1',
      passed: false,
    });

    await startRun(observer, 'run-2');
    expect(core.status()?.bindings[0]?.superseded).toBe(true);
    expect(core.status()?.evidence[0]?.superseded).toBe(true);
    await expect(
      observer.recordRuntimeEvidence({
        ...priorRun,
        criterionID: 'criterion-1',
        passed: true,
      }),
    ).rejects.toThrow(GoalRevisionConflictError);

    const restartedRun = binding(goal, 1, 'task-1', 'run-2');
    await completeBinding(observer, restartedRun);
    await observer.recordRuntimeEvidence({
      ...restartedRun,
      criterionID: 'criterion-1',
      passed: true,
    });
    expect(core.status()?.status).toBe('completed');
  });

  test('allows a lower task generation after a board-run restart', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    const priorRun = binding(goal, 9, 'task-1', 'run-1');
    await completeBinding(observer, priorRun);

    await startRun(observer, 'run-2');
    await expect(
      observer.bindRuntimeTask({ ...priorRun, status: 'running' }),
    ).rejects.toThrow(GoalRevisionConflictError);
    await expect(observer.reconcileRuntimeBinding(priorRun)).rejects.toThrow(
      GoalRevisionConflictError,
    );
    await expect(
      observer.recordRuntimeEvidence({
        ...priorRun,
        criterionID: 'criterion-1',
        passed: true,
      }),
    ).rejects.toThrow(GoalRevisionConflictError);

    const restartedRun = binding(goal, 1, 'task-1', 'run-2');
    await completeBinding(observer, restartedRun);
    await observer.recordRuntimeEvidence({
      ...restartedRun,
      criterionID: 'criterion-1',
      passed: true,
    });
    expect(core.status()?.status).toBe('completed');
  });

  test('rejects stale board-run transitions and run-1 runtime events after run-2', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    await startRun(observer, 'run-1');
    const runOneFence = observer.boardRunFence();
    const runOneTask = binding(goal, 1, 'task-1', 'run-1');
    await completeBinding(observer, runOneTask);
    await observer.recordRuntimeEvidence({
      ...runOneTask,
      criterionID: 'criterion-1',
      passed: false,
    });

    await startRun(observer, 'run-2');
    const runTwoTask = binding(goal, 1, 'task-1', 'run-2');
    await observer.bindRuntimeTask({ ...runTwoTask, status: 'running' });
    await expect(
      observer.rehydrateBoardRun({
        boardRunID: 'run-1',
        expected: runOneFence,
      }),
    ).rejects.toThrow(GoalRevisionConflictError);
    await expect(
      observer.rehydrateBoardRun({
        boardRunID: 'run-1',
        expected: observer.boardRunFence(),
      }),
    ).rejects.toThrow(GoalRevisionConflictError);
    await expect(
      observer.recordRuntimeEvidence({
        ...runOneTask,
        criterionID: 'criterion-1',
        passed: true,
      }),
    ).rejects.toThrow(GoalRevisionConflictError);

    const activeBindings = core
      .status()
      ?.bindings.filter((item) => !item.superseded);
    expect(activeBindings).toHaveLength(1);
    expect(activeBindings?.[0]?.boardRunID).toBe('run-2');
    expect(core.status()?.status).toBe('active');
  });

  test('does not expose authoritative evidence methods on the command surface', () => {
    const { core, observer } = testCore();
    expect('store' in core).toBe(false);
    expect('runtimeBindRuntimeTask' in core).toBe(false);
    expect('recordRuntimeEvidence' in core).toBe(false);
    expect('reconcileRuntimeBinding' in core).toBe(false);
    expect(typeof observer.recordRuntimeEvidence).toBe('function');
  });

  test('fences stale revisions and valid superseded evidence', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    const oldBinding = binding(goal, 1);
    await completeBinding(observer, oldBinding);
    await observer.recordRuntimeEvidence({
      ...oldBinding,
      criterionID: 'criterion-1',
      passed: false,
    });
    expect(core.status()?.status).toBe('active');

    const revised = await core.revise({
      objective: 'revised',
      requiredCriteria: ['criterion'],
    });
    expect(revised.bindings[0]?.superseded).toBe(true);
    await expect(
      observer.recordRuntimeEvidence({
        ...oldBinding,
        criterionID: 'criterion-1',
        passed: true,
      }),
    ).rejects.toThrow(GoalRevisionConflictError);
  });

  test('rejects premature reconciliation and lifecycle regressions', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    const task = binding(goal, 1);
    await startRun(observer);
    await observer.bindRuntimeTask({ ...task, status: 'running' });
    await observer.assignRuntimeVerification({
      ...task,
      criterionID: 'criterion-1',
    });
    await expect(observer.reconcileRuntimeBinding(task)).rejects.toThrow(
      GoalLifecycleError,
    );

    await observer.updateRuntimeBinding({ ...task, status: 'completed' });
    await expect(
      observer.updateRuntimeBinding({ ...task, status: 'running' }),
    ).rejects.toThrow(GoalLifecycleError);
  });

  test('requires evidence from a reconciled terminal binding to complete', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    const task = binding(goal, 1);
    await startRun(observer);
    await observer.bindRuntimeTask({ ...task, status: 'running' });
    await observer.assignRuntimeVerification({
      ...task,
      criterionID: 'criterion-1',
    });
    await expect(
      observer.recordRuntimeEvidence({
        ...task,
        criterionID: 'criterion-1',
        passed: true,
      }),
    ).rejects.toThrow(GoalLifecycleError);
    await expect(
      observer.recordRuntimeEvidence({
        ...task,
        taskID: 'unbound-task',
        criterionID: 'criterion-1',
        passed: true,
      }),
    ).rejects.toThrow(GoalRevisionConflictError);

    await observer.updateRuntimeBinding({ ...task, status: 'completed' });
    expect(core.status()?.status).toBe('active');
    await observer.reconcileRuntimeBinding(task);
    expect(core.status()?.status).toBe('active');
    await observer.recordRuntimeEvidence({
      ...task,
      criterionID: 'criterion-1',
      passed: true,
    });
    expect(core.status()?.status).toBe('completed');
  });

  test('rejects evidence without an explicit verification assignment', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    const task = binding(goal, 1);
    await startRun(observer);
    await observer.bindRuntimeTask({ ...task, status: 'running' });
    await observer.updateRuntimeBinding({ ...task, status: 'completed' });
    await observer.reconcileRuntimeBinding(task);

    await expect(
      observer.recordRuntimeEvidence({
        ...task,
        criterionID: 'criterion-1',
        passed: true,
      }),
    ).rejects.toThrow('explicit Goal verification assignment');
    expect(core.status()).toMatchObject({ status: 'active', evidence: [] });
  });

  test('records one idempotent verdict per verification assignment', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    const task = binding(goal, 1);
    await completeBinding(observer, task);
    const verdict = {
      ...task,
      criterionID: 'criterion-1',
      passed: false,
      contradicts: true,
    };

    await observer.recordRuntimeEvidence(verdict);
    await observer.recordRuntimeEvidence(verdict);
    expect(core.status()?.evidence).toHaveLength(1);
    await expect(
      observer.recordRuntimeEvidence({
        ...verdict,
        passed: true,
        contradicts: false,
      }),
    ).rejects.toThrow(GoalRevisionConflictError);
  });

  test('resolves canonical criterion IDs before ambiguous criterion text', async () => {
    const { core, observer } = testCore();
    const goal = await core.create({
      objective: 'objective',
      requiredCriteria: ['criterion-2', 'actual second criterion'],
    });
    const task = binding(goal, 1);
    await startRun(observer);
    await observer.bindRuntimeTask({ ...task, status: 'running' });
    await observer.assignRuntimeVerification({
      ...task,
      criterionID: 'criterion-2',
    });
    await observer.updateRuntimeBinding({ ...task, status: 'completed' });
    await observer.reconcileRuntimeBinding(task);
    await observer.recordRuntimeEvidence({
      ...task,
      criterionID: 'criterion-2',
      passed: true,
    });

    expect(core.status()?.evidence[0]?.criterionID).toBe('criterion-2');
    expect(core.renderGoalContext().context).toContain(
      '- [pending] criterion-1: criterion-2',
    );
    expect(core.renderGoalContext().context).toContain(
      '- [passing] criterion-2: actual second criterion',
    );
  });

  test('does not render evidence whose binding was superseded', async () => {
    const { core, observer } = testCore();
    const goal = await core.create({
      objective: 'objective',
      requiredCriteria: ['first', 'second'],
    });
    const firstGeneration = binding(goal, 1);
    await startRun(observer);
    await observer.bindRuntimeTask({ ...firstGeneration, status: 'running' });
    await observer.assignRuntimeVerification({
      ...firstGeneration,
      criterionID: 'criterion-1',
    });
    await observer.updateRuntimeBinding({
      ...firstGeneration,
      status: 'completed',
    });
    await observer.reconcileRuntimeBinding(firstGeneration);
    await observer.recordRuntimeEvidence({
      ...firstGeneration,
      criterionID: 'criterion-1',
      passed: true,
    });
    expect(core.renderGoalContext().context).toContain(
      '- [passing] criterion-1: first',
    );

    await observer.bindRuntimeTask({
      ...binding(goal, 2),
      status: 'running',
    });
    expect(core.renderGoalContext().context).toContain(
      '- [pending] criterion-1: first',
    );
  });

  test('readSnapshot projects no-goal and goal state without runtime details', async () => {
    const { core } = testCore();
    expect(core.readSnapshot()).toEqual({ apiVersion: 1, state: 'no-goal' });

    const goal = await core.create({
      objective: 'objective',
      requiredCriteria: ['first', 'second'],
    });
    const snapshot = core.readSnapshot();
    expect(snapshot).toEqual({
      apiVersion: 1,
      state: 'goal',
      goal: {
        id: goal.id,
        objective: 'objective',
        status: 'active',
        revision: 1,
        recordVersion: 0,
        epoch: 0,
        progress: { verified: 0, total: 2, percent: 0 },
        criteria: [
          { id: 'criterion-1', text: 'first', status: 'pending' },
          { id: 'criterion-2', text: 'second', status: 'pending' },
        ],
      },
    });
    if (snapshot.state === 'goal') {
      expect(snapshot.goal).not.toHaveProperty('bindings');
      expect(snapshot.goal).not.toHaveProperty('evidence');
      expect(snapshot.goal).not.toHaveProperty('verificationAssignments');
    }
  });

  test('counts only strict eligible evidence and gives contradictions precedence', async () => {
    const { core, observer, store } = testCore();
    const goal = await core.create({
      objective: 'objective',
      requiredCriteria: ['first', 'second'],
    });
    await startRun(observer);

    const passing = binding(goal, 1, 'task-passing');
    await completeBinding(observer, passing);
    await observer.recordRuntimeEvidence({
      ...passing,
      criterionID: 'criterion-1',
      passed: true,
    });

    const contradictory = binding(goal, 1, 'task-contradictory');
    await completeBinding(observer, contradictory);
    await observer.assignRuntimeVerification({
      ...contradictory,
      criterionID: 'criterion-1',
    });
    await observer.recordRuntimeEvidence({
      ...contradictory,
      criterionID: 'criterion-1',
      passed: false,
      contradicts: true,
    });

    const unassigned = binding(goal, 1, 'task-unassigned');
    await observer.bindRuntimeTask({ ...unassigned, status: 'completed' });
    await observer.reconcileRuntimeBinding(unassigned);
    await store.update(undefined, (state) => {
      if (!state.goal) throw new Error('Expected a goal');
      state.goal.evidence.push({
        ...unassigned,
        criterionID: 'criterion-2',
        passed: true,
        contradicts: false,
        superseded: false,
      });
    });

    expect(core.readSnapshot()).toMatchObject({
      state: 'goal',
      goal: {
        progress: { verified: 0, total: 2, percent: 0 },
        criteria: [
          { id: 'criterion-1', status: 'contradicted' },
          { id: 'criterion-2', status: 'pending' },
        ],
      },
    });
  });

  test('progress counts verified required criteria, not bindings or tasks', async () => {
    const { core, observer } = testCore();
    const goal = await core.create({
      objective: 'objective',
      requiredCriteria: ['first', 'second'],
    });
    await startRun(observer);

    const verified = binding(goal, 1, 'task-verified');
    await completeBinding(observer, verified);
    await observer.recordRuntimeEvidence({
      ...verified,
      criterionID: 'criterion-1',
      passed: true,
    });

    const unverified = binding(goal, 1, 'task-unverified');
    await observer.bindRuntimeTask({ ...unverified, status: 'running' });

    const snapshot = core.readSnapshot();
    expect(snapshot).toMatchObject({
      state: 'goal',
      goal: {
        status: 'active',
        progress: { verified: 1, total: 2, percent: 50 },
        criteria: [
          { id: 'criterion-1', status: 'verified' },
          { id: 'criterion-2', status: 'pending' },
        ],
      },
    });
  });

  test('persists terminal verification observations while paused', async () => {
    const { core, observer } = testCore();
    const goal = await createGoal(core);
    const task = binding(goal, 1);
    await startRun(observer);
    await observer.bindRuntimeTask({ ...task, status: 'running' });
    await observer.assignRuntimeVerification({
      ...task,
      criterionID: 'criterion-1',
    });
    await core.pause();

    await observer.updateRuntimeBinding({ ...task, status: 'completed' });
    await observer.reconcileRuntimeBinding(task);
    await observer.recordRuntimeEvidence({
      ...task,
      criterionID: 'criterion-1',
      passed: true,
    });

    expect(core.status()?.status).toBe('paused');
    expect(core.status()?.evidence).toMatchObject([
      { criterionID: 'criterion-1', passed: true },
    ]);
  });

  test('rejects evidence from failed or cancelled reconciled bindings', async () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const { core, observer } = testCore();
      const goal = await createGoal(core);
      const task = binding(goal, 1);
      await startRun(observer);
      await observer.bindRuntimeTask({ ...task, status: 'running' });
      await observer.assignRuntimeVerification({
        ...task,
        criterionID: 'criterion-1',
      });
      await observer.updateRuntimeBinding({ ...task, status });
      await observer.reconcileRuntimeBinding(task);
      await expect(
        observer.recordRuntimeEvidence({
          ...task,
          criterionID: 'criterion-1',
          passed: true,
        }),
      ).rejects.toThrow(GoalLifecycleError);
      expect(core.status()?.status).toBe('active');
    }
  });

  test('rejects stale expected versions after clear and create', async () => {
    const { core } = testCore();
    await createGoal(core);
    const stale = core.versionCheck();
    if (!stale) throw new Error('Expected a goal version check');

    await core.clear();
    const recreated = await createGoal(core);
    expect(recreated.sessionGeneration).toBe(stale.sessionGeneration + 1);
    await expect(core.pause(stale)).rejects.toThrow(
      GoalStateVersionConflictError,
    );
  });

  test('serializes concurrent updates across core instances', async () => {
    const { core, root } = testCore();
    await createGoal(core);
    const other = createGoalRuntime('session-1', { root }).commands;

    await Promise.all([core.pause(), other.resume()]);

    expect(core.status()).toMatchObject({
      status: 'active',
      recordVersion: 2,
      epoch: 2,
    });
  });

  test('enforces CAS after actual cross-process lock contention', async () => {
    const { core, root } = testCore();
    await createGoal(core);
    const stale = core.versionCheck();
    if (!stale) throw new Error('Expected a goal version check');

    const readyPath = join(root, 'child-ready');
    const storeModuleURL = pathToFileURL(
      resolve(process.cwd(), 'src', 'goal', 'store.ts'),
    ).href;
    const child = Bun.spawn(
      [
        'bun',
        '-e',
        `const { GoalStore } = await import(${JSON.stringify(storeModuleURL)});
const { writeFileSync } = await import('node:fs');
const { GOAL_TEST_ROOT: root, GOAL_TEST_READY: readyPath } = process.env;
if (!root || !readyPath) throw new Error('Missing child test paths');
const store = new GoalStore('session-1', { root });
await store.update(undefined, (state) => {
  writeFileSync(readyPath, 'locked');
  const deadline = Date.now() + 150;
  while (Date.now() < deadline) {}
  if (!state.goal) throw new Error('Expected a goal');
  state.goal.status = 'paused';
  state.goal.recordVersion += 1;
  state.goal.epoch += 1;
});`,
      ],
      {
        env: {
          ...process.env,
          GOAL_TEST_ROOT: root,
          GOAL_TEST_READY: readyPath,
        },
      },
    );

    try {
      await waitForFile(readyPath);
      await expect(core.resume(stale)).rejects.toThrow(
        GoalStateVersionConflictError,
      );
      expect(await child.exited).toBe(0);
    } finally {
      child.kill();
    }
    expect(core.status()?.status).toBe('paused');
  });
});
