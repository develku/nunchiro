// Ticket 1115 step 2 (owner 11-24, mockup docs/design/workers-1115/mockup.html panel 2): in the Team tab a lead's tasks are
// cards, one per task. A card shows the task's stage (Plan · Build · Review · Gate · Landed), one line of what goes on, and
// the seat's model. A press peeks at the task's most urgent seat in the drawer beside the board (TeamView); no tab opens
// until "Open as tab". A reviewer seat is the Review stage of its task's card, never a card of its own.
import { useMemo, useState, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import { unmark } from '../board/tasks';
import { ago, useSummary } from '../board/WatchGrid';
import type { T } from '../i18n';
import { agentState, status, type Session } from '../types';
import { closedWord, GROUPS, roleWord, sayOf, stateWord, urgent, type Other } from './LeadHead';
import { seatText, type Pair } from './level';
import { tasksChanged, type TaskView } from './tasks';
import { rawError } from '../errors';

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
/** A task with no seat yet, or whose Reviewer waits for a free one (ticket 1081 part B), waits for a seat; one that waits
 *  for another task does not (it waits for that task). */
export const waitsSeat = (x: TaskView) => !x.closed && !x.blockers?.length && (x.advance?.review === 'waits' || (!x.seats?.length && x.state === 'idle'));
/** It waits for another task that has not landed. A card whose writer sat on it before (`early`) or whose blocker was
 *  dropped (`stuck`, it asks) says that instead, so a card never says it waits while it builds. */
export const waitsTask = (x: TaskView) => !x.closed && !!x.blockers?.length && !x.early && !x.stuck;
/** What a task waits for, in place of its stage row. */
const waitsWord = (t: T, x: TaskView) => (x.blockers!.length === 1 ? t('tboard.waitsFor.one', { title: x.blockers![0].title }) : t('tboard.waitsFor.other', { n: x.blockers!.length }));
/** A blocker's stage as the board says it: its own card's, "waits" when it waits too. */
function blockerStage(t: T, id: string, stage: string, tasks: TaskView[]) {
  const view = tasks.find((x) => x.id === id);
  if (view && waitsTask(view)) return t('tboard.waitsStage');
  const at = view ? STAGES[stageOf(view)] : stage;
  return (STAGES as readonly string[]).includes(at) ? t(`tboard.stage.${at as (typeof STAGES)[number]}`) : closedWord(t, at);
}
/** Sets what `task` waits for, as a whole; the core's refusal comes back as the error. */
const setAfter = (core: CoreClient, task: TaskView, after: string[]) => core.request({ op: 'task', operation: 'after', id: task.id, project: task.place, after }).then(() => tasksChanged());

/** The card menu's and the drawer's "Wait for…": the place's open tasks to tick, this task greyed, and "Wait for nothing".
 *  A tick that would make an order go round shows the core's sentence and changes nothing. */
export function WaitFor({ t, core, task, tasks }: { t: T; core: CoreClient; task: TaskView; tasks: TaskView[] }) {
  const [error, setError] = useState('');
  const now = task.after ?? [];
  const set = (after: string[]) => void setAfter(core, task, after).then(() => setError(''), (e: unknown) => setError(rawError(e)));
  return (
    <div className="lead-menu" role="menu" data-wait-menu={task.id}>
      {tasks
        .filter((x) => !x.closed && x.place === task.place)
        .map((x) =>
          x.id === task.id ? (
            <button key={x.id} role="menuitemcheckbox" aria-checked={false} disabled>
              {x.title} <span className="room-meta">{t('tboard.thisTask')}</span>
            </button>
          ) : (
            <button key={x.id} role="menuitemcheckbox" aria-checked={now.includes(x.id)} onClick={() => set(now.includes(x.id) ? now.filter((id) => id !== x.id) : [...now, x.id])}>
              {now.includes(x.id) ? '✓ ' : ''}
              {x.title} <span className="room-meta">{blockerStage(t, x.id, '', tasks)}</span>
            </button>
          ),
        )}
      <button role="menuitem" onClick={() => set([])}>
        {t('tboard.waitNothing')}
      </button>
      {error && (
        <p className="place-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TaskBoard({ t, core, tasks, sessions, open, decide, others = [], menu, peek, setPeek }: { t: T; core: CoreClient; tasks: TaskView[]; sessions: Session[]; open: (id: string) => void; decide?: (id: string) => void; others?: Other[]; menu?: (task: TaskView) => ReactNode; peek: Peek | null; setPeek: (p: Peek | null) => void }) {
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const seated = (x: TaskView) =>
    (x.seats ?? [])
      .map((s) => byId.get(s.session))
      .filter((s): s is Session => !!s && s.state !== 'closed')
      .sort((a, b) => Number(agentState(b) === 'running') - Number(agentState(a) === 'running'));
  const today = new Date().setHours(0, 0, 0, 0);
  // A card that waits for another task goes after the ones waiting for a seat, before the closed ones.
  const rank = (x: TaskView) => (x.closed ? GROUPS.length + 1 : waitsTask(x) ? GROUPS.length : GROUPS.findIndex(([, states]) => (states as readonly string[]).includes(x.state)));
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
        <TaskCard key={x.id} t={t} core={core} x={x} tasks={tasks} list={seated(x)} byId={byId} open={open} decide={decide} menu={menu} peek={peek} setPeek={setPeek} />
      ))}
    </div>
  );
}

