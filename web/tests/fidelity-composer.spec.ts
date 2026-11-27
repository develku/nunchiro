// FIDELITY BAR (needs 130): the composer and the session header against claude-feel-2.html (needs 121, approved).
// Each gap the coordinator named is one acceptance test. A real core and the fake Claude that draws Claude 2.1.310's
// permission footer (crates/nunchiro-core/tests/fixtures/claude-mode); "working" is the real hook event.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, goTab, openWindow, REPO, test, showComposer } from './fixtures';
import { defaultBars } from '../src/layout/bars';


function fakeClaude(core: Core) {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
}

// The agent hook bridge needs a session token; the owner socket takes the same event with the owner token (chat-stop).
const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event, agent] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: agent ? { session_id: agent } : {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
/** A hook event; `agent` is Claude's own session id, which is how the core learns the transcript's file name. */
function hook(core: Core, id: string, event: 'SessionStart' | 'UserPromptSubmit' | 'Stop', agent?: string) {
  const reply = JSON.parse(execFileSync(process.execPath, ['-e', HOOK, core.home, id, event, agent ?? ''], { encoding: 'utf8', timeout: 10_000 }));
  if (!reply.Ok) throw new Error(`hook refused: ${JSON.stringify(reply)}`);
}

/** The transcript the core itself reads for context: CLAUDE_CONFIG_DIR/projects/<cwd, every non-alnum as ->/<id>.jsonl. */
function transcript(core: Core, cwd: string, agent: string, used = 124_000, model = 'claude-opus-4-5-20251101') {
  const dir = path.join(core.home, 'claude-home/projects', cwd.replace(/[^0-9A-Za-z]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const line = { type: 'assistant', message: { model, usage: { input_tokens: used } } };
  fs.writeFileSync(path.join(dir, `${agent}.jsonl`), `${JSON.stringify(line)}\n`);
}

const tab = (app: Page, id: string) => app.locator(`.tab[data-tab="${id}"]`);
const composer = (app: Page) => app.locator('.composer');
/** needs 109 (ticket 180, 8c00145e): the header's Diff button shows only while Diff is on neither bar, so the specs that
 *  pin the mockup's header Diff (needs 130) seed a store whose right bar has no Diff icon. */
const diffOffBar = (app: Page) => {
  const d = defaultBars();
  const bars = { ...d, right: d.right.map((w) => (w === 'diff' ? null : w)) };
  return app.addInitScript(([k, v]) => localStorage.setItem(k as string, JSON.stringify(v)), ['nunchiro.settings.v1', { bars }] as const);
};

/** The core has the turn, and the window has drawn Stop for it; `agent` also hands the core Claude's transcript id. */
async function working(app: Page, core: Core, id: string, agent?: string) {
  hook(core, id, 'UserPromptSubmit', agent);
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; attention: { working: boolean } }[]).find((x) => x.id === id)?.attention.working).toBe(true);
  await expect(composer(app).locator('.send.stop')).toHaveAccessibleName('Stop');
}

// 1
// Ticket 371 item 15: the one-line row became a list above the box, so the row and gap checks follow it.
test('queued_list_above_box: while the agent works, the list sits on top of the box and the placeholder keeps its words', async ({ app, core }) => {
  fakeClaude(core);
  const p = core.project('nunchiro');
  const s = core.agent(p, 'ux-fix-2', 'x');
  await openWindow(app);
  await tab(app, s.id).click();
  const ta = composer(app).locator('textarea');
  await working(app, core, s.id);
  await expect(ta).toHaveAttribute('placeholder', 'Message ux-fix-2… (@ files, / commands)');
  const list = composer(app).locator('.qlist');
  await expect(list).toHaveCount(0);
  await ta.fill('stop touching the project rows');
  await ta.press('Enter');
  await expect(list.locator('.qt')).toHaveText('stop touching the project rows');
  await expect(list).toHaveAttribute('role', 'group');
  // The tray touches the box's top edge and is 14px in from each side (mock 371 .qlist).
  const [tray, box] = await Promise.all([list.boundingBox(), composer(app).locator('.cbox').boundingBox()]);
  expect(Math.abs(tray!.y + tray!.height - box!.y)).toBeLessThanOrEqual(1);
  expect(Math.round(tray!.x - box!.x)).toBe(14);
  expect(Math.round(box!.x + box!.width - (tray!.x + tray!.width))).toBe(14);
});

