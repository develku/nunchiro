// A bot in one minute (owner-approved mockup docs/design/bots-1166.html, panel 3): the one-step dialog, the first chat's
// cards, a bot's offer of a new bot, and a worktree handed to a bot. A real core; the store's own tests are in
// crates/nunchiro-core/src/team/tests/one_minute.rs.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, nunchiro, openWindow, REPO, test } from './fixtures';
import { mates, openSeat, repo, sessions, tokenClaude, tokenOf } from './leader-990';
import { openSettings } from './settings-modal';
import { patchSnapshots } from './tree-mock-states';

const SHOTS = path.join(REPO, '.scratch/shots');
const NOTES = 'Writes release notes from what landed this week.';
type Stored = { id: string; name: string; job: string; face: { shape: string; tile: string }; seat: { kind: string; project?: string }; agent: string; v1?: { project?: string } };
const stored = (core: Core) => JSON.parse(fs.readFileSync(path.join(core.home, 'team', 'bots.json'), 'utf8')).bots as Stored[];

/** An office with one project and its Lead, Dalsu; Ori is a bot of the project with no seat. */
async function office(app: Page, core: Core) {
  tokenClaude(core);
  const project = repo(core, 'nunchiro');
  mates(core, [
    { id: 'bot-dalsu', name: 'Dalsu', job: 'Splits goals into tasks, staffs and reviews them.', project, lead: true },
    { id: 'bot-ori', name: 'Ori', job: "Reviews every lead's work before it lands.", project },
  ]);
  const set = await patchSnapshots(app);
  await openWindow(app, {}, core);
  return { project, set };
}
async function newBot(app: Page) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await app.locator('.sbody [data-open-bots]').click();
  await app.locator('[data-bots] [data-bots-new]').click();
  const dlg = app.getByRole('dialog', { name: 'New bot' });
  await expect(dlg).toBeVisible();
  return dlg;
}
const seatOf = (core: Core, name: string) => sessions(core).find((s) => s.label === name && s.teammate && s.state === 'running');

test('new_bot_one_step: a name and one sentence make a bot with the face shown, and its chat opens', async ({ app, core }) => {
  await office(app, core);
  const dlg = await newBot(app);
  // Mockup panel 3, the left window: the title, a face that a press changes, the name, the sentence, six templates,
  // one line for the agent and the model, Cancel and Create.
  await expect(dlg.locator('h2')).toHaveText('New bot');
  const face = dlg.locator('[data-new-face] .face');
  const shown = () => face.evaluate((e) => ({ shape: e.getAttribute('data-shape')!, tile: e.getAttribute('data-tile')! }));
  const first = await shown();
  await dlg.locator('[data-new-face]').click();
  const second = await shown();
  expect(second, 'a press gives another face').not.toEqual(first);
  await expect(dlg, 'the band takes the tile of the face').toHaveAttribute('data-tile', second.tile);
  await expect(dlg.locator('.nb-hint')).toHaveText('Click the face for another one');
  expect(await dlg.locator('.nb-tpl button').allTextContents()).toEqual(['Lead', 'Reviewer', 'Release notes', 'Chief', 'Peer watch', 'Docs']);
  await expect(dlg.locator('[data-new-runs] span')).toHaveText('Runs on Claude Code · follows its newest model');
  const create = dlg.locator('[data-new-create]');
  await expect(create).toBeDisabled();
  // A template fills the sentence and is on while the sentence is its own.
  const job = dlg.getByRole('textbox', { name: 'What this bot is for, in one sentence' });
  await dlg.locator('[data-template="notes"]').click();
  await expect(job).toHaveValue(NOTES);
  await expect(dlg.locator('[data-template="notes"]')).toHaveAttribute('aria-pressed', 'true');
  await job.fill(`${NOTES} For users.`);
  await expect(dlg.locator('[data-template="notes"]')).toHaveAttribute('aria-pressed', 'false');
  await dlg.locator('[data-template="notes"]').click();
  await expect(create, 'a sentence alone is no bot').toBeDisabled();
  // Change opens the agent, the model and the place; closed, they are one line.
  await expect(dlg.getByRole('combobox', { name: 'Agent' })).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Change' }).click();
  await expect(dlg.getByRole('combobox', { name: 'Agent' })).toBeVisible();
  await expect(dlg.getByRole('combobox', { name: 'Works in' })).toHaveValue('');
  await dlg.getByRole('button', { name: 'Change' }).click();
  // The name, then Cmd+Enter: one step.
  const name = dlg.getByRole('textbox', { name: 'Name' });
  await name.fill('Bom');
  await expect(create).toBeEnabled();
  await name.press('ControlOrMeta+Enter');
  await expect(dlg).toHaveCount(0);
  await expect.poll(() => seatOf(core, 'Bom')?.id ?? '', { message: "the new bot's chat opens" }).not.toBe('');
  await expect(app.getByRole('dialog', { name: 'Bots' }), 'the Bots view gives way to the chat').toHaveCount(0);
  const bom = stored(core).find((b) => b.name === 'Bom')!;
  expect([bom.job, bom.face, bom.seat, bom.agent]).toEqual([NOTES, second, { kind: 'none' }, 'claude']);
  expect(bom.v1?.project, 'made in Home when no project is in front').toBeUndefined();
  expect(fs.readFileSync(path.join(core.home, 'team', bom.id, 'SOUL.md'), 'utf8')).toBe(`${NOTES}\n`);
  // The files an earlier build reads keep their shape: the bot is a plain row of team.json, and bots.json has no new field.
  const v1 = JSON.parse(fs.readFileSync(path.join(core.home, 'team', 'team.json'), 'utf8')).teammates as Record<string, unknown>[];
  expect(Object.keys(v1.find((m) => m.id === bom.id)!).sort()).toEqual(['id', 'job', 'kind', 'name']);
  expect(Object.keys(bom).sort()).toEqual(['agent', 'face', 'id', 'job', 'model', 'name', 'seat']);
  // A name that is taken is said in the dialog, and nothing is made twice.
  const again = await newBot(app);
  await again.getByRole('textbox', { name: 'Name' }).fill('bom');
  await again.locator('[data-template="docs"]').click();
  await again.locator('[data-new-create]').click();
  await expect(again.getByRole('alert')).toContainText('There is already a teammate named bom here');
  expect(stored(core).filter((b) => b.name.toLowerCase() === 'bom')).toHaveLength(1);
  await again.getByRole('button', { name: 'Cancel' }).click();
  await expect(again).toHaveCount(0);
});

