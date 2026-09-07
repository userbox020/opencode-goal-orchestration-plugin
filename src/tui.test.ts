import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RGBA } from '@opentui/core';
import { createRoot } from 'solid-js/dist/solid.js';
import type { GoalSnapshot } from './goal/core';
import { getOpenCodeStateDir } from './goal/store';
import { readTmuxPane } from './multiplexer/tmux-pane-registry';
import {
  type ActiveTmuxPaneRegistration,
  createGoalCardResource,
  createTuiPlugin,
  type GoalSidebarCardModel,
  getContrastForeground,
  getSidebarAgentNames,
  projectGoalSidebarCard,
  readCompactSidebar,
  readConfigInvalid,
  readGoalSidebarCard,
  resolveLocalGoalDataRoot,
  splitSidebarModelId,
  syncTmuxPaneRegistration,
  default as tuiPlugin,
} from './tui';
import type { TuiSnapshot } from './tui-state';

function createSnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    version: 1,
    updatedAt: 0,
    agentModels: {},
    agentVariants: {},
    ...overrides,
  };
}

function createGoalSnapshot(
  status: 'active' | 'paused' | 'completed' | 'cancelled' = 'active',
  objective = 'Ship a focused native Goal status card',
): GoalSnapshot {
  return {
    apiVersion: 1,
    state: 'goal',
    goal: {
      id: 'goal-1',
      objective,
      status,
      revision: 1,
      recordVersion: 1,
      epoch: 1,
      progress: { verified: 1, total: 3, percent: 33 },
      criteria: [
        { id: 'criterion-1', text: 'Typecheck passes', status: 'verified' },
        { id: 'criterion-2', text: 'Visual review passes', status: 'pending' },
        {
          id: 'criterion-3',
          text: 'Remote state must not leak',
          status: 'contradicted',
        },
      ],
    },
  };
}

