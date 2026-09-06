import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordTmuxPane } from '../tmux-pane-registry';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

const logMock = mock(() => {});
const crossSpawnMock = mock((_command: string[]) => createSpawnResult());

mock.module('../../utils/logger', () => ({
  log: logMock,
}));

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

async function importFreshTmux() {
  return import(`./index?test=${importCounter++}`);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function commands(): string[][] {
  return crossSpawnMock.mock.calls.map((call) => call[0] as string[]);
}

describe('TmuxMultiplexer', () => {
  const originalTmux = process.env.TMUX;
  const originalTmuxPane = process.env.TMUX_PANE;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;
  let stateDirectory: string;

  beforeEach(() => {
    stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tmux-'));
    process.env.XDG_DATA_HOME = stateDirectory;
    process.env.TMUX = '/tmp/tmux-test/default,1,0';
    process.env.TMUX_PANE = '%1';

    logMock.mockClear();
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command[1] === '-V') return createSpawnResult(0, 'tmux 3.6a');
      if (command[1] === 'split-window') {
        return createSpawnResult(0, '%2\n');
      }
      return createSpawnResult();
    });
  });

  afterEach(() => {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
    process.env.TMUX = originalTmux;
    process.env.TMUX_PANE = originalTmuxPane;
  });

  test('targets the pane registered by the attached parent session', async () => {
    recordTmuxPane('root-session-b', '%42');
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane(
      'child-session',
      'Attached worker',
      'http://localhost:4096',
      '/repo',
      { parentSessionId: 'root-session-b' },
    );

    const splitCommand = commands().find((command) =>
      command.includes('split-window'),
    );
    expect(splitCommand).toContain('%42');
    expect(splitCommand).not.toContain('%1');

    await wait(300);
    const layoutCommands = commands().filter((command) =>
      command.includes('select-layout'),
    );
    expect(layoutCommands).toHaveLength(2);
    expect(layoutCommands.every((command) => command.includes('%42'))).toBe(
      true,
    );
  });

  test('falls back to the server pane when a registered target rejects the split', async () => {
    recordTmuxPane('root-session-b', '%42');
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command[1] === '-V') return createSpawnResult(0, 'tmux 3.6a');
      if (command[1] === 'split-window' && command.includes('%42')) {
        return createSpawnResult(1, '', 'target pane not found');
      }
      if (command[1] === 'split-window') {
        return createSpawnResult(0, '%2\n');
      }
      return createSpawnResult();
    });
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    const result = await tmux.spawnPane(
      'child-session',
      'Attached worker',
      'http://localhost:4096',
      '/repo',
      { parentSessionId: 'root-session-b' },
    );

    const splitCommands = commands().filter((command) =>
      command.includes('split-window'),
    );
    expect(result).toEqual({ success: true, paneId: '%2' });
    expect(splitCommands).toHaveLength(2);
    expect(splitCommands[0]).toContain('%42');
    expect(splitCommands[1]).toContain('%1');

    await tmux.applyLayout('tiled', 60);
  });

  test('coalesces layout application after bursty pane spawns', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );
    await tmux.spawnPane(
      'session-2',
      'Second worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(
      commands().filter((command) => command.includes('select-layout')),
    ).toHaveLength(0);

    await wait(300);

    const layoutCommands = commands().filter((command) =>
      command.includes('select-layout'),
    );
    const sizeCommands = commands().filter((command) =>
      command.includes('set-window-option'),
    );

    expect(layoutCommands).toHaveLength(2);
    expect(sizeCommands).toHaveLength(1);
    expect(sizeCommands[0]).toContain('main-pane-width');
    expect(sizeCommands[0]).toContain('60%');
  });

  test('logs and stops layout sequence when a tmux layout command fails', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which')
        return createSpawnResult(0, '/usr/bin/tmux\n');
      if (command[1] === '-V') return createSpawnResult(0, 'tmux 3.6a');
      if (command.includes('select-layout')) {
        return createSpawnResult(1, '', 'layout failed');
      }
      return createSpawnResult();
    });

    await tmux.applyLayout('main-vertical', 60);

    expect(
      commands().filter((command) => command.includes('set-window-option')),
    ).toHaveLength(0);
    expect(logMock).toHaveBeenCalledWith('[tmux] command failed', {
      command: 'select-layout',
      args: ['/usr/bin/tmux', 'select-layout', '-t', '%1', 'main-vertical'],
      exitCode: 1,
      stderr: 'layout failed',
    });
    expect(logMock).not.toHaveBeenCalledWith(
      '[tmux] applyLayout: applied',
      expect.anything(),
    );
  });

  test('direct applyLayout cancels a pending debounced layout', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();
    const tmux = new TmuxMultiplexer('main-vertical', 60);

    await tmux.spawnPane(
      'session-1',
      'First worker',
      'http://localhost:4096',
      '/repo',
    );
    await tmux.applyLayout('tiled', 60);
    await wait(300);

    const layoutCommands = commands().filter((command) =>
      command.includes('select-layout'),
    );

    expect(layoutCommands).toHaveLength(1);
    expect(layoutCommands[0]).toContain('tiled');
  });
});