test('first_chat_cards: a Lead template asks for the seat in the chat, and the SOUL the bot wrote is read, edited and undone there', async ({ app, core }) => {
  const { project, set } = await office(app, core);
  // Dalsu leads the project already: the seat is held, and the card says so instead of taking it.
  const dlg = await newBot(app);
  await dlg.getByRole('textbox', { name: 'Name' }).fill('Haru');
  await dlg.locator('[data-template="lead"]').click();
  await dlg.locator('[data-new-create]').click();
  await expect.poll(() => seatOf(core, 'Haru')?.id ?? '').not.toBe('');
  const haru = stored(core).find((b) => b.name === 'Haru')!;
  expect(haru.seat, 'nobody sits before the owner says where').toEqual({ kind: 'none' });
  const seat = app.locator('[data-first-seat="lead"]');
  await expect(seat).toContainText('Which project should Haru lead?');
  await expect(seat.getByRole('combobox', { name: 'Project' })).toHaveValue(project);
  await seat.locator('[data-first-sit]').click();
  await expect(seat.getByRole('alert')).toContainText('Dalsu');
  expect(stored(core).find((b) => b.name === 'Haru')!.seat).toEqual({ kind: 'none' });
  // Not now ends the question; the bot stays without a seat.
  await seat.locator('[data-first-not-now]').click();
  await expect(seat).toHaveCount(0);
  expect(stored(core).find((b) => b.name === 'Haru')!.seat).toEqual({ kind: 'none' });
  // The bot writes its SOUL file during a turn; when the turn ends the chat shows it.
  const soul = app.locator('[data-first-soul]');
  await expect(soul).toHaveCount(0);
  const file = path.join(core.home, 'team', haru.id, 'SOUL.md');
  const seed = fs.readFileSync(file, 'utf8');
  const wrote = ['I lead one project at a time.', 'I split a goal into parts that touch different files.', 'Every part gets a worker and a reviewer.', 'I ask you only what you must decide.', 'I report in a few lines.'];
  set({ Haru: { working: true } });
  await expect(app.locator('.shead .face')).toHaveAttribute('data-eyes', 'work');
  fs.writeFileSync(file, `${wrote.join('\n')}\n`);
  set({ Haru: {} });
  await expect(soul.locator('.bw-h')).toHaveText('Haru wrote SOUL.md· 5 lines');
  await expect(soul.locator('pre')).toHaveText(wrote.slice(0, 3).join('\n'));
  await soul.locator('[data-first-read]').click();
  await expect(soul.locator('pre')).toHaveText(wrote.join('\n'));
  // Edit changes the file itself.
  await soul.locator('[data-first-edit]').click();
  await soul.getByRole('textbox', { name: "Haru's SOUL" }).fill('I lead one project at a time.\nI report in a few lines.');
  await soul.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(soul.locator('.bw-h')).toHaveText('Haru wrote SOUL.md· 2 lines');
  expect(fs.readFileSync(file, 'utf8')).toBe('I lead one project at a time.\nI report in a few lines.\n');
  // Undo: the one sentence the bot was made with is the file again, and the card goes.
  await soul.locator('[data-first-undo]').click();
  await expect(soul).toHaveCount(0);
  expect(fs.readFileSync(file, 'utf8')).toBe(seed);
  // A bot made the earlier way has no first chat: no card in its chat, whatever its SOUL file holds.
  fs.mkdirSync(path.join(core.home, 'team', 'bot-ori'), { recursive: true });
  fs.writeFileSync(path.join(core.home, 'team', 'bot-ori', 'SOUL.md'), 'I review.\n');
  await openSeat(app, core, 'Ori');
  await expect(app.locator('.shead')).toContainText('Ori');
  await expect(app.locator('[data-first-soul], [data-first-seat]')).toHaveCount(0);
});

