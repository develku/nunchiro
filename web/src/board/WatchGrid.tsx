// V2.5-69 (ticket 289, needs 208): the watch grid. Four columns derived from state (watch.ts), a lane per project when
// more than one project shows, glanceable cards, and a click that opens the card's detail in place (WatchDetail).
// Column layout and "None" for an empty column follow Orca's agent board (dashboard-popout, MIT, Lovecast Inc.; notice and
// commit in watch.ts).
import { Fragment, useEffect, useState, type KeyboardEvent } from 'react';
import type { CoreClient } from '../api';
import { pullUrl, type PrChipData } from '../chat/PrChip';
import { Icon } from '../icons/Icon';
import { composing } from '../keys';
import { sessionName } from '../Sidebar';
import { REFRESH_MS, wordOf } from '../tree/kids';
import { status, type Kid, type Session } from '../types';
import type { T } from './Board';
import { base, broken, unmark, yourTurn, type Lane } from './tasks';
import { Bdot, type CardCtx } from './CardView';
import { RefLink, WaitsOn } from './CardParts';
import { keyOf, type Card } from './model';
import { startCard } from './CardEditor';
import { elapsed, morph, summaryOf, type Bucket } from './watch';
import { kindOfChip, STATE_PRESENTATION } from './prFacts';
import { Archive, DoneDays } from './Archive';
import './watch.css';

export const bucketWord = (t: T, b: Bucket) => t(`board.watch.col.${b}`);
/** "1 card", "2 cards": the singular form for one, the plural otherwise (other languages pick by their own rules in `t`). */
export const cardCount = (t: T, n: number) => t(n === 1 ? 'board.watch.cards.one' : 'board.watch.cards.other', { n });
export function ago(t: T, ms: number) {
  const { unit, n } = elapsed(ms);
  return t(`board.watch.ago.${unit}`, { n });
}