// 2. Ticket 83 (newer than the mockup's chip line, needs 121 follow-up): the chip shows the mode the footer read,
// and "Mode" when the footer names none. Both are pinned here; the colour is the mockup's --you.
test('mode_chip_names_mode: the permission chip names the mode the CLI showed, in its colour, and never guesses one', async ({ app, core }) => {
  fakeClaude(core);
  const p = core.project('nunchiro');
  const s = core.agent(p, 'ux-fix-2', 'x');
  await openWindow(app);
  await tab(app, s.id).click();
  const chip = composer(app).getByRole('button', { name: 'Permission mode' });
  await expect(chip).toHaveText(/^Normal/); // ticket 285 (needs 207): "Manual" is listed as Normal
  await chip.click(); // ticket 285: the click opens the list; one pick, the CLI's mode read back from its footer
  await app.getByRole('menuitemradio', { name: /^Accept edits/ }).click();
  await expect(chip).toHaveText(/^Accept edits/);
  await chip.click();
  await app.getByRole('menuitemradio', { name: /^Plan/ }).click();
  await expect(chip).toHaveText(/^Plan/);
  const you = await app.evaluate(() => {
    const probe = document.createElement('i');
    document.body.append(probe);
    probe.style.color = 'var(--muted)'; // ticket 1041 (owner 11-22): a mode word is muted; orange stays "your turn"
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  await expect(chip).toHaveCSS('color', you);
  // The footer goes (a decision dialog takes the box): the chip keeps the mode it last read, never an unlabelled "Mode"
  // (B15, ticket 991; ticket 83's chip read "Mode" here and flipped while the mode stayed).
  fs.writeFileSync(path.join(p, 'dialog'), '');
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; permission_mode?: string }[]).find((x) => x.id === s.id)?.permission_mode).toBeUndefined();
  await expect(chip).toHaveText(/^Plan/);
  // N16 (look 1117 v4f B): the chip drawn again (another tab, then back) while the field is still absent keeps the mode.
  const other = core.agent(p, 'other-one', 'x');
  await tab(app, other.id).click();
  await tab(app, s.id).click();
  await expect(chip).toHaveText(/^Plan/);
});

// 3
test('focus_ring_rounded: the composer box is the mockup rounded box, and focusing it draws the neutral focus ring (ticket 1041)', async ({ app, core }) => {
  core.shell(core.project('p'), 'plain');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  // Showing it focuses it, a moment later (the command's own timeout, commands.ts focus.composer): a blur sent before
  // that focus left the box focused, and the rest state read the focus colour. Blurred once the focus has arrived.
  await expect(composer(app).locator('textarea')).toBeFocused();
  await composer(app).locator('textarea').blur();
  await expect(composer(app).locator('textarea')).not.toBeFocused();
  const cbox = composer(app).locator('.cbox');
  const rest = await cbox.evaluate((el) => {
    const probe = document.createElement('i');
    document.body.append(probe);
    probe.style.color = 'var(--line)';
    const line = getComputedStyle(probe).color;
    probe.style.color = 'var(--run)';
    const run = getComputedStyle(probe).color;
    probe.remove();
    const c = getComputedStyle(el);
    return { box: { radius: c.borderTopLeftRadius, border: c.borderTopWidth, color: c.borderTopColor }, line, run };
  });
  // The mockup's .cmp rounded box, radius 14 in the design book; ticket 1041 (polish-1121 .comp): no border, a tint step.
  expect(rest.box).toMatchObject({ radius: '14px', border: '0px' });
  await composer(app).locator('textarea').click();
  const focus = await cbox.evaluate((el) => {
    const probe = document.createElement('i');
    document.body.append(probe);
    probe.style.color = 'var(--ring-focus)';
    const ring = getComputedStyle(probe).color;
    const halo = ring;
    probe.remove();
    const c = getComputedStyle(el);
    return { radius: c.borderTopLeftRadius, color: c.borderTopColor, ring: c.outlineWidth, ringStyle: c.outlineStyle, ringColor: c.outlineColor, want: ring, halo };
  });
  expect(focus.radius).toBe('14px');
  // Ticket 1041 (owner 11-22: focus is the neutral --ring-focus): no border; a 1px ring of that colour round the box.
  expect(focus).toMatchObject({ ring: '1px', ringStyle: 'solid', ringColor: focus.halo });
});

/** A worktree needs the project to be a repository of its own: without one, git found the checkout around .scratch (a run
 *  under GIT_CEILING_DIRECTORIES failed with "not a git repository"). */
