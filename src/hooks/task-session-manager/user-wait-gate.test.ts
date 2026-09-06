import { beforeEach, describe, expect, test } from 'bun:test';
import {
  beginUserWait,
  clearUserWait,
  clearUserWaitForMessage,
  hasUserWait,
  resetUserWaitGateForTests,
} from './user-wait-gate';

describe('user wait gate', () => {
  beforeEach(() => {
    resetUserWaitGateForTests();
  });

  test('beginUserWait arms hasUserWait until a distinct external message', () => {
    beginUserWait('parent-1');
    expect(hasUserWait('parent-1')).toBe(true);

    expect(clearUserWaitForMessage('parent-1', 'msg-1')).toBe(true);
    expect(hasUserWait('parent-1')).toBe(false);

    beginUserWait('parent-1');
    expect(clearUserWaitForMessage('parent-1', 'msg-1')).toBe(false);
    expect(hasUserWait('parent-1')).toBe(true);

    expect(clearUserWaitForMessage('parent-1', 'msg-2')).toBe(true);
    expect(hasUserWait('parent-1')).toBe(false);
  });

  test('clearUserWait drops wait and rearm identity', () => {
    beginUserWait('parent-1');
    clearUserWaitForMessage('parent-1', 'msg-1');
    beginUserWait('parent-1');
    clearUserWait('parent-1');
    expect(hasUserWait('parent-1')).toBe(false);
    // After full clear, the same message identity can clear a new wait.
    beginUserWait('parent-1');
    expect(clearUserWaitForMessage('parent-1', 'msg-1')).toBe(true);
  });

  test('wait state is shared across gate consumers in-process', () => {
    beginUserWait('parent-1');
    expect(hasUserWait('parent-1')).toBe(true);
  });
});
