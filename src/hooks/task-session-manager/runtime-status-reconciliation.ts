import type { PluginInput } from '@opencode-ai/plugin';
import type {
  BackgroundJobRecord,
  BackgroundJobStore,
  ContextFile,
} from '../../utils';
import {
  getRuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../../utils';
import { log } from '../../utils/logger';
import {
  observeNonBusyRuntime,
  STOP_CONFIRMATION_GRACE_MS,
} from './stop-confirmation';

export const RUNTIME_STATUS_RECONCILE_DELAY_MS = 5_000;

export function createRuntimeStatusReconciler(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  delayMs?: number;
  statusTimeoutMs?: number;
  stopConfirmationGraceMs?: number;
  /**
   * Historical launches are not trusted until the host confirms this exact
   * board generation is live. Values are expected board generations by task.
   */
  pendingLiveRunning?: Map<string, number>;
  /** Called once when a pending historical generation is live-confirmed. */
  onLiveRunning?: (record: BackgroundJobRecord) => void | Promise<void>;
  taskContextTracker: {
    pendingManagedTaskIds: Set<string>;
    contextFilesForPrompt(taskId: string): ContextFile[];
    prune(board: { taskIDs(): Set<string> }): void;
  };
}) {
  const delayMs = options.delayMs ?? RUNTIME_STATUS_RECONCILE_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let activeReconcile: Promise<void> | undefined;
  let rerunRequested = false;

  function discardPendingLiveRunning(taskID: string, generation?: number): void {
    if (
      generation === undefined ||
      options.pendingLiveRunning?.get(taskID) === generation
    ) {
      options.pendingLiveRunning?.delete(taskID);
    }
  }

  function prunePendingLiveRunning(): void {
    for (const [taskID, generation] of options.pendingLiveRunning ?? []) {
      const record = options.backgroundJobBoard.get(taskID);
      if (record?.generation !== generation || record.state !== 'running') {
        options.pendingLiveRunning?.delete(taskID);
      }
    }
  }

  function schedule(): void {
    if (disposed) return;
    if (activeReconcile) {
      rerunRequested = true;
      return;
    }
    if (timer) return;
    if (
      !options.backgroundJobBoard.list().some((job) => job.state === 'running')
    ) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void reconcile();
    }, delayMs);
    timer.unref?.();
  }

  async function reconcilePass(): Promise<void> {
    if (disposed) return;
    prunePendingLiveRunning();
    const running = options.backgroundJobBoard
      .list()
      .filter((job) => job.state === 'running');
    if (running.length === 0) return;

    const requestStartedAt = Date.now();
    const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
      timeoutMs: options.statusTimeoutMs,
    });
    if (disposed) return;
    const observedAt = Date.now();
    const graceMs =
      options.stopConfirmationGraceMs ?? STOP_CONFIRMATION_GRACE_MS;
    if (snapshot.error) {
      for (const job of running) {
        options.backgroundJobBoard.markStatusUncertain(
          job.taskID,
          `Runtime status lookup failed: ${snapshot.error}`,
          job.generation,
        );
      }
      log('[task-session-manager] runtime status reconciliation uncertain', {
        activeJobs: running.length,
        error: snapshot.error,
      });
      return;
    }

    for (const job of running) {
      if (disposed) return;
      const current = options.backgroundJobBoard.get(job.taskID);
      if (
        current?.state !== 'running' ||
        current.generation !== job.generation
      ) {
        discardPendingLiveRunning(job.taskID, job.generation);
        continue;
      }
      const status = runtimeSessionStatus(snapshot, job.taskID);
      if (status === 'busy' || status === 'retry') {
        const confirmed = options.backgroundJobBoard.markRunningFromLiveSession(
          job.taskID,
          observedAt,
          job.generation,
        );
        if (
          confirmed?.state === 'running' &&
          confirmed.generation === job.generation &&
          options.pendingLiveRunning?.get(job.taskID) === job.generation
        ) {
          // Delete before invoking user code so repeated reconciliation or a
          // callback failure cannot bind this historical identity twice.
          options.pendingLiveRunning.delete(job.taskID);
          await options.onLiveRunning?.(confirmed);
        }
        continue;
      }
      if (
        status === undefined &&
        snapshot.malformedSessionIDs.has(job.taskID)
      ) {
        options.backgroundJobBoard.markStatusUncertain(
          job.taskID,
          'Runtime status response did not contain a recognized session state.',
          job.generation,
        );
        continue;
      }

      const lastStatusError =
        status === undefined
          ? 'Runtime status response did not contain a live session state; task termination is unconfirmed.'
          : 'Runtime session is idle; task termination is unconfirmed.';
      const updated = observeNonBusyRuntime({
        backgroundJobBoard: options.backgroundJobBoard,
        taskID: job.taskID,
        observedAt: requestStartedAt,
        generation: job.generation,
        graceMs,
        lastStatusError,
        taskContextTracker: options.taskContextTracker,
      });
      if (updated?.state === 'stopped') {
        discardPendingLiveRunning(job.taskID, job.generation);
        log('[task-session-manager] confirmed runtime-stopped job', {
          taskID: updated.taskID,
          alias: updated.alias,
          parentSessionID: updated.parentSessionID,
        });
        continue;
      }
      log(
        '[task-session-manager] runtime session quiescent; terminal result pending',
        {
          taskID: job.taskID,
          generation: job.generation,
        },
      );
    }
  }

  async function reconcile(): Promise<void> {
    if (disposed) return;
    if (activeReconcile) {
      rerunRequested = true;
      await activeReconcile;
      return;
    }

    const run = (async () => {
      try {
        do {
          rerunRequested = false;
          await reconcilePass();
        } while (!disposed && rerunRequested);
      } finally {
        activeReconcile = undefined;
        schedule();
      }
    })();
    activeReconcile = run;
    await run;
  }

  function dispose(): void {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    options.pendingLiveRunning?.clear();
  }

  return { schedule, reconcile, dispose };
}
