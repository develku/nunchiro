// Ticket 1168 (lane 1 of the bot structure; owner-approved mockup docs/design/bots-1166.html, panels 1, 2 and 4): the
// face, the Bots view and the lead's header. A real core; the roster is written to team.json as a build before this
// ticket kept it, so every test also reads a home from before the move. Tests 8, 9 and 10 of the 1166 plan; the store's
// own (1 to 7) are in crates/nunchiro-core/src/team/bots/tests.rs.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { mates, openSeat, repo, tokenClaude } from './leader-990';
import { openSettings } from './settings-modal';
import { patchSnapshots } from './tree-mock-states';

const SHOTS = path.join(REPO, '.scratch/shots');

/** The mockup's office: Mina is the Chief, Dalsu leads nunchiro, Ori (in the project) and Bom (Home) have no seat. */
async function office(app: Page, core: Core) {
  tokenClaude(core);
  const project = repo(core, 'nunchiro');
  mates(core, [
    { id: 'bot-mina', name: 'Mina', job: 'Runs your office: brief, reply drafts, follow-ups.', lead: true },
    { id: 'bot-dalsu', name: 'Dalsu', job: 'Splits goals into tasks, staffs and reviews them.', project, lead: true },
    { id: 'bot-ori', name: 'Ori', job: "Reviews every lead's work before it lands.", project },
    { id: 'bot-bom', name: 'Bom', job: 'Writes release notes from what landed.' },
  ]);
  const set = await patchSnapshots(app);
  await openWindow(app, {}, core);
  return { project, set };
}
async function openBots(app: Page) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await app.locator('.sbody [data-open-bots]').click();
  const view = app.getByRole('dialog', { name: 'Bots' }).locator('[data-bots]');
  await expect(view).toBeVisible();
  return view;
}
const faceOf = (l: Locator) => l.evaluate((e) => [e.getAttribute('data-shape'), e.getAttribute('data-tile'), e.getAttribute('data-eyes')]);

// 8
test('faces_header_only (1168): the tree has no face, the lead\'s header has one, and a lead that waits looks at you with an orange ring', async ({ app, core }) => {
  const { set } = await office(app, core);
  const seat = await openSeat(app, core, 'Dalsu');
  // Mockup panel 4: the lead's tree row is the bot's name, with no face; the Home section keeps its name and its chip says Chief.
  const row = app.locator(`.tree button.row.wt2[data-menu-session="${seat}"]`);
  await expect(row.locator('.nm')).toHaveText('Dalsu');
  await expect(app.locator('.tree .face')).toHaveCount(0);
  await expect(app.locator('.tabs .face, .stab .face, .tab .face')).toHaveCount(0);
  const home = app.locator('.tree [data-mate="bot-mina"]');
  await expect(home.locator('.lead-tag')).toHaveText('Chief');
  await expect(app.locator('.tree').getByRole('button', { name: 'Assistants', exact: true })).toBeVisible();
  // The header: exactly one face, where the letter circle stood (the chip keeps only its count).
  const face = app.locator('.shead .face');
  await expect(face).toHaveCount(1);
  await expect(face).toHaveAttribute('data-eyes', 'rest');
  await expect(face.getByRole('img')).toHaveAccessibleName('Dalsu, resting');
  await expect(app.locator('.shead [data-team-chip] .lead-av')).toHaveCount(0);
  await expect(app.locator('.shead .lead-tag')).toHaveText('Lead');
  const ring = () => face.evaluate((e) => [getComputedStyle(e).outlineStyle, getComputedStyle(e).outlineColor]);
  expect((await ring())[0], 'no ring at rest').toBe('none');
  // Working: eyes down. Needs you: eyes on you, the ring in the your-turn orange, and the label says it.
  set({ Dalsu: { working: true } });
  await expect(face).toHaveAttribute('data-eyes', 'work');
  await expect(face.getByRole('img')).toHaveAccessibleName('Dalsu, working');
  set({ Dalsu: { waiting: true } });
  await expect(face).toHaveAttribute('data-eyes', 'look');
  await expect(face).toHaveAttribute('data-you', 'true');
  await expect(face.getByRole('img')).toHaveAccessibleName('Dalsu, needs you');
  const you = await app.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('i'));
    probe.style.color = 'var(--you)';
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(await ring()).toEqual(['solid', you]);
  await expect(app.locator('.shead .face')).toHaveCount(1);
  await expect(app.locator('.tree .face')).toHaveCount(0);
});

