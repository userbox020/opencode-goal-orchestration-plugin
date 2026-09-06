import { describe, expect, test } from 'bun:test';
import {
  applyActivityEvent,
  resolveEventSessionID,
  TaskActivityTracker,
} from './task-activity';

describe('resolveEventSessionID', () => {
  test('keys message.updated by info.sessionID, not the message id', () => {
    expect(
      resolveEventSessionID({
        type: 'message.updated',
        properties: { info: { id: 'msg_123', sessionID: 'ses_child1' } },
      }),
    ).toBe('ses_child1');
  });

  test('keys step-finish by info.sessionID, not the step/message id', () => {
    expect(
      resolveEventSessionID({
        type: 'step-finish',
        properties: { info: { id: 'step_9', sessionID: 'ses_child1' } },
      }),
    ).toBe('ses_child1');
  });

  test('keys session-scoped events by info.id (the session id)', () => {
    expect(
      resolveEventSessionID({
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'busy' } },
      }),
    ).toBe('ses_child1');
    expect(
      resolveEventSessionID({
        type: 'session.deleted',
        properties: { info: { id: 'ses_child1' } },
      }),
    ).toBe('ses_child1');
  });

  test('falls back to properties.sessionID', () => {
    expect(
      resolveEventSessionID({
        type: 'session.status',
        properties: { sessionID: 'ses_child1', status: { type: 'retry' } },
      }),
    ).toBe('ses_child1');
  });

  test('returns undefined without any session id', () => {
    expect(
      resolveEventSessionID({
        type: 'message.updated',
        properties: { info: { id: 'msg_1' } },
      }),
    ).toBeUndefined();
  });
});

describe('TaskActivityTracker event integration', () => {
  test('message.updated activity refreshes the child session key, never the message id', () => {
    const tracker = new TaskActivityTracker();
    applyActivityEvent(
      tracker,
      {
        type: 'message.updated',
        properties: { info: { id: 'msg_1', sessionID: 'ses_child1' } },
      },
      1_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBe(1_000);
    expect(tracker.lastActivityAt('msg_1')).toBeUndefined();
  });

  test('busy session.status, retry status, and step-finish all refresh activity', () => {
    const tracker = new TaskActivityTracker();
    applyActivityEvent(
      tracker,
      {
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'busy' } },
      },
      1_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBe(1_000);

    applyActivityEvent(
      tracker,
      {
        type: 'message.updated',
        properties: { info: { id: 'msg_2', sessionID: 'ses_child1' } },
      },
      2_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBe(2_000);

    applyActivityEvent(
      tracker,
      {
        type: 'step-finish',
        properties: { info: { id: 'step_3', sessionID: 'ses_child1' } },
      },
      3_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBe(3_000);

    applyActivityEvent(
      tracker,
      {
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'retry' } },
      },
      4_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBe(4_000);
  });

  test('idle status does not refresh activity; session.deleted forgets it', () => {
    const tracker = new TaskActivityTracker();
    applyActivityEvent(
      tracker,
      {
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'busy' } },
      },
      1_000,
    );
    applyActivityEvent(
      tracker,
      {
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'idle' } },
      },
      2_000,
    );
    // Idle is not activity: the stuck timer keeps the last busy timestamp.
    expect(tracker.lastActivityAt('ses_child1')).toBe(1_000);

    applyActivityEvent(
      tracker,
      { type: 'session.deleted', properties: { info: { id: 'ses_child1' } } },
      3_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBeUndefined();
  });
});
