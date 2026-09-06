import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalRuntime } from './core';
import { createGoalSessionRuntimeResolver } from './v1-runtime';

describe('V1 Goal runtime resolver', () => {
  test('does not cache synchronous initialization failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-runtime-sync-'));
    try {
      let attempts = 0;
      const resolve = createGoalSessionRuntimeResolver({
        runtimes: new Map(),
        boardRunID: 'run',
        createRuntime: (id) => {
          if (++attempts === 1) throw new Error('temporary read failure');
          return createGoalRuntime(id, { root });
        },
      });
      await expect(resolve('session')).rejects.toThrow(
        'temporary read failure',
      );
      await expect(resolve('session')).resolves.toHaveProperty('commands');
      expect(attempts).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('shares concurrent rehydration and retains every concurrent binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-runtime-'));
    try {
      const runtimes = new Map();
      let creations = 0;
      const resolve = createGoalSessionRuntimeResolver({
        runtimes,
        boardRunID: 'board-run-1',
        createRuntime: (sessionID) => {
          creations += 1;
          return createGoalRuntime(sessionID, { root });
        },
      });

      const [first, second, third] = await Promise.all([
        resolve('session-1'),
        resolve('session-1'),
        resolve('session-1'),
      ]);
      expect(creations).toBe(1);
      expect(second).toBe(first);
      expect(third).toBe(first);

      const goal = await first.commands.create({
        objective: 'Ship the fix',
        requiredCriteria: ['The requested objective is completed.'],
      });
      const identity = {
        goalID: goal.id,
        sessionGeneration: goal.sessionGeneration,
        revision: goal.revision,
        boardRunID: 'board-run-1',
      };
      await Promise.all([
        first.observer.bindRuntimeTask({
          ...identity,
          taskID: 'task-1',
          boardGeneration: 1,
          status: 'running',
        }),
        second.observer.bindRuntimeTask({
          ...identity,
          taskID: 'task-2',
          boardGeneration: 1,
          status: 'running',
        }),
      ]);
      expect(
        first.commands
          .status()
          ?.bindings.map((binding) => binding.taskID)
          .sort(),
      ).toEqual(['task-1', 'task-2']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('clears a rejected initialization so a later caller can retry', async () => {
    let attempts = 0;
    const runtime = {
      observer: {
        boardRunFence: () => ({ boardRunID: null, boardRunGeneration: 0 }),
        rehydrateBoardRun: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('locked');
          return null;
        },
      },
    } as never;
    const resolve = createGoalSessionRuntimeResolver({
      runtimes: new Map(),
      boardRunID: 'board-run-1',
      createRuntime: () => runtime,
    });
    await expect(resolve('session-1')).rejects.toThrow('locked');
    await expect(resolve('session-1')).resolves.toBe(runtime);
    expect(attempts).toBe(2);
  });
});
