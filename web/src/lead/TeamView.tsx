// Ticket 990 (owner 11-17, docs/design/leader-room/team-widget-1117.html "1 + 4"): the Team view, a lead's tasks and its room in
// one component. It lives in the right sidebar or as a centre tab, one place at a time (team.ts). Its layout follows its own
// width: narrow, the two parts are tabs (Tasks first); wide, they sit side by side. Home view (11-17,
// docs/design/leader-room/home-view-1117.html): the Home lead's has three parts, Projects | Assistants | Room (HomeParts.tsx).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import type { WindowCtx } from '../layout/windows';
import { useRoom } from '../room/room';
import { RoomView } from '../room/RoomView';
import { WidenMark } from '../history/HistoryView';
import type { Decision, Session } from '../types';
import { leadOf, useTeam } from './lead';
import { AssistantRows, BriefLine, ProjectRows } from './HomeParts';
import { TaskRows, TeamTasks, type Other } from './LeadHead';
import { SeatDrawer, waitsSeat, type Peek } from './TaskBoard';
import { PlaceGear } from './place';
import { askTitle, asks, hasCard, placeOfCard, teamWaiting, whatWhy, type Item } from '../tree/decisions';
import { sessionName } from '../sessionNames';
import { showTeamTab, useTeamAt } from './team';
import { useTasks, withMerges } from './tasks';
import '../room/room.css';
import './lead.css';

/** An ask in one line: what a permission asks to do ("Run pytest"), else the first line of the question that has words (a screen-read question starts with Claude's rule of dashes: look v9 B N-S2-1). */
const sayOfAsk = (d: Item, t: T) => (d.kind === 'permission' && askTitle(d, t)) || (d.text.trimStart().startsWith('{') ? whatWhy(d, t).what : (d.text.split('\n').find((l) => /[\p{L}\p{N}]/u.test(l)) ?? '').trim());

/** At this width of its own the view shows both parts side by side. */
const WIDE = 720;
/** The three Home columns' floors (340 + 240 + 280) and their borders. */
const THREE = 870;
type Part = 'tasks' | 'projects' | 'assistants' | 'room';