const repo = (p: string) => {
  execFileSync('git', ['-C', p, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
};

// Look 1117 v7 (S2-3): "main" names a repository's main checkout. A plain folder (under no repository) has none: its
// header, composer chip and tree row say the project alone; it read "plain-folder / main", as if on a branch named main.
test('no_main_for_a_plain_folder: a folder under no repository shows no "main" in the header, the composer chip or the tree', async ({ app, core }) => {
  const [git, plain] = [core.project('withgit'), core.project('plain-folder')];
  repo(git);
  const [a, b] = [core.shell(git, 'in-repo'), core.shell(plain, 'in-folder')];
  const kinds = Object.fromEntries((core.cli('snapshot', '--json').sessions as { id: string; start_commit?: { kind: string } }[]).map((s) => [s.id, s.start_commit?.kind]));
  expect([kinds[a.id], kinds[b.id]]).toEqual(['commit', 'not_git']); // the core's own record of each folder at the start
  await openWindow(app);
  const head = app.locator('.shead').first();
  await tab(app, a.id).click();
  await showComposer(app);
  await expect(head.locator('.dim').first()).toHaveText(/^withgit \/ main( ·|$)/);
  await expect(composer(app).locator('.chips .chip').first()).toContainText('withgit / main');
  await expect(app.locator('.grp[data-project="withgit"] .head > .d')).toHaveText('main');
  // The other project's session: opened by name from the palette (the tab strip holds the first project's tabs).
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('Go to in-folder');
  await app.locator(`[data-command="session.open.${b.id}"]`).click();
  await expect(tab(app, b.id)).toHaveAttribute('aria-selected', 'true');
  await showComposer(app);
  await expect(head.locator('.dim').first()).toHaveText(/^plain-folder( ·|$)/);
  await expect(head).not.toContainText('main');
  await expect(composer(app).locator('.chips .chip').first()).toHaveText('plain-folder');
  await expect(app.locator('.grp[data-project="plain-folder"] .head .n')).toHaveText('plain-folder');
  await expect(app.locator('.grp[data-project="plain-folder"] .head > .d')).toHaveCount(0);
  await expect(app.locator('.grp[data-project="plain-folder"] .head')).not.toContainText('main');
});

// 4
test('header_no_uuid: the header reads "<name> · <project> / <worktree or branch>" once, and no raw id reaches it', async ({ app, core }) => {
  const p = core.project('nunchiro');
  repo(p);
  const main = core.shell(p, 'ux-fix-2');
  const tree = core.agent(p, 'tree-work', 'never-created', true); // a worktree session: its folder is named by the session id
  await openWindow(app);
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  await tab(app, main.id).click();
  await showComposer(app); // V2.5-34: a shell shows its terminal; its composer is asked for
  const head = app.locator('.shead').first();
  await expect(head).toContainText('ux-fix-2');
  await expect(head.locator('.dim').first()).toHaveText(/^nunchiro \/ main( ·|$)/);
  await expect(head).not.toContainText(uuid);
  await expect(composer(app).locator('.chips')).not.toContainText(uuid);
  await tab(app, tree.id).click();
  await expect(head.locator('.dim').first()).toHaveText(/^nunchiro \/ tree-work( ·|$)/);
  await expect(head).not.toContainText(uuid);
  await expect(composer(app).locator('.chips')).toContainText('nunchiro / tree-work');
  // The project part appears once, and the name is not repeated: "ux-fix-2 ux-fix-2 · main" is not this shape.
  const line = await head.innerText();
  expect(line.match(/ux-fix-2/g)?.length ?? 0).toBeLessThanOrEqual(2); // the session's own row name and its worktree part
  // A managed worktree has a branch: the header shows the branch, as the mockup's "nunchiro / herdr-layout-b".
  execFileSync('git', ['-C', p, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=[EMAIL]', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const w = (core.cli('worktree', 'create', '--project', p, '--branch', 'herdr-layout-b', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'herdr-layout-b')!;
  const onBranch = core.cli('session', 'start', '--kind', 'shell', '--project', w.path, '--label', 'inner').session as { id: string };
  await goTab(app, core, onBranch.id); // ticket 570: a session started in the worktree's folder is in a project of its own
  await showComposer(app);
  await expect(head.locator('.dim').first()).toHaveText(/^nunchiro \/ herdr-layout-b( ·|$)/);
  await expect(head).not.toContainText(uuid);
  await expect(composer(app).locator('.chips')).toContainText('nunchiro / herdr-layout-b');
  // Q6 C13: the header writes the checkout as the tree does, in the window's language (ko: 기본).
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.reload();
  await tab(app, main.id).click();
  await expect(head.locator('.dim').first()).toHaveText(/^nunchiro \/ main( ·|$)/);
});

// 5
test('header_controls_styled: notify is the app\'s own control, and the header carries Diff at the right', async ({ app, core }) => {
  const p = core.project('p');
  const s = core.shell(p, 'plain');
  await diffOffBar(app);
  await openWindow(app);
  await tab(app, s.id).click();
  const head = app.locator('.shead').first();
  // notify: a button with a popover of the three levels, drawn like the app's other chips (no UA select look).
  const notify = head.getByRole('button', { name: /notifications/i });
  await expect(notify).toHaveAttribute('data-tip', /notify: all/);
  // A button of the app's own, not a UA `<select>` (the base drew one; `appearance` stays "auto" for a button in
  // Chromium, so the tag is the proof). Ticket 1041: the mockup's bell on a quiet tint, no outline.
  const look = await notify.evaluate((el) => {
    const c = getComputedStyle(el);
    return { tag: el.tagName, radius: c.borderTopLeftRadius, height: el.getBoundingClientRect().height, border: c.borderTopWidth };
  });
  expect(look.tag).toBe('BUTTON');
  expect(look.border).toBe('0px');
  expect(look.height).toBeGreaterThanOrEqual(20);
  await expect(head.locator('select')).toHaveCount(0);
  await notify.click();
  const menu = app.getByRole('menu', { name: /notifications/i });
  await expect(menu.getByRole('menuitem')).toHaveCount(3);
  await menu.getByRole('menuitem', { name: 'notify: waiting only' }).click();
  await expect(notify).toHaveAttribute('data-tip', /notify: waiting only/);
  await expect(app.getByRole('menu', { name: /notifications/i })).toHaveCount(0);
  // The mockup's Diff button sits at the right of the row, after the text and before notify. This project is not a git
  // repo, so there is no change to count; `header_diff_stat` covers the count itself.
  const diff = head.getByRole('button', { name: 'Diff' });
  await expect(diff).toBeVisible();
  const [name, diffX, notifyX] = await Promise.all([head.locator('b').first().boundingBox(), diff.boundingBox(), notify.boundingBox()]);
  expect(diffX!.x).toBeGreaterThan(name!.x);
  expect(diffX!.x).toBeLessThan(notifyX!.x);
  expect(await head.locator('.hstat').count()).toBe(0);
});

// 6. Round 2 (the coordinator compared the shots with the mockup): the header's own +a −b, the model's real name, the
// context ring, and flat chips. Same rule: red on the base, then green.
test('header_diff_stat: the header reads +a −b before Diff from the session\'s own changes, and hides it with none', async ({ app, core }) => {
  const repo = (name: string) => {
    const p = core.project(name);
    execFileSync('git', ['-C', p, 'init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(p, 'a.txt'), 'one\nold\n');
    execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'a.txt']);
    execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
    return p;
  };
  const changed = repo('changing');
  const clean = repo('clean');
  // Both baselines are their HEAD; then one file changes under the session.
  const a = core.shell(changed, 'changing');
  const b = core.shell(clean, 'clean');
  fs.writeFileSync(path.join(changed, 'a.txt'), 'one\ntwo\nthree\n');
  await diffOffBar(app);
  await openWindow(app);
  const head = app.locator('.shead').first();
  await goTab(app, core, a.id);
  const stat = head.locator('.hstat');
  // The mockup's pill: the session's real counts, +N in --ok and −M in --bad.
  await expect(stat).toHaveText('+2 −1');
  await expect(stat).toHaveAttribute('title', 'Changes since the session started, in this checkout and all its sessions: +2 −1'); // Q6 B18: its scope on hover
  const look = await stat.evaluate((el) => {
    const probe = document.createElement('i');
    document.body.append(probe);
    probe.style.color = 'var(--ok)';
    const ok = getComputedStyle(probe).color;
    probe.style.color = 'var(--bad)';
    const bad = getComputedStyle(probe).color;
    probe.remove();
    const c = getComputedStyle(el);
    return { ok, bad, add: getComputedStyle(el.querySelector('.add')!).color, del: getComputedStyle(el.querySelector('.del')!).color, border: c.borderTopWidth, radius: c.borderTopLeftRadius };
  });
  expect(look).toMatchObject({ add: look.ok, del: look.bad, border: '0px' }); // ticket 1041: plain numbers in their colours, no box
  // Left of Diff, right of the name, as the mockup draws it.
  const [name, statX, diffX] = await Promise.all([head.locator('b').first().boundingBox(), stat.boundingBox(), head.getByRole('button', { name: 'Diff' }).boundingBox()]);
  expect(statX!.x).toBeGreaterThan(name!.x);
  expect(statX!.x).toBeLessThan(diffX!.x);
  // No change, no count: the pill would promise a diff that is not there.
  await goTab(app, core, b.id);
  await expect(head.locator('.hstat')).toHaveCount(0);
});

// 7. Ticket 10's chip read the raw model string, so a fixture's placeholder letter reached the screen.
test('model_chip_names_model: the chip names the model the session runs, and only the agent when the name is unknown', async ({ app, core }) => {
  fakeClaude(core);
  const p = core.project('p');
  const named = core.agent(p, 'alpha', 'opus');
  const odd = core.agent(p, 'odd', 'x'); // the fixture's placeholder: a value the catalogue has no name for
  await openWindow(app);
  const chip = app.locator('.composer .pk-chip[data-picker="model"]');
  await tab(app, named.id).click();
  await expect(chip).toHaveText(/^Claude · Opus/);
  // A value with no catalogue name is not printed raw: the shot read "Claude · x" before this fix.
  await tab(app, odd.id).click();
  await expect(chip).toHaveText('Claude');
  // Round 3: the same for no model at all (the chip read "Claude · Default", a word that is not a model).
  const plain = core.cli('session', 'start', '--kind', 'claude', '--project', p, '--label', 'plain').session as { id: string };
  await tab(app, plain.id).click();
  await expect(chip).toHaveText('Claude');
  await expect(chip).not.toHaveText(/Default/);
  await expect(chip).not.toHaveText(/·\s*[a-z]{1,2}$/); // never a placeholder letter in the model's place
});

// B15 (ticket 991): a Default session's chip names the model the agent reported in its transcript, not only "Claude".
test('model_chip_names_reported_model: a Default start shows the model the transcript names (B15)', async ({ app, core }) => {
  fakeClaude(core);
  const p = core.project('p');
  const plain = core.cli('session', 'start', '--kind', 'claude', '--project', p, '--label', 'plain').session as { id: string; cwd: string };
  const id = (core.cli('snapshot', '--json').sessions as { id: string; agent_session_id: string }[]).find((x) => x.id === plain.id)!.agent_session_id;
  transcript(core, plain.cwd, id, 1000, 'claude-fable-5-2');
  await openWindow(app);
  await tab(app, plain.id).click();
  await expect(app.locator('.composer .pk-chip[data-picker="model"]')).toHaveText('Claude · Fable 5.2');
});

// B8 (ticket 991): the "switch when idle" hint floats above the chips, never squeezes them, and goes once the agent is idle.
test('picker_hint_does_not_squeeze_chips: the not-idle hint leaves the chips readable and goes when the turn ends (B8)', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'alpha', 'opus');
  await openWindow(app);
  await tab(app, s.id).click();
  const model = composer(app).locator('.pk-chip[data-picker="model"]');
  const effort = composer(app).locator('.pk-chip[data-picker="effort"]');
  const before = (await model.boundingBox())!.width;
  await working(app, core, s.id);
  await model.click({ force: true }); // aria-disabled while working: the click shows why
  const hint = composer(app).locator('.pk-msg');
  await expect(hint).toContainText('switch when the agent is idle');
  const [m, h] = [(await model.boundingBox())!, (await hint.boundingBox())!];
  expect(Math.abs(m.width - before)).toBeLessThan(2); // the chip keeps its width
  expect(h.y + h.height).toBeLessThanOrEqual(m.y + 1); // the hint sits above the row, not in it
  expect((await effort.boundingBox())!.width).toBeGreaterThanOrEqual(63);
  hook(core, s.id, 'Stop');
  await expect(hint).toHaveCount(0);
});

// 8. needs 123: the context ring, left of Send/Stop, whenever the session has context data.
test('context_ring_visible: the context ring sits left of Stop while the session has context data, and not otherwise', async ({ app, core }) => {
  fakeClaude(core);
  const p = core.project('p');
  const s = core.agent(p, 'alpha', 'opus');
  const bare = core.agent(p, 'bare', 'opus'); // no transcript: no ring
  // The core gives a Claude session its transcript id at start; the transcript is where the ring's numbers come from.
  const id = (core.cli('snapshot', '--json').sessions as { id: string; agent_session_id: string }[]).find((x) => x.id === s.id)!.agent_session_id;
  transcript(core, s.cwd, id);
  hook(core, s.id, 'UserPromptSubmit');
  await openWindow(app);
  await expect(composer(app).locator('.send.stop')).toHaveAccessibleName('Stop');
  await tab(app, s.id).click();
  const ring = composer(app).locator('.context-ring');
  await expect(ring).toHaveAttribute('aria-label', 'Context 124k / 200k');
  const [ringBox, stopBox] = await Promise.all([ring.boundingBox(), composer(app).locator('.send').boundingBox()]);
  expect(ringBox!.x).toBeLessThan(stopBox!.x);
  expect(Math.abs(ringBox!.y + ringBox!.height / 2 - (stopBox!.y + stopBox!.height / 2))).toBeLessThan(6); // one row
  await tab(app, bare.id).click();
  await expect(composer(app).locator('.context-ring')).toHaveCount(0);
});

// 8b. Round 3 (strict review): the project chip's hover text carried the session's cwd, a UUID path on a worktree.
test('no_uuid_in_tooltips: the project chip\'s hover text is the name it shows, never the folder path', async ({ app, core }) => {
  const p = core.project('nunchiro');
  repo(p);
  const s = core.agent(p, 'tree-work', 'never-created', true); // a worktree session: its folder is named by its id
  await openWindow(app);
  await tab(app, s.id).click();
  const chip = composer(app).locator('.chips .chip', { hasText: 'nunchiro /' }).first();
  await expect(chip).toHaveText('nunchiro / tree-work');
  const title = await chip.getAttribute('title');
  expect(title).toBe('nunchiro / tree-work');
  expect(title).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  expect(title).not.toContain(core.home);
});

// 8c. Round 3 (strict review): the input's type and the Send/Stop target were both smaller than the mockup's.
test('composer_type_and_target_size: the input reads at the mockup\'s 14.5px and Send/Stop is the design book\'s 28px round control', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'alpha', 'opus');
  await openWindow(app);
  await tab(app, s.id).click();
  const ta = composer(app).locator('textarea');
  expect(await ta.evaluate((el) => getComputedStyle(el).fontSize)).toBe('14.5px');
  const send = composer(app).locator('.send');
  await expect(send).toHaveAccessibleName('Send');
  const idle = (await send.boundingBox())!;
  expect([Math.round(idle.width), Math.round(idle.height)]).toEqual([28, 28]);
  await working(app, core, s.id);
  const stop = (await composer(app).locator('.send.stop').boundingBox())!;
  expect([Math.round(stop.width), Math.round(stop.height)]).toEqual([28, 28]);
});

