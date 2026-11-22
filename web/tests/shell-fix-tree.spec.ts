// V2.5-34 (panel Lane B, visual finding 2): a tree row gives its name the width, shows Caution as the HIDEROWS r6 text label
// (lane v25-conformance-2: the panel's 8px dot read as a red status dot, which needs 92 keeps for broken rows), and keeps its
// actions for hover and focus. Seam: the rendered tree in a 250 px sidebar. Since RC gap 3 (needs 92, 95) a waiting
// main-folder session has its own row, so the head line here is a project-level (board) decision, which names its source;
// the session's own line, under its row, shows its actions at rest.
import { expect, test } from './fixtures';
import { openQuiet } from './tree-seed';
import { repo, show } from './visual/compare';

test.use({ viewport: { width: 1440, height: 900 } });
test.skip(({ browserName }) => browserName !== 'chromium', 'row geometry is measured in Chromium');

const NAME = 'nightly-backtest-runner-for-lumen'; // 33 characters

async function setup(app: import('@playwright/test').Page, core: import('./fixtures').Core) {
  const p = repo(core, 'lumen');
  core.shell(p, 'asker');
  openQuiet(core);
  // The snapshot as the core sends it with a risky permission from `asker` and a project-level board decision whose
  // source is NAME (a board card carries no session; its head line names the source).
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const s of msg.sessions ?? []) {
        if (s.label !== 'asker') continue;
        Object.assign(s.attention, { working: false, stale: false, failed: false, waiting: true, last_activity: Date.now() - 600_000 });
        const base = { scope: s.project, kind: 'permission', text: 'npm install', choices: [], observed_at: Date.now() - 120_000, actionable: true, risky: true };
        const board = { identity: 'integration:ci:b1', source: 'integration', source_name: NAME, id: 'b1', title: 'Card b1', question: 'npm install', project: s.project, url: null, column: 'ask', updated_at: 1 };
        s.pending = [{ ...base, id: 'board-b1', session_id: '', board }, { ...base, id: 'd-asker', session_id: s.id }];
      }
      ws.send(JSON.stringify(msg));
    });
  });
  await show(app, 'light');
  await app.locator('.sbar.l').evaluate((e) => ((e as HTMLElement).style.width = '250px'));
  const line = app.locator('.sess.hl .q[data-risky]');
  await expect(line).toBeVisible();
  expect(Math.round((await app.locator('.sbar.l').boundingBox())!.width)).toBe(250);
  return line;
}

test('tree_row_name_full: a 250px tree shows at least 20 characters of a long name; Caution is a text label; actions only on hover or focus', async ({ app, core }) => {
  const line = await setup(app, core);
  const who = line.locator('.who');
  await expect(who).toHaveText(NAME);
  const [client, scroll] = await who.evaluate((e) => [e.clientWidth, e.scrollWidth]);
  const shown = Math.floor(NAME.length * Math.min(1, client / scroll));
  expect(shown, `${shown} of ${NAME.length} characters show (${client}px of ${scroll}px)`).toBeGreaterThanOrEqual(20);

  // Caution is the r6 label (hiderows-r6.html `.warn`: 10.5px bold word on --bad, radius 4px), its word painted whole.
  const warn = line.locator('.warn');
  await expect(warn).toHaveText('Caution');
  const css = await warn.evaluate((e) => {
    const c = getComputedStyle(e);
    return { indent: c.textIndent, fits: e.scrollWidth <= e.clientWidth + 1, h: e.getBoundingClientRect().height, radius: c.borderTopLeftRadius, bg: c.backgroundColor };
  });
  // It is drawn: before the name, inside the line (a label inside a question squeezed to nothing would never show).
  const [d, w, l] = await Promise.all([warn.boundingBox(), who.boundingBox(), line.boundingBox()]);
  expect(d!.x).toBeGreaterThanOrEqual(l!.x);
  expect(d!.x + d!.width).toBeLessThanOrEqual(w!.x);
  expect(css.indent).toBe('0px');
  expect(css.fits).toBe(true);
  expect(css.h).toBeLessThanOrEqual(16); // a label within the 28px line, not a block
  expect(parseFloat(css.radius)).toBe(4);
  expect(css.bg).not.toBe('rgba(0, 0, 0, 0)');

  // Row height is 28px.
  expect(Math.round((await line.boundingBox())!.height)).toBeLessThanOrEqual(28);

  // Actions: drawn only while the pointer or keyboard focus is on the row.
  const actions = line.locator('.ag');
  await app.mouse.move(900, 600);
  await expect(actions).toHaveCSS('opacity', '0');
  await line.hover();
  await expect(actions).toHaveCSS('opacity', '1');
  await app.mouse.move(900, 600);
  await expect(actions).toHaveCSS('opacity', '0');
  await line.focus();
  await expect(actions).toHaveCSS('opacity', '1');

  // RC gap 3 (needs 95, HIDEROWS r6): the session's own line, under its row, shows its actions at rest.
  const own = app.locator('.sess:not(.hl) .q[data-risky]');
  await expect(own).toBeVisible();
  await app.mouse.move(900, 600);
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(own.locator('.ag')).toHaveCSS('opacity', '1');
});

// The worktree row stays the approved ko/ mockup's 30px (needs 102): fidelity-tree.spec.ts pins it, this finding is the line.
test('tree_row_28px: the decision line under a project head is 28px tall', async ({ app, core }) => {
  const line = await setup(app, core);
  expect(Math.round((await line.boundingBox())!.height)).toBe(28);
});