describe('native Goal sidebar card', () => {
  test.each([
    ['active', '●', 'active'],
    ['paused', 'Ⅱ', 'paused'],
    ['completed', '✓', 'completed'],
    ['cancelled', '×', 'cancelled'],
  ] as const)('projects %s lifecycle text and mark', (status, mark, tone) => {
    const card = projectGoalSidebarCard(createGoalSnapshot(status));

    expect(card?.heading).toBe('Goal');
    expect(card?.lifecycle).toEqual({ label: status, mark, tone });
    expect(card?.progress).toEqual({ verified: 1, total: 3, percent: 33 });
    expect(card?.criteria).toEqual([
      {
        text: 'Typecheck passes',
        label: 'verified',
        mark: '✓',
        tone: 'completed',
      },
      {
        text: 'Visual review passes',
        label: 'pending',
        mark: '·',
        tone: 'muted',
      },
      {
        text: 'Remote state must not leak',
        label: 'contradicted',
        mark: '!',
        tone: 'cancelled',
      },
    ]);
  });

  test('renders no card when the session has no Goal', () => {
    expect(
      readGoalSidebarCard('session-empty', 'C:/data', () => ({
        apiVersion: 1,
        state: 'no-goal',
      })),
    ).toBeUndefined();
  });

  test('truncates objective and criterion text without splitting emoji', () => {
    const snapshot = createGoalSnapshot('active', `${'a'.repeat(90)}😀bc`);
    if (snapshot.state === 'goal') {
      snapshot.goal.criteria[0] = {
        id: 'criterion-1',
        text: `${'b'.repeat(94)}😀cd`,
        status: 'verified',
      };
    }

    const card = projectGoalSidebarCard(snapshot);

    expect(card?.objective).toEndWith('😀…');
    expect(card?.criteria[0]?.text).toEndWith('😀…');
    expect(card?.objective).not.toContain('\uFFFD');
    expect(card?.criteria[0]?.text).not.toContain('\uFFFD');
  });

  test('slot reads its session_id and switching A to B cannot show A', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-goal-'));
    const reads: string[] = [];
    const reader = (sessionID: string) => {
      reads.push(sessionID);
      return createGoalSnapshot(
        'active',
        sessionID === 'session-a' ? 'Objective A' : 'Objective B',
      );
    };
    let slot:
      | ((
          context: { theme: { current: Record<string, unknown> } },
          props: { session_id: string },
        ) => unknown)
      | undefined;
    const disposers: Array<() => void | Promise<void>> = [];
    let disposeCardA = () => {};
    let disposeCardB = () => {};
    const plugin = createTuiPlugin(
      reader,
      (_snapshot, _version, _theme, _invalid, _compact, goalCard) =>
        goalCard as never,
    );

    try {
      await plugin.tui(
        {
          state: {
            ready: true,
            path: {
              directory: tempDir,
              state: getOpenCodeStateDir(),
            },
          },
          route: { current: { name: 'home' } },
          lifecycle: {
            onDispose: (dispose: () => void | Promise<void>) => {
              disposers.push(dispose);
              return () => {};
            },
          },
          renderer: { requestRender: () => {} },
          slots: {
            register: (registration: {
              slots: { sidebar_content?: typeof slot };
            }) => {
              slot = registration.slots.sidebar_content;
              return 'slot-id';
            },
          },
          theme: { current: {} },
        } as unknown as Parameters<typeof plugin.tui>[0],
        {},
        { version: 'test' } as Parameters<typeof plugin.tui>[2],
      );

      const context = { theme: { current: {} } };
      const cardA = createRoot((dispose) => {
        disposeCardA = dispose;
        return slot?.(context, {
          session_id: 'session-a',
        }) as () => GoalSidebarCardModel | undefined;
      });
      const cardB = createRoot((dispose) => {
        disposeCardB = dispose;
        return slot?.(context, {
          session_id: 'session-b',
        }) as () => GoalSidebarCardModel | undefined;
      });

      expect(reads).toEqual(['session-a', 'session-b']);
      expect(cardA()?.objective).toBe('Objective A');
      expect(cardB()?.objective).toBe('Objective B');
      expect(cardB()?.objective).not.toBe(cardA()?.objective);
    } finally {
      disposeCardA();
      disposeCardB();
      for (const dispose of disposers) await dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('same-session resource refreshes and disappears', () => {
    let snapshot: unknown = createGoalSnapshot('active', 'First objective');
    const resource = createGoalCardResource({
      sessionID: 'same-session',
      getDataRoot: () => 'C:/data',
      readSnapshot: () => snapshot,
    });

    expect(resource.current()?.objective).toBe('First objective');

    snapshot = createGoalSnapshot('paused', 'Revised objective');
    resource.refresh();
    expect(resource.current()?.objective).toBe('Revised objective');
    expect(resource.current()?.lifecycle.label).toBe('paused');

    snapshot = { apiVersion: 1, state: 'no-goal' };
    resource.refresh();
    expect(resource.current()).toBeUndefined();
  });

  test('fails closed for read errors and corrupt snapshots', () => {
    expect(
      readGoalSidebarCard('locked', 'C:/data', () => {
        throw new Error('state is locked');
      }),
    ).toBeUndefined();
    expect(
      readGoalSidebarCard('corrupt', 'C:/data', () => ({
        apiVersion: 1,
        state: 'goal',
        goal: { objective: '<broken>' },
      })),
    ).toBeUndefined();
  });
});

describe('native Goal durable read boundary', () => {
  test('reads only when TUI state is ready and roots match', () => {
    const localStateRoot = path.resolve(
      'C:\\Users\\Local\\.local\\state\\opencode',
    );
    const localDataRoot = path.resolve(
      'C:\\Users\\Local\\.local\\share\\opencode',
    );
    const reportedLocalStateRoot =
      process.platform === 'win32'
        ? localStateRoot.toUpperCase()
        : localStateRoot;
    const matchingState = {
      ready: true,
      path: { state: path.join(reportedLocalStateRoot, 'nested', '..') },
    };
    const mismatchedState = {
      ready: true,
      path: {
        state: path.resolve('C:\\Users\\Remote\\.local\\state\\opencode'),
      },
    };
    const reader = mock(() => ({ apiVersion: 1, state: 'no-goal' }));
    const noTimer = (() => 1) as unknown as typeof setInterval;
    const clearTimer = (() => {}) as typeof clearInterval;
    let disposeMatching = () => {};
    let disposeMismatch = () => {};

    const matching = createRoot((dispose) => {
      disposeMatching = dispose;
      return createGoalCardResource({
        sessionID: 'matching-session',
        getDataRoot: () =>
          resolveLocalGoalDataRoot(
            matchingState,
            localDataRoot,
            localStateRoot,
          ),
        readSnapshot: reader,
        setInterval: noTimer,
        clearInterval: clearTimer,
      });
    });
    const mismatch = createRoot((dispose) => {
      disposeMismatch = dispose;
      return createGoalCardResource({
        sessionID: 'mismatched-session',
        getDataRoot: () =>
          resolveLocalGoalDataRoot(
            mismatchedState,
            localDataRoot,
            localStateRoot,
          ),
        readSnapshot: reader,
        setInterval: noTimer,
        clearInterval: clearTimer,
      });
    });

    try {
      expect(matching.current()).toBeUndefined();
      expect(mismatch.current()).toBeUndefined();
      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader).toHaveBeenCalledWith('matching-session', localDataRoot);
      expect(
        resolveLocalGoalDataRoot(
          { ready: false, path: { state: localStateRoot } },
          localDataRoot,
          localStateRoot,
        ),
      ).toBeUndefined();
    } finally {
      disposeMatching();
      disposeMismatch();
    }
  });

  test('malformed host state fails closed without throwing', () => {
    const localStateRoot = path.resolve(
      'C:\\Users\\Local\\.local\\state\\opencode',
    );
    const localDataRoot = path.resolve(
      'C:\\Users\\Local\\.local\\share\\opencode',
    );
    const malformedStates: Array<[string, unknown]> = [
      [
        'truthy string ready',
        { ready: 'true', path: { state: localStateRoot } },
      ],
      ['truthy numeric ready', { ready: 1, path: { state: localStateRoot } }],
      ['relative state path', { ready: true, path: { state: 'opencode' } }],
      ['empty state path', { ready: true, path: { state: '   ' } }],
      ['non-string state path', { ready: true, path: { state: 42 } }],
      ['missing state', undefined],
      ['null state', null],
      ['missing path', { ready: true }],
      ['null path', { ready: true, path: null }],
    ];

    for (const [caseName, malformedState] of malformedStates) {
      let result: string | undefined;
      expect(() => {
        result = resolveLocalGoalDataRoot(
          malformedState,
          localDataRoot,
          localStateRoot,
        );
      }, caseName).not.toThrow();
      expect(result, caseName).toBeUndefined();
    }
  });

  test('legacy, corrupt, and migration-locked files fail softly without mutation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-durable-'));
    const goalsDirectory = path.join(root, 'oh-my-opencode-slim', 'goals');
    fs.mkdirSync(goalsDirectory, { recursive: true });

    const legacySession = 'legacy-session';
    const legacyPath = path.join(
      goalsDirectory,
      `${Buffer.from(legacySession).toString('base64url')}.json`,
    );
    const lockPath = `${legacyPath}.lock`;
    const legacyContent = JSON.stringify({ version: 1, goal: null });
    fs.writeFileSync(legacyPath, legacyContent);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: Date.now(),
        token: 'held',
      }),
    );

    const corruptSession = 'corrupt-session';
    const corruptPath = path.join(
      goalsDirectory,
      `${Buffer.from(corruptSession).toString('base64url')}.json`,
    );
    fs.writeFileSync(corruptPath, '{broken');

    try {
      expect(readGoalSidebarCard(legacySession, root)).toBeUndefined();
      expect(readGoalSidebarCard(corruptSession, root)).toBeUndefined();
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyContent);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.readFileSync(corruptPath, 'utf8')).toBe('{broken');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('tui sidebar agents', () => {
  test('hides disabled agents when models are persisted explicitly', () => {
    const agentNames = getSidebarAgentNames(
      createSnapshot({
        agentModels: {
          explorer: 'openai/gpt-5.6-luna',
          fixer: 'openai/gpt-5.6-luna',
        },
      }),
    );

    expect(agentNames).toEqual(['explorer', 'fixer']);
    expect(agentNames).not.toContain('observer');
    expect(agentNames).not.toContain('librarian');
  });

  test('uses default-enabled fallback before models are persisted', () => {
    const agentNames = getSidebarAgentNames(createSnapshot({}));

    expect(agentNames).toContain('explorer');
    expect(agentNames).toContain('fixer');
    expect(agentNames).not.toContain('observer');
    expect(agentNames).not.toContain('council');
    expect(agentNames).not.toContain('councillor');
  });
});

