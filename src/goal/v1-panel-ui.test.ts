import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderGoalPanelPage } from './v1-panel-ui';

test('panel consumes fragment auth, renders text safely, and resumes after back navigation', async () => {
  const requests: Array<{ url: string; authorization: string }> = [];
  const objective = '<img src=x onerror=alert(1)>Goal';
  const dom = new JSDOM(renderGoalPanelPage(), {
    url: 'http://127.0.0.1:4444/#fixture-capability',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.AbortController = AbortController;
      window.fetch = (async (url: string, init: RequestInit) => {
        requests.push({
          url,
          authorization: (init.headers as Record<string, string>).Authorization,
        });
        return new Response(
          JSON.stringify({
            apiVersion: 1,
            state: 'goal',
            goal: {
              id: 'goal-1',
              objective,
              status: 'active',
              revision: 1,
              recordVersion: 1,
              epoch: 1,
              progress: { verified: 0, total: 1, percent: 0 },
              criteria: [
                { id: 'criterion-1', text: objective, status: 'pending' },
              ],
            },
          }),
        );
      }) as typeof fetch;
    },
  });
  try {
    // Execute our bundled script against the DOM without Bun's unsupported jsdom VM globals.
    const script =
      dom.window.document.querySelector('script')?.textContent ?? '';
    const run = new Function(
      'window',
      'document',
      'history',
      'location',
      'AbortController',
      'fetch',
      script,
    );
    run(
      dom.window,
      dom.window.document,
      dom.window.history,
      dom.window.location,
      AbortController,
      dom.window.fetch,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dom.window.location.hash).toBe('');
    expect(requests).toEqual([
      { url: '/api/v1/snapshot', authorization: 'Bearer fixture-capability' },
    ]);
    expect(dom.window.document.querySelector('h1')?.textContent).toBe(
      objective,
    );
    expect(dom.window.document.querySelector('img')).toBeNull();
    for (let restored = 0; restored < 2; restored++) {
      dom.window.dispatchEvent(
        new dom.window.PageTransitionEvent('pagehide', { persisted: true }),
      );
      dom.window.dispatchEvent(
        new dom.window.PageTransitionEvent('pageshow', { persisted: true }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(requests).toHaveLength(restored + 2);
    }
  } finally {
    dom.window.close();
  }
});