export function TeamView({ core, t, folder, sessions, open, wt, owner, decide, where, term }: { core: CoreClient; t: T; folder: string | null; sessions: Session[]; open: (id: string) => void; wt?: WindowCtx['wt']; owner: Decision[]; decide: (id: string) => void; where: 'side' | 'tab'; term?: (id: string) => ReactNode }) {
  const team = useTeam(core, true);
  const place = folder === null ? null : team.home && folder === team.home ? '' : folder;
  const lead = place === null ? null : leadOf(team, place);
  const live = lead ? folder : null;
  const [, put] = useTeamAt(lead ? place : null);
  const { tasks: ledger, place: way } = useTasks(core, live, true, sessions);
  const tasks = useMemo(() => withMerges(ledger, owner), [ledger, owner]);
  const home = !!lead && !lead.project;
  const needs = teamWaiting(sessions, owner, live, home);
  // Ticket 1081: what waits on the lead, as the core's heartbeat counts it.
  const openTasks = tasks.filter((x) => !x.closed);
  const waits = [
    ((n) => n > 0 && t(n === 1 ? 'lead.waits.review.one' : 'lead.waits.review.other', { n }))(openTasks.filter((x) => x.waits === 'review').length),
    ((n) => n > 0 && t('lead.waits.merge', { n }))(openTasks.filter((x) => x.waits === 'merge').length),
    ((n) => n > 0 && t('lead.waits.stalled', { n }))(openTasks.reduce((n, x) => n + (x.advance?.stalled?.length ?? 0), 0)),
    ((n) => n > 0 && t(n === 1 ? 'lead.waits.seat.one' : 'lead.waits.seat.other', { n }))(openTasks.filter((x) => x.advance?.review === 'waits').length),
  ].filter(Boolean);
  const today = new Date().setHours(0, 0, 0, 0);
  const boardMeta = [
    ((n) => n > 0 && t('tboard.meta.working', { n }))(openTasks.filter((x) => x.state === 'working').length),
    needs > 0 && t(needs === 1 ? 'tboard.meta.asks.one' : 'tboard.meta.asks.other', { n: needs }),
    ((n) => n > 0 && t(n === 1 ? 'tboard.meta.seat.one' : 'tboard.meta.seat.other', { n }))(tasks.filter(waitsSeat).length),
    ((n) => n > 0 && t('tboard.meta.landed', { n }))(tasks.filter((x) => x.closed && x.closed.how === 'merged' && x.closed.at >= today).length),
  ]
    .filter(Boolean)
    .join(' · ');
  const parts: Part[] = home ? ['projects', 'assistants', 'room'] : ['tasks', 'room'];
  const [picked, setPart] = useState<Part>('tasks');
  const part = parts.includes(picked) ? picked : parts[0];
  const [wide, setWide] = useState(false);
  const [three, setThree] = useState(false); // N3: room for Projects, Assistants and Room side by side
  const ro = useRef<ResizeObserver | null>(null);
  const root = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    if (el) (ro.current = new ResizeObserver(([e]) => (setWide(e.contentRect.width >= WIDE), setThree(e.contentRect.width >= THREE)))).observe(el);
  }, []);
  const room = useRoom(core, live, true, wide || part === 'room');
  // Ticket 1115 step 2: the Team tab's board peeks at one seat at a time; the drawer takes the room's place while open.
  const [peek, setPeek] = useState<Peek | null>(null);
  const board = where === 'tab' && term ? { peek, setPeek } : undefined;
  const drawer = board && peek && term ? peek : null;
  // Esc anywhere in the view (captured before the peek's terminal) or the x: the drawer closes and the focus goes back to its card.
  const closeDrawer = () => {
    const task = peek?.task;
    setPeek(null);
    if (task) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.tcard[data-task="${CSS.escape(task)}"] .tcard-go`)?.focus());
  };
  // A team line says a worktree was made, removed or handed elsewhere (the lead's own CLI): the list is read again at once.
  const lastNote = room.messages.filter((m) => m.kind === 'team').at(-1)?.id;
  const refresh = wt?.refresh;
  useEffect(() => void (lastNote && refresh?.()), [lastNote, refresh]);
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  // q67 look (new 2, Q7-9): "Needs you" counted the tasks' merge asks (2) while Decisions said 3: the lead's own question
  // had no row here. What waits in this place and is no task's own ask has a row, and the heading says the shared count.
  const others = useMemo((): Other[] => {
    if (!lead || !live || home) return [];
    const seated = new Set(tasks.filter((x) => !x.closed && x.state === 'needs').flatMap((x) => (x.seats ?? []).map((s) => s.session)));
    return [
      ...sessions.filter((s) => s.project === live && !seated.has(s.id) && asks(s.pending).length > 0).map((s) => ({ key: s.id, title: sessionName(s), say: sayOfAsk(asks(s.pending)[0], t), answer: () => (open(s.id), decide(asks(s.pending)[0].id)) })), // look v10 N10-S2-1: its card in Decisions too (the side view's lead was already in front, so open alone did nothing)
      ...owner.filter((d) => hasCard(d) && placeOfCard(d) === live && !tasks.some((x) => x.merge === d.id)).map((d) => ({ key: d.id, title: lead.name, say: d.text.split('\n')[0], answer: () => decide(d.id) })),
    ];
  }, [lead, live, home, tasks, sessions, owner, t, open, decide]);
  if (!lead || !live) return <div className="teamv" ref={root}><p className="room-empty">{t('lead.paneNone')}</p></div>;

  const move = where === 'side' ? () => (put({ tab: true }), showTeamTab(live)) : () => put({ open: true });
  const homeMates = home ? team.teammates.filter((m) => !m.project && m.id !== lead.id) : [];
  const id = (p: Part) => `teamv-${where}-${p}`;
  const tabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = parts[(parts.indexOf(part) + (e.key === 'ArrowRight' ? 1 : parts.length - 1)) % parts.length];
    setPart(next);
    document.getElementById(`${id(next)}-tab`)?.focus();
  };
  const tab = (p: Part, label: string, n = 0) => (
    <button role="tab" id={`${id(p)}-tab`} aria-selected={part === p} aria-controls={id(p)} tabIndex={part === p ? 0 : -1} onClick={() => setPart(p)} onKeyDown={tabKey}>
      {label}
      {n > 0 && <span className="lead-n">{n}</span>}
    </button>
  );
  const title = (p: Part) => (p === 'tasks' ? t('lead.task.band') : p === 'projects' ? t('home.part.projects') : p === 'assistants' ? t('home.part.assistants') : t('room.tab'));
  const panel = (p: Part) => (wide ? { role: 'region', 'aria-label': title(p) } : { role: 'tabpanel', id: id(p), 'aria-labelledby': `${id(p)}-tab`, hidden: part !== p });
  return (
    <div className="teamv" ref={root} data-wide={wide || undefined} data-three={three || undefined} data-where={where} data-team-view={live} data-drawer={drawer ? true : undefined} onKeyDownCapture={drawer ? (e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), closeDrawer()) : undefined}>
      <div className="teamv-head">
        {wide ? (
          // The legend is about worktrees, and Home has none (look 1117 v3).
          <span className="room-meta">{home ? '' : t('lead.legend')}</span>
        ) : (
          <div className="teamv-tabs" role="tablist" aria-label={t('lead.team.parts')}>
            {parts.map((p) => tab(p, title(p), p === 'room' ? room.unread : 0))}
          </div>
        )}
        {!home && waits.length > 0 && (
          <span className="room-meta lead-waits" data-waits>
            {waits.join(' · ')}
          </span>
        )}
        {/* Ticket 1099: the way of working is a setting (Settings > Team > How this place works); the gear opens it here. */}
        {!home && <PlaceGear t={t} project={lead.project ?? live} />}
        <button className="teamv-move" data-move={where === 'side' ? 'tab' : 'side'} onClick={move}>
          <WidenMark /> <span className="teamv-move-l">{where === 'side' ? t('lead.team.toTab') : t('lead.team.toSide')}</span>
        </button>
      </div>
      <div className="teamv-body" data-parts={parts.length}>
        {home ? (
          <>
            <div className="teamv-tasks" data-part="projects" {...panel('projects')}>
              {wide && <div className="lead-gh">{title('projects')}</div>}
              <BriefLine t={t} lead={lead} sessions={sessions} messages={room.messages} />
              <ProjectRows t={t} core={core} team={team} sessions={sessions} owner={owner} open={open} decide={decide} />
            </div>
            <div className="teamv-tasks" data-part="assistants" {...panel('assistants')}>
              {wide && <div className="lead-gh">{title('assistants')}</div>}
              {/* The Home lead's own tasks, only while it has open ones. */}
              {tasks.some((x) => !x.closed) && <TaskRows t={t} tasks={tasks} sessions={sessions} open={open} decide={decide} />}
              <AssistantRows t={t} core={core} mates={homeMates} sessions={sessions} messages={room.messages} open={open} />
            </div>
          </>
        ) : (
          <div className="teamv-tasks" {...panel('tasks')}>
            {board ? (
              // Ticket 1115 step 2 (mockup panel 2): the board's counts beside its title, from the same tasks.
              <div className="tboard-head">
                {wide && <span className="lead-gh">{t('lead.task.band')}</span>}
                <span className="room-meta" data-board-meta>
                  {boardMeta}
                </span>
              </div>
            ) : (
              wide && <div className="lead-gh">{t('lead.task.band')}</div>
            )}
            {wt ? <TeamTasks t={t} core={core} project={live} mate={lead} sessions={sessions} tasks={tasks} place={way} wt={wt} open={open} decide={decide} others={others} needs={needs} board={board} /> : (tasks.some((x) => !x.closed) || others.length > 0) && <TaskRows t={t} tasks={tasks} sessions={sessions} open={open} decide={decide} others={others} needs={needs} />}
          </div>
        )}
        <div className="teamv-room" {...panel('room')} {...(drawer ? { hidden: true } : {})}>
          {wide && home && <div className="lead-gh">{title('room')}</div>}
          <RoomView core={core} t={t} project={live} sessions={sessions} byId={byId} messages={room.messages} pins={room.pins} names={room.names} delivery={room.delivery} dropped={room.dropped} toggle={room.toggle} refresh={room.refresh} open={open} wt={wt} />
        </div>
        {drawer && term && <SeatDrawer t={t} peek={drawer} tasks={tasks} sessions={sessions} term={term} open={open} close={closeDrawer} />}
      </div>
    </div>
  );
}