// 9
test('bots_view_default_screen (1168): two groups, no level words, the Models fold is closed, and SOUL.md is read and edited', async ({ app, core }) => {
  await office(app, core);
  const view = await openBots(app);
  // Mockup panel 1: in a seat (the Chief, the project's Lead), then no seat. Each row: face, name, seat, job, state, model line.
  const names = (group: string) => view.locator(`[data-bots-group="${group}"] [data-bot] .bot-name .wordcut`).allTextContents();
  expect(await names('seat')).toEqual(['Mina', 'Dalsu']);
  expect(await names('none')).toEqual(['Ori', 'Bom']);
  await expect(view.locator('[data-bot="bot-mina"] .bot-seat')).toHaveText('Chief');
  await expect(view.locator('[data-bot="bot-dalsu"] .bot-seat')).toHaveText('Lead of nunchiro');
  await expect(view.locator('[data-bot="bot-ori"] .bot-seat')).toHaveCount(0);
  await expect(view.locator('[data-bots-sum]')).toHaveText('4 bots · 4 resting');
  await expect(view.locator('[data-bot="bot-bom"] [data-bot-model]')).toHaveText('follows Claude Code');
  await expect(view.locator('[data-bot] .face')).toHaveCount(4);
  const LEVEL_WORDS = /\b(Light|Standard|Deep)\b/i;
  await expect(view).not.toContainText(LEVEL_WORDS, { useInnerText: true });
  // The settings pages point here: Assistants too.
  await app.getByRole('button', { name: 'Close Bots' }).click();
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="assistants"]').click();
  await app.locator('.sbody [data-open-bots]').click();
  // Mockup panel 2: one bot's page.
  await view.locator('[data-bot="bot-bom"]').click();
  const page = app.locator('[data-bot-page="bot-bom"]');
  await expect(page.locator('.bot-head h2')).toHaveText('Bom');
  await expect(page.locator('.bot-head .face').getByRole('img')).toHaveAccessibleName('Bom, resting');
  const fold = page.locator('details[data-bot-models]');
  await expect(fold).toHaveJSProperty('open', false);
  await expect(fold.locator('summary')).toContainText("Models and limits Follows the agent's newest model. The lead picks per task.");
  await expect(page).not.toContainText(LEVEL_WORDS, { useInnerText: true });
  // SOUL: seeded from the job; Edit changes the file itself, beside the bot's memory.
  const soul = page.locator('[data-bot-soul]');
  await expect(soul.locator('.bot-soul')).toHaveText('Writes release notes from what landed.');
  await soul.locator('[data-soul-edit]').click();
  await soul.getByRole('textbox', { name: "Bom's SOUL" }).fill('I write release notes for users.\nPlain words. No ticket numbers.');
  await soul.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(soul.locator('.bot-soul')).toHaveText('I write release notes for users.\nPlain words. No ticket numbers.');
  const file = path.join(core.home, 'team', 'bot-bom', 'SOUL.md');
  expect(fs.readFileSync(file, 'utf8')).toBe('I write release notes for users.\nPlain words. No ticket numbers.\n');
  // Reading and editing a SOUL moved nothing: the roster is still the older build's file, byte for byte.
  expect(fs.existsSync(path.join(core.home, 'team', 'bots.json'))).toBe(false);
  // The fold holds today's controls; a save there is the move, and team.json is not rewritten by it.
  const before = fs.readFileSync(path.join(core.home, 'team', 'team.json'), 'utf8');
  await fold.locator('summary').click();
  await expect(fold.getByRole('combobox', { name: 'Agent' })).toBeVisible();
  await fold.getByRole('combobox', { name: 'Agent' }).selectOption('codex');
  await fold.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.bot-head .dim')).toContainText('Codex');
  await expect.poll(() => fs.existsSync(path.join(core.home, 'team', 'bots.json'))).toBe(true);
  expect(fs.readFileSync(path.join(core.home, 'team', 'team.json'), 'utf8')).toBe(before);
  const stored = JSON.parse(fs.readFileSync(path.join(core.home, 'team', 'bots.json'), 'utf8'));
  expect(stored.bots.find((b: { id: string }) => b.id === 'bot-bom').agent).toBe('codex');
  // Back to the roster.
  await page.getByRole('button', { name: /All bots/ }).click();
  await expect(view.locator('[data-bot="bot-bom"] [data-bot-model]')).toHaveText('follows Codex');
});

