import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalRuntime } from './core';
import { createGoalCommandHook } from './v1-command';

describe('V1 goal command', () => {
  test('uses the shared command ownership guard and manages lifecycle only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-command-'));
    const runtime = createGoalRuntime(`goal-command-${crypto.randomUUID()}`, {
      root,
    });
    const userOwnedHook = createGoalCommandHook({
      commandsForSession: async () => runtime.commands,
    });
    const config: Record<string, unknown> = {
      command: { goal: { template: 'owned elsewhere' } },
    };
    userOwnedHook.registerCommand(config);
    expect(config.command).toEqual({ goal: { template: 'owned elsewhere' } });

    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await userOwnedHook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'session-1', arguments: 'Ship it' },
      output,
    );
    expect(output.parts).toEqual([]);
    expect(runtime.commands.status()).toBeNull();

    const hook = createGoalCommandHook({
      commandsForSession: async () => runtime.commands,
    });
    hook.registerCommand({});
    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'session-1', arguments: 'Ship it' },
      output,
    );
    expect(runtime.commands.status()?.objective).toBe('Ship it');
    expect('recordRuntimeEvidence' in runtime.commands).toBe(false);
    rmSync(root, { recursive: true });
  });

  test('renders a command rejection when durable runtime acquisition fails', async () => {
    const hook = createGoalCommandHook({
      commandsForSession: async () => {
        throw new Error('Goal state is locked');
      },
    });
    hook.registerCommand({});
    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'session-1', arguments: 'status' },
      output,
    );
    expect(output.parts[0]?.text).toContain(
      'Goal command rejected: Goal state is locked',
    );
  });

  test('opens the injected panel with the session snapshot reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-command-'));
    const runtime = createGoalRuntime('goal-command-panel', { root });
    let resolveCalls = 0;
    let opened:
      | {
          sessionID: string;
          readSnapshot: typeof runtime.commands.readSnapshot;
        }
      | undefined;
    let notified: string | undefined;
    const hook = createGoalCommandHook({
      commandsForSession: async () => {
        resolveCalls += 1;
        return runtime.commands;
      },
      openPanel: async (input) => {
        opened = input;
        return 'http://127.0.0.1:43210/#capability-secret';
      },
      notifyPanel: async (sessionID) => {
        notified = sessionID;
      },
    });
    hook.registerCommand({});
    const output = { parts: [] as Array<{ type: string; text?: string }> };

    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'session-1', arguments: 'panel' },
      output,
    );

    expect(resolveCalls).toBe(1);
    expect(opened?.sessionID).toBe('session-1');
    expect(opened?.readSnapshot).toBe(runtime.commands.readSnapshot);
    expect(notified).toBe('session-1');
    expect(output.parts[0]?.text).toContain(
      'Goal panel opened in your browser.',
    );
    expect(JSON.stringify(output.parts)).not.toContain('capability-secret');
    expect(runtime.commands.status()).toBeNull();
    rmSync(root, { recursive: true });
  });

  test('rejects panel arguments before resolving or mutating the session', async () => {
    let resolveCalls = 0;
    let openCalls = 0;
    let notifyCalls = 0;
    const hook = createGoalCommandHook({
      commandsForSession: async () => {
        resolveCalls += 1;
        throw new Error('must not resolve');
      },
      openPanel: async () => {
        openCalls += 1;
        return 'http://127.0.0.1:43210/#secret';
      },
      notifyPanel: async () => {
        notifyCalls += 1;
      },
    });
    hook.registerCommand({});
    const output = { parts: [] as Array<{ type: string; text?: string }> };

    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'session-1', arguments: 'panel extra' },
      output,
    );

    expect(resolveCalls).toBe(0);
    expect(openCalls).toBe(0);
    expect(notifyCalls).toBe(0);
    expect(output.parts[0]?.text).toContain(
      'Goal command rejected: /goal panel does not accept arguments.',
    );
  });

  test('keeps legacy status safe when no goal exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-command-'));
    const runtime = createGoalRuntime('goal-command-status', { root });
    const hook = createGoalCommandHook({
      commandsForSession: async () => runtime.commands,
    });
    hook.registerCommand({});
    const output = { parts: [] as Array<{ type: string; text?: string }> };

    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'session-1', arguments: 'status' },
      output,
    );

    expect(output.parts[0]?.text).toContain('Goal: none');
    expect(runtime.commands.status()).toBeNull();
    rmSync(root, { recursive: true });
  });
});
