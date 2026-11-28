// Ticket 990 (H2 ① and ②): what a lead's seat and its team's sessions add to the window. The lead's header gets a Lead tag and
// one chip (its tasks, the running seats' faces) that opens the Team view (TeamView.tsx, owner 11-17), whose Tasks part is drawn
// here from the core's ledger (mockup J ②); a session working for a lead gets one quiet line back to it. Nothing here draws without a lead.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ago } from '../board/WatchGrid';
import { elapsed } from '../board/watch';
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import type { WindowCtx } from '../layout/windows';
import { sessionName } from '../Sidebar';
import { basename } from '../tree';
import { agentState, shownStatus, status, type Session } from '../types';
import { independent, openSeat, type Teammate } from './lead';
import { useRoles, type Place, type Seat, type TaskView } from './tasks';
import { homeCount, type Digest } from './HomeParts';
import { daySentence, openPlace } from './place';
import { TaskBoard, WaitFor, type Peek } from './TaskBoard';
import './lead.css';

type Wt = NonNullable<WindowCtx['wt']>;

/** Owner 11-17: the lead's one header chip, "N tasks · M needs you" (orange while M > 0) beside the running seats' faces (the lead
 *  first). A press opens the place's Team view where it lives (the side or its tab). */
export function TeamChip({ t, mate, tasks, sessions, onOpen, digest, waiting = 0, faced }: { t: T; mate: Teammate; tasks: TaskView[]; sessions: Session[]; onOpen: () => void; digest?: Digest | null; waiting?: number; faced?: boolean }) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const live = tasks.flatMap((x) => (x.closed ? [] : (x.seats ?? []).filter((s) => x.live?.includes(s.session))));
  // Home view: the Home lead's chip reads the core's digest and the Decisions pane's count, "3 projects · 2 needs you".
  const needs = waiting > 0;
  const count = digest ? homeCount(t, digest, waiting) : taskCount(t, tasks, waiting);
  return (
    <button className="lead-room" data-team-chip data-needs={needs || undefined} aria-label={count} data-tip={t('lead.team.open')} onClick={onOpen}>
      <span className="lead-stack" aria-hidden>
        {/* Ticket 1168: the lead's own face is drawn once, at the header's left (bots/Face.tsx); the letter circle stays only
            where the core sent no bot for it. */}
        {!faced && <Avatar letter={mate.name} label={mate.name} c={3} face={null} small />}
        {live.slice(0, 3).map((s) => (
          <Avatar key={s.session} letter={roleWord(t, s.role)} label={t('lead.face', { label: seatLabel(t, s), state: t(`lead.face.${faceOf(s, byId)}`) })} c={hue(s.session)} face={null} small />
        ))}
      </span>
      {count}
    </button>
  );
}

/** What a press on its tree row opens: the most urgent session in it. */
export const urgent = (list: Session[]) => list.find((s) => status(s) === 'waiting') ?? list.find((s) => status(s) === 'failed') ?? list.find((s) => status(s) === 'working') ?? list[0];

