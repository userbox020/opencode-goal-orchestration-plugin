import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

const crossSpawnMock = mock((_command: string[]) => createSpawnResult());

mock.module('../../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

let importCounter = 0;

function createSpawnResult(
  exitCode = 0,
  stdout = '',
  stderr = '',
): SpawnResult {
  return {
    exited: Promise.resolve(exitCode),
    stdout: () => Promise.resolve(stdout),
    stderr: () => Promise.resolve(stderr),
    kill: () => true,
    exitCode,
    proc: {} as never,
  };
}

function createPaneListJson(parentTabId = 0): string {
  return JSON.stringify([
    {
      id: 0,
      is_plugin: false,
      tab_id: parentTabId,
    },
    {
      id: 4,
      is_plugin: false,
      tab_id: 1,
    },
  ]);
}

async function importFreshZellij() {
  return import(`./index?test=${importCounter++}`);
}

function commands(): string[][] {
  return crossSpawnMock.mock.calls.map((call) => call[0] as string[]);
}

/**
 * Install the standard success mock set (binary found, supported version,
 * list-panes with the parent pane in tab 0, new-pane emitting a valid id).
 */
function mockStandardImpl(version: string): void {
  crossSpawnMock.mockImplementation((command: string[]) => {
    if (command[0] === 'which' || command[0] === 'where') {
      return createSpawnResult(0, '/usr/bin/zellij\n');
    }
    if (command.includes('--version')) {
      return createSpawnResult(0, `zellij ${version}\n`);
    }
    if (command.includes('list-panes')) {
      return createSpawnResult(0, createPaneListJson());
    }
    if (command.includes('new-pane')) {
      return createSpawnResult(0, 'terminal_2\n');
    }
    return createSpawnResult();
  });
}

async function spawnSecondAgentTabPane(
  layout: 'main-vertical' | 'main-horizontal' | 'tiled',
): Promise<string[] | undefined> {
  const { ZellijMultiplexer } = await importFreshZellij();
  const zellij = new ZellijMultiplexer(layout, 60, 'agent-tab');

  crossSpawnMock.mockImplementation((command: string[]) => {
    if (command[0] === 'which' || command[0] === 'where') {
      return createSpawnResult(0, '/usr/bin/zellij\n');
    }
    if (command.includes('--version')) {
      return createSpawnResult(0, 'zellij 0.44.3\n');
    }
    if (command.includes('list-tabs')) {
      return createSpawnResult(
        0,
        JSON.stringify([{ name: 'opencode-agents', tab_id: 5 }]),
      );
    }
    if (command.includes('list-panes') && command.includes('--json')) {
      return createSpawnResult(
        0,
        JSON.stringify([
          { id: 0, is_plugin: false, tab_id: 0 },
          { id: 7, is_plugin: false, tab_id: 5 },
        ]),
      );
    }
    if (command.includes('new-pane')) {
      return createSpawnResult(0, 'terminal_8\n');
    }
    return createSpawnResult();
  });

  await zellij.spawnPane(
    'session-1',
    'First agent worker',
    'http://localhost:4096',
    '/repo',
  );

  await zellij.spawnPane(
    'session-2',
    'Second agent worker',
    'http://localhost:4096',
    '/repo',
  );

  return commands().findLast((command) => command.includes('new-pane'));
}

describe('ZellijMultiplexer', () => {
  const originalZellij = process.env.ZELLIJ;
  const originalZellijPaneId = process.env.ZELLIJ_PANE_ID;

  beforeEach(() => {
    process.env.ZELLIJ = '1';
    process.env.ZELLIJ_PANE_ID = '0';

    crossSpawnMock.mockReset();
    mockStandardImpl('0.44.3');
  });

  afterEach(() => {
    process.env.ZELLIJ = originalZellij;
    process.env.ZELLIJ_PANE_ID = originalZellijPaneId;
  });

  describe('version gate', () => {
    test('isAvailable is false for zellij older than 0.44.1', async () => {
      mockStandardImpl('0.43.1');

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60, 'agent-tab');

      const result = await zellij.spawnPane(
        'session-1',
        'Old zellij worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: false });
      // Only binary discovery ran; no zellij actions were attempted.
      expect(commands().some((command) => command.includes('action'))).toBe(
        false,
      );
    });

    test('isAvailable is false for zellij 0.44.0 (new-pane --tab-id needs 0.44.1)', async () => {
      mockStandardImpl('0.44.0');

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

      const result = await zellij.spawnPane(
        'session-1',
        'Boundary worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: false });
      // Only binary discovery ran; no zellij actions were attempted.
      expect(commands().some((command) => command.includes('action'))).toBe(
        false,
      );
    });

    test('isAvailable is true for the 0.44.1 boundary release', async () => {
      mockStandardImpl('0.44.1');

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

      const result = await zellij.spawnPane(
        'session-1',
        'Boundary worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: true, paneId: 'terminal_2' });
    });

    test('isAvailable is true for zellij 0.44.3', async () => {
      mockStandardImpl('0.44.3');

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

      const result = await zellij.spawnPane(
        'session-1',
        'Modern worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: true, paneId: 'terminal_2' });
    });

    test('isAvailable is false when version output cannot be parsed', async () => {
      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === 'which' || command[0] === 'where') {
          return createSpawnResult(0, '/usr/bin/zellij\n');
        }
        if (command.includes('--version')) {
          return createSpawnResult(0, 'zellij version unknown\n');
        }
        return createSpawnResult();
      });

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60, 'agent-tab');

      const result = await zellij.spawnPane(
        'session-1',
        'Unknown worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: false });
      expect(commands().some((command) => command.includes('action'))).toBe(
        false,
      );
    });

    test('isAvailable is false when the version probe fails', async () => {
      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === 'which' || command[0] === 'where') {
          return createSpawnResult(0, '/usr/bin/zellij\n');
        }
        if (command.includes('--version')) {
          return createSpawnResult(1, '', 'probe failed');
        }
        return createSpawnResult();
      });

      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60, 'agent-tab');

      const result = await zellij.spawnPane(
        'session-1',
        'Probe failure worker',
        'http://localhost:4096',
        '/repo',
      );

      expect(result).toEqual({ success: false });
      expect(commands().some((command) => command.includes('action'))).toBe(
        false,
      );
    });

    test('a second availability check awaits the in-flight probe instead of returning false early', async () => {
      const { ZellijMultiplexer } = await importFreshZellij();
      const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

      let releaseWhich!: () => void;
      const whichGate = new Promise<void>((resolve) => {
        releaseWhich = resolve;
      });

      crossSpawnMock.mockImplementation((command: string[]) => {
        if (command[0] === 'which' || command[0] === 'where') {
          return {
            ...createSpawnResult(0, '/usr/bin/zellij\n'),
            exited: whichGate.then(() => 0),
          };
        }
        if (command.includes('--version')) {
          return createSpawnResult(0, 'zellij 0.44.1\n');
        }
        return createSpawnResult();
      });

      const first = zellij.isAvailable();
      // Second call while the binary probe is still pending: it must join the
      // in-flight probe rather than short-circuit to an early false.
      const second = zellij.isAvailable();

      let secondSettled = false;
      void second.then(() => {
        secondSettled = true;
      });

      // Flush microtasks deterministically; the probe is gated on `which`, so
      // the second call must not settle before the probe completes.
      for (let i = 0; i < 32; i++) {
        await Promise.resolve();
      }
      expect(secondSettled).toBe(false);

      releaseWhich();
      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);
      expect(secondSettled).toBe(true);

      // Only one probe ran: both calls shared the same in-flight promise.
      const discoveryCalls = commands().filter(
        (c) => c[0] === 'which' || c[0] === 'where',
      );
      expect(discoveryCalls).toHaveLength(1);
    });
  });

  test('current-tab mode spawns a pane in the parent OpenCode tab', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    const result = await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: true, paneId: 'terminal_2' });

    const allCommands = commands();
    const newPaneCommand = allCommands.find((command) =>
      command.includes('new-pane'),
    );

    expect(newPaneCommand).toEqual([
      '/usr/bin/zellij',
      'action',
      'new-pane',
      '--tab-id',
      '0',
      '--direction',
      'right',
      '--name',
      'Current tab worker',
      '--close-on-exit',
      '--',
      'sh',
      '-lc',
      "opencode attach 'http://localhost:4096' --session 'session-1' --dir '/repo'",
    ]);
    expect(allCommands.some((command) => command.includes('new-tab'))).toBe(
      false,
    );
    expect(
      allCommands.some((command) => command.includes('go-to-tab-by-id')),
    ).toBe(false);
  });

  test('current-tab mode reports failure when zellij does not return a terminal pane id', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'plugin_2\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false });
  });

  test('new-pane retries without --direction when a directed create is silently dropped', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');
    let newPaneCalls = 0;

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        newPaneCalls++;
        if (newPaneCalls === 1) {
          // Zellij drops the split silently: exit 0, no terminal_ id.
          return createSpawnResult(0, '');
        }
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: true, paneId: 'terminal_2' });

    const newPaneCmds = commands().filter((c) => c.includes('new-pane'));
    expect(newPaneCmds).toHaveLength(2);
    expect(newPaneCmds[0]).toContain('--direction');
    // The fallback keeps the pane name, close-on-exit, and the command part,
    // but drops the direction hint so Zellij picks the largest free space.
    expect(newPaneCmds[1]).not.toContain('--direction');
    expect(newPaneCmds[1]).toContain('--name');
    expect(newPaneCmds[1]).toContain('--close-on-exit');
    expect(newPaneCmds[1].join(' ')).toContain('opencode attach');
  });

  test('new-pane reports failure when both the directed create and the fallback fail', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'plugin_2\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false });

    const newPaneCmds = commands().filter((c) => c.includes('new-pane'));
    expect(newPaneCmds).toHaveLength(2);
    expect(newPaneCmds[0]).toContain('--direction');
    expect(newPaneCmds[1]).not.toContain('--direction');
  });

  test('agent-tab mode retries new-pane without --direction after a crowded split', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'agent-tab');
    let newPaneCalls = 0;

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-tabs')) {
        return createSpawnResult(
          0,
          JSON.stringify([{ name: 'opencode-agents', tab_id: 5 }]),
        );
      }
      if (command.includes('list-panes') && command.includes('--json')) {
        return createSpawnResult(
          0,
          JSON.stringify([
            { id: 0, is_plugin: false, tab_id: 0 },
            { id: 7, is_plugin: false, tab_id: 5 },
          ]),
        );
      }
      if (command.includes('new-pane')) {
        newPaneCalls++;
        if (newPaneCalls === 1) return createSpawnResult(0, '');
        return createSpawnResult(0, 'terminal_8\n');
      }
      return createSpawnResult();
    });

    // First spawn reuses the agent tab's default pane via write-chars.
    await zellij.spawnPane(
      'session-1',
      'First agent worker',
      'http://localhost:4096',
      '/repo',
    );
    // Second spawn creates a new pane, hitting the crowded-split fallback.
    const result = await zellij.spawnPane(
      'session-2',
      'Second agent worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: true, paneId: 'terminal_8' });

    const newPaneCmds = commands().filter((c) => c.includes('new-pane'));
    expect(newPaneCmds).toHaveLength(2);
    expect(newPaneCmds[0]).toContain('--direction');
    expect(newPaneCmds[1]).not.toContain('--direction');
  });

  test('current-tab mode targets the parent OpenCode tab even when another tab is focused', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );

    const tabIdArgIndex = newPaneCommand?.indexOf('--tab-id') ?? -1;
    expect(result).toEqual({ success: true, paneId: 'terminal_2' });
    expect(tabIdArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand?.[tabIdArgIndex + 1]).toBe('0');
  });

  test('current-tab mode accepts terminal-prefixed parent pane ids', async () => {
    process.env.ZELLIJ_PANE_ID = 'terminal_0';

    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );
    const tabIdArgIndex = newPaneCommand?.indexOf('--tab-id') ?? -1;

    expect(tabIdArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand?.[tabIdArgIndex + 1]).toBe('0');
  });

  test('current-tab mode omits --tab-id when the parent tab lookup fails', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(1, '', 'list failed');
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );

    // No tab is guessed: the pane is created in whatever tab Zellij has
    // focused, which is Zellij's own default rather than a guess by us.
    expect(result).toEqual({ success: true, paneId: 'terminal_2' });
    expect(newPaneCommand).toBeDefined();
    expect(newPaneCommand).not.toContain('--tab-id');
  });

  test('current-tab mode re-queries a failed parent tab lookup on the next spawn', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');
    let listPanesCalls = 0;

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        listPanesCalls++;
        return createSpawnResult(1, '', 'list failed');
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );
    await zellij.spawnPane(
      'session-2',
      'Current tab worker 2',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommands = commands().filter((command) =>
      command.includes('new-pane'),
    );

    // A failed lookup is NOT cached as permanent null: the second spawn
    // queries again (and fails again, so still no --tab-id).
    expect(listPanesCalls).toBe(2);
    expect(newPaneCommands).toHaveLength(2);
    for (const command of newPaneCommands) {
      expect(command).not.toContain('--tab-id');
    }
  });

  test('a transient parent tab lookup failure is retried and cached once it succeeds', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');
    let listPanesCalls = 0;

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        listPanesCalls++;
        if (listPanesCalls === 1) {
          return createSpawnResult(1, '', 'list failed');
        }
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );
    await zellij.spawnPane(
      'session-2',
      'Current tab worker 2',
      'http://localhost:4096',
      '/repo',
    );
    await zellij.spawnPane(
      'session-3',
      'Current tab worker 3',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommands = commands().filter((command) =>
      command.includes('new-pane'),
    );

    expect(listPanesCalls).toBe(2);
    expect(newPaneCommands).toHaveLength(3);
    // First spawn: lookup failed -> no --tab-id.
    expect(newPaneCommands[0]).not.toContain('--tab-id');
    // Second spawn: lookup succeeded -> targeted the parent tab.
    const tabIdArgIndex = newPaneCommands[1].indexOf('--tab-id');
    expect(tabIdArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommands[1][tabIdArgIndex + 1]).toBe('0');
    // Third spawn: the successful lookup is cached, no re-query.
    const tabIdArgIndex3 = newPaneCommands[2].indexOf('--tab-id');
    expect(tabIdArgIndex3).toBeGreaterThanOrEqual(0);
    expect(newPaneCommands[2][tabIdArgIndex3 + 1]).toBe('0');
  });

  test('main-horizontal layout opens current-tab panes down', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-horizontal', 60, 'current-tab');

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );
    const directionArgIndex = newPaneCommand?.indexOf('--direction') ?? -1;

    expect(directionArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand?.[directionArgIndex + 1]).toBe('down');
  });

  test('even-horizontal layout uses zellij native current-tab pane placement', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('even-horizontal', 60, 'current-tab');

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );
    expect(newPaneCommand).not.toContain('--direction');
  });

  test('even-vertical layout uses zellij native current-tab pane placement', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('even-vertical', 60, 'current-tab');

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );
    expect(newPaneCommand).not.toContain('--direction');
  });

  test('concurrent spawnPane calls are serialized through the pane-op queue', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    let releaseFirstNewPane!: () => void;
    const firstNewPaneGate = new Promise<void>((resolve) => {
      releaseFirstNewPane = resolve;
    });
    const order: string[] = [];

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-panes')) {
        order.push('list');
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        order.push('new-pane');
        if (order.filter((entry) => entry === 'new-pane').length === 1) {
          return {
            ...createSpawnResult(0, 'terminal_2\n'),
            exited: firstNewPaneGate.then(() => 0),
          };
        }
        return createSpawnResult(0, 'terminal_3\n');
      }
      return createSpawnResult();
    });

    const first = zellij.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );
    const second = zellij.spawnPane(
      'session-2',
      'Second worker',
      'http://localhost:4096',
      '/repo',
    );

    // Flush microtasks deterministically. The first spawn must reach its
    // (gated) new-pane call while the second spawn has not started anything:
    // the whole tab/focus-mutating sequence is queued.
    for (let i = 0; i < 32; i++) {
      await Promise.resolve();
    }

    expect(order).toEqual(['list', 'new-pane']);

    releaseFirstNewPane();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({ success: true, paneId: 'terminal_2' });
    expect(secondResult).toEqual({ success: true, paneId: 'terminal_3' });

    const newPaneCmds = commands().filter((c) => c.includes('new-pane'));
    expect(newPaneCmds).toHaveLength(2);
    // The second spawn's new-pane ran only after the first completed.
    expect(newPaneCmds[0].join(' ')).toContain("'session-1'");
    expect(newPaneCmds[1].join(' ')).toContain("'session-2'");
  });

  test('tiled layout uses zellij native current-tab pane placement', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('tiled', 60, 'current-tab');

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );

    expect(newPaneCommand).not.toContain('--direction');
  });

  test('main-vertical layout opens agent-tab panes right', async () => {
    const newPaneCommand = await spawnSecondAgentTabPane('main-vertical');
    const directionArgIndex = newPaneCommand?.indexOf('--direction') ?? -1;

    expect(directionArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand?.[directionArgIndex + 1]).toBe('right');
  });

  test('main-horizontal layout opens agent-tab panes down', async () => {
    const newPaneCommand = await spawnSecondAgentTabPane('main-horizontal');
    const directionArgIndex = newPaneCommand?.indexOf('--direction') ?? -1;

    expect(directionArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand?.[directionArgIndex + 1]).toBe('down');
  });

  test('tiled layout uses zellij native agent-tab pane placement', async () => {
    const newPaneCommand = await spawnSecondAgentTabPane('tiled');

    expect(newPaneCommand).not.toContain('--direction');
  });

  test('getFirstPaneInTab picks the target tab pane, not the current tab pane', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'agent-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-tabs')) {
        return createSpawnResult(
          0,
          JSON.stringify([{ name: 'opencode-agents', tab_id: 5 }]),
        );
      }
      // getFirstPaneInTab / findTabIdForPane: list-panes with --json --tab --all
      if (command.includes('--json') && command.includes('--tab')) {
        return createSpawnResult(
          0,
          JSON.stringify([
            { id: 0, is_plugin: false, tab_id: 0 },
            { id: 7, is_plugin: false, tab_id: 5 },
            { id: 8, is_plugin: false, tab_id: 5 },
          ]),
        );
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_8\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'First agent worker',
      'http://localhost:4096',
      '/repo',
    );
    expect(result).toEqual({ success: true, paneId: 'terminal_7' });

    const allCommands = commands();

    // Should NOT create a new pane — reused the first pane via write-chars
    const newPaneCmds = allCommands.filter((c) => c.includes('new-pane'));
    expect(newPaneCmds).toHaveLength(0);

    // Should target the pane in tab 5 (terminal_7), not the one in tab 0,
    // via direct pane-id targeting — and never use focus-pane.
    expect(allCommands.some((c) => c.includes('focus-pane'))).toBe(false);

    const renameCmd = allCommands.find((c) => c.includes('rename-pane'));
    expect(renameCmd).toBeDefined();
    expect(renameCmd).toEqual([
      '/usr/bin/zellij',
      'action',
      'rename-pane',
      'First agent worker',
      '-p',
      'terminal_7',
    ]);

    const writeCharsCmds = allCommands.filter((c) => c.includes('write-chars'));
    expect(writeCharsCmds).toHaveLength(2);
    expect(writeCharsCmds[0][0]).toBe('/usr/bin/zellij');
    expect(writeCharsCmds[0][1]).toBe('action');
    expect(writeCharsCmds[0][2]).toBe('write-chars');
    expect(writeCharsCmds[0][3]).toContain('sh -lc');
    expect(writeCharsCmds[0][3]).toContain('opencode attach');
    expect(writeCharsCmds[0][3]).toContain("'http://localhost:4096'");
    expect(writeCharsCmds[0][4]).toBe('-p');
    expect(writeCharsCmds[0][5]).toBe('terminal_7');
    expect(writeCharsCmds[1]).toEqual([
      '/usr/bin/zellij',
      'action',
      'write-chars',
      '\n',
      '-p',
      'terminal_7',
    ]);
  });

  test('getFirstPaneInTab null falls through to new-pane', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'agent-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-tabs')) {
        return createSpawnResult(
          0,
          JSON.stringify([{ name: 'opencode-agents', tab_id: 5 }]),
        );
      }
      // getFirstPaneInTab: only main tab (tab 0) has panes, agent tab (5) has none
      if (command.includes('--json') && command.includes('--tab')) {
        return createSpawnResult(
          0,
          JSON.stringify([
            { id: 0, is_plugin: false, tab_id: 0 },
            { id: 4, is_plugin: false, tab_id: 1 },
          ]),
        );
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_8\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'First agent worker',
      'http://localhost:4096',
      '/repo',
    );

    // Falls through to createPaneInAgentTab -> new-pane
    expect(result).toEqual({ success: true, paneId: 'terminal_8' });

    const allCommands = commands();
    const newPaneCmd = allCommands.find((c) => c.includes('new-pane'));
    expect(newPaneCmd).toBeDefined();

    // Should NOT use write-chars (no pane to reuse)
    const writeCharsCmds = allCommands.filter((c) => c.includes('write-chars'));
    expect(writeCharsCmds).toHaveLength(0);
  });

  test('agent-tab mode ignores a failed rename when the attach write succeeds', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'agent-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-tabs')) {
        return createSpawnResult(
          0,
          JSON.stringify([{ name: 'opencode-agents', tab_id: 5 }]),
        );
      }
      if (command.includes('list-panes') && command.includes('--json')) {
        return createSpawnResult(
          0,
          JSON.stringify([
            { id: 0, is_plugin: false, tab_id: 0 },
            { id: 7, is_plugin: false, tab_id: 5 },
          ]),
        );
      }
      if (command.includes('rename-pane')) {
        return createSpawnResult(1, '', 'rename failed');
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_8\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'First agent worker',
      'http://localhost:4096',
      '/repo',
    );

    // Rename failure is cosmetic; the attach writes still launched the agent.
    expect(result).toEqual({ success: true, paneId: 'terminal_7' });
    expect(commands().some((c) => c.includes('new-pane'))).toBe(false);
  });

  test('agent-tab mode falls through to a new pane when the attach write fails', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'agent-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-tabs')) {
        return createSpawnResult(
          0,
          JSON.stringify([{ name: 'opencode-agents', tab_id: 5 }]),
        );
      }
      if (command.includes('list-panes') && command.includes('--json')) {
        return createSpawnResult(
          0,
          JSON.stringify([
            { id: 0, is_plugin: false, tab_id: 0 },
            { id: 7, is_plugin: false, tab_id: 5 },
          ]),
        );
      }
      if (command.includes('write-chars')) {
        return createSpawnResult(1, '', 'write failed');
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_8\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'First agent worker',
      'http://localhost:4096',
      '/repo',
    );

    // The failed write must be reported as a reuse failure (never silently
    // treated as success), so the pane is created fresh in the agent tab.
    expect(result).toEqual({ success: true, paneId: 'terminal_8' });
    expect(commands().some((c) => c.includes('focus-pane'))).toBe(false);
  });

  test('agent-tab mode restores the parent tab after creating a pane', async () => {
    await spawnSecondAgentTabPane('main-vertical');

    const goToTabCmds = commands().filter((c) => c.includes('go-to-tab-by-id'));

    // Switch to the agent tab (5), then back to the parent tab (0).
    expect(goToTabCmds).toHaveLength(2);
    expect(goToTabCmds[0][3]).toBe('5');
    expect(goToTabCmds[1][3]).toBe('0');
  });

  test('agent-tab mode does not restore a tab when the parent tab is unknown', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'agent-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('list-tabs')) {
        return createSpawnResult(
          0,
          JSON.stringify([{ name: 'opencode-agents', tab_id: 5 }]),
        );
      }
      if (command.includes('list-panes') && command.includes('--json')) {
        return createSpawnResult(1, '', 'list failed');
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    // First spawn: agent tab exists but has no panes -> falls through to
    // new-pane directly (no go-to-tab needed for the first reuse attempt).
    await zellij.spawnPane(
      'session-1',
      'First agent worker',
      'http://localhost:4096',
      '/repo',
    );

    const goToTabCmds = commands().filter((c) => c.includes('go-to-tab-by-id'));

    // The agent tab switch happened, but the parent tab could not be located
    // so no restore command is emitted — focus is left in the agent tab
    // rather than guessing a tab id.
    expect(goToTabCmds.map((c) => c[3])).toEqual(['5']);
  });

  test('ensureAgentTab restores the parent tab after creating the opencode-agents tab', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'agent-tab');
    let tabCreated = false;

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which' || command[0] === 'where') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('--version')) {
        return createSpawnResult(0, 'zellij 0.44.3\n');
      }
      if (command.includes('new-tab')) {
        tabCreated = true;
        return createSpawnResult();
      }
      if (command.includes('list-tabs')) {
        if (tabCreated) {
          return createSpawnResult(
            0,
            JSON.stringify([{ name: 'opencode-agents', tab_id: 5 }]),
          );
        }
        return createSpawnResult(0, JSON.stringify([]));
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(
          0,
          JSON.stringify([
            { id: 0, is_plugin: false, tab_id: 0 },
            { id: 7, is_plugin: false, tab_id: 5 },
          ]),
        );
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_8\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'First agent worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: true, paneId: 'terminal_7' });

    // The tab was created (no pre-existing opencode-agents tab), so new-tab
    // moved focus to it — and the adapter switched straight back to the
    // parent tab (0) before launching the first agent.
    const newTabCmds = commands().filter((c) => c.includes('new-tab'));
    expect(newTabCmds).toHaveLength(1);

    const goToTabCmds = commands().filter((c) => c.includes('go-to-tab-by-id'));
    expect(goToTabCmds.map((c) => c[3])).toEqual(['0']);
  });
});
