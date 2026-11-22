// V2.5-8/9 (ticket 149): the PR view from the chip, the PRs tab by merge readiness, merge behind a confirm step.
// The real core runs a `gh` shim on its PATH; the shim logs every argv line, so a test sees exactly what gh was asked.
import fs from 'node:fs';
import path from 'node:path';
import { append, openChat, rec, test, expect } from './fixtures/chat/harness';
import { byReadiness } from '../src/pr/readiness';
import type { PrItem } from '../src/api';

const URL = 'https://github.com/develku/nunchiro/pull/12';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const item = (n: number, o: Partial<PrItem>): PrItem => ({
  repo: 'develku/nunchiro',
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/develku/nunchiro/pull/${n}`,
  draft: false,
  author: 'develku',
  updated_at: `2026-10-3${n % 10}T10:00:00Z`,
  review: '',
  mergeable: 'MERGEABLE',
  checks: 'pending',
  ...o,
});
const LIST = [
  item(1, { draft: true, review: 'APPROVED', checks: 'pass' }),
  item(2, { checks: 'fail', review: 'APPROVED' }),
  item(3, { checks: 'pass' }),
  item(4, { review: 'APPROVED', checks: 'pass' }),
  item(5, {}),
  item(6, { mergeable: 'CONFLICTING', checks: 'pass' }),
];

const VIEW = {
  number: 12, title: 'Add the PR view', url: URL, state: 'OPEN', isDraft: false, author: 'develku', body: 'Body <b>not html</b>',
  createdAt: '2026-10-30T10:00:00Z', headRefOid: HEAD, headRefName: 'herdr/v25-pr-view', baseRefName: 'main',
  reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', additions: 3, deletions: 1, labels: ['ui'], requested: ['bob'],
  latest: [{ who: 'amy', state: 'APPROVED' }], checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS', state: '' }],
  commits: [{ at: '2026-10-30T10:01:00Z', who: 'develku', text: 'first commit' }],
  comments: [{ at: '2026-10-30T10:03:00Z', who: 'bob', text: 'looks fine' }],
  reviews: [{ at: '2026-10-30T10:02:00Z', who: 'amy', state: 'APPROVED', text: '' }],
  files: [{ path: 'web/src/pr/PrView.tsx', additions: 3, deletions: 1 }],
};
// gh pr list answers in the `--jq` shape (the core rolls checks up from contexts).
const ghList = LIST.map((p) => ({
  number: p.number, title: p.title, url: p.url, isDraft: p.draft, author: p.author, updatedAt: p.updated_at,
  reviewDecision: p.review, mergeable: p.mergeable,
  checks: p.checks === 'pass' ? [{ status: 'COMPLETED', conclusion: 'SUCCESS', state: '' }] : p.checks === 'fail' ? [{ status: 'COMPLETED', conclusion: 'FAILURE', state: '' }] : [{ status: 'IN_PROGRESS', conclusion: '', state: '' }],
}));

function shim(home: string) {
  fs.writeFileSync(path.join(home, 'gh-view'), JSON.stringify(VIEW));
  fs.writeFileSync(path.join(home, 'gh-list'), JSON.stringify(ghList));
  fs.writeFileSync(
    path.join(home, 'bin/gh'),
    `#!/bin/sh\nprintf '%s|' "$@" >> '${home}/gh-runs'\nprintf '\\n' >> '${home}/gh-runs'\ncase "$2" in\n  view) /bin/cat '${home}/gh-view' ;;\n  diff) printf '+added line\\n-removed line\\n' ;;\n  list) /bin/cat '${home}/gh-list' ;;\nesac\n`,
    { mode: 0o700 },
  );
  return () => (fs.existsSync(path.join(home, 'gh-runs')) ? fs.readFileSync(path.join(home, 'gh-runs'), 'utf8').split('\n').filter((l) => l.startsWith('pr|')) : []);
}

test('pr_tab_sorted_by_readiness: ready, checks pass, waiting, blocked, draft', () => {
  expect(byReadiness(LIST).map((p) => p.number)).toEqual([4, 3, 5, 6, 2, 1]);
  // Inside a tier the most recently updated comes first.
  const a = item(7, { updated_at: '2026-10-01T00:00:00Z' });
  const b = item(8, { updated_at: '2026-10-02T00:00:00Z' });
  expect(byReadiness([a, b]).map((p) => p.number)).toEqual([8, 7]);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
});