/** A card's pull-request chip (ticket 177's `pr_chip`), asked once per change of the card: from its session, or its first attached one. */
export function usePrChip(core: CoreClient, card: Card, on = true): { chip: PrChipData; url: string; number: string } | null {
  const sid = card.source === 'session' ? card.session_id : card.source === 'manual' ? (card.attachments?.[0]?.session_id ?? card.session_id) : null;
  const [chip, setChip] = useState<PrChipData | null>(null);
  useEffect(() => {
    setChip(null);
    if (!on || !sid) return;
    let active = true;
    void core.request({ op: 'pr_chip', id: sid }).then(
      (reply) => active && setChip((reply as { chip: PrChipData | null }).chip),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [core, sid, on, card.updated_at]);
  const url = chip && pullUrl(chip.url);
  return chip && url ? { chip: { ...chip, url }, url, number: url.split('/').pop()! } : null;
}

/** The card's summary (watch.ts `summaryOf`) from its agent's transcript, asked again when the card or the agent changes; null on any failure. */
/** The session whose last message a card may show: a session card's own, a task card's first attached agent. */
export const agentOf = (card: Card) => (card.source === 'manual' ? (card.attachments?.[0]?.session_id ?? null) : (card.session_id ?? card.attachments?.[0]?.session_id ?? null));
export function useSummary(core: CoreClient, sessionId: string | null, refresh: string): string | null {
  const [summary, setSummary] = useState<string | null>(null);
  useEffect(() => {
    setSummary(null);
    if (!sessionId) return;
    let active = true;
    void core.request({ op: 'chat_page', id: sessionId }).then(
      (reply) => active && setSummary(summaryOf((reply as { page?: { events?: { data?: Record<string, unknown> }[] } }).page?.events ?? [])),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [core, sessionId, refresh]);
  return summary;
}

/**
 * The card's subagents (the tree's `subagents` read, ticket 297 item 2): asked for a running agent session only (a shell reports
 * none), once and then at the tree's own pace while the card shows. Read only; the same list the session row folds under itself.
 * Child sessions linked by `parent` are not here: the card does not know the session list.
 */
export function useCardKids(core: CoreClient, session: Session | undefined): Kid[] {
  const [kids, setKids] = useState<Kid[]>([]);
  const id = session && session.kind !== 'shell' && session.state === 'running' ? session.id : null;
  useEffect(() => {
    setKids([]);
    if (!id) return;
    let live = true;
    const read = () =>
      void core.request({ op: 'subagents', id }).then(
        (r) => {
          const got = (r as { kids?: unknown }).kids;
          const next = Array.isArray(got) ? (got as Kid[]) : []; // a reply that is not a list says "none", as the tree's read does
          if (live) setKids((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
        },
        () => live && setKids([]), // an unanswered read drops the list, as the tree's does: no stale children
      );
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => ((live = false), window.clearInterval(timer));
  }, [core, id]);
  return kids;
}

export function WatchCard({ t, core, card, session, bucket, open, showProject, ctx, onOpen, onKeyDown }: { t: T; core: CoreClient; card: Card; session?: Session; bucket: Bucket; open: boolean; showProject: boolean; ctx: Pick<CardCtx, 'cards' | 'coordinator' | 'fields'>; onOpen: () => void; onKeyDown: (e: KeyboardEvent) => void }) {
  const key = keyOf(card);
  const title = card.source === 'session' && session ? sessionName(session) : card.title;
  const pr = usePrChip(core, card, bucket === 'done');
  const live = card.source === 'session' && session ? status(session) : null;
  const dot = live ?? (card.stale ? 'stale' : card.state ?? (card.source === 'manual' ? 'todo' : undefined));
  const you = yourTurn(card, session);
  const bad = broken(card, session);
  // The one fact line of a Done card (V2.5-34h keeps the outcome): the PR's state and number, else the receipt.
  const prFact = pr && `${t(STATE_PRESENTATION[kindOfChip(pr.chip).kind].label)} #${pr.number}`;
  // Look 1117 v13 Home S3: a task closed by the core has no commit (`sha` "-", board/mod.rs `move_task_cards`): no "- ·".
  const receipt = card.receipt && [card.receipt.sha === '-' ? '' : card.receipt.sha.slice(0, 7), card.receipt.result].filter(Boolean).join(' · ');
  const fact = bucket === 'done' ? [prFact, receipt].filter(Boolean).join(' · ') : '';
  const meta = [card.source === 'session' ? session?.kind : t('board.word.manual'), ago(t, Date.now() - (card.last_moved_at ?? card.updated_at))].filter(Boolean).join(' · ');
  const kids = useCardKids(core, session);
  // Look 1117 v5 (B-S2-1): a task card's own session is the one that made it (a lead), whose last words are about another
  // task. A card shows the core's words for it (its note, its task's outcome), never a session's last message; the title
  // alone is not said twice. Plain words, never raw markdown.
  const words = unmark(card.note || card.text || '');
  const note = words === card.title ? '' : words;
  const [subs, setSubs] = useState(false);
  // Click and Enter/Space open the detail through the card's morph (watch.ts): the card is the old state, the panel the new one.
  const launch = (from: HTMLElement) => morph(from, onOpen, () => document.querySelector<HTMLElement>('.wdetail'));
  const press = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target === e.currentTarget && (e.code === 'Enter' || e.code === 'Space') && !composing(e.nativeEvent) && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      launch(e.currentTarget);
    } else onKeyDown(e);
  };
  // Look v35 b S3-3 (inventory 4.5.17/4.5.18): the ref link and "waits on" as on the columns card; outside the card's
  // button, so a link is never nested in it.
  const ref = ctx.fields.ref && card.ref;
  const waits = ctx.fields.waits ? (card.waits_on ?? []) : [];
  const count = t(kids.length === 1 ? 'board.watch.subagents.one' : 'board.watch.subagents.other', { n: kids.length });
  return (
    <div className="wcell">
      <div
        className="wcard"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={t('board.watch.cardAria', { title, bucket: bucketWord(t, bucket) })}
        data-menu="board"
        data-menu-session={session?.id}
        data-menu-arg={key}
        data-card={key}
        data-source={card.source}
        data-bucket={bucket}
        data-you={you || undefined}
        data-bad={bad || undefined}
        data-open={open || undefined}
        onClick={(e) => launch(e.currentTarget)}
        onKeyDown={press}
      >
        <span className="wt">
          {/* Inventory N011: your turn is the hand the columns view and the tree row draw (CardView, V2.5-82), also for a task under Needs you, which has no state of its own. */}
          {you || bucket === 'attention' ? <Bdot s="you" /> : dot && <i className="st" data-s={dot} aria-hidden />}
          <span className="wtt" title={title}>
            {title}
          </span>
        </span>
        {note && (
          <span className="wnote" title={note}>
            {note}
          </span>
        )}
        {fact && (
          <span className="wfact" title={fact}>
            {fact}
          </span>
        )}
        <span className="wmeta dim">
          {meta}
          {showProject && card.project && <span className="btag" title={card.project}> {base(card.project)}</span>}
        </span>
      </div>
      {(ref || waits.length > 0) && (
        <span className="bmt wmt">
          {ref && <RefLink t={t} card={card} fallback={ctx.coordinator} />}
          <WaitsOn t={t} ids={waits} cards={ctx.cards} />
        </span>
      )}
      {/* Ticket 991 B16: a task card with no live session says how to start one, on the card itself. */}
      {card.source === 'manual' && bucket !== 'done' && !session && !card.attachments?.some((a) => a.state) && (
        <button type="button" className="wsub" title={t('board.start.hint')} onClick={() => startCard(card)}>
          <Icon name="plus" size={10} />
          {t('board.start.button')}
        </button>
      )}
      {kids.length > 0 && (
        <button type="button" className="wsub" aria-expanded={subs} aria-label={count} title={count} onClick={() => setSubs(!subs)}>
          <Icon name="chevron-right" size={10} />
          {count}
        </button>
      )}
      {subs && kids.length > 0 && (
        <ul className="wkids" aria-label={t('board.watch.subs.list', { title })}>
          {kids.map((k) => (
            <li key={k.id} className="wkid" data-state={k.state} title={k.label}>
              <span className="wkn">{k.label}</span>
              <span className="wks dim">{wordOf(k, Date.now(), t)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Ticket 1090: Done cards sit under day heads and `old` ones (past the Archive age) in the Archive fold, as the columns view does (1066). */
export function WatchGrid({ t, buckets, lanes, counts, bucketOf, cell, old, now }: { t: T; buckets: Bucket[]; lanes: Lane[]; counts: Map<Bucket, number>; bucketOf: (card: Card) => Bucket; cell: (card: Card, bucket: Bucket) => React.ReactNode; old: Card[]; now: number }) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const fold = (key: string) => setFolded((f) => (f.has(key) ? new Set([...f].filter((k) => k !== key)) : new Set([...f, key])));
  const rows: (Lane | null)[] = lanes.length ? lanes : [null];
  return (
    <div className="wcols" style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(140px, 1fr))` }}>
      {buckets.map((b) => (
        <div key={b} className="wch" data-bucket={b}>
          <b title={bucketWord(t, b)}>{bucketWord(t, b)}</b>
          <span className="bcount dim" aria-label={cardCount(t, counts.get(b) ?? 0)}>
            {counts.get(b) ?? 0}
          </span>
        </div>
      ))}
      {rows.map((lane) => {
        const open = !lane || lane.kind === 'all' || !folded.has(lane.key);
        return (
          <Fragment key={lane?.key ?? ''}>
            {lane && lane.kind !== 'all' && (
              <div className="wlane" data-lane={lane.key}>
                <button type="button" className="blfold" aria-expanded={open} onClick={() => fold(lane.key)}>
                  <Icon name="chevron-right" size={10} />
                  <span className="blname" title={lane.name || t('board.lane.none')}>
                    {lane.name || t('board.lane.none')}
                  </span>
                </button>
                <span className="dim">{cardCount(t, lane.cards.length)}</span>
              </div>
            )}
            {open &&
              buckets.map((b) => {
                const cards = (lane?.cards ?? []).filter((c) => bucketOf(c) === b);
                const item = (c: Card) => <li key={keyOf(c)}>{cell(c, b)}</li>;
                return (
                  <div key={b} className="wcol" data-bucket={b} data-lane={lane?.key ?? ''}>
                    {cards.length ? (
                      <ul className="wcards">{b === 'done' ? <DoneDays t={t} cards={cards} now={now} item={item} /> : cards.map(item)}</ul>
                    ) : (
                      <p className="wnone dim">{t('board.watch.empty')}</p>
                    )}
                  </div>
                );
              })}
          </Fragment>
        );
      })}
      {old.length > 0 &&
        buckets.map((b) => (
          <div key={b} className="wcol" data-bucket={b} data-archive-cell>
            {b === 'done' && <Archive t={t} cards={old} />}
          </div>
        ))}
    </div>
  );
}
