import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHILD_ARGUMENT = '--mounted-reactivity-child';

async function runMountedReactivityScenario() {
  const buildRoot = path.join(
    process.env.XDG_DATA_HOME ?? os.tmpdir(),
    'build',
  );
  const builtTuiPath = path.join(buildRoot, 'tui.js');

  await import('@opentui/solid/runtime-plugin-support');
  const tuiModule = pathToFileURL(builtTuiPath).href;
  const [{ testRender }, { getOpenCodeStateDir }, { createTuiPlugin }] =
    await Promise.all([
      import('@opentui/solid'),
      import('./goal/store'),
      import(tuiModule),
    ]);

  const snapshots = [
    {
      apiVersion: 1,
      state: 'goal',
      goal: {
        id: 'goal-1',
        objective: 'Active objective',
        status: 'active',
        revision: 1,
        recordVersion: 1,
        epoch: 1,
        progress: { verified: 0, total: 1, percent: 0 },
        criteria: [
          { id: 'criterion-1', text: 'Pending criterion', status: 'pending' },
        ],
      },
    },
    {
      apiVersion: 1,
      state: 'goal',
      goal: {
        id: 'goal-1',
        objective: 'Completed objective',
        status: 'completed',
        revision: 2,
        recordVersion: 2,
        epoch: 1,
        progress: { verified: 1, total: 1, percent: 100 },
        criteria: [
          {
            id: 'criterion-1',
            text: 'Verified criterion',
            status: 'verified',
          },
        ],
      },
    },
    { apiVersion: 1, state: 'no-goal' },
  ];
  let snapshotIndex = 0;
  const plugin = createTuiPlugin(() => snapshots[snapshotIndex]);
  const lifecycleDisposers = [];
  let sidebarContent;
  let slotCalls = 0;
  let nextTimerHandle = 1;
  const timers = new Map();
  const clearedTimers = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  globalThis.setInterval = (callback, delay) => {
    const handle = nextTimerHandle++;
    timers.set(handle, { callback, delay });
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    clearedTimers.push(handle);
    timers.delete(handle);
  };

  let renderer;
  try {
    await plugin.tui(
      {
        state: {
          ready: true,
          path: { directory: process.cwd(), state: getOpenCodeStateDir() },
        },
        route: { current: { name: 'home' } },
        lifecycle: {
          onDispose: (dispose) => {
            lifecycleDisposers.push(dispose);
            return () => {};
          },
        },
        renderer: { requestRender: () => {} },
        slots: {
          register: (registration) => {
            sidebarContent = registration.slots.sidebar_content;
            return 'slot-id';
          },
        },
        theme: { current: {} },
      },
      {},
      { version: 'test' },
    );
    assert.ok(sidebarContent);

    const theme = {
      accent: '#00ff00',
      background: '#000000',
      backgroundElement: '#111111',
      borderActive: '#ffffff',
      borderSubtle: '#555555',
      error: '#ff0000',
      success: '#00ff00',
      text: '#ffffff',
      textMuted: '#aaaaaa',
      warning: '#ffff00',
    };
    renderer = await testRender(
      () => {
        slotCalls += 1;
        return sidebarContent(
          { theme: { current: theme } },
          { session_id: 'session-1' },
        );
      },
      { width: 120, height: 40, useThread: false },
    );
    await renderer.renderOnce();

    const goalTimers = [...timers.entries()].filter(
      ([, timer]) => timer.delay === 1000,
    );
    assert.equal(goalTimers.length, 2);
    const [goalTimerHandle, goalTimer] = goalTimers[1];

    let frame = renderer.captureCharFrame();
    assert.match(frame, /OMO-Slim/);
    assert.match(frame, /Agents/);
    assert.match(frame, /Goal/);
    assert.match(frame, /Active objective/);
    assert.match(frame, /● active/);
    assert.match(frame, /· pending/);
    assert.match(frame, /Pending criterion/);

    snapshotIndex = 1;
    await goalTimer.callback();
    await renderer.renderOnce();
    frame = renderer.captureCharFrame();
    assert.doesNotMatch(frame, /Active objective/);
    assert.doesNotMatch(frame, /· pending/);
    assert.doesNotMatch(frame, /Pending criterion/);
    assert.match(frame, /Completed objective/);
    assert.match(frame, /✓ completed/);
    assert.match(frame, /1\/1 verified/);
    assert.match(frame, /✓ verified/);
    assert.equal(slotCalls, 1);

    snapshotIndex = 2;
    await goalTimer.callback();
    await renderer.renderOnce();
    frame = renderer.captureCharFrame();
    assert.match(frame, /OMO-Slim/);
    assert.match(frame, /Agents/);
    assert.doesNotMatch(frame, /Goal/);
    assert.doesNotMatch(frame, /Completed objective/);
    assert.doesNotMatch(frame, /verified/);
    assert.equal(slotCalls, 1);

    renderer.renderer.destroy();
    assert.ok(clearedTimers.includes(goalTimerHandle));
  } finally {
    renderer?.renderer.destroy();
    for (const dispose of lifecycleDisposers) await dispose();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

if (process.argv.includes(CHILD_ARGUMENT)) {
  await runMountedReactivityScenario();
} else {
  const { expect, test } = await import('bun:test');

  test('mounted V1 sidebar reconciles Goal updates under host runtime support', async () => {
    const environmentRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omos-tui-reactivity-'),
    );
    try {
      const buildRoot = path.join(environmentRoot, 'build');
      const buildResult = await Bun.build({
        entrypoints: [path.join(import.meta.dir, 'tui.ts')],
        outdir: buildRoot,
        target: 'node',
        format: 'esm',
        external: [
          '@opencode-ai/plugin',
          '@opencode-ai/plugin/tui',
          '@opentui/core',
          '@opentui/solid',
          'solid-js',
        ],
      });
      expect(
        buildResult.success,
        buildResult.logs.map((log) => log.message).join('\n'),
      ).toBe(true);
      const builtTui = fs.readFileSync(path.join(buildRoot, 'tui.js'), 'utf8');
      expect(builtTui).toMatch(/import\(["']solid-js["']\)/);
      expect(builtTui).not.toContain('solid-js/dist/');

      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          '--preload',
          '@opentui/solid/preload',
          '--preload',
          '@opentui/solid/runtime-plugin-support',
          import.meta.path,
          CHILD_ARGUMENT,
        ],
        cwd: import.meta.dir,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: environmentRoot,
          XDG_DATA_HOME: environmentRoot,
          XDG_STATE_HOME: environmentRoot,
        },
        stderr: 'pipe',
        stdout: 'pipe',
      });
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;
      expect(result.exitCode, output).toBe(0);
    } finally {
      fs.rmSync(environmentRoot, { recursive: true, force: true });
    }
  });
}
