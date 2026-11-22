// V2.5-34 (needs 149): what a Done card says about its pull request, and the cache that keeps a merged PR to one read.
// Lifted and adapted (MIT):
//   - the state set, labels and tones (open green, draft grey, closed red, merged violet) from T3 Code
//     `apps/web/src/components/pullRequest/pullRequestIcons.tsx` (PULL_REQUEST_STATE_PRESENTATION), commit
//     d14ace8233ad3cf7856b6b834824f888240d67a1. Copyright (c) 2026 T3 Tools Inc. Tones map onto our tokens and
//     the labels onto our existing `chat.pr.*` words; the lucide icons are not lifted (state is a word, never a glyph alone).
//   - the checks wording ("All checks passing", "checks failing", "checks pending", "No checks found") from Orca
//     `src/renderer/src/components/pr-check-counts.ts` (getChecksSummaryLabel), commit
//     2eb0bb637dff41925d8ffa22ff9054ab656e4816. Copyright (c) 2026 Lovecast Inc. The core's `pr_view` gives a rollup
//     (pass, fail, pending, none), not per-check rows, so only the summary wording applies; the count chips do not.
// MIT License. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction, including without
// limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
// Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of
// the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
// EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
// OTHER DEALINGS IN THE SOFTWARE.
import type { CoreClient, PrView } from '../api';
import type { PrChipData } from '../chat/PrChip';
import type { Key } from '../i18n';

export type PrKind = 'open' | 'draft' | 'closed' | 'merged';
export type Checks = PrView['checks'];

/** Label key (our `chat.pr.*` words) and token per state; the token is the tone, the word is the fact. */
export const STATE_PRESENTATION: Record<PrKind, { label: Key; tone: string }> = {
  open: { label: 'chat.pr.open', tone: 'var(--ok)' },
  draft: { label: 'chat.pr.draft', tone: 'var(--muted)' },
  closed: { label: 'chat.pr.closed', tone: 'var(--bad)' },
  merged: { label: 'chat.pr.merged', tone: 'var(--done)' },
};

export const CHECKS_WORD: Record<Checks, Key> = {
  pass: 'board.done.checks.pass',
  fail: 'board.done.checks.fail',
  pending: 'board.done.checks.pending',
  none: 'board.done.checks.none',
};

export const kindOf = (v: Pick<PrView, 'state' | 'draft'>): PrKind => (v.state === 'MERGED' ? 'merged' : v.state === 'CLOSED' ? 'closed' : v.draft ? 'draft' : 'open');

/** What the transcript badge alone knows (gh off, or a repository the core does not know): the state and the checks it hints. */
export function kindOfChip(c: PrChipData): { kind: PrKind; checks: Checks | null } {
  const kind: PrKind = c.state === 'merged' || c.state === 'closed' || c.state === 'draft' ? c.state : 'open';
  return { kind, checks: c.state === 'checks_pass' ? 'pass' : c.state === 'checks_fail' ? 'fail' : null };
}

const TTL = 60_000;
interface Entry {
  at: number;
  view: PrView | null;
}
interface Cache {
  /** A merged PR no longer changes: kept for the life of the window. */
  merged: Map<string, PrView>;
  /** Anything else (open, closed, a refusal) is asked again after TTL, never on every board poll. */
  recent: Map<string, Entry>;
  flying: Map<string, Promise<PrView | null>>;
}
const caches = new WeakMap<object, Cache>();

/** `pr_view` for `url` through `core`, or null when the core refuses (live PR status off, unknown repository, gh failed). */
export function loadPrView(core: CoreClient, url: string, now = Date.now()): Promise<PrView | null> {
  let c = caches.get(core);
  if (!c) caches.set(core, (c = { merged: new Map(), recent: new Map(), flying: new Map() }));
  const done = c.merged.get(url);
  if (done) return Promise.resolve(done);
  const hit = c.recent.get(url);
  if (hit && now - hit.at < TTL) return Promise.resolve(hit.view);
  const flying = c.flying.get(url);
  if (flying) return flying;
  const cache = c;
  const p = core.prView(url).then(
    (view) => view,
    () => null,
  ).then((view) => {
    cache.flying.delete(url);
    if (view?.state === 'MERGED') cache.merged.set(url, view);
    else cache.recent.set(url, { at: now, view });
    return view;
  });
  c.flying.set(url, p);
  return p;
}

/** The last answer without asking, so a remounted card paints its facts at once. */
export const peekPrView = (core: CoreClient, url: string): PrView | null => {
  const c = caches.get(core);
  return c?.merged.get(url) ?? c?.recent.get(url)?.view ?? null;
};
