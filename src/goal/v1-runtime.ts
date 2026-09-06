import type { GoalRuntimeComposition } from './core';

/**
 * Serializes only in-flight board-run rehydration. A later independent caller
 * still revalidates the durable fence, while concurrent lifecycle paths share
 * the same CAS-backed initialization.
 */
export function createGoalSessionRuntimeResolver(options: {
  runtimes: Map<string, GoalRuntimeComposition>;
  boardRunID: string;
  createRuntime: (sessionID: string) => GoalRuntimeComposition;
}): (sessionID: string) => Promise<GoalRuntimeComposition> {
  const inFlight = new Map<string, Promise<GoalRuntimeComposition>>();

  return (sessionID) => {
    const pending = inFlight.get(sessionID);
    if (pending) return pending;

    const initialization = Promise.resolve().then(async () => {
      try {
        let runtime = options.runtimes.get(sessionID);
        if (!runtime) {
          runtime = options.createRuntime(sessionID);
          options.runtimes.set(sessionID, runtime);
        }
        await runtime.observer.rehydrateBoardRun({
          boardRunID: options.boardRunID,
          expected: runtime.observer.boardRunFence(),
        });
        return runtime;
      } finally {
        // A rejected persistence attempt must not poison future callers.
        inFlight.delete(sessionID);
      }
    });
    inFlight.set(sessionID, initialization);
    return initialization;
  };
}
