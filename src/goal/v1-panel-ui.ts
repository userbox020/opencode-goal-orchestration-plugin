type GoalPanelNonce = string | undefined;

/**
 * Returns the self-contained, read-only browser UI for the Goal v1 panel.
 * The optional nonce lets the host use a strict script CSP.
 */
export function renderGoalPanelPage(nonce?: GoalPanelNonce): string {
  const nonceAttribute = nonce
    ? ` nonce="${nonce.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Goal</title>
  <style>
    :root { color-scheme: light dark; --ink: #1d2a25; --muted: #62716a; --paper: #f5f6f0; --surface: #ffffff; --line: #dce2d9; --accent: #176b51; --accent-soft: #ddf0e7; --amber: #8d5900; --amber-soft: #fff0cf; --red: #a22d2d; --red-soft: #fbe4e1; --shadow: 0 18px 50px rgb(27 45 35 / 9%); }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 20rem; background: var(--paper); color: var(--ink); font-family: ui-rounded, "Aptos", "Segoe UI", system-ui, sans-serif; }
    body::before { position: fixed; z-index: -1; inset: 0; content: ""; opacity: .5; background-image: radial-gradient(circle at 4% 0%, #dceee5 0, transparent 31rem), radial-gradient(circle at 100% 100%, #e8e7cd 0, transparent 28rem); }
    main { width: min(100% - 2rem, 70rem); margin: 0 auto; padding: clamp(2rem, 6vw, 5.5rem) 0 3rem; }
    .eyebrow { margin: 0 0 .65rem; color: var(--accent); font-size: .73rem; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
    .topline { display: flex; gap: 1rem; align-items: flex-start; justify-content: space-between; border-bottom: 1px solid var(--line); padding-bottom: 1.35rem; }
    h1 { max-width: 16ch; margin: 0; font-family: ui-serif, Georgia, serif; font-size: clamp(2rem, 5vw, 4.2rem); font-weight: 650; letter-spacing: -.045em; line-height: .98; overflow-wrap: anywhere; }
    .status { flex: none; margin-top: .25rem; border: 1px solid currentColor; border-radius: 999px; padding: .38rem .68rem; font-size: .78rem; font-weight: 700; line-height: 1; text-transform: capitalize; }
    .status.active, .status.completed { color: var(--accent); background: var(--accent-soft); }.status.paused { color: var(--amber); background: var(--amber-soft); }.status.cancelled { color: var(--red); background: var(--red-soft); }
    .summary { display: grid; grid-template-columns: minmax(13rem, .72fr) minmax(0, 1.28fr); gap: 1px; margin: 2rem 0; overflow: hidden; border: 1px solid var(--line); border-radius: 1rem; background: var(--line); box-shadow: var(--shadow); }
    .summary > section { padding: clamp(1.25rem, 3vw, 2.25rem); background: color-mix(in srgb, var(--surface) 94%, transparent); }
    .summary-label { margin: 0 0 .55rem; color: var(--muted); font-size: .78rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }.progress-number { margin: 0; font-size: clamp(2.4rem, 6vw, 4.75rem); font-weight: 750; letter-spacing: -.06em; line-height: .9; }.progress-number span { font-size: .42em; letter-spacing: -.03em; }.progress-note { margin: .9rem 0 0; color: var(--muted); line-height: 1.45; }
    .meter { height: .55rem; margin: 1.2rem 0 .75rem; overflow: hidden; border-radius: 999px; background: var(--line); }.meter > span { display: block; width: 0; height: 100%; border-radius: inherit; background: var(--accent); transition: width 500ms ease; }.percent { margin: 0; font-size: 1.25rem; font-weight: 700; }
    .ledger-header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin: 2.7rem 0 .8rem; }.ledger-header h2 { margin: 0; font-family: ui-serif, Georgia, serif; font-size: 1.55rem; letter-spacing: -.025em; }.ledger-header p { margin: 0; color: var(--muted); font-size: .88rem; }
    .ledger { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }.criterion { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: .9rem; align-items: start; padding: 1.05rem .2rem; border-bottom: 1px solid var(--line); }.mark { display: grid; width: 1.2rem; height: 1.2rem; place-items: center; margin-top: .08rem; border: 1px solid var(--line); border-radius: 50%; color: var(--muted); font-size: .75rem; }.criterion.verified .mark { border-color: var(--accent); background: var(--accent); color: white; }.criterion.contradicted .mark { border-color: var(--red); background: var(--red-soft); color: var(--red); }.criterion p { margin: 0; line-height: 1.45; overflow-wrap: anywhere; }.criterion small { color: var(--muted); font-size: .74rem; font-weight: 700; text-transform: capitalize; }.criterion.contradicted small { color: var(--red); }
    .empty, .message { border: 1px dashed var(--line); border-radius: .8rem; padding: 1.35rem; color: var(--muted); line-height: 1.5; }.message { margin-top: 2rem; background: color-mix(in srgb, var(--surface) 70%, transparent); }.message h1 { max-width: none; font-size: clamp(2rem, 5vw, 3.5rem); }.message p { max-width: 42rem; }.message.error { border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }.message button { margin-top: .4rem; }
    button { border: 1px solid var(--ink); border-radius: .45rem; padding: .55rem .8rem; background: var(--ink); color: var(--surface); font: inherit; font-weight: 700; cursor: pointer; } button:hover { background: var(--accent); border-color: var(--accent); } button:focus-visible { outline: 3px solid #d48d00; outline-offset: 3px; }
    footer { display: flex; flex-wrap: wrap; gap: .35rem .9rem; margin-top: 2rem; color: var(--muted); font-family: ui-monospace, "Cascadia Code", monospace; font-size: .72rem; }.paused-note, .terminal-note { margin: 0 0 1rem; padding: .8rem 1rem; border-left: 3px solid var(--amber); background: var(--amber-soft); color: #654000; line-height: 1.4; }.terminal-note { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }.cancelled-note { border-color: var(--red); background: var(--red-soft); color: var(--red); }
    @media (max-width: 40rem) { main { width: min(100% - 1.25rem, 70rem); padding-top: 2rem; }.topline { gap: .65rem; }.summary { grid-template-columns: 1fr; }.criterion { grid-template-columns: auto minmax(0, 1fr); }.criterion small { grid-column: 2; }.ledger-header { align-items: flex-start; flex-direction: column; gap: .2rem; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
  </style>
</head>
<body>
  <main id="app" aria-live="polite" aria-busy="true"></main>
  <script${nonceAttribute}>
    (() => {
      'use strict';
      const app = document.getElementById('app');
      const hash = window.location.hash.slice(1);
      let token = '';
      try { token = decodeURIComponent(hash.startsWith('token=') ? hash.slice(6) : hash); } catch { token = hash; }
      if (window.location.hash) history.replaceState(null, '', location.pathname + location.search);
      let timer = null, controller = null, stopped = false, failures = 0, resumeRequested = false;
      const statuses = new Set(['active', 'paused', 'completed', 'cancelled']);
      const criterionStatuses = new Set(['pending', 'verified', 'contradicted']);
      const el = (name, className) => { const node = document.createElement(name); if (className) node.className = className; return node; };
      const text = (node, value) => { node.textContent = String(value); return node; };
      const clear = () => app.replaceChildren();
      const add = (parent, name, value, className) => { const node = el(name, className); if (value !== undefined) text(node, value); parent.append(node); return node; };
      const button = (parent, label) => { const node = add(parent, 'button', label); node.type = 'button'; node.addEventListener('click', () => request(true)); return node; };
      function message(title, copy, kind, retry) { clear(); app.setAttribute('aria-busy', 'false'); const box = el('section', 'message' + (kind ? ' ' + kind : '')); box.setAttribute('role', kind === 'error' ? 'alert' : 'status'); add(box, 'p', 'Goal panel', 'eyebrow'); add(box, 'h1', title); add(box, 'p', copy); if (retry) button(box, 'Retry'); app.append(box); }
      function valid(snapshot) {
        if (!snapshot || snapshot.apiVersion !== 1 || (snapshot.state !== 'goal' && snapshot.state !== 'no-goal')) return false;
        if (snapshot.state === 'no-goal') return true;
        const goal = snapshot.goal;
        return !!goal && typeof goal.id === 'string' && typeof goal.objective === 'string' && statuses.has(goal.status) && Number.isFinite(goal.revision) && Number.isFinite(goal.recordVersion) && Number.isFinite(goal.epoch) && goal.progress && Number.isFinite(goal.progress.verified) && Number.isFinite(goal.progress.total) && Number.isFinite(goal.progress.percent) && Array.isArray(goal.criteria) && goal.criteria.every((item) => item && typeof item.id === 'string' && typeof item.text === 'string' && criterionStatuses.has(item.status));
      }
      function render(snapshot) {
        if (snapshot.state === 'no-goal') { message('No Goal yet', 'Create a Goal, then refresh this panel.', '', false); return; }
        clear(); app.setAttribute('aria-busy', 'false'); const goal = snapshot.goal, terminal = goal.status === 'completed' || goal.status === 'cancelled';
        const header = el('header'); const top = el('div', 'topline'); const heading = el('div'); add(heading, 'p', 'Current goal', 'eyebrow'); add(heading, 'h1', goal.objective); top.append(heading); add(top, 'span', goal.status, 'status ' + goal.status); header.append(top); app.append(header);
        if (goal.status === 'paused') add(app, 'p', 'This Goal is paused. Progress remains visible while work is on hold.', 'paused-note');
        if (terminal) add(app, 'p', goal.status === 'completed' ? 'This Goal is complete. The ledger is retained as its final record.' : 'This Goal was cancelled. The ledger is retained as its final record.', 'terminal-note' + (goal.status === 'cancelled' ? ' cancelled-note' : ''));
        const summary = el('section', 'summary'); const quantity = el('section'); add(quantity, 'p', 'Verified criteria', 'summary-label'); const number = add(quantity, 'p', undefined, 'progress-number'); text(number, goal.progress.verified + ' '); const of = el('span'); text(of, 'of ' + goal.progress.total); number.append(of); add(quantity, 'p', goal.progress.total === 0 ? 'No criteria have been added to this revision.' : 'Criteria verified against this Goal.', 'progress-note'); summary.append(quantity);
        const progress = el('section'); add(progress, 'p', 'Progress', 'summary-label'); const meter = el('div', 'meter'); meter.setAttribute('role', 'progressbar'); meter.setAttribute('aria-label', 'Verified criteria progress'); meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', String(Math.max(0, goal.progress.total))); meter.setAttribute('aria-valuenow', String(Math.max(0, goal.progress.verified))); const fill = el('span'); const percent = goal.progress.total === 0 ? 0 : Math.max(0, Math.min(100, goal.progress.percent)); fill.style.width = percent + '%'; meter.append(fill); progress.append(meter); add(progress, 'p', goal.progress.total === 0 ? '—' : percent + '%', 'percent'); summary.append(progress); app.append(summary);
        const ledgerHeader = el('div', 'ledger-header'); add(ledgerHeader, 'h2', 'Criteria ledger'); add(ledgerHeader, 'p', goal.criteria.length + (goal.criteria.length === 1 ? ' criterion' : ' criteria')); app.append(ledgerHeader);
        if (!goal.criteria.length) { add(app, 'p', 'No criteria are listed for this revision.', 'empty'); } else { const list = el('ol', 'ledger'); goal.criteria.forEach((criterion) => { const item = el('li', 'criterion ' + criterion.status); const mark = add(item, 'span', criterion.status === 'verified' ? '✓' : criterion.status === 'contradicted' ? '!' : '·', 'mark'); mark.setAttribute('aria-hidden', 'true'); add(item, 'p', criterion.text); add(item, 'small', criterion.status); list.append(item); }); app.append(list); }
        const footer = el('footer'); add(footer, 'span', 'Revision ' + goal.revision); add(footer, 'span', 'Record ' + goal.recordVersion); add(footer, 'span', 'Epoch ' + goal.epoch); app.append(footer);
      }
      function schedule(delay) { if (!stopped && !document.hidden) { window.clearTimeout(timer); timer = window.setTimeout(() => request(false), delay); } }
      async function request(force) {
        if (stopped || document.hidden) return;
        if (controller) { if (force) resumeRequested = true; return; }
        window.clearTimeout(timer); timer = null;
        if (!token) { message('Access expired', 'Rerun /goal panel to open a fresh panel.', 'error', false); return; }
        if (force) failures = 0; controller = new AbortController(); app.setAttribute('aria-busy', 'true');
        const timeout = window.setTimeout(() => controller?.abort(), 10000);
        try { const response = await fetch('/api/v1/snapshot', { headers: { Authorization: 'Bearer ' + token }, signal: controller.signal, cache: 'no-store' }); if (response.status === 401 || response.status === 403) { stopped = true; message('Access expired', 'Rerun /goal panel to open a fresh panel.', 'error', false); return; } if (!response.ok) throw new Error('unavailable'); const snapshot = await response.json(); if (!valid(snapshot)) { message('Goal data could not be read', 'The panel received an unexpected response. Rerun /goal panel or retry shortly.', 'error', true); return; } failures = 0; render(snapshot); schedule(snapshot.state === 'goal' && (snapshot.goal.status === 'active' || snapshot.goal.status === 'paused') ? 2000 : 5000); } catch (error) { if (stopped || document.hidden) return; failures += 1; message('Goal panel is unavailable', 'The local Goal service could not be reached.', 'error', true); schedule(Math.min(1000 * 2 ** (failures - 1), 10000)); } finally { window.clearTimeout(timeout); controller = null; if (resumeRequested && !stopped && !document.hidden) { resumeRequested = false; request(true); } }
      }
      document.addEventListener('visibilitychange', () => { if (document.hidden) { window.clearTimeout(timer); timer = null; if (controller) controller.abort(); } else { request(true); } });
      window.addEventListener('pagehide', () => { stopped = true; window.clearTimeout(timer); if (controller) controller.abort(); });
      window.addEventListener('pageshow', (event) => { if (event.persisted) { stopped = false; request(true); } });
      message('Loading Goal', 'Reading the current Goal from this local workspace.', '', false); request(false);
    })();
  </script>
</body>
</html>`;
}
