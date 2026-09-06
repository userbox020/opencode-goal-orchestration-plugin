import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  createGoalRuntime,
  GOAL_AUTO_CREATE_SUPPRESSION_METADATA_KEY,
  GoalStore,
} from './goal';
import type { GoalSessionState } from './goal/schema';
import * as panelModule from './goal/v1-panel';
import {
  createGoalPanelAutoOpenController,
  createV1GoalAutoCreateHandler,
  markGoalAutoCreateSuppressed,
  OhMyOpenCodeLite as plugin,
} from './index';
import { createInternalAgentTextPart } from './utils/internal-initiator';

const realPanelFactory = panelModule.createGoalPanelManager;
let panelFactorySpy: ReturnType<typeof spyOn>;
let testPanelURLs: string[];
beforeEach(() => {
  testPanelURLs = [];
  panelFactorySpy = spyOn(
    panelModule,
    'createGoalPanelManager',
  ).mockImplementation(() =>
    realPanelFactory({
      openBrowser: (url) => {
        testPanelURLs.push(url);
      },
    }),
  );
});
afterEach(() => panelFactorySpy.mockRestore());

function createPluginClient(
  noop: () => Promise<unknown>,
  abort?: (input: { path: { id: string } }) => Promise<unknown>,
) {
  const session = new Proxy(abort ? { abort } : {}, {
    get(target, property) {
      if (property in target) {
        return target[property as keyof typeof target];
      }
      return noop;
    },
  }) as Record<string, unknown>;
  return new Proxy(
    { app: { log: noop }, session },
    {
      get(target, property) {
        if (property in target) {
          return target[property as keyof typeof target];
        }
        return new Proxy({}, { get: () => noop });
      },
    },
  );
}

function createHostTimerHarness() {
  let now = 0;
  let nextID = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const setTimeout = (callback: () => void, delay = 0) => {
    const id = ++nextID;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  const clearTimeout = (id: number) => timers.delete(id);
  const advanceTo = async (target: number) => {
    now = target;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
  };

  return { now: () => now, setTimeout, clearTimeout, advanceTo };
}

describe('plugin env disable', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns empty hooks without reading plugin context', async () => {
    process.env.OH_MY_OPENCODE_SLIM_DISABLE = '1';

    const ctx = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`disabled plugin read ctx.${String(property)}`);
        },
      },
    );

    const hooks = await plugin(ctx as Parameters<typeof plugin>[0]);

    expect(hooks).toEqual({});
    expect(hooks.config).toBeUndefined();
    expect(hooks.event).toBeUndefined();
    expect(hooks.tool).toBeUndefined();
  });
});

