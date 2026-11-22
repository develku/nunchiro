// V2.5-34 (needs 149): Done cards say what became of their pull request. Real core, `gh` shim on its PATH that logs every call.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { append, rec, test, expect, type ChatCore } from './fixtures/chat/harness';

const URLS = { merged: 'https://github.com/develku/nunchiro/pull/12', open: 'https://github.com/develku/nunchiro/pull/13' };
const view = (state: 'MERGED' | 'OPEN', n: number, url: string) => ({
  number: n, title: state === 'MERGED' ? 'Add the PR view' : 'Board Done card detail', url, state, isDraft: false, author: 'develku', body: '',
  createdAt: '2026-10-30T10:00:00Z', headRefOid: '0123456789abcdef0123456789abcdef01234567', headRefName: `herdr/pr-${n}`, baseRefName: 'main',
  reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', additions: 120, deletions: 34, labels: [], requested: [], latest: [],
  checks: [{ status: 'COMPLETED', conclusion: state === 'MERGED' ? 'SUCCESS' : 'FAILURE', state: '' }],
  commits: [], comments: [], reviews: [], files: [{ path: 'web/src/board/DoneFacts.tsx', additions: 120, deletions: 34 }],
});

function shim(home: string) {
  for (const [k, url] of Object.entries(URLS)) fs.writeFileSync(path.join(home, `gh-${url.split('/').pop()}`), JSON.stringify(view(k === 'merged' ? 'MERGED' : 'OPEN', Number(url.split('/').pop()), url)));
  fs.writeFileSync(
    path.join(home, 'bin/gh'),
    `#!/bin/sh\nprintf '%s %s\\n' "$2" "$3" >> '${home}/gh-runs'\ncase "$2" in\n  view) /bin/cat "${home}/gh-\${3##*/}" ;;\n  diff) printf '+added line\\n' ;;\nesac\n`,
    { mode: 0o700 },
  );
  // One short line per call ("view <url>"): the gh argv holds the multi-line --jq program, and logging it let two calls that start
  // together (both cards ask at once) splice their lines, so a call went missing from the count (round 2, finding 1).
  return (n: number) => (fs.existsSync(path.join(home, 'gh-runs')) ? fs.readFileSync(path.join(home, 'gh-runs'), 'utf8').split('\n').filter((l) => l === `view ${URLS.merged.replace(/12$/, String(n))}`) : []);
}
const card = (page: Page, title: string) => page.locator('.board .bcard').filter({ has: page.locator('.btt', { hasText: new RegExp(`^${title}$`) }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
});

/** Two exited Claude sessions (PR 12 merged, PR 13 open with failing checks), live PR status on, both cards in the Done column. */
async function boot(page: Page, chatCore: ChatCore) {
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/board/layout.toml'), path.join(chatCore.home, 'layout.toml'));
  const asked = shim(chatCore.home);
  const sessions = (['merged', 'open'] as const).map((k) => {
    const s = chatCore.chat(k);
    append(s.file, rec.user('open a pr'), rec.use('t1', 'Bash', { command: 'gh pr create' }), rec.result('t1', URLS[k]));
    if (k === 'merged') append(s.file, rec.use('t2', 'Bash', { command: `gh pr view ${URLS[k]} --json state` }), rec.result('t2', '{"state":"MERGED"}'));
    return s;
  });
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  // Live PR status is the owner's opt-in (needs 82): turn it on once from the chip.
  await page.locator(`.tab[data-tab="${sessions[0].id}"]`).click();
  await page.locator('.shead .prchip button').first().click({ timeout: 20_000 });
  await page.getByRole('dialog', { name: 'Pull request' }).getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('dialog', { name: 'Pull request' }).getByRole('heading', { name: /Add the PR view/ })).toBeVisible();
  await page.keyboard.press('Escape');
  for (const s of sessions) chatCore.cli('session', 'send-text', s.id, 'EXIT\r');
  await page.mouse.move(2, 2); // the board holds still while the pointer is over it (needs 26)
  await expect(page.locator('.board [data-column="done"] .bcard')).toHaveCount(2, { timeout: 20_000 });
  return { asked, sessions, merged: card(page, 'merged'), open: card(page, 'open') };
}

