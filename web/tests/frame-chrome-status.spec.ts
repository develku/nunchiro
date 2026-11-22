// Ticket 1031 status bar (mockup docs/design/bot-statusbar-1121/index.html 1-1, 1-2): the session's state + agent, branch,
// +N −M, the limit chip, the Lock switch and the keys chip are gone (the header and the tree say them); the PR chip sits
// in the session header beside +N −M; "Connected" is words for a screen reader only and a lost connection shows; notices
// only when set. The usage block at the left end is usage-block-1031.spec.ts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, test as plain } from './fixtures';
import { append, chat, expect, rec, test } from './fixtures/chat/harness';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });

test('status_bar_items', async ({ page, chatCore }) => {
  const project = chatCore.project('bar');
  git(project, 'init', '-q');
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'init');
  const wt = (chatCore.cli('worktree', 'create', '--project', project, '--branch', 'feat-x', '--no-focus').worktrees as { branch: string; path: string }[]).find((w) => w.branch === 'feat-x')!;
  const s = chatCore.cli('session', 'start', '--kind', 'claude', '--project', wt.path, '--label', 'bar').session as { id: string; cwd: string; agent_session_id: string };
  const file = chatCore.transcriptPath(s);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.writeFileSync(path.join(s.cwd, 'new.txt'), 'one\ntwo\n');
  append(file, rec.user('open a pr'), rec.use('t1', 'Bash', { command: 'gh pr create' }), rec.result('t1', 'https://github.com/develku/nunchiro/pull/12'));
  await page.goto('/');
  const connected = page.getByRole('status').filter({ hasText: /^Connected$/ });
  await expect(connected).toBeVisible();
  await page.locator(`.tab[data-tab="${s.id}"]`).click();
  const bar = page.locator('footer.status');
  const head = page.locator('.shead');
  // The header carries the session's facts: state, branch and agent, then the PR chip, +N −M and Diff, left to right.
  await expect(head.locator('.dim').first()).toContainText('feat-x · claude');
  const parts = ['.st', '.prchip', '.hstat'];
  for (const p of parts) await expect(head.locator(p)).toBeVisible({ timeout: 20_000 });
  await expect(head.locator('.hstat')).toContainText('+2');
  const xs = await Promise.all(parts.map((p) => head.locator(p).evaluate((e) => e.getBoundingClientRect().left)));
  expect(xs).toEqual([...xs].sort((a, b) => a - b));
  expect((await head.locator('.prchip').boundingBox())!.height).toBeLessThanOrEqual(24); // inside the 24 px header line
  await expect(chat(page, s.id).locator('.prchip')).toBeHidden(); // NODUP: the chip is in the header only
  fs.mkdirSync(path.join(REPO, '.scratch/shots/1031'), { recursive: true });
  await page.screenshot({ path: path.join(REPO, '.scratch/shots/1031', `header-pr-${test.info().project.name}.png`) });
  // A narrow window: the chip's one-time offer gives way, the header does not overflow and the state button stays whole.
  await page.setViewportSize({ width: 820, height: 700 });
  expect(await head.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await expect(head.locator('.prchip button').first()).toBeVisible();
  expect(await head.locator('.prchip button').first().evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  // The status bar repeats none of it, and has no Lock switch or keys chip.
  for (const gone of ['.fstate', '.fbranch', '.fdiff', '.flimit', '.prchip', '.lock', '.keyhelp', '.cdot']) await expect(bar.locator(gone), gone).toHaveCount(0);
  await expect(page.getByRole('switch', { name: /lock/i })).toHaveCount(0);
  const text = await bar.innerText();
  expect(text).not.toMatch(/density|1 machine|feat-x|claude|Working|Idle|Lock|keys|\+2/);
  // Connected is the normal state: one clipped pixel a screen reader still hears, nothing to read on the bar.
  const box = (await connected.boundingBox())!;
  expect(box.width * box.height).toBeLessThanOrEqual(1);
  await expect(bar.locator('.fcore')).toHaveCount(0);
  await expect(bar.locator('.lerr, .lnote')).toHaveCount(0); // notices only while set
});

plain('disconnected_shows: without a core connection the bar says so, in words one can read', async ({ page, core }) => {
  await page.addInitScript((b) => (window.__NUNCHIRO__ = { ...b, token: 'f'.repeat(64) }), core.boot()); // as api.spec.ts: never connects
  await page.goto('/');
  const lost = page.locator('footer.status .fcore');
  await expect(lost).toHaveText('Disconnected · reconnecting');
  await expect(lost).toHaveAttribute('role', 'status');
  await expect(lost.locator('.cdot.off')).toBeVisible();
  expect((await lost.boundingBox())!.width).toBeGreaterThan(40);
});
