/**
 * Activity event shapes the tracker consumes. `info.id` is the session id
 * for session-scoped events (session.*) but the message/step id for
 * message-scoped events (message.updated, step-finish); the session id for
 * those lives in `info.sessionID`.
 */
export interface ActivityEvent {
  type: string;
  properties?: {
    info?: { id?: string; sessionID?: string };
    sessionID?: string;
    status?: { type?: string };
  };
}

/**
 * Resolves the session id from an event, keying message/step-scoped events
 * by `info.sessionID` (never the message id) and session-scoped events by
 * `info.id`. Returns undefined when no session id is present.
 */
export function resolveEventSessionID(
  event: ActivityEvent,
): string | undefined {
  const info = event.properties?.info;
  if (event.type === 'message.updated' || event.type === 'step-finish') {
    return info?.sessionID ?? event.properties?.sessionID;
  }
  return info?.id ?? event.properties?.sessionID;
}

/** True when the event is observable child activity that refreshes the stuck timer. */
export function shouldRecordActivity(event: ActivityEvent): boolean {
  const statusType = event.properties?.status?.type;
  return (
    event.type === 'message.updated' ||
    event.type === 'step-finish' ||
    (event.type === 'session.status' &&
      (statusType === 'busy' || statusType === 'retry'))
  );
}

/** True when the session is gone and its activity bookkeeping can be dropped. */
export function shouldForgetActivity(event: ActivityEvent): boolean {
  return event.type === 'session.deleted';
}

export class TaskActivityTracker {
  private readonly activity = new Map<string, number>();

  touch(sessionID: string, now = Date.now()): void {
    if (sessionID) this.activity.set(sessionID, now);
  }

  lastActivityAt(sessionID: string): number | undefined {
    return this.activity.get(sessionID);
  }

  forget(sessionID: string): void {
    this.activity.delete(sessionID);
  }
}

/**
 * Applies an event to the tracker: records activity for live child signals
 * keyed by session id, forgets sessions on deletion. This mirrors the wiring
 * in src/index.ts so the event policy is testable in isolation.
 */
export function applyActivityEvent(
  tracker: TaskActivityTracker,
  event: ActivityEvent,
  now = Date.now(),
): void {
  const sessionID = resolveEventSessionID(event);
  if (!sessionID) return;
  if (shouldRecordActivity(event)) {
    tracker.touch(sessionID, now);
  } else if (shouldForgetActivity(event)) {
    tracker.forget(sessionID);
  }
}