// 10
test('face_is_the_ids (1168): the same id draws the same face after a reload and after the move, and reduced motion stops the eyes', async ({ app, core }) => {
  const { set } = await office(app, core);
  await openSeat(app, core, 'Dalsu');
  const view = await openBots(app);
  const faces = async () => Object.fromEntries(await Promise.all(['mina', 'dalsu', 'ori', 'bom'].map(async (n) => [n, (await faceOf(view.locator(`[data-bot="bot-${n}"] .face`))).slice(0, 2)])));
  const first = await faces();
  // Coordinator's look at the first shots: "bot-mina" and "bot-dalsu" derive the same face; on one roster no two bots share one.
  expect(new Set(Object.values(first).map((f) => (f as string[]).join(' '))).size, JSON.stringify(first)).toBe(4);
  for (const [shape, tile] of Object.values(first) as string[][]) {
    expect(['bun', 'bear', 'round', 'drop', 'cat', 'bot']).toContain(shape);
    expect(['lilac', 'sky', 'mint', 'peach', 'teal', 'slate']).toContain(tile);
  }
  // The colours are the mockup's (docs/design/bots-1166.html WHO), now tokens (tokens.css --face-*): tile, head, face patch, eye.
  const MOCKUP: Record<string, [tile: string, ink: string]> = { lilac: ['#ddd4f3', '#51356b'], sky: ['#cfe4f7', '#27365f'], mint: ['#cdebd7', '#2a5a45'], peach: ['#f9dcc4', '#8a4526'], teal: ['#c7e9e5', '#1f5d68'], slate: ['#dbe0e7', '#414b5a'] };
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  for (const n of ['mina', 'dalsu', 'ori', 'bom']) {
    const face = view.locator(`[data-bot="bot-${n}"] .face`);
    const fills = await face.evaluate((e) => ['.f-tile', '.f-ink', '.f-skin', '.f-line'].map((c) => getComputedStyle(e.querySelector(c)!)[c === '.f-line' ? 'stroke' : 'fill']));
    const [tile, ink] = MOCKUP[(first[n] as string[])[1]];
    expect(fills, n).toEqual([rgb(tile), rgb(ink), rgb('#fff5e2'), rgb('#141a2a')]);
  }
  // A reload keeps the view (the modal is the window's) and every face.
  await app.reload();
  await expect(view).toBeVisible();
  expect(await faces()).toEqual(first);
  // The header's face is the roster's.
  expect((await faceOf(app.locator('.shead .face'))).slice(0, 2)).toEqual(first.dalsu);
  // A working face's eyes move; with reduced motion they are still.
  set({ Dalsu: { working: true } });
  const dalsu = view.locator('[data-bot="bot-dalsu"]');
  await expect(dalsu.locator('.face')).toHaveAttribute('data-eyes', 'work');
  await expect(dalsu.locator('.bot-now')).toHaveText('Working');
  const moving = () => dalsu.locator('.face .scan').evaluate((e) => getComputedStyle(e).animationName);
  await app.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await moving()).toBe('face-scan');
  await app.emulateMedia({ reducedMotion: 'reduce' });
  expect(await moving()).toBe('none');
  // After the move (a change of the roster) the faces are the ones bots.json keeps: the same.
  await dalsu.click();
  const fold = app.locator('[data-bot-page="bot-dalsu"] details[data-bot-models]');
  await fold.locator('summary').click();
  await fold.getByRole('combobox', { name: 'Agent' }).selectOption('codex');
  await fold.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => fs.existsSync(path.join(core.home, 'team', 'bots.json'))).toBe(true);
  await app.locator('[data-bot-page="bot-dalsu"]').getByRole('button', { name: /All bots/ }).click();
  expect(await faces()).toEqual(first);
  const stored = JSON.parse(fs.readFileSync(path.join(core.home, 'team', 'bots.json'), 'utf8')).bots as { id: string; face: { shape: string; tile: string } }[];
  expect(Object.fromEntries(stored.map((b) => [b.id.slice(4), [b.face.shape, b.face.tile]]))).toEqual(first);
});

// Pictures of the two screens in light and dark, on request: PW_OPT_IN=shots ... --project shots -g bots_shots
test('bots_shots (1168) @shots: the Bots view, a bot page and the lead\'s header, light and dark', async ({ app, core }) => {
  const { set } = await office(app, core);
  await openSeat(app, core, 'Dalsu');
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    set({ Dalsu: { waiting: true } });
    await expect(app.locator('.shead .face')).toHaveAttribute('data-eyes', 'look');
    await app.screenshot({ path: path.join(SHOTS, `1168-header-needs-you-${scheme}.png`) });
    await app.locator('.shead').screenshot({ path: path.join(SHOTS, `1168-header-strip-needs-you-${scheme}.png`) });
    set({ Dalsu: { working: true } });
    await expect(app.locator('.shead .face')).toHaveAttribute('data-eyes', 'work');
    await app.locator('.shead').screenshot({ path: path.join(SHOTS, `1168-header-strip-working-${scheme}.png`) });
    set({ Dalsu: { waiting: true } });
    const view = await openBots(app);
    await expect(view.locator('[data-bot="bot-dalsu"] .face')).toHaveAttribute('data-eyes', 'look');
    await app.screenshot({ path: path.join(SHOTS, `1168-bots-roster-${scheme}.png`) });
    await view.locator('[data-bot="bot-mina"]').click();
    await expect(app.locator('[data-bot-page="bot-mina"] .bot-soul')).not.toBeEmpty();
    await app.screenshot({ path: path.join(SHOTS, `1168-bot-page-${scheme}.png`) });
    await app.locator('[data-bot-page="bot-mina"] details[data-bot-models] summary').click();
    await app.screenshot({ path: path.join(SHOTS, `1168-bot-page-models-open-${scheme}.png`) });
    await app.getByRole('button', { name: 'Close Bots' }).click();
  }
});
