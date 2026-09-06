/**
 * Tmux multiplexer implementation
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import {
  buildOpencodeAttachCommand,
  findBinary,
  gracefulClosePane,
} from '../shared';
import { readTmuxPane } from '../tmux-pane-registry';
import type { Multiplexer, PaneResult, PaneSpawnOptions } from '../types';

const TMUX_LAYOUT_DEBOUNCE_MS = 150;

export class TmuxMultiplexer implements Multiplexer {
  readonly type = 'tmux' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private storedLayout: MultiplexerLayout;
  private storedMainPaneSize: number;
  private targetPane = process.env.TMUX_PANE;
  private layoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private paneTargets = new Map<string, string | undefined>();

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }

    this.binaryPath = await findBinary('tmux', { verify: true });
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!process.env.TMUX;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    const tmux = await this.getBinary();
    if (!tmux) {
      log('[tmux] spawnPane: tmux binary not found');
      return { success: false };
    }

    try {
      // Build the attach command
      const opencodeCmd = buildOpencodeAttachCommand(
        sessionId,
        serverUrl,
        directory,
      );

      const registeredTarget = options?.parentSessionId
        ? readTmuxPane(options.parentSessionId)
        : undefined;
      let targetPane = registeredTarget ?? this.targetPane;
      let result = await this.splitPane(tmux, targetPane, opencodeCmd);

      if (
        result.exitCode !== 0 &&
        registeredTarget &&
        this.targetPane !== registeredTarget
      ) {
        log('[tmux] spawnPane: registered target failed, using fallback', {
          registeredTarget,
          fallbackTarget: this.targetPane,
        });
        targetPane = this.targetPane;
        result = await this.splitPane(tmux, targetPane, opencodeCmd);
      }

      const paneId = result.stdout.trim();

      log('[tmux] spawnPane: result', {
        exitCode: result.exitCode,
        paneId,
        stderr: result.stderr.trim(),
        targetPane,
      });

      if (result.exitCode === 0 && paneId) {
        // Rename the pane for visibility
        const renameProc = crossSpawn(
          [tmux, 'select-pane', '-t', paneId, '-T', description.slice(0, 30)],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        await renameProc.exited;

        // Rebalance panes after bursts of child sessions settle.
        this.paneTargets.set(paneId, targetPane);
        this.scheduleLayout(targetPane);

        log('[tmux] spawnPane: SUCCESS', { paneId });
        return { success: true, paneId };
      }

      return { success: false };
    } catch (err) {
      log('[tmux] spawnPane: exception', { error: String(err) });
      return { success: false };
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    const tmux = await this.getBinary();
    const layoutTarget = this.paneTargets.get(paneId) ?? this.targetPane;
    const closed = await gracefulClosePane(tmux, paneId, {
      ctrlC: ['send-keys', '-t', paneId, 'C-c'],
      close: ['kill-pane', '-t', paneId],
    });
    if (closed) {
      this.paneTargets.delete(paneId);
      this.scheduleLayout(layoutTarget);
    }
    return closed;
  }

  async applyLayout(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    for (const timer of this.layoutTimers.values()) clearTimeout(timer);
    this.layoutTimers.clear();
    await this.applyLayoutNow(layout, mainPaneSize, this.targetPane);
  }

  private scheduleLayout(targetPane: string | undefined): void {
    const key = targetPane ?? '';
    const pending = this.layoutTimers.get(key);
    if (pending) clearTimeout(pending);

    const timer = setTimeout(() => {
      this.layoutTimers.delete(key);
      void this.applyLayoutNow(
        this.storedLayout,
        this.storedMainPaneSize,
        targetPane,
      );
    }, TMUX_LAYOUT_DEBOUNCE_MS);
    this.layoutTimers.set(key, timer);
    timer.unref?.();
  }

  private async applyLayoutNow(
    layout: MultiplexerLayout,
    mainPaneSize: number,
    targetPane: string | undefined,
  ): Promise<void> {
    const tmux = await this.getBinary();
    if (!tmux) return;

    // Store for later use
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;

    try {
      // Apply the layout
      const layoutResult = await this.runTmux(tmux, [
        'select-layout',
        ...this.targetArgs(targetPane),
        layout,
      ]);
      if (layoutResult !== 0) return;

      // For main-* layouts, set the main pane size
      if (layout === 'main-horizontal' || layout === 'main-vertical') {
        const sizeOption =
          layout === 'main-horizontal' ? 'main-pane-height' : 'main-pane-width';

        const sizeResult = await this.runTmux(tmux, [
          'set-window-option',
          ...this.targetArgs(targetPane),
          sizeOption,
          `${mainPaneSize}%`,
        ]);
        if (sizeResult !== 0) return;

        // Reapply layout to use the new size
        const reapplyResult = await this.runTmux(tmux, [
          'select-layout',
          ...this.targetArgs(targetPane),
          layout,
        ]);
        if (reapplyResult !== 0) return;
      }

      log('[tmux] applyLayout: applied', { layout, mainPaneSize });
    } catch (err) {
      log('[tmux] applyLayout: exception', { error: String(err) });
    }
  }

  private async runTmux(tmux: string, args: string[]): Promise<number> {
    const proc = crossSpawn([tmux, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      proc.stdout(),
      proc.stderr(),
    ]);

    if (exitCode !== 0) {
      log('[tmux] command failed', {
        command: args[0],
        args: [tmux, ...args],
        exitCode,
        stderr: stderr.trim(),
      });
    }

    return exitCode;
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }

  private async splitPane(
    tmux: string,
    targetPane: string | undefined,
    opencodeCmd: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const args = [
      'split-window',
      '-h',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      ...this.targetArgs(targetPane),
      opencodeCmd,
    ];
    log('[tmux] spawnPane: executing', { tmux, args });

    const proc = crossSpawn([tmux, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      proc.stdout(),
      proc.stderr(),
    ]);
    return { exitCode, stdout, stderr };
  }

  private targetArgs(targetPane = this.targetPane): string[] {
    return targetPane ? ['-t', targetPane] : [];
  }
}