async function chipChat(page: import('@playwright/test').Page, chatCore: import('./fixtures/chat/harness').ChatCore) {
  const runs = shim(chatCore.home);
  const s = chatCore.chat('alpha');
  append(s.file, rec.user('open a pr'), rec.use('t1', 'Bash', { command: 'gh pr create' }), rec.result('t1', URL));
  await openChat(page, s.id);
  const chip = page.locator('.shead .prchip button').first(); // ticket 1031: the chip is in the session header
  await expect(chip).toBeVisible({ timeout: 20_000 });
  return { runs, chip };
}

test('pr_view_from_chip: the chip opens the view (summary, timeline, changed code, reviewers, labels), then the PRs tab', async ({ page, chatCore }) => {
  const { runs, chip } = await chipChat(page, chatCore);
  await chip.click(); // click 1
  const dlg = page.getByRole('dialog', { name: 'Pull request' });
  // Off by default (needs 82): no gh until the owner turns it on.
  await expect(dlg.getByText('Turn on live PR status')).toBeVisible();
  expect(runs()).toEqual([]);
  await dlg.getByRole('button', { name: 'Turn on' }).click();
  await expect(dlg.getByRole('heading', { name: /Add the PR view/ })).toBeVisible();
  await expect(dlg.getByText('Body <b>not html</b>')).toBeVisible(); // outside text renders as text
  await expect(dlg.getByText('Checks pass')).toBeVisible();
  for (const s of ['Summary', 'Labels', 'Reviewers', 'Timeline', 'Changed code']) await expect(dlg.getByRole('region', { name: s })).toBeVisible();
  await expect(dlg.getByRole('region', { name: 'Labels' })).toContainText('ui');
  await expect(dlg.getByRole('region', { name: 'Reviewers' })).toContainText('amy');
  await expect(dlg.getByRole('region', { name: 'Reviewers' })).toContainText('bob requested');
  await expect(dlg.locator('.pr-timeline li')).toHaveText([/develku committed/, /amy reviewed/, /bob commented/]);
  await expect(dlg.locator('.pr-diff [data-line="add"]')).toHaveText('+added line');
  await dlg.screenshot({ path: test.info().outputPath('pr-view.png') });
  expect(runs()).toEqual([expect.stringMatching(/^pr\|view\|https:\/\/github\.com\/develku\/nunchiro\/pull\/12\|--json\|/), `pr|diff|${URL}|--color|never|`]);
  // The PRs tab (click 2 from the view): sorted by merge readiness.
  await dlg.getByRole('tab', { name: 'PRs' }).click();
  await expect(dlg.locator('.pr-row .pr-rtitle')).toHaveText(['PR 4', 'PR 3', 'PR 5', 'PR 6', 'PR 2', 'PR 1']);
  await expect(dlg.locator('.pr-row .pr-tier').first()).toHaveText('Ready to merge');
  await dlg.screenshot({ path: test.info().outputPath('pr-list.png') });
  expect(runs().at(-1)).toBe('pr|list|--repo|develku/nunchiro|--state|open|--limit|30|--json|number,title,url,isDraft,author,updatedAt,reviewDecision,mergeable,statusCheckRollup|--jq|' + runs().at(-1)!.split('--jq|')[1]);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});

test('merge_needs_confirm: Merge… asks first; Cancel sends nothing; Merge now merges the head commit shown', async ({ page, chatCore }) => {
  const { runs, chip } = await chipChat(page, chatCore);
  await chip.click();
  const dlg = page.getByRole('dialog', { name: 'Pull request' });
  await dlg.getByRole('button', { name: 'Turn on' }).click();
  await dlg.getByRole('combobox', { name: 'Merge method' }).selectOption('rebase');
  await dlg.getByRole('button', { name: 'Merge…' }).click();
  const ask = dlg.getByRole('alertdialog');
  await expect(ask).toContainText('Merge #12 into main (Rebase) with the GitHub CLI (gh)? Head commit: 0123456');
  await dlg.screenshot({ path: test.info().outputPath('pr-confirm.png') });
  await page.waitForTimeout(300);
  expect(runs().filter((l) => l.startsWith('pr|merge'))).toEqual([]);
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(runs().filter((l) => l.startsWith('pr|merge'))).toEqual([]);
  await dlg.getByRole('button', { name: 'Merge…' }).click();
  await dlg.getByRole('button', { name: 'Merge now' }).click();
  await expect.poll(() => runs().filter((l) => l.startsWith('pr|merge'))).toEqual([`pr|merge|${URL}|--rebase|--match-head-commit|${HEAD}|`]);
});
