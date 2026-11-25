// Ticket 1087: a message with an image always goes with its image (Enter, Enter while the agent works, Ctrl+Enter, a queued
// row's Send now), and the "!" shell mode is easy to notice: the whole box takes the shell look in a Claude and a Codex box,
// and the chat shows the command the person ran. A real core and the fake agent of steer-1056.spec.ts; the window's socket
// is watched, never rewritten.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { give, helpers } from './fixtures/images/helpers';

const SHOTS = path.join(REPO, '.scratch/shots');
const shot = (app: Page, name: string) => app.screenshot({ path: path.join(SHOTS, `chat-input-1087-${name}.png`) });
const cbox = (app: Page) => app.locator('.cbox:visible').first();
const box = (app: Page) => cbox(app).locator('textarea:not(.hoff-edit)');
const chips = (app: Page) => app.locator('.cbox .ichip');
const rows = (app: Page) => app.locator('.composer .qrow');
const isWorking = (core: Core, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; attention: { working: boolean } }[]).find((x) => x.id === id)?.attention.working;
const fake = (core: Core, name: 'claude' | 'codex') => fs.writeFileSync(path.join(core.home, 'bin', name), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
/** The core's rows for a session (queued and sent), as the snapshot carries them. */
const sendLog = (core: Core, id: string) => ((core.cli('snapshot', '--json').sessions as { id: string; send_log?: { content: string }[] }[]).find((x) => x.id === id)?.send_log ?? []).map((r) => r.content);

/** Every request the window sends to the core, in order. */
async function watch(app: Page) {
  const sent: { op: string; [k: string]: unknown }[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? (JSON.parse(m) as { request?: { op: string } }) : null;
      if (msg?.request) sent.push(msg.request);
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return sent;
}

async function working(app: Page, core: Core) {
  fake(core, 'claude');
  await app.addInitScript(helpers);
  const s = core.agent(core.project('p'), 'alpha', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  core.hook(s.id, 'UserPromptSubmit');
  await expect.poll(() => isWorking(core, s.id)).toBe(true);
  await expect(app.locator('.composer .send')).toHaveAccessibleName('Stop');
  await box(app).focus();
  return s;
}
const imageLine = (id: string) => new RegExp(`^/.*/images/${id}/[^\\n]+$`, 'm');

test('ctrl_enter_sends_the_image: a steered message carries its image lines to the core and empties the box', async ({ app, core }) => {
  const sent = await watch(app);
  const s = await working(app, core);
  await give(app, [{ png: [40, 30, 7, 'image.png'] }]);
  await expect(chips(app)).toHaveCount(1);
  await box(app).fill('what is in this picture');
  await box(app).press('Control+Enter');
  await expect(box(app)).toHaveValue('');
  await expect(chips(app)).toHaveCount(0);
  const steer = sent.filter((r) => r.op === 'steer_now').map((r) => String(r.text));
  expect(steer).toHaveLength(1);
  expect(steer[0].split('\n')[0]).toBe('what is in this picture');
  expect(steer[0]).toMatch(imageLine(s.id));
  // The core holds it with the image line, to write once Claude's box shows (sessions.rs steer_now).
  await expect.poll(() => sendLog(core, s.id).some((c) => c.startsWith('what is in this picture\n') && imageLine(s.id).test(c))).toBe(true);
  await shot(app, 'ctrl-enter-image');
});

test('queued_row_shows_its_image_and_send_now_sends_it', async ({ app, core }) => {
  const sent = await watch(app);
  const s = await working(app, core);
  await give(app, [{ png: [40, 30, 8, 'image.png'] }]);
  await expect(chips(app)).toHaveCount(1);
  await box(app).fill('and this one');
  await box(app).press('Enter');
  await expect(rows(app)).toHaveCount(1);
  await expect(box(app)).toHaveValue('');
  await expect(chips(app)).toHaveCount(0);
  await expect(rows(app).first().locator('.qt')).toHaveText('and this one'); // the path line is not shown as words
  await expect(rows(app).first().locator('.qimg')).toHaveText('Image #1');
  await shot(app, 'queued-image');
  await rows(app).first().getByRole('button', { name: '1 Send now', exact: true }).click();
  await expect.poll(() => sent.filter((r) => r.op === 'steer_now').map((r) => String(r.text))).toEqual([expect.stringMatching(/^and this one\n\//)]);
  expect(String(sent.find((r) => r.op === 'steer_now')!.text)).toMatch(imageLine(s.id));
});

for (const kind of ['claude', 'codex'] as const)
  test(`shell_look_in_a_${kind}_box: "!" first turns the whole box to the shell look; delete and send clear it`, async ({ app, core }) => {
    fake(core, kind);
    const project = core.project('p');
    const s = kind === 'claude' ? core.agent(project, 'alpha', 'x') : (core.cli('session', 'start', '--kind', 'codex', '--project', project, '--label', 'beta').session as { id: string });
    await openWindow(app);
    await app.locator(`.tab[data-tab="${s.id}"]`).click();
    await expect(box(app)).toBeEditable();
    const chip = cbox(app).locator('.shellchip');
    await expect(chip).toBeHidden();
    await box(app).pressSequentially('!');
    await expect(cbox(app)).toHaveAttribute('data-shell', '');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Shell');
    await expect(chip).toContainText('Runs as a shell command in p');
    expect(await cbox(app).evaluate((e) => parseFloat(getComputedStyle(e).outlineWidth))).toBeGreaterThanOrEqual(2);
    await box(app).pressSequentially('ls');
    await shot(app, `shell-${kind}`);
    await box(app).press('Backspace');
    await box(app).press('Backspace');
    await box(app).press('Backspace');
    await expect(cbox(app)).not.toHaveAttribute('data-shell', '');
    await expect(chip).toBeHidden();
    await box(app).pressSequentially('!ls');
    await expect(chip).toBeVisible();
    await box(app).press('Enter');
    await expect(box(app)).toHaveValue('');
    await expect(cbox(app)).not.toHaveAttribute('data-shell', '');
    await expect(chip).toBeHidden();
  });

test('shell_command_row: after "! ls" the chat shows the command and its output as Claude wrote them', async ({ app, core }) => {
  fake(core, 'claude');
  const s = core.agent(core.project('p'), 'alpha', 'x');
  // The two records Claude 2.1.330 writes for "! ls" (seen in a real run, 2026-11-23).
  const file = core.transcriptPath(s);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (type: string, content: unknown) => JSON.stringify({ type, uuid: crypto.randomUUID(), message: { role: type, content } }) + '\n';
  fs.appendFileSync(file, line('user', 'hello') + line('assistant', [{ type: 'text', text: 'Hi.' }]) + line('user', '<bash-input>ls</bash-input>') + line('user', '<bash-stdout>a.txt\nb.txt</bash-stdout><bash-stderr></bash-stderr>'));
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const row = app.locator('.shellrow');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.shc')).toHaveText('!ls');
  await expect(row.locator('.shm')).toHaveAccessibleName('Shell');
  await expect(row.locator('pre')).toHaveText('a.txt\nb.txt');
  await expect(app.getByText('<bash-stdout>', { exact: false })).toHaveCount(0);
  await shot(app, 'shell-row');
});