test('bot_offer_card: a bot offers a new bot on a card, and only Create makes it', async ({ app, core }) => {
  const { project } = await office(app, core);
  const ori = await openSeat(app, core, 'Ori');
  const token = await tokenOf(core, ori);
  const offer = (name: string) => nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, ['bot', 'offer', name, '--job', NOTES, '--why', '3 of the last 5 tasks were release notes']);
  expect(offer('Bom')).toContain('The user is asked on a card');
  // The Decisions icon gets its dot; the card is there.
  const icon = app.locator('#icon-decisions');
  await expect(icon.locator('.wdot')).toBeVisible();
  await icon.click();
  const card = app.locator('.dw [data-bot-offer="Bom"]');
  await expect(card.locator('.mc-head')).toHaveText('Ori offers a new bot');
  await expect(card.locator('.mc-head .face'), "the offering bot's own face").toHaveCount(1);
  await expect(card.locator('.rc-words')).toHaveText(`Bom${NOTES}3 of the last 5 tasks were release notes`);
  await expect(card.locator('.rc-pill')).toHaveText('in nunchiro');
  const names = () => (fs.existsSync(path.join(core.home, 'team', 'bots.json')) ? stored(core).map((b) => b.name) : ['Dalsu', 'Ori']);
  expect(names(), 'an offer makes nothing').toEqual(['Dalsu', 'Ori']);
  // Not now: nothing is made.
  await card.locator('[data-act="not-now"]').click();
  await expect(card).toHaveCount(0);
  expect(names()).toEqual(['Dalsu', 'Ori']);
  // Create: the bot is made in the offering bot's project, with no seat.
  offer('Bom');
  await card.locator('[data-act="create-bot"]').click();
  await expect(card).toHaveCount(0);
  await expect.poll(names).toEqual(['Dalsu', 'Ori', 'Bom']);
  const bom = stored(core).find((b) => b.name === 'Bom')!;
  expect([bom.job, bom.seat, bom.v1?.project]).toEqual([NOTES, { kind: 'none' }, project]);
});

test('hand_worktree_to_bot: a worktree row hands its worktree to a bot, whose chat opens with the hand-over', async ({ app, core }) => {
  const { project } = await office(app, core);
  const wt = (core.cli('worktree', 'create', '--project', project, '--branch', 'tab-strip', '--no-focus').worktrees as { path: string; branch: string }[]).find((w) => w.branch === 'tab-strip')!;
  await app.reload();
  const row = app.locator(`.tree [data-wt="${wt.path}"] [data-menu="worktree"]`).first();
  await row.click({ button: 'right' });
  await app.getByRole('menuitem', { name: 'Hand to a bot…' }).click();
  const dlg = app.getByRole('dialog', { name: 'Hand tab-strip to a bot' });
  // The project's own bots, each with its face; the first one is picked.
  await expect(dlg.locator('[data-hand-to] b')).toHaveText(['Dalsu', 'Ori']);
  await expect(dlg.locator('[data-hand-to] .face')).toHaveCount(2);
  await dlg.locator('[data-hand-to="bot-ori"]').click();
  await dlg.getByRole('textbox', { name: 'What should it do with it? (optional)' }).fill('Review what is there.');
  await dlg.locator('[data-hand-go]').click();
  await expect(dlg).toHaveCount(0);
  // Ori's seat opened and read its brief, then the hand-over with the folder and the owner's words.
  let seat = '';
  await expect.poll(() => (seat = seatOf(core, 'Ori')?.id ?? '')).not.toBe('');
  const sent = () => (core.cli('snapshot', '--json').sessions as { id: string; send_log?: { content: string }[]; send_queue?: { content: string }[] }[]).filter((s) => s.id === seat).flatMap((s) => [...(s.send_log ?? []), ...(s.send_queue ?? [])].map((x) => x.content));
  await expect.poll(() => sent().join('\n---\n')).toContain('The user hands you a worktree');
  const hand = sent().find((c) => c.startsWith('The user hands you a worktree'))!;
  expect(hand).toContain(wt.path);
  expect(hand).toContain('Review what is there.');
  await expect(app.locator('.shead')).toContainText('Ori');
});

