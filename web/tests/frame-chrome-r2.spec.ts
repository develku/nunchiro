// CHROME round 2 (CLAUDEFEEL): transcript views, the per-turn summary line, the turn's changes card, the decision line.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';
import { patchSnapshots } from './visual/compare';

const turn = (file: string, cwd: string) =>
  append(
    file,
    rec.user('fix the row height'),
    rec.thinking('the row is 22 px, check the css first'),
    rec.use('r1', 'Read', { file_path: `${cwd}/a.css` }),
    rec.result('r1', 'css', { timestamp: '2026-10-29T10:00:00.000Z' }),
    rec.use('r2', 'Read', { file_path: `${cwd}/b.css` }),
    rec.result('r2', 'css'),
    rec.edit('e1', `${cwd}/a.css`, ['-a', '+b', '+c']),
    rec.edit('e2', `${cwd}/b.css`, ['-x', '+y']),
    rec.use('t1', 'Bash', { command: 'pnpm test' }),
    rec.result('t1', '18 passed', { timestamp: '2026-10-29T10:00:42.000Z' }),
    rec.assistant('Done.'),
    rec.end(),
  );

test('transcript_views_cycle', async ({ page, chatCore }) => {
  const s = chatCore.chat('views');
  turn(s.file, s.cwd);
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const btn = view.getByRole('button', { name: /^Transcript view/ });
  await expect(btn).toContainText('Normal');
  await btn.click();
  await expect(btn).toContainText('Thinking');
  await btn.click();
  // Verbose still exposes every step and thinking.
  await expect(btn).toContainText('Verbose');
  await expect(view.locator('.tool .tl').first()).toBeVisible();
  await expect(view.getByRole('button', { name: /^Thinking/ })).toBeVisible();
  // Ctrl+O cycles Verbose -> Normal.
  await page.keyboard.press('Control+KeyO');
  await expect(btn).toContainText('Normal');
  const sum = view.locator('.sum');
  await expect(sum).toHaveCount(1);
  await expect(sum).toContainText('Read 2 files');
  await expect(sum).toContainText('18 passed');
  await expect(sum).toContainText('42s');
  await expect(sum).toHaveAttribute('aria-expanded', 'false');
  await expect(view.locator('.tool')).toHaveCount(0); // steps are collapsed away
  await expect(view.getByRole('button', { name: /^Thinking/ })).toHaveCount(0);
  await sum.focus();
  await page.keyboard.press('Enter');
  await expect(sum).toHaveAttribute('aria-expanded', 'true');
  await expect(view.locator('.tool .tl').first()).toBeVisible();
  await page.keyboard.press('Space');
  await expect(sum).toHaveAttribute('aria-expanded', 'false');
  await sum.click();
  await expect(sum).toHaveAttribute('aria-expanded', 'true');
  // Normal -> Thinking: summary stays, thinking shows. The visible control cycles too.
  await btn.click();
  await expect(btn).toContainText('Thinking');
  await expect(view.getByRole('button', { name: /^Thinking/ })).toBeVisible();
  await expect(view.locator('.sum')).toHaveCount(1);
  await btn.click();
  await expect(btn).toContainText('Verbose');
  await expect(view.locator('.sum')).toHaveCount(0);
});

test('turn_changes_card_aggregates', async ({ page, chatCore }) => {
  const dir = chatCore.project('agg');
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]);
  git('init', '-q');
  for (const f of ['a.css', 'b.css']) fs.writeFileSync(path.join(dir, f), 'a\nx\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const s0 = chatCore.cli('session', 'start', '--kind', 'claude', '--project', dir, '--label', 'agg').session as { id: string; cwd: string; agent_session_id: string };
  const file = chatCore.transcriptPath(s0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.writeFileSync(path.join(s0.cwd, 'a.css'), 'b\nc\nx\n');
  fs.writeFileSync(path.join(s0.cwd, 'b.css'), 'a\ny\n');
  turn(file, s0.cwd);
  await openChat(page, s0.id);
  const view = chat(page, s0.id);
  await expect(view.getByRole('button', { name: /^Transcript view/ })).toContainText('Normal');
  const card = view.locator('.chcard');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('2 files');
  await expect(card).toContainText('+3 −2');
  await expect(card.locator('[data-path]')).toHaveCount(2);
  await expect(view.locator('.dcard')).toHaveCount(0);
  await card.getByRole('button', { name: 'View in Diff' }).click();
  await expect(page.getByRole('list', { name: 'Changed files' })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Control+KeyO'); // Thinking
  await page.keyboard.press('Control+KeyO'); // Verbose: per-edit cards again
  await expect(view.locator('.dcard')).toHaveCount(2);
});

test('decision_line_points_to_widget', async ({ page, chatCore }) => {
  const s = chatCore.chat('asks');
  append(s.file, rec.user('go'), rec.assistant('Need to run it.'));
  // The answer strip (on by default) shows the decision itself and the chat then skips it (decision_shown_once); with the strip off the chat line is the pointer.
  await page.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ strip: 'off' })));
  await patchSnapshots(page, { asks: { waiting: 'permission', text: 'Bash: pnpm install' } });
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.dline')).toHaveCount(0); // needs 205: no line in the chat
  await expect(view.getByRole('button', { name: /allow|deny|accept|reject/i })).toHaveCount(0); // no answer controls in the chat
  // Ticket 1030: the session in front answers its permission request on the card above its composer, and Decisions no
  // longer lists it (tree/decisions.ts `withoutFront`). Before 1030 the Decisions widget held it.
  await expect(page.locator(`.composer .deccard.docked[data-session="${s.id}"]`)).toContainText('pnpm install');
  await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  await expect(page.locator('.sbar[data-widget="decisions"], .wg[data-widget="decisions"]').first()).toContainText('Nothing waiting');
});

// Pictures for the side-by-side page (ROUND 2): a real transcript in each view, same 1440x900 window.
for (const scheme of ['light', 'dark'] as const) {
  test(`frame_side_by_side chat views (${scheme})`, async ({ page, chatCore }) => {
    const out = path.join(import.meta.dirname, '../../.scratch/chrome/shots');
    fs.mkdirSync(out, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const s = chatCore.chat('ux-fix-2');
    turn(s.file, s.cwd);
    await patchSnapshots(page, { 'ux-fix-2': { waiting: 'permission', text: 'cargo test --workspace' } });
    await openChat(page, s.id);
    await page.keyboard.press('Control+KeyO'); // Thinking
    await page.keyboard.press('Control+KeyO'); // Verbose
    await page.mouse.move(700, 880);
    await page.screenshot({ path: path.join(out, `chat-verbose-app-${scheme}.png`) });
    await page.keyboard.press('Control+KeyO');
    await page.locator('.sum').first().click();
    await page.mouse.move(700, 880);
    await page.screenshot({ path: path.join(out, `chat-normal-app-${scheme}.png`) });
  });
}
