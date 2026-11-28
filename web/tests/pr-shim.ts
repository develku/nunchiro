// The PR view's fake gh (pr-view.spec.ts, themes-sweep.spec.ts): a shim on the core's PATH answers view, diff and list
// from fixed JSON and logs every argv line, so a test sees exactly what gh was asked.
import fs from 'node:fs';
import path from 'node:path';
import type { PrItem } from '../src/api';

export const URL = 'https://github.com/develku/nunchiro/pull/12';
export const HEAD = '0123456789abcdef0123456789abcdef01234567';
export const item = (n: number, o: Partial<PrItem>): PrItem => ({
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
export const LIST = [
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

export function shim(home: string) {
  fs.writeFileSync(path.join(home, 'gh-view'), JSON.stringify(VIEW));
  fs.writeFileSync(path.join(home, 'gh-list'), JSON.stringify(ghList));
  fs.writeFileSync(
    path.join(home, 'bin/gh'),
    `#!/bin/sh\nprintf '%s|' "$@" >> '${home}/gh-runs'\nprintf '\\n' >> '${home}/gh-runs'\ncase "$2" in\n  view) /bin/cat '${home}/gh-view' ;;\n  diff) printf '+added line\\n-removed line\\n' ;;\n  list) /bin/cat '${home}/gh-list' ;;\nesac\n`,
    { mode: 0o700 },
  );
  return () => (fs.existsSync(path.join(home, 'gh-runs')) ? fs.readFileSync(path.join(home, 'gh-runs'), 'utf8').split('\n').filter((l) => l.startsWith('pr|')) : []);
}
