// V2.5-34: the two quiet lines under a Done card's title: the fact line (PR state, checks, +/- lines) and the quiet
// line (when, commit); the detail opens from its button. Data is the core's `pr_view`, asked at most once for a merged
// PR (prFacts.ts); with gh off the transcript badge still gives the state.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CoreClient, PrView } from '../api';
import { Icon, type IconName } from '../icons/Icon';
import { composing } from '../keys';
import { openExternal, webUrl } from '../sandbox/link';
import { ageText, type PrChipData } from '../chat/PrChip';
import type { T } from './Board';
import { hostOf } from './model';
import { CHECKS_WORD, STATE_PRESENTATION, kindOf, kindOfChip, loadPrView, peekPrView, type Checks, type PrKind } from './prFacts';

const REVIEW = { APPROVED: 'chat.pr.approved', CHANGES_REQUESTED: 'board.done.review.changes', REVIEW_REQUIRED: 'board.done.review.required' } as const;
/** The mockup's check mark: a shape and a tone per rollup (never colour alone); the full wording is its accessible name. */
const CHECK_ICON: Record<Checks, { icon: IconName; tone: string }> = {
  pass: { icon: 'check', tone: 'var(--ok)' },
  fail: { icon: 'x', tone: 'var(--bad)' },
  pending: { icon: 'clock', tone: 'var(--muted)' },
  none: { icon: 'dash', tone: 'var(--muted)' },
};
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** Draft B / placement item 5: the merge mark before "Merged #n", the pull-request mark before the other states. */
function StateMark({ kind }: { kind: PrKind }) {
  return (
    <svg className="bprm" viewBox="0 0 24 24" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'merged' ? (
          <>
            <circle cx="6" cy="5" r="2.3" />
            <circle cx="6" cy="19" r="2.3" />
            <circle cx="18" cy="12" r="2.3" />
            <path d="M6 7.3v9.4M6 7.5c0 3 3 4.5 9.7 4.5" />
          </>
        ) : (
          <>
            <circle cx="6" cy="6" r="2.3" />
            <circle cx="6" cy="18" r="2.3" />
            <circle cx="18" cy="18" r="2.3" />
            <path d="M6 8.3v7.4M18 15.7V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2" />
          </>
        )}
      </g>
    </svg>
  );
}

export function DoneFacts({ t, core, chip, number, updatedAt, onOpenSession }: { t: T; core: CoreClient; chip: PrChipData; number: string; updatedAt: number; onOpenSession?: () => void }) {
  const [view, setView] = useState<PrView | null>(() => peekPrView(core, chip.url));
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLSpanElement>(null);
  // needs 172: a pointer press outside the popover (and its toggle) closes it; Esc closes it back to its toggle. Esc is
  // taken on the window, first and only there: WebKit leaves focus on the page after a click, and an outer dialog stays open.
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !popover.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || composing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  useEffect(() => {
    let active = true;
    void loadPrView(core, chip.url).then((v) => active && setView(v));
    return () => { active = false; };
  }, [core, chip.url, updatedAt]);
  const hint = kindOfChip(chip);
  const kind: PrKind = view ? kindOf(view) : hint.kind;
  const checks: Checks | null = view ? view.checks : hint.checks;
  const { label, tone } = STATE_PRESENTATION[kind];
  const age = ageText(new Date(updatedAt).toISOString(), Date.now(), t);
  // needs 171: the PR state and number ("Merged #12") open the PR in the user's browser (https with a public host only, webUrl).
  const prHref = webUrl(view?.url ?? chip.url);
  const n = view?.number ?? number;
  const toggle = { onPointerDown: stop, onKeyDown: (e: KeyboardEvent) => stop(e), onClick: (e: { stopPropagation: () => void }) => (stop(e), setOpen(!open)) };
  return (
    <>
      <span className="bfact" data-pr-state={kind} title={view?.title}>
        <b className="bprs" style={{ color: tone }}>
          <StateMark kind={kind} />
          {prHref ? (
            <button type="button" className="bprn" title={t('board.card.opensLink', { host: hostOf(prHref) ?? '' })} onPointerDown={stop} onKeyDown={(e) => stop(e)} onClick={(e) => (stop(e), void openExternal(prHref))}>
              {t(label)} #{n}
            </button>
          ) : (
            <>
              {t(label)} #{n}
            </>
          )}
        </b>
        {checks && (
          <span className="bchk" data-checks={checks} role="img" aria-label={t(CHECKS_WORD[checks])} title={t(CHECKS_WORD[checks])} style={{ color: CHECK_ICON[checks].tone }}>
            <Icon name={CHECK_ICON[checks].icon} size={12} />
          </span>
        )}
        {view && <span className="bdelta"><span className="add">+{view.additions}</span> <span className="del">−{view.deletions}</span></span>}
      </span>
      <span className="bquiet dim">
        {[age, view?.head.slice(0, 7)].filter(Boolean).join(' · ')}
        {view && (
          <button ref={button} type="button" className="bmore" aria-expanded={open} {...toggle}>
            {open ? t('board.done.hide') : t('board.done.details')}
          </button>
        )}
      </span>
      {view && open && (
        // Placement item 5: a popover over the board (rows: PR, branch, checks, review, changes, when; Open PR, Open session).
        <span ref={popover} className="bdetail" role="group" aria-label={t('board.done.detail')} onPointerDown={stop} onClick={stop} onKeyDown={(e) => stop(e)}>
          <span className="bdh">{view.title}</span>
          <span className="bdr"><span className="bdk">{t('board.detail.pr')}</span><b style={{ color: tone }} className="bprs"><StateMark kind={kind} />{t(label)} #{view.number}</b></span>
          <span className="bdr"><span className="bdk">{t('board.detail.branch')}</span><span className="mono">{t('board.done.branch', { head: view.head_ref, base: view.base_ref })}</span></span>
          <span className="bdr"><span className="bdk">{t('board.detail.checks')}</span><span style={{ color: CHECK_ICON[view.checks].tone }} className="bchk"><Icon name={CHECK_ICON[view.checks].icon} size={12} /></span>{t(CHECKS_WORD[view.checks])}</span>
          <span className="bdr"><span className="bdk">{t('board.detail.review')}</span><span>{[reviewWord(view, t), ...view.reviewers.map((r) => r.who)].filter(Boolean).join(' · ') || t('board.detail.noReview')}</span></span>
          <span className="bdr"><span className="bdk">{t('board.detail.changes')}</span><span>{t('board.done.files', { n: view.files.length })} <span className="bdelta"><span className="add">+{view.additions}</span> <span className="del">−{view.deletions}</span></span></span></span>
          <span className="bdr"><span className="bdk">{t(kind === 'merged' ? 'board.detail.merged' : 'board.detail.updated')}</span><span>{age} · <span className="mono">{view.head.slice(0, 7)}</span></span></span>
          <span className="bdacts">
            {webUrl(view.url) && <button type="button" className="bdbtn" onClick={() => void openExternal(webUrl(view.url)!)}>{t('board.detail.openPr')}</button>}
            {onOpenSession && <button type="button" className="bdbtn" onClick={onOpenSession}>{t('board.detail.openSession')}</button>}
          </span>
        </span>
      )}
    </>
  );
}

function reviewWord(v: PrView, t: T) {
  const key = REVIEW[v.review as keyof typeof REVIEW];
  return key ? t(key) : '';
}