describe('V1 Goal panel auto-open transition', () => {
  test('suppresses duplicate opens, resets after a non-Goal message, and honors manual opens', async () => {
    const readSnapshot = () => ({
      apiVersion: 1 as const,
      state: 'no-goal' as const,
    });
    const opens: string[] = [];
    let receivedReader: unknown;
    const controller = createGoalPanelAutoOpenController({
      enabled: true,
      openPanel: async ({ sessionID, readSnapshot: reader }) => {
        opens.push(sessionID);
        receivedReader = reader;
      },
    });

    await controller.openForGoal('goal-panel-session', readSnapshot);
    await controller.openForGoal('goal-panel-session', readSnapshot);
    expect(opens).toEqual(['goal-panel-session']);
    expect(receivedReader).toBe(readSnapshot);

    controller.resetForNonGoal('goal-panel-session');
    await controller.openForGoal('goal-panel-session', readSnapshot);
    expect(opens).toEqual(['goal-panel-session', 'goal-panel-session']);

    controller.clear('goal-panel-session');
    await controller.openForGoal('goal-panel-session', readSnapshot);
    controller.markOpened('goal-panel-session');
    await controller.openForGoal('goal-panel-session', readSnapshot);
    expect(opens).toHaveLength(3);
  });

  test('does not auto-open when Goal is disabled', async () => {
    let opens = 0;
    const controller = createGoalPanelAutoOpenController({
      enabled: false,
      openPanel: async () => {
        opens += 1;
      },
    });

    await controller.openForGoal('v2-session', () => ({}) as never);
    expect(opens).toBe(0);
  });

  test('collapses concurrent Goal opens into one reservation', async () => {
    const readSnapshot = () => ({
      apiVersion: 1 as const,
      state: 'no-goal' as const,
    });
    let opens = 0;
    let releaseOpen: (() => void) | undefined;
    const pendingOpen = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const controller = createGoalPanelAutoOpenController({
      enabled: true,
      openPanel: async () => {
        opens += 1;
        await pendingOpen;
      },
    });

    const first = controller.openForGoal('parallel-goal-session', readSnapshot);
    const second = controller.openForGoal(
      'parallel-goal-session',
      readSnapshot,
    );
    expect(opens).toBe(1);
    releaseOpen?.();
    await Promise.all([first, second]);
    await controller.openForGoal('parallel-goal-session', readSnapshot);
    expect(opens).toBe(1);
  });

  test('allows a post-reset Goal open while an earlier open is pending', async () => {
    const readSnapshot = () => ({
      apiVersion: 1 as const,
      state: 'no-goal' as const,
    });
    const releases: Array<() => void> = [];
    let opens = 0;
    const controller = createGoalPanelAutoOpenController({
      enabled: true,
      openPanel: async () => {
        opens += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
      },
    });

    const first = controller.openForGoal('reset-goal-session', readSnapshot);
    controller.resetForNonGoal('reset-goal-session');
    const second = controller.openForGoal('reset-goal-session', readSnapshot);
    expect(opens).toBe(2);

    releases[0]?.();
    await first;
    const sharedSecond = controller.openForGoal(
      'reset-goal-session',
      readSnapshot,
    );
    expect(sharedSecond).toBe(second);
    expect(opens).toBe(2);

    releases[1]?.();
    await second;
    await controller.openForGoal('reset-goal-session', readSnapshot);
    expect(opens).toBe(2);
  });

  test('clears a failed reservation so a later Goal message can retry', async () => {
    const readSnapshot = () => ({
      apiVersion: 1 as const,
      state: 'no-goal' as const,
    });
    let opens = 0;
    const controller = createGoalPanelAutoOpenController({
      enabled: true,
      openPanel: async () => {
        opens += 1;
        if (opens === 1) throw new Error('panel unavailable');
      },
    });

    await expect(
      controller.openForGoal('failed-goal-session', readSnapshot),
    ).rejects.toThrow('panel unavailable');
    await controller.openForGoal('failed-goal-session', readSnapshot);
    expect(opens).toBe(2);
  });

  test('propagates one shared open failure to concurrent Goal messages before retrying', async () => {
    const readSnapshot = () => ({
      apiVersion: 1 as const,
      state: 'no-goal' as const,
    });
    let opens = 0;
    let rejectOpen: ((error: Error) => void) | undefined;
    const failedOpen = new Promise<void>((_resolve, reject) => {
      rejectOpen = reject;
    });
    const controller = createGoalPanelAutoOpenController({
      enabled: true,
      openPanel: async () => {
        opens += 1;
        if (opens === 1) await failedOpen;
      },
    });

    const first = controller.openForGoal(
      'shared-failure-session',
      readSnapshot,
    );
    const second = controller.openForGoal(
      'shared-failure-session',
      readSnapshot,
    );
    expect(first).toBe(second);
    expect(opens).toBe(1);

    const firstFailure = first.then(
      () => new Error('first unexpectedly succeeded'),
      (error) => error,
    );
    const secondFailure = second.then(
      () => new Error('second unexpectedly succeeded'),
      (error) => error,
    );
    rejectOpen?.(new Error('shared panel failure'));
    expect((await firstFailure).message).toBe('shared panel failure');
    expect((await secondFailure).message).toBe('shared panel failure');

    await controller.openForGoal('shared-failure-session', readSnapshot);
    expect(opens).toBe(2);
  });
});