test('done_card_facts_real: Done cards show the PR state, checks, lines, when and commit; Details opens the rest; cached across remounts', async ({ page, chatCore }) => {
  const { asked, sessions, merged, open } = await boot(page, chatCore);
  // The fact line and the quiet line.
  await expect(merged.locator('.bfact')).toContainText('Merged #12', { timeout: 20_000 });
  await expect(merged.locator('.bfact')).toContainText('+120 −34');
  await expect(merged.locator('.bfact').getByRole('img', { name: 'All checks passing' })).toBeVisible(); // the check icon; the words are its name
  await expect(merged.locator('.bfact b')).toHaveCSS('color', /rgb\((130, 80, 223|163, 113, 247)\)/); // --done, violet
  await expect(merged.locator('.bquiet')).toContainText(/just now|min ago/);
  await expect(merged.locator('.bquiet')).toContainText('0123456');
  await expect(open.locator('.bfact')).toContainText('Open #13');
  await expect(open.locator('.bfact')).toContainText('+120 −34');
  await expect(open.locator('.bfact').getByRole('img', { name: 'Checks failing' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('board-done.png') });
  // Detail opens from its labelled button and does not open the session.
  await merged.getByRole('button', { name: 'Details' }).click();
  await expect(merged.getByRole('group', { name: 'Pull request detail' })).toContainText('herdr/pr-12 → main');
  // V2.5-37 (placement item 5 rows): changes and review are rows of their own.
  await expect(merged.getByRole('group', { name: 'Pull request detail' })).toContainText('Files changed: 1 +120 −34');
  await expect(merged.getByRole('group', { name: 'Pull request detail' })).toContainText('ReviewApproved');
  await expect(page.locator(`.tab[data-tab="${sessions[1].id}"][aria-selected="true"]`)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('board-done-detail.png') });
  // V2.5-37 (ticket 177 gaps folded into 185): the merge mark before the state, a Checks row, Open PR and Open session.
  const detail = merged.getByRole('group', { name: 'Pull request detail' });
  await expect(merged.locator('.bfact .bprm')).toBeVisible();
  await expect(detail).toContainText('ChecksAll checks passing');
  await expect(detail.getByRole('button', { name: 'Open PR ↗' })).toBeVisible();
  await merged.getByRole('button', { name: 'Hide' }).click();
  await expect(merged.getByRole('group', { name: 'Pull request detail' })).toHaveCount(0);

  // merged_cached: the project filter unmounts and remounts the cards; no new pr_view, merged or open (inside the minute).
  // Expected `gh pr view` calls so far: PR 12 twice (the chip dialog that turned live status on has its own call, then the
  // card's one read), PR 13 once (the card's one read; the badge alone never asks gh).
  const before = [asked(12).length, asked(13).length];
  expect(before, 'PR 12: dialog + card; PR 13: card').toEqual([2, 1]);
  // ticket 219 / needs 178 L10, needs 185: the project filter is a searchable picker; pick the first project, then All projects.
  await page.locator('button.bproj').click();
  await page.getByRole('option').nth(1).click();
  await page.locator('button.bproj').click();
  await page.getByRole('option', { name: 'All projects', exact: true }).click();
  await expect(merged.locator('.bfact')).toContainText('+120 −34');
  await page.waitForTimeout(1500);
  expect([asked(12).length, asked(13).length]).toEqual(before);
  // Open session in the detail focuses that card's session.
  await open.getByRole('button', { name: 'Details' }).click();
  await open.getByRole('group', { name: 'Pull request detail' }).getByRole('button', { name: 'Open session' }).click();
  await expect(page.locator(`.tab[data-tab="${sessions[1].id}"][aria-selected="true"]`)).toHaveCount(1);
});

test('details_a11y: Details is its own focusable button, not inside another button, and Enter and Space open and close it', async ({ page, chatCore }) => {
  const { sessions, open } = await boot(page, chatCore); // the open card's session was never selected, so "opened" is visible
  const details = open.getByRole('button', { name: /details/i });
  await expect(details).toHaveCount(1, { timeout: 20_000 });
  // The accessibility tree drops a button nested in role=button: no ancestor of Details may be one.
  expect(await details.evaluate((el) => el.parentElement!.closest('button, [role="button"], a[href]') === null)).toBe(true);
  const group = open.getByRole('group', { name: 'Pull request detail' });
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(group).toContainText('herdr/pr-13 → main');
  await expect(open.getByRole('button', { name: /hide/i })).toHaveAttribute('aria-expanded', 'true'); // the same button, now named Hide
  await page.keyboard.press('Enter');
  await expect(group).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(group).toHaveCount(1);
  await page.keyboard.press('Space');
  await expect(group).toHaveCount(0);
  // The keys were Details' own: the card did not open its session.
  await expect(page.locator(`.tab[data-tab="${sessions[1].id}"][aria-selected="true"]`)).toHaveCount(0);
});

test('card_click_session: clicking the card body opens its session and not the detail', async ({ page, chatCore }) => {
  const { sessions, open } = await boot(page, chatCore);
  const selected = page.locator(`.tab[data-tab="${sessions[1].id}"][aria-selected="true"]`);
  await expect(open.locator('.bfact')).toContainText('+120 −34', { timeout: 20_000 });
  await expect(selected).toHaveCount(0);
  await open.locator('.bfact').click(); // the fact line is part of the card body
  await expect(selected).toHaveCount(1);
  await expect(open.getByRole('group', { name: 'Pull request detail' })).toHaveCount(0);
});

test('card_click_session: Enter on the card button (title and state) opens its session and not the detail', async ({ page, chatCore }) => {
  const { sessions, open } = await boot(page, chatCore);
  await expect(open.locator('.bfact')).toContainText('+120 −34', { timeout: 20_000 });
  await open.getByRole('button', { name: /opens the session/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`.tab[data-tab="${sessions[1].id}"][aria-selected="true"]`)).toHaveCount(1);
  await expect(open.getByRole('group', { name: 'Pull request detail' })).toHaveCount(0);
});
