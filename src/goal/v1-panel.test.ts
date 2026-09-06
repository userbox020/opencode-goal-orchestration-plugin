import { afterEach, describe, expect, test } from 'bun:test';
import { createGoalPanelManager, type GoalPanelManager } from './v1-panel';

const managers: GoalPanelManager[] = [];

function manager(opened: string[] = []): GoalPanelManager {
  const value = createGoalPanelManager({
    openBrowser: (url) => {
      opened.push(url);
    },
  });
  managers.push(value);
  return value;
}

function capability(link: string): { origin: string; token: string } {
  const url = new URL(link);
  expect(url.protocol).toBe('http:');
  expect(url.hostname).toBe('127.0.0.1');
  expect(Number(url.port)).toBeGreaterThan(0);
  expect(url.pathname).toBe('/');
  expect(url.search).toBe('');
  return { origin: url.origin, token: url.hash.slice(1) };
}

async function snapshotResponse(
  origin: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${origin}/api/v1/snapshot`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((value) => value.dispose()));
});

describe('V1 Goal panel manager', () => {
  test('reports launcher failure without exposing its URL or revoking the previous panel', async () => {
    let attempts = 0;
    const panel = createGoalPanelManager({
      openBrowser: async (url) => {
        if (++attempts > 1) throw new Error(url);
      },
    });
    managers.push(panel);
    const input = {
      sessionID: 'launch-retry',
      readSnapshot: () => ({
        apiVersion: 1 as const,
        state: 'no-goal' as const,
      }),
    };
    const issued = capability(await panel.openPanel(input));
    await expect(panel.openPanel(input)).rejects.toThrow(
      'Goal panel could not be opened',
    );
    expect((await snapshotResponse(issued.origin, issued.token)).status).toBe(
      200,
    );
  });

  test('uses an ephemeral localhost listener and serves a static no-secret page', async () => {
    const opened: string[] = [];
    const panel = manager(opened);
    const link = await panel.openPanel({
      sessionID: 'session-a',
      readSnapshot: () => ({ apiVersion: 1, state: 'no-goal' }),
    });
    const { origin, token } = capability(link);

    expect(opened).toEqual([link]);
    const page = await fetch(origin);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<title>Goal</title>');
    expect(html).not.toContain(token);
    expect(html).not.toContain('session-a');
    expect(page.headers.get('content-security-policy')).toContain(
      "script-src 'nonce-",
    );
  });

  test('allows bearer snapshot access and rejects unsafe credential transports', async () => {
    const snapshot = { apiVersion: 1 as const, state: 'no-goal' as const };
    const panel = manager();
    const { origin, token } = capability(
      await panel.openPanel({
        sessionID: 'session-a',
        readSnapshot: () => snapshot,
      }),
    );

    const valid = await snapshotResponse(origin, token);
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual(snapshot);

    expect(
      (
        await fetch(`${origin}/api/v1/snapshot`, {
          headers: { Accept: 'application/json' },
        })
      ).status,
    ).toBe(401);
    expect((await snapshotResponse(origin, 'wrong-token')).status).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/v1/snapshot?token=${token}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await snapshotResponse(origin, token, {
          headers: { Cookie: 'goal=capability' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await snapshotResponse(origin, token, {
          method: 'POST',
        })
      ).status,
    ).toBe(404);
  });

  test('isolates sessions and rotates only the reopened session capability', async () => {
    const panel = manager();
    const snapshotA = { apiVersion: 1 as const, state: 'no-goal' as const };
    const snapshotB = {
      apiVersion: 1 as const,
      state: 'goal' as const,
      goal: {
        id: 'goal-b',
        objective: 'B',
        status: 'active' as const,
        revision: 1,
        recordVersion: 0,
        epoch: 0,
        progress: { verified: 0, total: 1, percent: 0 },
        criteria: [
          { id: 'criterion-1', text: 'B', status: 'pending' as const },
        ],
      },
    };
    const firstA = capability(
      await panel.openPanel({
        sessionID: 'session-a',
        readSnapshot: () => snapshotA,
      }),
    );
    const sessionB = capability(
      await panel.openPanel({
        sessionID: 'session-b',
        readSnapshot: () => snapshotB,
      }),
    );
    const secondA = capability(
      await panel.openPanel({
        sessionID: 'session-a',
        readSnapshot: () => snapshotA,
      }),
    );

    expect((await snapshotResponse(firstA.origin, firstA.token)).status).toBe(
      401,
    );
    expect(
      await (await snapshotResponse(sessionB.origin, sessionB.token)).json(),
    ).toEqual(snapshotB);
    expect(
      await (await snapshotResponse(secondA.origin, secondA.token)).json(),
    ).toEqual(snapshotA);
  });

  test('deleted sessions cannot issue or use capabilities, including an in-flight open check', async () => {
    const panel = manager();
    const issued = capability(
      await panel.openPanel({
        sessionID: 'deleted-session',
        readSnapshot: () => ({ apiVersion: 1, state: 'no-goal' }),
      }),
    );
    panel.revokeSession('deleted-session');

    await expect(
      panel.openPanel({
        sessionID: 'deleted-session',
        readSnapshot: () => ({ apiVersion: 1, state: 'no-goal' }),
      }),
    ).rejects.toThrow('Goal panel is unavailable');
    expect((await snapshotResponse(issued.origin, issued.token)).status).toBe(
      401,
    );

    const pending = panel.openPanel({
      sessionID: 'in-flight-session',
      readSnapshot: () => ({ apiVersion: 1, state: 'no-goal' }),
    });
    panel.revokeSession('in-flight-session');
    await expect(pending).rejects.toThrow('Goal panel is unavailable');
  });

  test('disposal revokes existing capabilities and prevents late opens', async () => {
    const opened: string[] = [];
    const panel = manager(opened);
    const issued = capability(
      await panel.openPanel({
        sessionID: 'session-a',
        readSnapshot: () => ({ apiVersion: 1, state: 'no-goal' }),
      }),
    );
    await panel.dispose();

    await expect(
      snapshotResponse(issued.origin, issued.token),
    ).rejects.toThrow();
    await expect(
      panel.openPanel({
        sessionID: 'session-a',
        readSnapshot: () => ({ apiVersion: 1, state: 'no-goal' }),
      }),
    ).rejects.toThrow('Goal panel is unavailable');
    expect(opened).toHaveLength(1);
  });
});