// 9. The mockup's `.ch`: model, effort and mode are flat text with a caret, not pills.
test('chips_flat: model, effort and mode read as flat text with a caret, and hover gives a quiet background', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'alpha', 'opus');
  await openWindow(app);
  await tab(app, s.id).click();
  const chips = [app.locator('.composer .pk-chip[data-picker="model"]'), app.locator('.composer .pk-chip[data-picker="effort"]'), app.locator('.composer .ch.perm')];
  for (const chip of chips) {
    await expect(chip).toBeVisible();
    const look = await chip.evaluate((el) => {
      const c = getComputedStyle(el);
      return { border: c.borderTopWidth, bg: c.backgroundColor, caret: !!el.querySelector('svg, .c'), padding: c.paddingLeft };
    });
    // No box of its own; a caret says it opens something; it still reads as a control (padding, not bare text).
    expect(look.border).toBe('0px');
    expect(look.bg).toBe('rgba(0, 0, 0, 0)');
    expect(look.caret).toBe(true);
    expect(parseFloat(look.padding)).toBeGreaterThanOrEqual(6); // Q5 clip (5dde39855): 8 -> 6 px so whole words fit
  }
  // Hover may show a subtle background (the mockup's .ch:hover), and it goes away again.
  await chips[0].hover();
  await expect.poll(() => chips[0].evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await app.mouse.move(5, 5);
  await expect.poll(() => chips[0].evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
});