type Face = 'you' | 'work' | 'asked' | 'idle' | 'ended';
export const roleWord = (t: T, role: string) => (role === 'reviewer' ? t('lead.role.reviewer') : role === 'builder' ? t('lead.role.builder') : role);
/** "Builder · tax"; a seat `nunchiro task staff` started is already named "<Role> · <task>", so the role is not said twice. */
const seatLabel = (t: T, s: Seat) => {
  const role = roleWord(t, s.role);
  return [role, s.role, s.role.charAt(0).toUpperCase() + s.role.slice(1)].some((r) => s.name.startsWith(`${r} · `)) ? s.name : `${role} · ${s.name}`;
};
/** The header's "3 tasks · 1 needs you" (mockup J ②). `needs` is the place's shared count (tree/decisions.ts `teamWaiting`). */
export function taskCount(t: T, tasks: TaskView[], needs: number) {
  const open = tasks.filter((x) => !x.closed);
  const n = t(open.length === 1 ? 'lead.tasks.one' : 'lead.tasks.other', { n: open.length });
  return needs ? `${n} · ${t('lead.tasks.needs', { n: needs })}` : n;
}
/** A seat keeps its colour wherever its face shows: picked from its session id, one of six. */
export const hue = (id: string) => ([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 6) + 1;
function faceOf(seat: Seat, byId: Map<string, Session>): Face {
  const s = byId.get(seat.session);
  if (!s || agentState(s) !== 'running') return 'ended';
  const st = shownStatus(s);
  return st === 'waiting' ? 'you' : st === 'working' ? 'work' : st === 'asked' ? 'asked' : 'idle';
}
/** The seats a row shows: those that run now, else the newest one (a task's seats are never reused, so they pile up). */
const shownSeats = (task: TaskView) => {
  const seats = task.seats ?? [];
  const live = seats.filter((s) => task.live?.includes(s.session));
  return (live.length ? live : seats.slice(-1)).slice(-3);
};
/** A letter face with one state dot (mockup J `.av`); `face` null draws no dot (the room button's faces). */
export const Avatar = ({ letter, label, c, face, small }: { letter: string; label: string; c: number; face: Face | null; small?: boolean }) => (
  <i className="lead-av" data-c={c} data-face={face ?? undefined} data-sm={small || undefined} role="img" aria-label={label}>
    {letter.slice(0, 1).toUpperCase()}
  </i>
);
export const SeatFaces = ({ t, seats, byId, small }: { t: T; seats: Seat[]; byId: Map<string, Session>; small?: boolean }) => (
  <span className="lead-stack">
    {seats.map((s) => {
      const role = roleWord(t, s.role);
      const face = faceOf(s, byId);
      return <Avatar key={s.session} letter={role} label={t('lead.face', { label: seatLabel(t, s), state: t(`lead.face.${face}`) })} c={hue(s.session)} face={face} small={small} />;
    })}
  </span>
);

/** Something that waits for the person in this place and is no task's own ask: a session's question (the lead's own), a
 *  card the lead filed (a role, a schedule). It has a row under "Needs you", so the heading's number has its rows. */
export type Other = { key: string; title: string; say: string; answer: () => void };
export const GROUPS = [
  ['needs', ['needs']],
  ['review', ['review', 'changes']],
  ['working', ['working']],
  ['asked', ['asked']], // a seat waits for its lead's answer: not idle (look v9 B N2-S2-1), not working either (look 1117 v11 B N11-S2-3)
  // Look 1117 v13 B N13-S3-2: a merge the person said yes to stays here until it lands (it read nowhere before).
  ['approved', ['approved', 'merge']],
  ['idle', ['idle']],
] as const;
const CLOSED = ['done', 'merged', 'removed', 'dropped'] as const;
export const closedWord = (t: T, how: string) => t(how === 'merged' ? 'lead.state.merged' : how === 'removed' ? 'lead.state.removed' : how === 'dropped' ? 'lead.task.closed.dropped' : 'lead.task.closed.done');
export const stateWord = (t: T, task: TaskView) => (task.state === 'changes' ? t('lead.task.state.changes') : task.state === 'approved' ? t('lead.task.state.approved') : task.state === 'merge' ? t('lead.task.state.merge') : t(`lead.state.${task.state as 'review' | 'working' | 'idle' | 'needs' | 'asked'}`));
/** The row's one line: what waits for the person, what the review said, or who sits on it. */
export function sayOf(t: T, task: TaskView, byId: Map<string, Session>, inWt: Session[]) {
  const seats = task.seats ?? [];
  // A session the core seats on no task (a shell a lead started there) still says who is in the task's worktree.
  // In the task's own row a seat named "<Role> · <this task>" is its role alone (seen in the real app: the row said the
  // task's title three times).
  // A long title is cut after a whole word with "…" (core roles.rs seat_name); seats named before that were cut at 40.
  const named = (name: string) => name.endsWith(` · ${task.title}`) || name.endsWith(` · ${task.title.slice(0, 40).trim()}`) || (name.endsWith('…') && name.includes(' · ') && task.title.startsWith(name.slice(name.indexOf(' · ') + 3, -1)));
  const inRow = (seat: Seat) => (named(seat.name) ? roleWord(t, seat.role) : seatLabel(t, seat));
  const who = seats.length ? shownSeats(task).map(inRow).join(', ') : inWt.map((s) => `${sessionName(s)} · ${s.kind}`).join(', ');
  if (task.state === 'needs') {
    if (task.merge) return t('lead.task.mergeAsk');
    const seat = seats.find((s) => byId.get(s.session) && status(byId.get(s.session)!) === 'waiting');
    const card = seat && byId.get(seat.session)!.pending.find((d) => d.kind !== 'stale')?.text.split('\n')[0];
    if (card) return t('lead.task.asks', { who: roleWord(t, seat.role), text: card });
    return task.asks?.[0] ?? who;
  }
  if (task.state === 'asked') return task.asks?.[0] ?? who;
  // The yes reaches the lead on its next turn: a lead that is not running (resumable) merges only once resumed.
  if (task.state === 'merge') return t(!task.lead || [...byId.values()].some((s) => s.teammate === task.lead && agentState(s) === 'running') ? 'lead.task.mergeSoon' : 'lead.task.mergeResume');
  if (task.stale) return t('lead.task.stale');
  if (task.state === 'changes') return task.review?.note || t('lead.task.changesBy', { name: task.review?.name ?? '' });
  if (task.state === 'approved' && task.review) return t('lead.task.reviewedBy', { name: task.review.name });
  return who;
}
/** Ticket 1081: a running seat's last activity, "now" under a minute, then "N min ago" (hours and days as the board says them). */
const seenAgo = (t: T, ms: number) => ((e) => (e.unit === 'now' ? t('lead.seen.now') : e.unit === 'm' ? t('lead.seen.min', { n: e.n }) : ago(t, ms)))(elapsed(ms));
const startOfToday = () => new Date().setHours(0, 0, 0, 0);

/** The task rows by state (mockup J ②): needs you first, then in review, working, ready to merge, idle; the tasks closed
 *  today fold into one line. A press opens the task's most urgent seat, or its worktree when no seat is left. */
export function TaskRows({ t, tasks, sessions, open, openWt, menu, decide, others = [], needs }: { t: T; tasks: TaskView[]; sessions: Session[]; open: (id: string) => void; openWt?: (path: string) => void; menu?: (task: TaskView) => ReactNode; decide?: (id: string) => void; others?: Other[]; needs?: number }) {
  const [closedOpen, setClosedOpen] = useState(false);
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const seatSessions = (task: TaskView) =>
    (task.seats ?? [])
      .map((s) => byId.get(s.session))
      .filter((s): s is Session => !!s && s.state !== 'closed')
      .sort((a, b) => Number(agentState(b) === 'running') - Number(agentState(a) === 'running'));
  const inWt = (task: TaskView) => sessions.filter((s) => task.worktrees?.includes(s.cwd) && s.state !== 'closed' && !s.account_tab);
  const press = (task: TaskView) => {
    const seated = seatSessions(task);
    const s = urgent(seated.length ? seated : inWt(task));
    if (s) open(s.id);
    else if (task.worktrees?.[0]) openWt?.(task.worktrees[0]);
  };
  const today = startOfToday();
  const closed = tasks.filter((x) => x.closed && x.closed.at >= today).sort((a, b) => b.closed!.at - a.closed!.at);
  const row = (task: TaskView) => {
    const told = task.told?.at(-1);
    // Ticket 1081: the time is the newest running seat's last activity (the core's), else the task's last change.
    const seen = Math.max(0, ...(task.live ?? []).map((s) => task.seen?.[s] ?? 0));
    const stalled = task.advance?.stalled ?? [];
    const waiting = task.state === 'needs' ? seatSessions(task).find((s) => status(s) === 'waiting') : undefined;
    const tone = task.state === 'needs' ? 'you' : task.state === 'working' ? 'work' : task.state === 'review' || task.state === 'changes' || task.state === 'asked' ? 'rev' : task.state === 'approved' || task.state === 'merge' ? 'ok' : 'idle';
    return (
      <div className="lead-row" key={task.id} data-task={task.id} data-word={task.state} data-stale={task.stale || undefined} title={told ? t('lead.task.told', { name: told.name, text: told.text }) : undefined}>
        <button className="lead-go" onClick={() => press(task)}>
          <SeatFaces t={t} seats={shownSeats(task)} byId={byId} />
          <b className="lead-title">
            <i data-c={task.seats?.length ? hue(task.seats[0].session) : 0} aria-hidden />
            <span>{task.title}</span>
          </b>
          <span className="lead-who">{sayOf(t, task, byId, inWt(task))}</span>
          <span className="lead-tm" data-seen={seen > 0 || undefined}>{seen > 0 ? seenAgo(t, Date.now() - seen) : ago(t, Date.now() - task.updated)}</span>
          {stalled.length > 0 && (
            <span className="lead-stall" data-stalled title={stalled.map((s) => t('lead.task.stalledWhy', { name: s.name, why: s.why })).join('\n')}>
              {t('lead.task.stalled')}
            </span>
          )}
          {task.advance?.review && (
            <span className="lead-auto" data-auto-review={task.advance.review}>
              {t(task.advance.review === 'waits' ? 'lead.task.reviewWaits' : 'lead.task.reviewStarted')}
            </span>
          )}
          {!waiting && !task.merge && <span className="lead-st" data-tone={tone}>{stateWord(t, task)}</span>}
        </button>
        {/* Look v15 B: with the yes given (state "merge") nothing is left to answer: no Answer. */}
        {(waiting || (task.merge && decide && task.state !== 'merge')) && (
          <button className="lead-answer" onClick={() => (task.merge && decide ? decide(task.merge) : open(waiting!.id))}>
            {t('lead.task.answer')}
          </button>
        )}
        {menu?.(task)}
      </div>
    );
  };
  return (
    <>
      {GROUPS.map(([g, states]) => {
        const list = tasks.filter((x) => !x.closed && (states as readonly string[]).includes(x.state)).sort((a, b) => b.updated - a.updated);
        const more = g === 'needs' ? others : [];
        if (!list.length && !more.length) return null;
        // "Needs you" says the place's shared count (`needs`), never fewer than its rows (a list read a moment ago).
        const n = g === 'needs' ? Math.max(needs ?? 0, list.length + more.length) : list.length;
        return (
          <div className="lead-grp" key={g} data-group={g} role="group" aria-label={t('lead.task.group', { name: t(`lead.task.group.${g}`), n })}>
            <div className="lead-gh" aria-hidden>
              {t('lead.task.group', { name: t(`lead.task.group.${g}`), n })}
            </div>
            {list.map(row)}
            {more.map((o) => (
              <div className="lead-row" key={o.key} data-ask={o.key} data-word="needs">
                <button className="lead-go" onClick={o.answer}>
                  <b className="lead-title">
                    <span>{o.title}</span>
                  </b>
                  <span className="lead-who">{o.say}</span>
                </button>
                <button className="lead-answer" onClick={o.answer}>
                  {t('lead.task.answer')}
                </button>
              </div>
            ))}
          </div>
        );
      })}
      {closed.length > 0 && (
        <>
          <div className="lead-row lead-closed" data-gone>
            <button className="lead-go" aria-expanded={closedOpen} onClick={() => setClosedOpen(!closedOpen)}>
              <SeatFaces t={t} seats={(closed[0].seats ?? []).slice(-1)} byId={byId} small />
              <span className="lead-who">
                {t('lead.task.today', {
                  list: CLOSED.map((how) => [how, closed.filter((x) => x.closed!.how === how).length] as const)
                    .filter(([, n]) => n)
                    .map(([how, n]) => t('lead.band.count', { n, state: closedWord(t, how) }))
                    .join(' · '),
                })}
              </span>
              <span className="lead-tm">{closedOpen ? `${t('lead.task.hide')} ▾` : `${t('lead.task.show')} ▸`}</span>
            </button>
          </div>
          {closedOpen &&
            closed.map((task) => (
              <div className="lead-row" key={task.id} data-task={task.id} data-gone>
                <span className="lead-go">
                  <SeatFaces t={t} seats={shownSeats(task)} byId={byId} small />
                  <b className="lead-title">{task.title}</b>
                  <span className="lead-who">{closedWord(t, task.closed!.how)}</span>
                  <span className="lead-tm">{ago(t, Date.now() - task.closed!.at)}</span>
                </span>
              </div>
            ))}
        </>
      )}
    </>
  );
}

/** The first sentence of a role's job: the card's one line. Q9 zh-hans-J19-1: no lookbehind (a SyntaxError before Safari 16.4). */
export const firstLine = (job: string) => job.match(/^[\s\S]*?[.。](?=\s)/)?.[0] ?? job;

/** Day one (mockup J ①): a place with no task yet. What to do, the way of working in one sentence and the user's roles;
 *  no setup and no register screen. */
function WayCard({ t, core, project, place, mate }: { t: T; core: CoreClient; project: string; place: Place | null; mate: Teammate }) {
  const roles = useRoles(core, true);
  return (
    <div className="way-card" data-way-card>
      <p>{t('lead.day.intro', { name: mate.name })}</p>
      {/* Ticket 1099 (mockup panel 3): one sentence of what happens, and Change opens the place's Settings section. */}
      {place && (
        <p className="way-line" data-way-line>
          {daySentence(t, place.way)} ·{' '}
          <button type="button" className="way-change" onClick={() => openPlace(project)}>
            {t('lead.day.change')}
          </button>
        </p>
      )}
      {roles.length > 0 && (
        <ul className="way-roles" aria-label={t('lead.day.roles')}>
          {roles.map((r) => (
            <li key={r.name}>
              <Avatar letter={r.name} label={r.name} c={hue(r.name)} face={null} small />
              <b>{r.name}</b>
              <span>{firstLine(r.job)}</span>
              <i className="rc-pill">{r.kind === 'codex' ? 'Codex' : 'Claude'}{r.model ? ` ${r.model}` : ''}</i>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Team view's Tasks part for a project's lead (mockup J ②): the day-one card, the task rows and the independent worktrees. */
export function TeamTasks({ t, core, project, mate, sessions, tasks, place, wt, open, decide, others, needs, board }: { t: T; core: CoreClient; project: string; mate: Teammate; sessions: Session[]; tasks: TaskView[]; place: Place | null; wt: Wt; open: (id: string) => void; decide?: (id: string) => void; others?: Other[]; needs?: number; board?: { peek: Peek | null; setPeek: (p: Peek | null) => void } }) {
  const [menu, setMenu] = useState<string | null>(null);
  const free = independent(wt.list, project);
  const live = tasks.filter((x) => !x.closed);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => !(e.target as Element).closest?.('.lead-menu, .lead-more') && setMenu(null);
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [menu]);
  const hand = (paths: string[], lead: string) => (setMenu(null), void Promise.all(paths.map((p) => wt.team(p, lead))).catch(() => {}));
  const openWt = (path: string) => void wt.open(path).then((x) => x && open(x.id));
  // The ⋯ menu acts on the task's worktrees; a task without one has nothing to take back. On the board it also sets what
  // an open task waits for; there a card with nothing else in its menu shows ⋯ only under the pointer or the focus.
  const taskMenu = (task: TaskView) => {
    const paths = (task.worktrees ?? []).filter((p) => wt.list.some((l) => l.path === p && l.team === mate.id));
    const waits = !!board && !task.closed;
    if (!paths.length && !waits) return null;
    return (
      <>
        <button className="lead-more" data-quiet={!paths.length || undefined} aria-label={t('lead.band.actions', { name: task.title })} aria-haspopup="menu" aria-expanded={menu === task.id || menu === `wait:${task.id}`} onClick={() => setMenu(menu === task.id || menu === `wait:${task.id}` ? null : task.id)}>
          ⋯
        </button>
        {menu === task.id && (
          <div className="lead-menu" role="menu">
            {paths.length > 0 && (
              <button role="menuitem" onClick={() => hand(paths, '')}>
                {t('lead.band.takeBack')}
              </button>
            )}
            {waits && (
              <button role="menuitem" onClick={() => setMenu(`wait:${task.id}`)}>
                {t('tboard.waitFor')}
              </button>
            )}
          </div>
        )}
        {menu === `wait:${task.id}` && <WaitFor t={t} core={core} task={task} tasks={tasks} close={() => (setMenu(null), document.querySelector<HTMLElement>(`.tcard[data-task="${CSS.escape(task.id)}"] > .lead-more`)?.focus())} />}
      </>
    );
  };
  return (
    <>
      {!tasks.length ? <WayCard t={t} core={core} project={mate.project ?? project} place={place} mate={mate} /> : !live.length && !others?.length && <p className="lead-empty">{t('lead.task.empty')}</p>}
      {/* Ticket 1115 step 2: in the Team tab the tasks are cards, and a press peeks in the drawer instead of opening a tab. */}
      {board ? <TaskBoard t={t} core={core} tasks={tasks} sessions={sessions} open={open} decide={decide} others={others} menu={taskMenu} {...board} /> : <TaskRows t={t} tasks={tasks} sessions={sessions} open={open} openWt={openWt} menu={taskMenu} decide={decide} others={others} needs={needs} />}
      {free.length > 0 && (
        <div className="lead-free">
          <span>{t('lead.band.independent', { n: free.length })}</span>
          <button className="lead-more lead-hand" aria-haspopup="menu" aria-expanded={menu === '*free'} onClick={() => setMenu(menu === '*free' ? null : '*free')}>
            {t('lead.band.hand')}
          </button>
          {menu === '*free' && (
            <div className="lead-menu" role="menu">
              {free.map((l) => (
                <button key={l.path} role="menuitem" onClick={() => hand([l.path], mate.id)}>
                  {t('lead.band.handOne', { name: l.label || l.branch || basename(l.path) })}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** H2 ②: a session working for a lead: one quiet line, and the way back to the lead's seat. */
export function TeamLine({ t, core, mate, open }: { t: T; core: CoreClient; mate: Teammate; open: (id: string) => void }) {
  return (
    <div className="lead-crumb">
      <span>
        {t('lead.inTeam', { name: mate.name })} · {t('lead.inTeamNote')}
      </span>
      <button onClick={() => void openSeat(core, mate.id).then(({ session }) => open(session.id), () => {})}>← {t('lead.back')}</button>
    </div>
  );
}
