// V2.5-9: merge readiness, best first. Draft before blocked would hide a fixable PR, so drafts go last.
import type { PrItem } from '../api';

export type Tier = 0 | 1 | 2 | 3 | 4;

/** 0 ready to merge, 1 checks pass and review pending, 2 waiting, 3 blocked (failing checks, conflicts, changes asked), 4 draft. */
export function tier(p: Pick<PrItem, 'draft' | 'review' | 'checks' | 'mergeable'>): Tier {
  if (p.draft) return 4;
  if (p.checks === 'fail' || p.mergeable === 'CONFLICTING' || p.review === 'CHANGES_REQUESTED') return 3;
  if (p.review === 'APPROVED' && (p.checks === 'pass' || p.checks === 'none')) return 0;
  if (p.checks === 'pass') return 1;
  return 2;
}

/** By tier, then the most recently updated first. */
export function byReadiness(prs: PrItem[]): PrItem[] {
  return [...prs].sort((a, b) => tier(a) - tier(b) || b.updated_at.localeCompare(a.updated_at));
}