// Pictures for the comparison with the mockup, on request: PW_OPT_IN=shots ... --project shots -g bots_new_shots
test('bots_new_shots @shots: the one-step dialog, the first chat cards, the offer card and the hand-over dialog, light and dark', async ({ app, core }) => {
  const { project, set } = await office(app, core);
  fs.mkdirSync(SHOTS, { recursive: true });
  const wt = (core.cli('worktree', 'create', '--project', project, '--branch', 'tab-strip', '--no-focus').worktrees as { path: string; branch: string }[]).find((w) => w.branch === 'tab-strip')!;
  await app.reload();
  const shot = (name: string, scheme: string) => path.join(SHOTS, `bots-new-${name}-${scheme}.png`);
  let n = 0;
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const name = ['Bom', 'Sol'][n++];
    // The dialog as the mockup draws it: Bom, the Release notes template on.
    const dlg = await newBot(app);
    await dlg.getByRole('textbox', { name: 'Name' }).fill(name);
    await dlg.locator('[data-template="notes"]').click();
    await dlg.screenshot({ path: shot('dialog', scheme) });
    await app.screenshot({ path: shot('dialog-window', scheme) });
    await dlg.getByRole('button', { name: 'Change' }).click();
    await dlg.screenshot({ path: shot('dialog-change', scheme) });
    await dlg.getByRole('button', { name: 'Change' }).click();
    await dlg.locator('[data-template="lead"]').click();
    await dlg.locator('[data-new-create]').click();
    await expect.poll(() => seatOf(core, name)?.id ?? '').not.toBe('');
    const bot = stored(core).find((b) => b.name === name)!;
    await expect(app.getByRole('group', { name: `Which project should ${name} lead?` })).toBeVisible();
    set({ [name]: { working: true } });
    await expect(app.locator('.shead .face')).toHaveAttribute('data-eyes', 'work');
    fs.writeFileSync(path.join(core.home, 'team', bot.id, 'SOUL.md'), ['I write release notes for users.', 'Plain words. No ticket numbers, no process words.', 'I list only what a user would notice, newest first.', 'One line per change.', 'I ask before I guess.', 'I say what I did not check.', 'I keep the last four weeks.', 'I never publish; you do.', 'I report in a few lines.'].join('\n') + '\n');
    set({ [name]: {} });
    // A chat shown a moment ago stays mounted, hidden: the cards are asked for by their bot's name.
    const cards = app.locator('.bot-first').filter({ has: app.getByRole('group', { name: `${name} wrote SOUL.md` }) });
    await expect(cards.locator('[data-first-soul]')).toBeVisible();
    await app.screenshot({ path: shot('first-chat', scheme) });
    await cards.screenshot({ path: shot('first-chat-cards', scheme) });
    await cards.locator('[data-first-not-now]').click();
    // The offer card (Decisions) and the hand-over dialog: no mockup yet; drawn in the app's own shapes.
    const token = await tokenOf(core, seatOf(core, name)!.id);
    nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, ['bot', 'offer', `Notes ${scheme}`, '--job', NOTES, '--why', '3 of the last 5 tasks were release notes']);
    const card = app.locator('.dw [data-bot-offer]');
    if (!(await app.locator('.dw').isVisible())) await app.locator('#icon-decisions').click();
    await expect(card).toBeVisible();
    await card.screenshot({ path: shot('offer-card', scheme) });
    await app.screenshot({ path: shot('offer-card-window', scheme) });
    await card.locator('[data-act="not-now"]').click();
    await app.locator(`.tree [data-wt="${wt.path}"] [data-menu="worktree"]`).first().click({ button: 'right' });
    await app.screenshot({ path: shot('worktree-menu', scheme) });
    await app.getByRole('menuitem', { name: 'Hand to a bot…' }).click();
    const hand = app.getByRole('dialog', { name: 'Hand tab-strip to a bot' });
    await hand.getByRole('textbox').fill('Finish the tab strip.');
    await hand.screenshot({ path: shot('hand-dialog', scheme) });
    await hand.getByRole('button', { name: 'Cancel' }).click();
  }
});
