import { beforeEach, describe, expect, test } from 'bun:test';
import { CmuxSessionStore } from './session-state';

describe('CmuxSessionStore orphan scope', () => {
  const store = new CmuxSessionStore();

  beforeEach(() => store.resetForTests());

  test('does not claim ordinary orphans without the current server scope', () => {
    for (const [session, serverUrl] of [
      ['unscoped-orphan', undefined],
      ['wrong-scope-orphan', 'http://other/'],
    ] as const) {
      store.claimCreated({
        session,
        owner: 'old',
        parent: 'p',
        title: 'agent',
        directory: '/repo',
        serverUrl,
        paneId: `${session}-pane`,
        spawnState: 'attached',
        lifecycle: 'orphaned',
        lastActivityAt: 0,
        activityVersion: 0,
        idleConsecutive: 0,
      });
    }

    expect(store.claimOrphans('new', '/repo', 'http://server/')).toEqual([]);
    expect(store.get('unscoped-orphan')?.owner).toBe('old');
    expect(store.get('wrong-scope-orphan')?.owner).toBe('old');
  });
});
