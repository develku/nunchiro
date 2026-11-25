// Ticket 1096: "New Lead conversation" from the palette, the tab + menu and the project row menu: one palette command
// (lead.fresh) that sends one team_open with `fresh`, offered only while the project has a lead. The core's handover and
// time limit are covered in crates/nunchiro-core/src/team.rs; here the core's answers to team_list and team_open are
// stood in for, so each surface's op is counted exactly. Shots go to .scratch/shots (SHOT_TAG=before on the old code).
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, test } from './fixtures';

type Asked = { id: string; fresh?: string };
const tag = process.env.SHOT_TAG ?? 'after';
const shot = (app: Page, name: string) => app.screenshot({ path: `../.scratch/shots/1096-${name}-${tag}.png` });

/** A project "demo" whose lead is "Lead" (when `lead`); team_open answers `answer` and is recorded. */
async function setUp(app: Page, core: Core, { lead = true, answer }: { lead?: boolean; answer?: (n: number) => unknown } = {}) {
  const p = core.project('demo');
  core.shell(p, 'alpha');
  const alpha = core.cli('snapshot', '--json').sessions.find((s: { label: string }) => s.label === 'alpha');
  const asked: Asked[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request?.op === 'team_list') return ws.send(JSON.stringify({ id: r.id, response: { Ok: { teammates: lead ? [{ id: 'lead-demo', name: 'Lead', job: 'lead', kind: 'claude', project: p, lead: true }] : [], home: '' } } }));
      if (r?.request?.op === 'team_open') {
        asked.push({ id: r.request.id, fresh: r.request.fresh });
        const out = answer?.(asked.length) ?? { Ok: { type: 'team_opened', session: alpha, started: true } };
        return ws.send(JSON.stringify({ id: r.id, response: out }));
      }
      server.send(m);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  await openWindow(app);
  return { asked, alpha };
}
const palette = async (app: Page) => {
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette input').fill('lead');
};
const rowMenu = (app: Page) => app.locator('.tree .grp[data-project] .row.head .n').first().click({ button: 'right' });

test('new_lead_from_the_palette (1096): "lead" finds New Lead conversation; it sends one fresh team_open and shows the seat', async ({ app, core }) => {
  const { asked, alpha } = await setUp(app, core);
  await palette(app);
  const item = app.locator('#palette-list [data-command="lead.fresh"]');
  await expect(item).toHaveText(/New Lead conversation/);
  await shot(app, 'palette');
  await item.click();
  await expect.poll(() => asked).toEqual([{ id: 'lead-demo', fresh: 'now' }]);
  await expect(app.locator(`.tab[data-tab="${alpha.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.getByRole('dialog')).toHaveCount(0);
});

test('new_lead_from_the_plus_menu (1096): the tab + menu has the row; it sends one fresh team_open', async ({ app, core }) => {
  const { asked } = await setUp(app, core);
  await app.keyboard.press('Meta+KeyT');
  const row = app.locator('.newtab .nt-row', { hasText: 'New Lead conversation' });
  await expect(row).toHaveCount(1);
  await shot(app, 'plus');
  await row.click();
  await expect.poll(() => asked).toEqual([{ id: 'lead-demo', fresh: 'now' }]);
});

test('new_lead_from_the_row_menu (1096): the project row menu has it, for that row; it sends one fresh team_open', async ({ app, core }) => {
  const { asked } = await setUp(app, core);
  await rowMenu(app);
  const item = app.getByRole('menuitem', { name: 'New Lead conversation' });
  await expect(item).toHaveCount(1);
  await shot(app, 'row');
  await item.click();
  await expect.poll(() => asked).toEqual([{ id: 'lead-demo', fresh: 'now' }]);
});

// The core's two time-limit lines, word for word (team.rs fresh_lead, LATE_WITHDRAWN and LATE_HANDED).
const LATE = 'Lead did not finish its turn within 5 minutes, so it is still open and no new conversation started; ';
test('new_lead_stuck_old_lead (1096): past the limit one sheet says so; only the owner\'s click closes the old Lead', async ({ app, core }) => {
  const { asked, alpha } = await setUp(app, core, { answer: (n) => (n === 1 ? { Err: LATE + 'the handover message was withdrawn' } : undefined) });
  await palette(app);
  await app.locator('#palette-list [data-command="lead.fresh"]').click();
  const sheet = app.getByRole('dialog', { name: 'New Lead conversation for demo' });
  await expect(sheet).toContainText('Lead did not finish its turn within 5 minutes. It is still open, no new conversation started, and the handover message was withdrawn.');
  await shot(app, 'stuck');
  expect(asked).toEqual([{ id: 'lead-demo', fresh: 'now' }]);
  await sheet.getByRole('button', { name: 'Close the old Lead and open a new one' }).click();
  await expect.poll(() => asked.length).toBe(2);
  expect(asked[1]).toEqual({ id: 'lead-demo', fresh: 'close' });
  await expect(sheet).toHaveCount(0);
  await expect(app.locator(`.tab[data-tab="${alpha.id}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('new_lead_stuck_handed (1096 review): a Lead that already has the handover message is said so; Keep it open sends nothing', async ({ app, core }) => {
  const { asked } = await setUp(app, core, { answer: () => ({ Err: LATE + 'it already has the handover message and stops after its current turn' }) });
  await palette(app);
  await app.locator('#palette-list [data-command="lead.fresh"]').click();
  const sheet = app.getByRole('dialog', { name: 'New Lead conversation for demo' });
  await expect(sheet).toContainText('already has the handover message, so it stops after its current turn');
  await sheet.getByRole('button', { name: 'Keep it open' }).click();
  await expect(sheet).toHaveCount(0);
  expect(asked).toEqual([{ id: 'lead-demo', fresh: 'now' }]);
});

test('new_lead_lost_core (1096 review): a reconnect during the wait says the seat may still open, not that it failed', async ({ app, core }) => {
  const p = core.project('demo');
  core.shell(p, 'alpha');
  let dropped = false;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request?.op === 'team_list') return ws.send(JSON.stringify({ id: r.id, response: { Ok: { teammates: [{ id: 'lead-demo', name: 'Lead', job: 'lead', kind: 'claude', project: p, lead: true }], home: '' } } }));
      if (r?.request?.op === 'team_open' && !dropped) return ((dropped = true), ws.close());
      server.send(m);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  await openWindow(app);
  await palette(app);
  await app.locator('#palette-list [data-command="lead.fresh"]').click();
  const sheet = app.getByRole('dialog', { name: 'New Lead conversation for demo' });
  await expect(sheet).toContainText('It may still open');
  await expect(sheet.locator('.err, [role="alert"]')).toHaveCount(0);
});

test('new_lead_needs_a_lead (1096): a project with no lead offers it nowhere', async ({ app, core }) => {
  const { asked } = await setUp(app, core, { lead: false });
  await palette(app);
  await expect(app.locator('#palette-list [data-command]').first()).toBeVisible();
  await expect(app.locator('#palette-list [data-command="lead.fresh"]')).toHaveCount(0);
  await app.keyboard.press('Escape');
  await rowMenu(app);
  await expect(app.getByRole('menu')).toBeVisible();
  await expect(app.getByRole('menuitem', { name: 'New Lead conversation' })).toHaveCount(0);
  await app.keyboard.press('Escape');
  await app.keyboard.press('Meta+KeyT');
  await expect(app.locator('.newtab .nt-row').first()).toBeVisible();
  await expect(app.locator('.newtab .nt-row', { hasText: 'New Lead conversation' })).toHaveCount(0);
  expect(asked).toEqual([]);
});
