// Ticket 1115 step 2 (owner 11-24, mockup docs/design/workers-1115/mockup.html panel 2): in the Team tab a lead's tasks are
// cards, one per task. A card shows the task's stage (Plan · Build · Review · Gate · Landed), one line of what goes on, and
// the seat's model. A press peeks at the task's most urgent seat in the drawer beside the board (TeamView); no tab opens
// until "Open as tab". A reviewer seat is the Review stage of its task's card, never a card of its own.
import { useMemo, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import { unmark } from '../board/tasks';
import { ago, useSummary } from '../board/WatchGrid';
import type { T } from '../i18n';
import { agentState, status, type Session } from '../types';
import { closedWord, GROUPS, roleWord, sayOf, stateWord, urgent, type Other } from './LeadHead';
import { seatText, type Pair } from './level';
import type { TaskView } from './tasks';

export const STAGES = ['plan', 'build', 'review', 'gate', 'landed'] as const;
/** The seat the drawer shows and the task it works for. */
export type Peek = { task: string; session: string };

/** The task's stage as an index of STAGES; `role` is the role of the seat that waits for the person, if one does. */
export function stageOf(x: TaskView, role?: string): number {
  if (x.closed) return 4;
  if (x.merge || x.state === 'approved' || x.state === 'merge') return 3;
  if (x.state === 'review' || role === 'reviewer') return 2;
  return x.seats?.some((s) => s.writes) ? 1 : 0;
}
/** A task with no seat yet, or whose Reviewer waits for a free one (ticket 1081 part B), waits for a seat. */
export const waitsSeat = (x: TaskView) => !x.closed && (x.advance?.review === 'waits' || (!x.seats?.length && x.state === 'idle'));

export function TaskBoard({ t, core, tasks, sessions, open, decide, others = [], menu, peek, setPeek }: { t: T; core: CoreClient; tasks: TaskView[]; sessions: Session[]; open: (id: string) => void; decide?: (id: string) => void; others?: Other[]; menu?: (task: TaskView) => ReactNode; peek: Peek | null; setPeek: (p: Peek | null) => void }) {
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const seated = (x: TaskView) =>
    (x.seats ?? [])
      .map((s) => byId.get(s.session))
      .filter((s): s is Session => !!s && s.state !== 'closed')
      .sort((a, b) => Number(agentState(b) === 'running') - Number(agentState(a) === 'running'));
  const today = new Date().setHours(0, 0, 0, 0);
  const rank = (x: TaskView) => (x.closed ? GROUPS.length : GROUPS.findIndex(([, states]) => (states as readonly string[]).includes(x.state)));
  const shown = tasks.filter((x) => !x.closed || x.closed.at >= today).sort((a, b) => rank(a) - rank(b) || b.updated - a.updated);
  return (
    <div className="tboard" data-board>
      {others.map((o) => (
        <div className="tcard" key={o.key} data-ask={o.key} data-you>
          <span className="tcard-go">
            <b className="tcard-t">{o.title}</b>
            <span className="tcard-now" data-you>{o.say}</span>
          </span>
          <button className="lead-answer" onClick={o.answer}>
            {t('lead.task.answer')}
          </button>
        </div>
      ))}
      {shown.map((x) => (
        <TaskCard key={x.id} t={t} core={core} x={x} list={seated(x)} byId={byId} open={open} decide={decide} menu={menu} peek={peek} setPeek={setPeek} />
      ))}
    </div>
  );
}

/** A task's card; its line is what waits or what the review said, else the seat's last message (the watch card's summary). */
function TaskCard({ t, core, x, list, byId, open, decide, menu, peek, setPeek }: { t: T; core: CoreClient; x: TaskView; list: Session[]; byId: Map<string, Session>; open: (id: string) => void; decide?: (id: string) => void; menu?: (task: TaskView) => ReactNode; peek: Peek | null; setPeek: (p: Peek | null) => void }) {
  const waiting = x.state === 'needs' ? list.find((s) => status(s) === 'waiting') : undefined;
  const role = waiting && x.seats?.find((s) => s.session === waiting.id)?.role;
  const at = stageOf(x, role);
  const you = x.state === 'needs';
  const seat = urgent(list);
  const summary = useSummary(core, x.closed ? null : (seat?.id ?? null), seat ? `${status(seat)}:${seat.completion_seq ?? 0}` : '');
  const asks = ['needs', 'asked', 'merge', 'changes', 'approved'].includes(x.state) || x.stale;
  const seen = Math.max(0, ...(x.live ?? []).map((s) => x.seen?.[s] ?? 0));
  const landed = !x.closed || x.closed.how === 'merged';
  // A merged task's stages already say Landed; a summary is the seat's own words, set as code (mockup).
  const said = !x.closed && x.advance?.review !== 'waits' && !asks && !!unmark(summary ?? '');
  // A card that waits for its first seat says so in its stage row; "idle" under it adds nothing.
  const line = waitsSeat(x) && !x.seats?.length ? '' : x.closed ? (landed ? '' : closedWord(t, x.closed.how)) : x.advance?.review === 'waits' ? t('lead.task.reviewWaits') : asks ? sayOf(t, x, byId, []) : unmark(summary ?? '') || stateWord(t, x);
  const step = (i: number) => (i < at || (x.closed && landed) ? 'done' : i > at ? 'next' : you ? 'you' : 'now');
  return (
    <div className="tcard" data-task={x.id} data-stage={STAGES[at]} data-you={you || undefined} data-waits-seat={waitsSeat(x) || undefined} data-gone={x.closed ? true : undefined} data-selected={peek?.task === x.id || undefined}>
      {/* Focused on click: WebKit (the app's view) leaves a clicked button unfocused, and the board's Esc needs focus inside it. */}
      <button className="tcard-go" data-none={!seat || undefined} aria-pressed={peek?.task === x.id} onClick={(e) => (e.currentTarget.focus(), seat && setPeek(peek?.session === seat.id ? null : { task: x.id, session: seat.id }))}>
        <b className="tcard-t">{x.title}</b>
        {waitsSeat(x) && !x.seats?.length ? (
          <span className="tcard-stages"><span data-at="next">{t('tboard.waitsSeat')}</span></span>
        ) : (
          <>
            {/* A button's content is flat for assistive tech: the stage is said in words, the pills are hidden. */}
            <span className="sr">{t('tboard.stageAt', { stage: t(`tboard.stage.${STAGES[at]}`) })}</span>
            <span className="tcard-stages" aria-hidden>
              {(landed ? STAGES : STAGES.slice(0, 4)).map((s, i) => (
                <span key={s} data-at={step(i)}>
                  {t(`tboard.stage.${s}`)}{step(i) === 'done' ? ' ✓' : step(i) === 'you' ? ' ✋' : ''}
                </span>
              ))}
            </span>
          </>
        )}
        {line && (
          <span className="tcard-now" data-you={you || undefined} data-said={said || undefined}>
            {line}
          </span>
        )}
        <span className="tcard-facts">
          {seat && seat.kind !== 'shell' && <span>{seatText(t, seat as Session & Pair)}</span>}
          <span>{ago(t, Date.now() - (x.closed?.at ?? (seen || x.updated)))}</span>
        </span>
      </button>
      {(waiting || (x.merge && decide && x.state !== 'merge')) && (
        <button className="lead-answer" onClick={() => (x.merge && decide ? decide(x.merge) : open(waiting!.id))}>
          {t('lead.task.answer')}
        </button>
      )}
      {menu?.(x)}
    </div>
  );
}

/** The drawer beside the board: the peeked seat's terminal (the pane's own view, `term`), to read; "Open as tab" to type. */
export function SeatDrawer({ t, peek, tasks, sessions, term, open, close }: { t: T; peek: Peek; tasks: TaskView[]; sessions: Session[]; term: (id: string) => ReactNode; open: (id: string) => void; close: () => void }) {
  const s = sessions.find((x) => x.id === peek.session);
  const task = tasks.find((x) => x.id === peek.task);
  const role = task?.seats?.find((x) => x.session === peek.session)?.role;
  const name = [task?.title, role && roleWord(t, role)].filter(Boolean).join(' · ');
  return (
    <aside className="tdrawer" data-drawer={peek.session} aria-label={t('tboard.drawer', { name })}>
      <div className="tdrawer-h">
        <b>{name}</b>
        <span className="room-meta">{s && s.kind !== 'shell' ? seatText(t, s as Session & Pair) : ''}</span>
        <button className="teamv-move" onClick={() => (open(peek.session), close())}>
          {t('tboard.openTab')} ↗
        </button>
        <button className="tdrawer-x" aria-label={t('tboard.close')} onClick={close}>
          ✕
        </button>
      </div>
      <div className="pane tdrawer-term">{s?.state === 'running' ? term(s.id) : <div className="empty">{t('tboard.notRunning', { name })}</div>}</div>
    </aside>
  );
}