describe('V1 Goal automatic creation', () => {
  test('shares same-message initialization and discards work resolved after deletion', async () => {
    let release!: (value: never) => void;
    const ready = new Promise<never>((resolve) => {
      release = resolve;
    });
    let created = 0;
    const handler = createV1GoalAutoCreateHandler({
      enabled: true,
      agentForSession: () => 'goal',
      commandsForSession: () => ready,
      openForGoal: async () => {},
      resetForNonGoal: () => {},
      onFailure: () => {},
    });
    const message = {
      sessionID: 'deleted',
      messageID: 'same',
      parts: [{ type: 'text', text: 'objective' }],
    };
    const first = handler.handle(message);
    const second = handler.handle(message);
    expect(first).toBe(second);
    handler.clear('deleted');
    release({
      createIfAbsent: async () => {
        created++;
      },
    } as never);
    await Promise.all([first, second]);
    expect(created).toBe(0);
  });

  test('real hooks preserve command/internal classification and same-turn Goal context', async () => {
    const originalEnv = { ...process.env };
    const root = await mkdtemp('/tmp/omos-goal-real-hooks-');
    let hooks: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      process.env = {
        ...originalEnv,
        XDG_DATA_HOME: root,
        XDG_CONFIG_HOME: root,
        OPENCODE_CONFIG_DIR: root,
      };
      delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
      const client = createPluginClient(async () => ({}));
      client.session.prompt = async (request: {
        body: { agent?: string; parts: unknown[] };
        path: { id: string };
      }) => {
        await hooks?.['chat.message']?.(
          { sessionID: request.path.id, agent: request.body.agent },
          {
            message: {
              id: 'notification',
              sessionID: request.path.id,
              role: 'user',
              agent: request.body.agent ?? 'build',
            },
            parts: request.body.parts,
          },
        );
        return {};
      };
      hooks = await plugin({
        client,
        directory: root,
        worktree: root,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);
      const config: Record<string, unknown> = {};
      await hooks.config?.(config);
      expect(
        (
          config.agent as Record<
            string,
            { permission: Record<string, unknown> }
          >
        ).goal.permission.task_result,
      ).toBe('allow');
      const sessionID = 'real-goal';
      for (const argumentsText of ['status', 'panel']) {
        const output = { parts: [] as Array<{ type: string; text?: string }> };
        await hooks['command.execute.before']?.(
          { command: 'goal', arguments: argumentsText, sessionID },
          output,
        );
        await hooks['chat.message']?.(
          { sessionID, agent: 'goal' },
          {
            message: {
              id: argumentsText,
              role: 'user',
              sessionID,
              agent: 'goal',
            },
            parts: output.parts,
          },
        );
        expect(new GoalStore(sessionID).read().goal).toBeNull();
      }
      const parts = [{ type: 'text', text: 'Create the verified artifact' }];
      await hooks['chat.message']?.(
        { sessionID, agent: 'goal' },
        {
          message: { id: 'real-input', role: 'user', sessionID, agent: 'goal' },
          parts,
        },
      );
      expect(new GoalStore(sessionID).read().goal?.objective).toBe(
        parts[0].text,
      );
      expect(testPanelURLs).toHaveLength(1);
      const message = {
        info: { id: 'real-input', role: 'user', sessionID, agent: 'goal' },
        parts,
      };
      const original = structuredClone(message);
      const output = { messages: [message] as unknown[] };
      await hooks['experimental.chat.messages.transform']?.({}, output);
      expect(message.info).toEqual(original.info);
      expect(message.parts[0]).toEqual(original.parts[0]);
      expect(message.parts).toHaveLength(2);
      expect(message.parts[1]).toMatchObject({ synthetic: true });
      expect(JSON.stringify(output.messages)).toContain('Status: active');
      const system = { system: ['Host policy'] };
      await hooks['experimental.chat.system.transform']?.(
        { sessionID },
        system,
      );
      const once = structuredClone(system);
      await hooks['experimental.chat.system.transform']?.(
        { sessionID },
        system,
      );
      expect(system).toEqual(once);
      expect(system.system[0]).toContain('Goal verification:');
      await hooks['chat.message']?.(
        { sessionID, agent: 'build' },
        {
          message: { id: 'internal', role: 'user', sessionID, agent: 'build' },
          parts: [createInternalAgentTextPart('Notification')],
        },
      );
      await expect(
        hooks.tool?.wait_for_user.execute({ reason: 'Approve next step' }, {
          sessionID,
          agent: 'goal',
        } as never),
      ).resolves.toContain('waiting_for_user');
      await hooks['chat.message']?.(
        { sessionID, agent: 'build' },
        {
          message: {
            id: 'build-input',
            role: 'user',
            sessionID,
            agent: 'build',
          },
          parts,
        },
      );
      await hooks['experimental.chat.messages.transform']?.(
        {},
        { messages: [original] },
      );
      await expect(
        hooks.tool?.wait_for_user.execute({ reason: 'Must remain Build' }, {
          sessionID,
          agent: 'goal',
        } as never),
      ).rejects.toThrow();
      await hooks['chat.message']?.(
        { sessionID, agent: 'goal' },
        {
          message: { id: 'goal-again', role: 'user', sessionID, agent: 'goal' },
          parts,
        },
      );
      expect(testPanelURLs).toHaveLength(2);
      const panel = new URL(testPanelURLs[1]);
      await hooks.event?.({
        event: {
          type: 'session.deleted',
          properties: { info: { id: sessionID } },
        },
      } as never);
      const revoked = await fetch(`${panel.origin}/api/v1/snapshot`, {
        headers: { Authorization: `Bearer ${panel.hash.slice(1)}` },
      });
      expect(revoked.status).toBe(401);
    } finally {
      await hooks?.dispose?.();
      process.env = originalEnv;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('marks command results so status and panel commands cannot auto-create', () => {
    for (const text of ['Goal: none', 'Goal panel opened in your browser.']) {
      const output: {
        parts: Array<{ type: string; text: string; metadata?: unknown }>;
      } = { parts: [{ type: 'text', text }] };
      markGoalAutoCreateSuppressed(output);
      expect(output.parts[0]?.metadata).toEqual({
        [GOAL_AUTO_CREATE_SUPPRESSION_METADATA_KEY]: true,
      });
    }
  });

  test('creates from a classified Goal message, injects active context, and resets panel opening after another agent', async () => {
    const root = await mkdtemp('/tmp/oh-my-opencode-slim-goal-auto-');
    const sessionID = 'goal-auto-session';
    const commands = createGoalRuntime(sessionID, { root }).commands;
    const opened: string[] = [];
    let agent = 'goal';
    const handler = createV1GoalAutoCreateHandler({
      enabled: true,
      commandsForSession: async () => commands,
      agentForSession: () => agent,
      openForGoal: async (id) => {
        opened.push(id);
      },
      resetForNonGoal: () => {
        opened.length = 0;
      },
      onFailure: () => {
        throw new Error('automatic creation should not fail');
      },
    });

    try {
      await handler.handle({
        sessionID,
        messageID: 'first-goal-message',
        parts: [{ type: 'text', text: '  Ship automatic Goal creation  ' }],
      });
      expect(commands.status()).toMatchObject({
        objective: 'Ship automatic Goal creation',
        status: 'active',
      });
      expect(commands.renderGoalContext().context).toContain(
        'Ship automatic Goal creation',
      );
      expect(opened).toEqual([sessionID]);

      await handler.handle({
        sessionID,
        messageID: 'first-goal-message',
        parts: [{ type: 'text', text: 'Duplicate' }],
      });
      expect(opened).toEqual([sessionID]);

      agent = 'orchestrator';
      await handler.handle({
        sessionID,
        messageID: 'non-goal-message',
        parts: [{ type: 'text', text: 'Use another agent' }],
      });
      agent = 'goal';
      await handler.handle({
        sessionID,
        messageID: 'second-goal-message',
        parts: [{ type: 'text', text: 'Do not overwrite the existing Goal' }],
      });
      expect(commands.status()?.objective).toBe('Ship automatic Goal creation');
      expect(opened).toEqual([sessionID]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('suppresses slash-command parts and retries after a creation failure', async () => {
    const root = await mkdtemp('/tmp/oh-my-opencode-slim-goal-auto-retry-');
    const sessionID = 'goal-auto-retry';
    const commands = createGoalRuntime(sessionID, { root }).commands;
    let attempts = 0;
    let failures = 0;
    const handler = createV1GoalAutoCreateHandler({
      enabled: true,
      commandsForSession: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary failure');
        return commands;
      },
      agentForSession: () => 'goal',
      openForGoal: async () => {},
      resetForNonGoal: () => {},
      onFailure: () => {
        failures += 1;
      },
    });

    try {
      for (const text of ['/goal status', '/goal panel']) {
        await handler.handle({
          sessionID,
          messageID: text,
          parts: [
            {
              type: 'text',
              text,
              metadata: { [GOAL_AUTO_CREATE_SUPPRESSION_METADATA_KEY]: true },
            },
          ],
        });
      }
      expect(commands.status()).toBeNull();

      await handler.handle({
        sessionID,
        messageID: 'retry-message',
        parts: [{ type: 'text', text: 'Create after a transient failure' }],
      });
      await handler.handle({
        sessionID,
        messageID: 'retry-message',
        parts: [{ type: 'text', text: 'Create after a transient failure' }],
      });
      expect(failures).toBe(1);
      expect(commands.status()?.objective).toBe(
        'Create after a transient failure',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('retries a failed panel open without replacing the durable Goal', async () => {
    const root = await mkdtemp(
      '/tmp/oh-my-opencode-slim-goal-auto-open-retry-',
    );
    const sessionID = 'goal-auto-open-retry';
    const commands = createGoalRuntime(sessionID, { root }).commands;
    let openAttempts = 0;
    let failures = 0;
    const handler = createV1GoalAutoCreateHandler({
      enabled: true,
      commandsForSession: async () => commands,
      agentForSession: () => 'goal',
      openForGoal: async () => {
        openAttempts += 1;
        if (openAttempts === 1) throw new Error('panel unavailable');
      },
      resetForNonGoal: () => {},
      onFailure: () => {
        failures += 1;
      },
    });

    try {
      await handler.handle({
        sessionID,
        messageID: 'first-message',
        parts: [{ type: 'text', text: 'Create one durable Goal' }],
      });
      const originalID = commands.status()?.id;
      expect(originalID).toBeDefined();

      await handler.handle({
        sessionID,
        messageID: 'retry-message',
        parts: [{ type: 'text', text: 'Do not replace the durable Goal' }],
      });
      expect(failures).toBe(1);
      expect(openAttempts).toBe(2);
      expect(commands.status()?.id).toBe(originalID);
      expect(commands.status()?.objective).toBe('Create one durable Goal');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does nothing when the V1 Goal path is disabled', async () => {
    let commandsCalls = 0;
    let panelCalls = 0;
    const handler = createV1GoalAutoCreateHandler({
      enabled: false,
      commandsForSession: async () => {
        commandsCalls += 1;
        return {} as never;
      },
      agentForSession: () => 'goal',
      openForGoal: async () => {
        panelCalls += 1;
      },
      resetForNonGoal: () => {},
      onFailure: () => {},
    });

    await handler.handle({
      sessionID: 'disabled-goal-session',
      messageID: 'disabled-goal-message',
      parts: [{ type: 'text', text: 'Do not create a Goal' }],
    });
    expect(commandsCalls).toBe(0);
    expect(panelCalls).toBe(0);
  });
});

describe('Goal primary agent V2 gate', () => {
  test('keeps Goal visible in V1 and suppresses it in V2', async () => {
    const originalEnv = { ...process.env };
    const root = await mkdtemp('/tmp/oh-my-opencode-slim-goal-v2-');
    const noop = async () => ({});
    let v1: Awaited<ReturnType<typeof plugin>> | undefined;
    let v2: Awaited<ReturnType<typeof plugin>> | undefined;

    try {
      process.env = {
        ...originalEnv,
        OPENCODE_CONFIG_DIR: root,
        XDG_DATA_HOME: root,
      };
      delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
      await Bun.write(
        `${root}/oh-my-opencode-slim.json`,
        JSON.stringify({
          agents: {
            goal: { model: ['test/goal-primary', 'test/goal-fallback'] },
          },
        }),
      );
      const context = {
        client: createPluginClient(noop),
        directory: root,
        worktree: root,
        serverUrl: new URL('http://127.0.0.1:4096'),
      };
      v1 = await plugin(context as never);
      v2 = await plugin({
        ...context,
        __omosGoalDisabledForV2: true,
      } as never);

      expect(v1.agent?.goal).toBeDefined();
      expect(v2.agent?.goal).toBeUndefined();

      const v1Config: Record<string, unknown> = {};
      await v1.config?.(v1Config);
      expect((v1Config.agent as Record<string, unknown>).goal).toMatchObject({
        model: 'test/goal-primary',
      });

      const v2Config: Record<string, unknown> = {};
      await v2.config?.(v2Config);
      expect((v2Config.agent as Record<string, unknown>).goal).toBeUndefined();

      const sessionID = 'v2-goal-auto-create';
      await v2['chat.message']?.(
        {
          sessionID,
          agent: 'goal',
          messageID: 'v2-goal-message',
          parts: [{ type: 'text', text: 'Do not create a V2 Goal' }],
        },
        {
          message: {
            id: 'v2-goal-message',
            role: 'user',
            agent: 'goal',
            sessionID,
          },
          parts: [{ type: 'text', text: 'Do not create a V2 Goal' }],
        },
      );
      expect(
        new GoalStore(sessionID, { root: `${root}/opencode` }).read().goal,
      ).toBeNull();
    } finally {
      await v2?.dispose?.();
      await v1?.dispose?.();
      process.env = originalEnv;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('plugin tool registration', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    process.env.OPENCODE_CONFIG_DIR =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-config';
    process.env.XDG_CONFIG_HOME =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-xdg';
    process.env.XDG_DATA_HOME =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-data';
    process.env.XDG_CACHE_HOME =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-cache';
    process.env.OPENCODE_LOG_DIR =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-logs';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('preserves shorthand policies through the final MCP config merge', async () => {
    const hooks = await plugin({
      client: createPluginClient(async () => ({})),
      directory: '/private/tmp/oh-my-opencode-slim-permission-project',
      worktree: '/private/tmp/oh-my-opencode-slim-permission-project',
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    try {
      for (const permission of ['ask', 'allow', 'deny']) {
        const config = { agent: { goal: { permission } } };
        await hooks.config?.(config);
        expect(config.agent.goal.permission).toBe(permission);
      }
    } finally {
      await hooks.dispose?.();
    }
  });

  test('registers wait_for_user and recovers a stale orchestrator session mapping', async () => {
    const noop = async () => ({});
    const session = new Proxy({}, { get: () => noop }) as Record<
      string,
      unknown
    >;
    const client = new Proxy(
      { app: { log: noop }, session },
      {
        get(target, property) {
          if (property in target) {
            return target[property as keyof typeof target];
          }
          return new Proxy({}, { get: () => noop });
        },
      },
    );

    const hooks = await plugin({
      client,
      directory: '/private/tmp/oh-my-opencode-slim-hitl-project',
      worktree: '/private/tmp/oh-my-opencode-slim-hitl-project',
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    expect(hooks.tool?.task_status).toBeDefined();
    expect(hooks.tool?.task_result).toBeDefined();
    expect(hooks.tool?.task_message).toBeDefined();
    expect(hooks.tool?.task_cancel).toBeDefined();
    expect(hooks.tool?.task_revive).toBeDefined();
    expect(hooks.tool?.wait_for_user).toBeDefined();
    await expect(
      hooks.tool?.wait_for_user?.execute(
        { reason: 'Complete the external approval.' },
        { sessionID: 'parent-after-reload', agent: 'orchestrator' } as never,
      ),
    ).resolves.toContain('state: waiting_for_user');
  });

  test('exposes an idempotent top-level dispose finalizer', async () => {
    const noop = async () => ({});
    const session = new Proxy({}, { get: () => noop }) as Record<
      string,
      unknown
    >;
    const client = new Proxy(
      { app: { log: noop }, session },
      {
        get(target, property) {
          if (property in target) {
            return target[property as keyof typeof target];
          }
          return new Proxy({}, { get: () => noop });
        },
      },
    );

    const hooks = await plugin({
      client,
      directory: '/private/tmp/oh-my-opencode-slim-dispose-project',
      worktree: '/private/tmp/oh-my-opencode-slim-dispose-project',
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    expect(hooks.dispose).toBeFunction();
    await hooks.dispose?.();
    await hooks.dispose?.();
  });

  test('disposes generation one timers and fresh generation two supervises launches', async () => {
    const originalEnv = { ...process.env };
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalNow = Date.now;
    const clock = createHostTimerHarness();
    const abortCalls: string[] = [];
    const noop = async () => ({});
    const client = createPluginClient(noop, async ({ path }) => {
      abortCalls.push(path.id);
      return {};
    });
    const configDir = await mkdtemp('/tmp/oh-my-opencode-slim-phase-2r-');
    await Bun.write(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        backgroundJobs: {
          wallClockTimeoutMs: 60_000,
          abortGraceMs: 1_000,
        },
      }),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    globalThis.setTimeout = clock.setTimeout as typeof globalThis.setTimeout;
    globalThis.clearTimeout =
      clock.clearTimeout as typeof globalThis.clearTimeout;
    Date.now = clock.now;

    const launch = async (
      hooks: Awaited<ReturnType<typeof plugin>>,
      callID: string,
      taskID: string,
    ) => {
      await hooks['tool.execute.before']?.(
        { tool: 'task', sessionID: 'parent-1', callID },
        {
          args: {
            subagent_type: 'explorer',
            background: true,
            description: taskID,
          },
        },
      );
      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID: 'parent-1', callID },
        {
          output: [
            `task_id: ${taskID}`,
            'state: running',
            '',
            '<task_result>',
            'started',
            '</task_result>',
          ].join('\n'),
        },
      );
    };

    let generationOne: Awaited<ReturnType<typeof plugin>> | undefined;
    let generationTwo: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      generationOne = await plugin({
        client,
        directory: configDir,
        worktree: configDir,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);
      expect(generationOne.dispose).toBeFunction();
      await launch(generationOne, 'call-1', 'child-generation-1');

      await clock.advanceTo(59_999);
      expect(abortCalls).toEqual([]);
      await generationOne.dispose?.();
      await generationOne.dispose?.();
      await clock.advanceTo(60_000);
      expect(abortCalls).toEqual([]);

      generationTwo = await plugin({
        client,
        directory: configDir,
        worktree: configDir,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);
      expect(generationTwo.dispose).toBeFunction();
      await launch(generationTwo, 'call-2', 'child-generation-2');
      await clock.advanceTo(119_999);
      expect(abortCalls).toEqual([]);
      await clock.advanceTo(120_000);
      expect(abortCalls).toEqual(['child-generation-2']);
    } finally {
      await generationTwo?.dispose?.();
      await generationOne?.dispose?.();
      process.env = originalEnv;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      Date.now = originalNow;
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('V1 Goal runtime reconciliation', () => {
  test('does not bind a historical launch already completed in retained history', async () => {
    const originalEnv = { ...process.env };
    const root = await mkdtemp('/tmp/oh-my-opencode-slim-goal-history-');
    const sessionID = 'goal-historical-parent';
    try {
      process.env.XDG_DATA_HOME = root;
      delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
      const noop = async () => ({});
      const hooks = await plugin({
        client: createPluginClient(noop),
        directory: root,
        worktree: root,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);
      await hooks.config?.({});
      await hooks['command.execute.before']?.(
        {
          command: 'goal',
          sessionID,
          arguments: 'Ship the historical binding fix',
        },
        { parts: [] },
      );

      await hooks['experimental.chat.messages.transform']?.(
        {},
        {
          messages: [
            {
              info: { role: 'assistant', sessionID },
              parts: [
                {
                  type: 'tool',
                  tool: 'task',
                  state: {
                    status: 'running',
                    input: {
                      background: true,
                      subagent_type: 'fixer',
                      description: 'stale launch',
                    },
                    output: [
                      'task_id: historical-goal-child',
                      'state: running',
                      '',
                      '<task_result>',
                      'Background task started.',
                      '</task_result>',
                    ].join('\n'),
                  },
                },
              ],
            },
            {
              info: { role: 'user', agent: 'orchestrator', sessionID },
              parts: [
                {
                  type: 'text',
                  synthetic: true,
                  text: [
                    '<task id="historical-goal-child" state="completed">',
                    '<summary>Background task completed: stale launch</summary>',
                    '<task_result>',
                    'done before Goal creation',
                    '</task_result>',
                    '</task>',
                  ].join('\n'),
                },
              ],
            },
            {
              info: { role: 'user', agent: 'orchestrator', sessionID },
              parts: [{ type: 'text', text: 'Continue.' }],
            },
          ],
        },
      );

      expect(new GoalStore(sessionID).read().goal?.bindings).toEqual([]);
      await hooks.dispose?.();
    } finally {
      process.env = originalEnv;
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([false, true])(
    'does not treat an exact-objective task as Goal verification (retry=%s)',
    async (failOnce) => {
      const originalEnv = { ...process.env };
      const root = await mkdtemp('/tmp/oh-my-opencode-slim-goal-runtime-');
      const sessionID = 'goal-parent';
      const prototype = GoalStore.prototype as unknown as {
        write(state: GoalSessionState, token: string): void;
      };
      const originalWrite = prototype.write;
      let failures = 0;
      const writeSpy = spyOn(prototype, 'write').mockImplementation(
        function (state, token) {
          if (failOnce && !failures && state.goal?.evidence.length) {
            failures++;
            throw new Error('temporary persistence failure');
          }
          originalWrite.call(this, state, token);
        },
      );
      try {
        process.env.XDG_DATA_HOME = root;
        delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
        const noop = async () => ({});
        const hooks = await plugin({
          client: createPluginClient(noop),
          directory: root,
          worktree: root,
          serverUrl: new URL('http://127.0.0.1:4096'),
        } as never);
        await hooks.config?.({});

        await hooks['command.execute.before']?.(
          {
            command: 'goal',
            sessionID,
            arguments: 'Ship the release',
          },
          { parts: [] },
        );
        await hooks['tool.execute.before']?.(
          { tool: 'task', sessionID, callID: 'goal-task' },
          {
            args: {
              subagent_type: 'fixer',
              background: true,
              description: 'Ship the release',
            },
          },
        );
        await hooks['tool.execute.after']?.(
          { tool: 'task', sessionID, callID: 'goal-task' },
          {
            output: [
              'task_id: goal-task-1',
              'state: running',
              '',
              '<task_result>',
              'Background task started.',
              '</task_result>',
            ].join('\n'),
          },
        );

        await hooks['experimental.chat.messages.transform']?.(
          {},
          {
            messages: [
              {
                info: { role: 'user', agent: 'orchestrator', sessionID },
                parts: [
                  { type: 'text', text: 'Continue.' },
                  {
                    type: 'text',
                    id: 'goal-terminal-1',
                    synthetic: true,
                    text: [
                      '<task id="goal-task-1" state="completed">',
                      '<summary>Background task completed: Ship the release</summary>',
                      '<task_result>',
                      'done',
                      '</task_result>',
                      '</task>',
                    ].join('\n'),
                  },
                ],
              },
            ],
          },
        );

        // Publication makes the terminal binding visible, but does not itself
        // acknowledge delivery to the orchestrator or create Goal evidence.
        expect(new GoalStore(sessionID).read().goal).toMatchObject({
          status: 'active',
          evidence: [],
        });

        await hooks['experimental.chat.messages.transform']?.(
          {},
          {
            messages: [
              {
                info: { role: 'user', agent: 'orchestrator', sessionID },
                parts: [{ type: 'text', text: 'Acknowledge the result.' }],
              },
            ],
          },
        );

        let goal = new GoalStore(sessionID).read().goal;
        for (
          let attempt = 0;
          goal?.bindings[0]?.reconciled !== true && attempt < 20;
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          goal = new GoalStore(sessionID).read().goal;
        }
        expect(goal).toMatchObject({
          status: 'active',
          evidence: [],
          verificationAssignments: [],
          bindings: [{ taskID: 'goal-task-1', reconciled: true }],
        });

        await hooks['chat.message']?.(
          { sessionID, agent: 'goal' },
          {
            message: {
              id: 'goal-user-1',
              role: 'user',
              agent: 'goal',
              sessionID,
            },
            parts: [{ type: 'text', text: 'Verify criterion-1.' }],
          },
        );
        await hooks['tool.execute.before']?.(
          { tool: 'task', sessionID, callID: 'goal-verifier' },
          {
            args: {
              subagent_type: 'oracle',
              background: true,
              description: 'Goal verification: criterion-1',
            },
          },
        );
        await hooks['tool.execute.after']?.(
          { tool: 'task', sessionID, callID: 'goal-verifier' },
          {
            output: [
              'task_id: goal-verifier-1',
              'state: running',
              '',
              '<task_result>',
              'Background task started.',
              '</task_result>',
            ].join('\n'),
          },
        );
        await hooks['experimental.chat.messages.transform']?.(
          {},
          {
            messages: [
              {
                info: { role: 'user', agent: 'goal', sessionID },
                parts: [
                  { type: 'text', text: 'Continue.' },
                  {
                    type: 'text',
                    id: 'goal-verifier-terminal-1',
                    synthetic: true,
                    text: [
                      '<task id="goal-verifier-1" state="completed">',
                      '<summary>Background task completed: Goal verification</summary>',
                      '<task_result>',
                      '<goal_verdict>{"criterionID":"criterion-1","verdict":"passed"}</goal_verdict>',
                      '</task_result>',
                      '</task>',
                    ].join('\n'),
                  },
                ],
              },
            ],
          },
        );
        await hooks['experimental.chat.messages.transform']?.(
          {},
          {
            messages: [
              {
                info: { role: 'user', agent: 'goal', sessionID },
                parts: [{ type: 'text', text: 'Acknowledge verification.' }],
              },
            ],
          },
        );

        await hooks['experimental.chat.messages.transform']?.(
          {},
          {
            messages: [
              {
                info: { role: 'user', agent: 'goal', sessionID },
                parts: [
                  { type: 'text', text: 'Retry pending durable evidence.' },
                ],
              },
            ],
          },
        );
        expect(failures).toBe(failOnce ? 1 : 0);
        goal = new GoalStore(sessionID).read().goal;
        for (
          let attempt = 0;
          goal?.evidence.length !== 1 && attempt < 20;
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          goal = new GoalStore(sessionID).read().goal;
        }
        expect(goal).toMatchObject({
          status: 'completed',
          verificationAssignments: [
            { criterionID: 'criterion-1', consumed: true },
          ],
          evidence: [
            { criterionID: 'criterion-1', passed: true, contradicts: false },
          ],
        });
        await hooks.dispose?.();
      } finally {
        writeSpy.mockRestore();
        process.env = originalEnv;
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