describe('splitSidebarModelId', () => {
  test('splits provider from model at the first slash', () => {
    expect(splitSidebarModelId('openai/gpt-5.6-fast')).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-fast',
    });
    expect(
      splitSidebarModelId(
        'fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo',
      ),
    ).toEqual({
      provider: 'fireworks-ai',
      model: 'accounts/fireworks/routers/kimi-k2p5-turbo',
    });
  });

  test('keeps slashless names as model only', () => {
    expect(splitSidebarModelId('pending')).toEqual({ model: 'pending' });
  });
});

describe('readConfigInvalid', () => {
  let originalEnv: typeof process.env;
  let configHome: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Isolate from real user config and env presets
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-env-'));
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    fs.rmSync(configHome, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('detects invalid config from the current directory without persisted state', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      const configDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ agents: { oracle: { temperature: 5 } } }),
      );

      expect(readConfigInvalid(projectDir)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns false for valid config', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      const configDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ agents: { oracle: { model: 'valid/model' } } }),
      );

      expect(readConfigInvalid(projectDir)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns false for config with deprecated fallback keys (loads fine)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      const configDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          fallback: {
            enabled: true,
            timeoutMs: 15000,
            runtimeOverride: true,
          },
          agents: { oracle: { model: 'valid/model' } },
        }),
      );

      // Deprecated fallback keys are stripped with a warning; the config
      // loads successfully so the sidebar must NOT show "Config invalid".
      expect(readConfigInvalid(projectDir)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns false for config with normalized disabled_* string', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      const configDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          disabled_agents: 'explorer',
          agents: { oracle: { model: 'valid/model' } },
        }),
      );

      // The string key is normalized to an array with a 'normalized' warning
      // (not invalid-schema), so the config loads fine and the sidebar must
      // NOT show "Config invalid".
      expect(readConfigInvalid(projectDir)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('uses compact sidebar by default', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      expect(readCompactSidebar(projectDir)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('allows expanded sidebar config', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      const configDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ compactSidebar: false }),
      );

      expect(readCompactSidebar(projectDir)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('tui plugin env disable', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('does not perform setup when plugin is disabled by env', async () => {
    process.env.OH_MY_OPENCODE_SLIM_DISABLE = '1';

    let disposeRegistered = false;
    let renderRequested = false;
    let registered = false;
    await tuiPlugin.tui(
      {
        lifecycle: {
          onDispose: () => {
            disposeRegistered = true;
          },
        },
        renderer: {
          requestRender: () => {
            renderRequested = true;
          },
        },
        slots: {
          register: () => {
            registered = true;
          },
        },
        theme: { current: {} },
      } as unknown as Parameters<typeof tuiPlugin.tui>[0],
      {},
      { version: 'test' } as Parameters<typeof tuiPlugin.tui>[2],
    );

    expect(registered).toBe(false);
    expect(disposeRegistered).toBe(false);
    expect(renderRequested).toBe(false);
  });
});

describe('tmux pane registration', () => {
  let originalEnv: typeof process.env;
  let stateDirectory: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tmux-tui-'));
    process.env.XDG_DATA_HOME = stateDirectory;
    process.env.TMUX_PANE = '%42';
  });

  afterEach(() => {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('records the local pane for the active attached session', () => {
    const registration: ActiveTmuxPaneRegistration = {
      ownerPid: 100,
      lastRecordedAt: 0,
    };

    syncTmuxPaneRegistration(
      { name: 'session', params: { sessionID: 'root-session-b' } },
      registration,
      1_000,
    );

    expect(readTmuxPane('root-session-b', 1_000)).toBe('%42');
  });

  test('moves registration when the local TUI selects another session', () => {
    const registration: ActiveTmuxPaneRegistration = {
      ownerPid: 100,
      lastRecordedAt: 0,
    };
    const route = { name: 'session', params: { sessionID: 'root-a' } };

    syncTmuxPaneRegistration(route, registration, 1_000);
    route.params.sessionID = 'root-b';
    syncTmuxPaneRegistration(route, registration, 2_000);

    expect(readTmuxPane('root-a', 2_000)).toBeUndefined();
    expect(readTmuxPane('root-b', 2_000)).toBe('%42');
  });

  test('accepts the v2 route shape ({ type, sessionID })', () => {
    const registration: ActiveTmuxPaneRegistration = {
      ownerPid: 100,
      lastRecordedAt: 0,
    };

    syncTmuxPaneRegistration(
      { type: 'session', sessionID: 'v2-session' },
      registration,
      1_000,
    );

    expect(readTmuxPane('v2-session', 1_000)).toBe('%42');
  });
});

describe('getContrastForeground', () => {
  const white = RGBA.fromInts(255, 255, 255);
  const black = RGBA.fromInts(0, 0, 0);
  const darkGray = RGBA.fromInts(30, 30, 30);
  const transparent = RGBA.fromInts(0, 0, 0, 0);

  test('returns theme text when fallback is triggered', () => {
    expect(getContrastForeground(undefined, 'theme-text', 'theme-bg')).toBe(
      'theme-text',
    );
  });

  test('returns black on a light background', () => {
    // White background -> black text
    const result = getContrastForeground(white, white, black) as RGBA;
    expect(result.toInts()).toEqual([0, 0, 0, 255]);
  });

  test('returns white on a dark background', () => {
    // Black background -> white text
    const result = getContrastForeground(black, white, black) as RGBA;
    expect(result.toInts()).toEqual([255, 255, 255, 255]);
  });

  test('respects themeBackground if it is dark and solid when accent is light', () => {
    const result = getContrastForeground(white, white, darkGray) as RGBA;
    expect(result.toInts()).toEqual([30, 30, 30, 255]);
  });

  test('never returns transparent themeBackground even if accent is light', () => {
    const result = getContrastForeground(white, white, transparent) as RGBA;
    expect(result.toInts()).toEqual([0, 0, 0, 255]);
  });

  test('respects themeText if it is light when accent is dark', () => {
    const result = getContrastForeground(black, white, black) as RGBA;
    expect(result.toInts()).toEqual([255, 255, 255, 255]);
  });

  test('parses hex string colors correctly', () => {
    const result = getContrastForeground('#ffffff', '#ffffff', '#1e1e1e');
    expect(result).toBe('#1e1e1e');
  });
});

describe('dual-contract plugin module', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createV2Context(directory: string) {
    const slotClaims: Array<{
      append?: string;
      render: (input: { sessionID: string }) => unknown;
    }> = [];
    let disposeCalls = 0;
    const ctx = {
      location: { directory },
      renderer: { requestRender: () => {} },
      theme: {
        text: { default: '#f0f0f0', subdued: '#8a8a8a' },
        background: { default: '#101010' },
        border: { default: '#3a3a3a' },
      },
      ui: {
        slot: (claim: (typeof slotClaims)[number]) => {
          slotClaims.push(claim);
          return () => {
            disposeCalls += 1;
          };
        },
        router: {
          current: () =>
            ({ type: 'home' }) as {
              type?: string;
              sessionID?: string;
            },
        },
      },
    };
    return {
      ctx,
      slotClaims,
      getDisposeCalls: () => disposeCalls,
    };
  }

  type V2Context = Parameters<typeof tuiPlugin.setup>[0];

  test('exposes the dual contract shape', () => {
    expect(typeof tuiPlugin.id).toBe('string');
    expect(tuiPlugin.id.length).toBeGreaterThan(0);
    expect(typeof tuiPlugin.tui).toBe('function');
    expect(typeof tuiPlugin.setup).toBe('function');
  });

  test('setup registers one sidebar.content slot and cleanup disposes it', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-v2-'));
    let cleanup: (() => void) | undefined;
    try {
      const { ctx, slotClaims, getDisposeCalls } = createV2Context(tempDir);
      cleanup = (await tuiPlugin.setup(
        ctx as unknown as V2Context,
      )) as () => void;

      expect(slotClaims).toHaveLength(1);
      expect(slotClaims[0]?.append).toBe('sidebar.content');
      expect(typeof slotClaims[0]?.render).toBe('function');
      expect(getDisposeCalls()).toBe(0);

      cleanup();
      expect(getDisposeCalls()).toBe(1);
    } finally {
      cleanup?.();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('secondary setup contract never reads or exposes Goal state', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-v2-'));
    const goalReader = mock(() => createGoalSnapshot());
    const secondaryPlugin = createTuiPlugin(goalReader);
    let cleanup: (() => void) | undefined;
    try {
      const { ctx, slotClaims } = createV2Context(tempDir);
      cleanup = (await secondaryPlugin.setup(
        ctx as unknown as V2Context,
      )) as () => void;

      expect(slotClaims).toHaveLength(1);
      expect(goalReader).not.toHaveBeenCalled();
    } finally {
      cleanup?.();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('setup returns early without registering a slot when disabled by env', async () => {
    process.env.OH_MY_OPENCODE_SLIM_DISABLE = '1';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-v2-'));
    try {
      const { ctx, slotClaims } = createV2Context(tempDir);
      const cleanup = await tuiPlugin.setup(ctx as unknown as V2Context);

      expect(slotClaims).toHaveLength(0);
      expect(cleanup).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('native TUI refresh lifecycle', () => {
  let originalEnv: typeof process.env;
  let originalSetInterval: typeof globalThis.setInterval;
  let originalClearInterval: typeof globalThis.clearInterval;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  test('requests a render each second and clears its timer on disposal', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-v1-'));
    const timerHandle = 73 as unknown as ReturnType<typeof setInterval>;
    let intervalMs: number | undefined;
    let tick: (() => void | Promise<void>) | undefined;
    const clearIntervalSpy = mock(() => {});
    globalThis.setInterval = ((handler, timeout) => {
      tick = handler as () => void | Promise<void>;
      intervalMs = timeout;
      return timerHandle;
    }) as typeof setInterval;
    globalThis.clearInterval = clearIntervalSpy as typeof clearInterval;

    const requestRender = mock(() => {});
    const disposers: Array<() => void | Promise<void>> = [];
    try {
      await createTuiPlugin(() => ({ apiVersion: 1, state: 'no-goal' })).tui(
        {
          state: { path: { directory: tempDir } },
          route: { current: { name: 'home' } },
          lifecycle: {
            onDispose: (dispose: () => void | Promise<void>) => {
              disposers.push(dispose);
              return () => {};
            },
          },
          renderer: { requestRender },
          slots: { register: () => 'slot-id' },
          theme: { current: {} },
        } as unknown as Parameters<typeof tuiPlugin.tui>[0],
        {},
        { version: 'test' } as Parameters<typeof tuiPlugin.tui>[2],
      );

      expect(intervalMs).toBe(1000);
      expect(tick).toBeDefined();
      await tick?.();
      expect(requestRender).toHaveBeenCalledTimes(1);

      expect(disposers).toHaveLength(1);
      await disposers[0]?.();
      expect(clearIntervalSpy).toHaveBeenCalledWith(timerHandle);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