/** A task's card; its line is what waits or what the review said, else the seat's last message (the watch card's summary). */
function TaskCard({ t, core, x, tasks, list, byId, open, decide, menu, peek, setPeek }: { t: T; core: CoreClient; x: TaskView; tasks: TaskView[]; list: Session[]; byId: Map<string, Session>; open: (id: string) => void; decide?: (id: string) => void; menu?: (task: TaskView) => ReactNode; peek: Peek | null; setPeek: (p: Peek | null) => void }) {
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
  const waits = waitsTask(x);
  // Freed: it waited, and the last task it waited for landed then.
  const ready = waitsSeat(x) && x.after?.length ? Math.max(0, ...tasks.filter((b) => x.after!.includes(b.id) && b.closed).map((b) => b.closed!.at)) : 0;
  const dropped = !x.closed && x.stuck ? x.blockers?.find((b) => b.dropped) : undefined;
  const line = dropped ? t('tboard.stuck', { title: dropped.title }) : (waitsSeat(x) || waits) && !x.seats?.length ? '' : x.closed ? (landed ? '' : closedWord(t, x.closed.how)) : x.advance?.review === 'waits' ? t('lead.task.reviewWaits') : asks ? sayOf(t, x, byId, []) : unmark(summary ?? '') || stateWord(t, x);
  const step = (i: number) => (i < at || (x.closed && landed) ? 'done' : i > at ? 'next' : you ? 'you' : 'now');
  return (
    <div className="tcard" data-task={x.id} data-stage={STAGES[at]} data-you={you || undefined} data-waits-seat={waitsSeat(x) || undefined} data-waits-task={waits || undefined} data-gone={x.closed ? true : undefined} data-selected={peek?.task === x.id || undefined}>
      {/* Focused on click: WebKit (the app's view) leaves a clicked button unfocused, and the board's Esc needs focus inside it. */}
      <button className="tcard-go" data-none={(!seat && !waits) || undefined} aria-pressed={peek?.task === x.id} onClick={(e) => (e.currentTarget.focus(), seat ? setPeek(peek?.session === seat.id ? null : { task: x.id, session: seat.id }) : waits && setPeek(peek?.task === x.id ? null : { task: x.id, session: '' }))}>
        <b className="tcard-t">{x.title}</b>
        {waits ? (
          <span className="tcard-stages"><span data-at="next">{waitsWord(t, x)}</span></span>
        ) : dropped ? (
          <span className="tcard-stages"><span data-at="you"><i className="tcard-dot" aria-hidden />{t('tboard.waits')}</span></span>
        ) : waitsSeat(x) && !x.seats?.length ? (
          <span className="tcard-stages"><span data-at="next">{t('tboard.waitsSeat')}</span></span>
        ) : (
          <>
            {/* A button's content is flat for assistive tech: the stage is said in words, the pills are hidden. */}
            <span className="sr">{t('tboard.stageAt', { stage: t(`tboard.stage.${STAGES[at]}`) })}</span>
            <span className="tcard-stages" aria-hidden>
              {(landed ? STAGES : STAGES.slice(0, 4)).map((s, i) => (
                <span key={s} data-at={step(i)}>
                  {step(i) === 'you' && <i className="tcard-dot" aria-hidden />}
                  {t(`tboard.stage.${s}`)}{step(i) === 'done' ? ' ✓' : ''}
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
          {!x.closed && !!x.waiters && <span>{t(x.waiters === 1 ? 'tboard.waiters.one' : 'tboard.waiters.other', { n: x.waiters })}</span>}
          {ready > 0 && <span>{t('tboard.readySince', { when: ago(t, Date.now() - ready) })}</span>}
          {x.early && !x.closed && <span>{t('tboard.early', { title: x.blockers?.find((b) => !b.dropped)?.title ?? '' })}</span>}
        </span>
      </button>
      {dropped && (
        <span className="tcard-do">
          <button className="lead-answer" onClick={() => void setAfter(core, x, (x.after ?? []).filter((id) => !x.blockers?.some((b) => b.dropped && b.id === id))).catch(() => {})}>
            {t('tboard.stopWaiting')}
          </button>
          <button className="lead-answer" data-kind="quiet-bad" onClick={() => void core.request({ op: 'task', operation: 'drop', id: x.id, project: x.place }).then(() => tasksChanged(), () => {})}>
            {t('tboard.dropTask')}
          </button>
        </span>
      )}
      {(waiting || (x.merge && decide && x.state !== 'merge')) && (
        <button className="lead-answer" onClick={() => (x.merge && decide ? decide(x.merge) : open(waiting!.id))}>
          {t('lead.task.answer')}
        </button>
      )}
      {menu?.(x)}
    </div>
  );
}

/** The drawer of a waiting card with no seat: what it waits for, each with its stage, who is told when it may start, and
 *  "Wait for…" and "Start anyway". */
function WaitsDrawer({ t, core, task, tasks, lead, close }: { t: T; core: CoreClient; task: TaskView; tasks: TaskView[]; lead: string; close: () => void }) {
  const [menu, setMenu] = useState(false);
  const blockers = task.blockers ?? [];
  return (
    <aside className="tdrawer" data-drawer-task={task.id} aria-label={t('tboard.waitsDrawer', { name: task.title })}>
      <div className="tdrawer-h">
        <b>{task.title}</b>
        <span className="room-meta">{t('tboard.waitsHead')}</span>
        <button className="tdrawer-x" aria-label={t('tboard.close')} onClick={close}>
          ✕
        </button>
      </div>
      <div className="twaits">
        <ul>
          {blockers.map((b) => (
            <li key={b.id}>
              <span>{b.title}</span> <span className="room-meta">{blockerStage(t, b.id, b.stage, tasks)}</span>
            </li>
          ))}
        </ul>
        <p className="room-meta">{blockers.length === 1 ? t('tboard.startsWhen.one', { lead }) : t('tboard.startsWhen.other', { n: blockers.length, lead })}</p>
        <span className="tcard-do">
          <button className="lead-answer" data-kind="secondary" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            {t('tboard.waitFor')}
          </button>
          <button className="lead-answer" data-kind="secondary" onClick={() => void setAfter(core, task, []).catch(() => {})}>
            {t('tboard.startAnyway')}
          </button>
        </span>
        {menu && <WaitFor t={t} core={core} task={task} tasks={tasks} />}
      </div>
    </aside>
  );
}

/** The drawer beside the board: the peeked seat's terminal (the pane's own view, `term`), to read; "Open as tab" to type.
 *  A waiting card with no seat (`session` empty) shows what it waits for instead. */
export function SeatDrawer({ t, core, peek, tasks, sessions, term, open, close, lead }: { t: T; core: CoreClient; peek: Peek; tasks: TaskView[]; sessions: Session[]; term: (id: string) => ReactNode; open: (id: string) => void; close: () => void; lead: string }) {
  const s = sessions.find((x) => x.id === peek.session);
  const task = tasks.find((x) => x.id === peek.task);
  if (!peek.session && task) return <WaitsDrawer t={t} core={core} task={task} tasks={tasks} lead={lead} close={close} />;
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