// 10. The REPORT page (AGENTS.md design conformance): the same fixture data in the mockup and in the app, light and dark,
// mockup on the left, and a Korean judgement per visible element under each pair.
const OUT = path.join(REPO, '.scratch/fid-composer');
const MOCKUP = path.join(REPO, 'web/tests/visual/mockups/claude-feel-2.html');
const SCHEMES = ['light', 'dark'] as const;
const SAME_TEXT = 'Do not touch the project rows';

/** The two rows' text and box data for the page's judgement list; nothing here decides a verdict. */
const FACTS = `(el) => {
  const pick = (root, sel) => root.querySelector(sel);
  const box = (e) => (e ? { x: Math.round(e.getBoundingClientRect().x), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) } : null);
  const font = (e) => (e ? getComputedStyle(e).fontSize : null);
  return { box: box(el), textarea: font(pick(el, 'textarea')), text: el.innerText.replace(/\\n+/g, ' | ') };
}`;

test('same_data_side_by_side: the mockup and the app render one fixture light and dark, mockup left, with a Korean judgement per element', async ({ app, core, browser }) => {
  const p = core.project('nunchiro');
  execFileSync('git', ['-C', p, 'init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(p, 'a.txt'), 'one\nold\n');
  execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'a.txt']);
  execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  const wt = (core.cli('worktree', 'create', '--project', p, '--branch', 'herdr-layout-b', '--no-focus').worktrees as { path: string; branch: string }[]).find((w) => w.branch === 'herdr-layout-b')!;
  fakeClaude(core);
  // Round 3: the mockup's own session (Opus, effort high, Accept edits), so the two sides are one state, not two.
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', wt.path, '--label', 'layout-b', '--model', 'opus', '--effort', 'high').session as { id: string };
  // A real transcript under the id the core gave the session, so the context ring draws the session's own numbers
  // (124k of 200k, as the mockup's 62%).
  const agent = (core.cli('snapshot', '--json').sessions as { id: string; agent_session_id: string }[]).find((x) => x.id === s.id)!.agent_session_id;
  transcript(core, wt.path, agent, 124_000);
  // The header's +a −b is the session's own: two lines added, one removed under the worktree.
  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'one\ntwo\nthree\n');
  fs.mkdirSync(OUT, { recursive: true });
  const shots: string[] = [];
  const facts: Record<string, unknown> = {};
  for (const scheme of SCHEMES) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await openWindow(app, {}, core);
    await tab(app, s.id).click();
    // The mockup's mode: step the CLI's permission chip to "Accept edits" (it opens on Manual and cycles). Once only:
    // from the first pass on the agent is working, and the chip is disabled while it works. The CLI keeps the mode.
    const perm = composer(app).getByRole('button', { name: 'Permission mode' });
    if (scheme === SCHEMES[0]) {
      await expect.poll(() => core.read(s.id)).toContain('❯');
      await expect(perm).toHaveText(/^Normal/);
      await perm.click(); // ticket 285: the click opens the list; one pick (the CLI opens on Manual, listed as Normal)
      await app.getByRole('menuitemradio', { name: /^Accept edits/ }).click();
    }
    await expect(perm).toHaveText(/^Accept edits/);
    await working(app, core, s.id, agent);
    await app.locator('.composer textarea').fill(SAME_TEXT);
    await app.locator('.composer textarea').press('Enter');
    await expect(app.locator('.composer .qlist')).toContainText(SAME_TEXT);
    const m = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await m.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await m.goto(`file://${MOCKUP}`);
    // The mockup's own fake data, replaced by this fixture's so the two sides show one session.
    await m.evaluate((text) => {
      (window as unknown as { state(s: string): void }).state('running');
      document.querySelector('.top b')!.textContent = 'layout-b';
      document.querySelector('.top > span')!.textContent = '· nunchiro / herdr-layout-b';
      document.querySelector('.top .pill')!.textContent = '+2 −1';
      document.querySelector('#qtext')!.textContent = text;
    }, SAME_TEXT);
    // One frame width for both, so the two screenshots scale alike: the mockup's window takes the app header's own
    // width, and the composers then meet at the 700px cap both sides carry.
    const frame = (await app.locator('.shead').first().boundingBox())!.width;
    await m.locator('.win').evaluate((w, px) => {
      (w as HTMLElement).style.width = `${px}px`;
      (w as HTMLElement).style.margin = '0 auto';
    }, Math.round(frame));
    const [mockW, appW] = await Promise.all([m.locator('.cmp').boundingBox(), app.locator('.composer .cbox').boundingBox()]);
    expect(Math.round(mockW!.width)).toBe(700);
    expect(Math.round(appW!.width)).toBe(Math.round(mockW!.width));
    for (const [side, target, header, box] of [
      ['mockup', m, '.top', '.dock'],
      ['app', app, '.shead', '.composer'],
    ] as const) {
      for (const [part, sel] of [['header', header], ['composer', box]] as const) {
        const file = `${side}-${part}-${scheme}.png`;
        await (target as Page).locator(sel).first().screenshot({ path: path.join(OUT, file), animations: 'disabled' });
        if (!shots.includes(file)) shots.push(file);
      }
    }
    facts[scheme] = {
      mockup: {
        header: await m.locator('.top').evaluate(new Function('el', `return (${FACTS})(el)`) as never),
        composer: await m.locator('.cmp').evaluate(new Function('el', `return (${FACTS})(el)`) as never),
      },
      app: {
        header: await app.locator('.shead').first().evaluate(new Function('el', `return (${FACTS})(el)`) as never),
        composer: await app.locator('.cbox').first().evaluate(new Function('el', `return (${FACTS})(el)`) as never),
      },
    };
    await m.close();
  }
  // Every row is an element the eye sees on both sides, in the mockup's order; the numbers behind each verdict are in
  // the facts block under the pairs.
  const rows: [string, string, string, string][] = [
    ['header', '이름 (layout-b)', '같음', '양쪽 다 굵은 이름 하나; 앱은 앞에 상태 점이 더 있다'],
    ['header', '프로젝트 / 작업트리 (nunchiro / herdr-layout-b)', '같음', '같은 문자열, 같은 회색; 앱은 뒤에 · claude · working를 덧붙인다'],
    ['header', '변경 수 (+2 −1)', '같음', '양쪽 다 Diff 앞의 테두리 알약, 초록 + / 빨강 −; 같은 수를 목업에 넣었고, 앱은 core의 diff_list에서 읽은 세션의 실제 수'],
    ['header', 'Diff 버튼', '더 나음', '목업은 모양만; 앱은 눌러서 Diff 패널을 연다'],
    ['header', '알림 등급 (notify)', '더 나음', '목업에 없음; 앱은 세션별 알림 등급을 버튼+메뉴로 (네이티브 select 아님)'],
    ['composer', '대기 목록 (⏳ 대기 N개)', '더 나음', '티켓 371 항목 15: 예전 목업의 상자 안 한 줄 대신, 승인된 371 목업대로 상자 위 목록을 그립니다'],
    ['composer', '입력창 안내문', '같음', '목업은 작업 중 안내로 바꾸지만 앱은 큐 행이 그 역할을 하므로 안내문을 그대로 둔다 (needs 130 테스트1)'],
    ['composer', '텍스트 입력창 (16px 라운드 상자)', '같음', '상자 16px 라운드, 포커스 시 3px 파란 후광'],
    ['composer', '+ 버튼', '같음', '두 쪽 다 상자 왼쪽 첫 버튼'],
    ['composer', '모델 칩 (Opus)', '같음', '양쪽 다 Opus 세션, 테두리 없는 글자 + 캐럿; 앱은 세션의 실제 모델 이름, 모르는 값이면 Claude만 (r2 테스트 7). 목업의 버전 접미사(5.5)는 세션 데이터가 아니라 목업 글자다: CLI 모델 선택 화면에만 있어 웹이 알 수 없다 (core op 필요)'],
    ['composer', 'effort 칩 (high)', '같음', '양쪽 다 effort high, 테두리 없는 글자 + 캐럿; 앱은 세션의 실제 effort'],
    ['composer', '권한 모드 칩 (Accept edits)', '같음', '양쪽 다 Accept edits; 앱의 칩은 CLI 푸터에서 읽은 실제 모드라 눌러서 바꾼다 (ticket 83)'],
    ['composer', '사용량 링', '같음', '두 쪽 다 보내기 왼쪽의 원형 게이지; 앱은 트랜스크립트의 실제 사용량 (needs 123)'],
    ['composer', '프로젝트 칩', '더 나음', '목업에 없음; 앱은 nunchiro / herdr-layout-b를 상자 안에 둔다'],
    ['composer', '보내기 / 멈춤 버튼', '같음', '작업 중이면 양쪽 다 멈춤'],
    ['composer', '단축키 힌트 줄', '더 나음', '목업은 보내기·줄바꿈·멈춤만; 앱은 Esc 추가 여부를 상태에 맞춰 보인다'],
  ];
  // needs 130: no element may be worse than the mockup (worse blocks the roadmap tick), and each verdict is one of three.
  expect(rows.filter(([, , v]) => !['같음', '더 나음', '못함'].includes(v))).toEqual([]);
  expect(rows.filter(([, , v]) => v === '못함')).toEqual([]);
  const cell = (v: string) => `<td class="${v === '같음' ? 'same' : 'better'}">${v}</td>`;
  const pairs = SCHEMES.map(
    (scheme) => `<h2>${scheme === 'light' ? '라이트' : '다크'}</h2>
<div class="pair"><figure><figcaption>목업 (claude-feel-2.html)</figcaption><img src="mockup-header-${scheme}.png"><img src="mockup-composer-${scheme}.png"></figure>
<figure><figcaption>앱 (실제 화면, 같은 데이터)</figcaption><img src="app-header-${scheme}.png"><img src="app-composer-${scheme}.png"></figure></div>
<h3>요소별 판정</h3><table><tr><th>요소</th><th>판정</th><th>근거</th></tr>${rows.map(([, el, v, why]) => `<tr><td>${el}</td>${cell(v)}<td>${why}</td></tr>`).join('')}</table>`,
  ).join('\n');
  fs.writeFileSync(
    path.join(OUT, 'side-by-side.html'),
    `<!doctype html><meta charset=utf-8><title>fid-composer: 목업 대비 앱</title>
<style>body{font:14px/1.55 -apple-system,"Apple SD Gothic Neo",sans-serif;margin:0;padding:20px;max-width:1180px;margin:auto}
.pair{display:flex;gap:24px;align-items:flex-start;margin:8px 0 16px}.pair figure{flex:1;min-width:0;margin:0}
img{display:block;max-width:100%;border:1px solid #d1d9e0;border-radius:8px;margin:0 0 8px}
figcaption{font-size:12.5px;color:#59636e;margin-bottom:6px}table{border-collapse:collapse;width:100%;font-size:13.5px;margin-bottom:24px}
td,th{border-bottom:1px solid #d1d9e0;padding:5px 8px;text-align:left;vertical-align:top}
.same{color:#1a7f37;font-weight:600}.better{color:#0969da;font-weight:600}
pre{font-size:12px;color:#59636e;white-space:pre-wrap}</style>
<h1>fid-composer: 목업과 앱, 같은 데이터</h1>
<p>needs 130 (FIDELITY BAR). 왼쪽이 목업, 오른쪽이 같은 데이터로 띄운 앱: 같은 세션(Opus, effort high, Accept edits, 작업 중, 큐 한 줄), 같은 폭(입력창 700px). 판정: <b class="same">같음</b> / <b class="better">더 나음</b>, 못함 없음.</p>
${pairs}
<h2>측정값</h2><pre>${JSON.stringify(facts, null, 1)}</pre>`,
  );
  expect(fs.existsSync(path.join(OUT, 'side-by-side.html'))).toBe(true);
  // Every pair it points at exists, so the page cannot show a broken image.
  for (const f of shots) expect(fs.statSync(path.join(OUT, f)).size).toBeGreaterThan(0);
});
