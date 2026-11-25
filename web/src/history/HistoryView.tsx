// Ticket 1022 (mockup docs/design/tree-done-1121, section 3): the History widget. Every finished session the core still
// lists, newest first, grouped by day. Search covers the name, the label, the project and the folder (a worktree's
// folder is its branch's name), and the conversation text through the core's `sessions_search` (no index: the same
// paged scan the Search panel uses). Filters: one project, the agents, stopped or failed. A row opens its conversation
// read-only (the tab's own Resume stays there); "Continue" resumes it, "View changes" opens it with Diff.
// One component in the right sidebar or as a centre tab (history.ts keeps which), as Schedules.
// Ticket 1029 (mockup docs/design/history-1121, direction A): the rows are drawn in the tree's language: a hollow rail,
// the agent's icon, the bold name with the run's start and length, one muted line with the project, and three icons on
// hover. In a wide place (the tab) a session is one row with a hollow run-length bar (history.css).
// Lane w59 (owner 11-21, the same mockup): its filter row (project list, agent segment, stopped-or-failed toggle, the
// count), its short run length ("18m"), its second line (never the name again) and its empty states.
// Ticket 1073 (owner 11-23: sessions and past conversations are one thing): the tree's "Past conversations" fold moved
// here; a conversation on disk that no listed session ran is a row of the same list (PastRow), with its own filter.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import { useSummary } from '../board/WatchGrid';
import { agentName } from '../chat/conversation';
import { causeText } from '../chat/problemCause';
import { openDiff } from '../diff/Diff';
import type { T } from '../i18n';
import { Icon } from '../icons/Icon';
import { PLAIN } from '../plainText';
import { sessionName } from '../sessionNames';
import { ownBranch } from '../tree';
import { AgentLogo } from '../tree/AgentLogo';
import { byEnd, daysAgo, ended, endedAt } from '../tree/finished';
import { RowIcon } from '../tree/RowIcon';
import { noCheckout, status, type AgentKind, type Session } from '../types';
import { continueSession, onOpenHistory, showHistTab, takeWanted, useHistAt } from './history';
import { conversationOf, isConversation, openPast, seenRan, usePastChats, type Past } from './pastChats';
import { ErrorDetails, plainError, rawError } from '../errors';
import { unmark } from '../board/tasks';
import './history.css';

const PAUSE_MS = 300;
// shortcut: only the newest rows ask the core for their last answer (one chat page each); the rest show their label. Ask
// per row as it scrolls into view if longer lists need it.
const SUMMARIES = 30;
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
/** "Stopped or failed": closed by a stop or close (done, grey), or ended with an error (red). */
const stoppedOrFailed = (s: Session) => s.state === 'closed' || status(s) === 'failed';
/** Finished: ended (tree/finished.ts `ended`: closed, its agent quit, or resumable), or moved to done by the owner while it runs (`settled`), so
 *  everything the tree drops is here. A failed one is listed too (red), also while its red row is still in the tree. */
export const finished = (s: Session, settled?: ReadonlySet<string>) => !s.account_tab && (ended(s) || !!settled?.has(s.id));

/** The mockup's marks that the tree's RowIcon has no kind for, drawn as RowIcon draws its own (24 grid, stroke 2, round caps). */
const MARKS = {
  chat: <path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  diff: <path d="M12 4v9M7.5 8.5h9M7.5 19h9" />,
  widen: <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />,
  stop: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <rect x="8.7" y="8.7" width="6.6" height="6.6" rx="1" />
    </>
  ),
  shell: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="M7 10l3 2.5L7 15M13 15h4" />
    </>
  ),
} satisfies Record<string, ReactNode>;
const Mark = ({ name }: { name: keyof typeof MARKS }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-icon={name}>
    {MARKS[name]}
  </svg>
);
/** Ticket 1041 (inventory N075): the one widen glyph, also Team's and Schedules' Open as a tab / Back to the side. */
export const WidenMark = () => <Mark name="widen" />;
/** The time a row shows (history-1121): its start, else (a row from before the core kept the start) its end. */
const shownAt = (s: Session) => s.started_at ?? endedAt(s);
/** The local day a run ended (0 for none: "Earlier", last). */
const endDay = (s: Session) => {
  const at = endedAt(s);
  return at === null ? 0 : new Date(at).setHours(0, 0, 0, 0);
};
const Logo = ({ kind, name }: { kind: AgentKind; name?: string }) => (kind === 'shell' ? <Mark name="shell" /> : <AgentLogo kind={kind} name={name} />);
/** The run-length bar's width in px, 5 to 56, on a log scale that is full at 90 minutes (the mockup's `durw`). */
const barWidth = (ms: number) => Math.round(5 + 51 * Math.min(1, Math.log(Math.max(0, ms) / 60_000 + 1) / Math.log(91)));
/** "18m", "1h 12m", "2d 3h": the mockup's short run length. History only; the tree keeps ticket 1025's words ("18 min"). */
export const runLength = (t: T, ms: number) => {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? t('history.len.sub') : m < 60 ? t('history.len.m', { m }) : m < 1440 ? t('history.len.hm', { h: Math.floor(m / 60), m: m % 60 }) : t('history.len.dh', { d: Math.floor(m / 1440), h: Math.floor((m % 1440) / 60) });
};
/** "09:42", on the 24-hour clock in every language (the mockup's): a column of times with no "AM" in it. History only;
 *  the tree's popover keeps the language's own clock (tree/finished.ts `clock`). */
const clock = (at: number) => new Date(at).toLocaleTimeString(document.documentElement.lang || undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
type Place = { project: string; path: string; branch: string };

function Row({ core, s, t, open, ask, places }: { core: CoreClient; s: Session; t: T; open: (id: string) => void; ask: boolean; places?: Place[] }) {
  const shell = s.kind === 'shell';
  const said = useSummary(core, ask && !shell ? s.id : null, String(s.completion_seq ?? 0)); // a shell has no transcript
  const name = sessionName(s);
  const at = endedAt(s);
  // Failed is red; closed by a stop or a close is the grey stop mark; one that ended by itself has no mark.
  const end = status(s) === 'failed' ? 'fail' : s.state === 'closed' ? 'stop' : 'done';
  const agent = agentName(s.kind, s.acp_agent);
  // Ticket 1025: a row started before the core kept the start shows when it ended, and no length.
  const ran = at === null || s.started_at === undefined ? null : at - s.started_at;
  // The second line: why it failed, else the agent's last answer, else a label that is not the name. Never the name
  // again (the mockup's rows say what happened). A shell's row carries no command (the core keeps a run's arguments off
  // the row, store.rs `launch_args`) and its screen read misses what it printed just before it exited, so a shell with
  // no label of its own has no line.
  const why = end === 'fail' && s.problem ? causeText(t, s.problem, { name: shell ? null : agent, program: s.kind === 'claude' || s.kind === 'codex' ? s.kind : null, machine: s.machine }) : null;
  // Look v33 S3-1: the answer's first line is markdown; the row shows its plain words (the CSS cuts it with an ellipsis).
  const sum = why ?? (said ? unmark(said) : null) ?? (s.label && s.label !== name ? s.label : '');
  // Its branch: a listed worktree's own, else the folder's name (a worktree's folder is its branch's name); the main
  // folder reads the tree's word for it, in the wide row only (the mockup's narrow row names no "main").
  const wt = places?.find((l) => l.path === s.cwd);
  const main = !wt && s.cwd === s.project;
  const branch = wt ? ownBranch(wt) || base(s.cwd) : main ? (noCheckout(s) ? '' : t('tree.main')) : base(s.cwd);
  const chip = (cls: string) => (
    <span className={cls}>
      <Icon name="git-branch" size={11} />
      <span>{branch}</span>
    </span>
  );
  const act = (key: 'history.view' | 'history.continue' | 'history.changes', mark: keyof typeof MARKS, run: () => void) => (
    // The tip goes below (the mockup's), not beside: beside, it covers the next icon.
    <button type="button" aria-label={t(key)} data-tip={t(key)} data-tip-below="" onClick={run}>
      <Mark name={mark} />
    </button>
  );
  return (
    // The tree row's own menu (Restart, Close, Rename, ...), as the session's row had before it left the tree.
    <li className="hr" data-history={s.id} data-end={end} data-menu="treerow" data-menu-session={s.id} data-menu-title={name}>
      <i className="hr-rail" aria-hidden />
      <span className="hr-ag" role="img" aria-label={agent}>
        <Logo kind={s.kind} name={s.acp_agent ?? undefined} />
      </span>
      <span className="hr-l1">
        <button type="button" className="hr-go" onClick={() => open(s.id)}>
          <b>{name}</b>
        </button>
        {branch && !main && chip('hr-bn')}
      </span>
      {/* The wide row's second column: the project and the branch in one cell. */}
      <span className="hr-meta">
        {base(s.project)}
        {branch && chip('hr-bn')}
      </span>
      <span className="hr-t">
        {end !== 'done' && (
          <span className="hr-mk" role="img" aria-label={t(end === 'fail' ? 'mw.status.failed' : 'history.stopped')}>
            {end === 'fail' ? <RowIcon kind="fail" /> : <Mark name="stop" />}
          </span>
        )}
        <span className="hr-st">{at === null ? '' : clock(s.started_at ?? at)}</span>
        {ran !== null && (
          <span className="hr-len">
            <i className="hr-dur" style={{ width: barWidth(ran) }} aria-hidden />
            {runLength(t, ran)}
          </span>
        )}
      </span>
      <span className="hr-acts">
        {act('history.view', 'chat', () => open(s.id))}
        {act('history.continue', 'play', () => continueSession(s))}
        {act('history.changes', 'diff', () => (open(s.id), requestAnimationFrame(() => openDiff())))}
      </span>
      <span className="hr-sum">{sum}</span>
      <span className="hr-pj">{base(s.project)}</span>
    </li>
  );
}

/** Ticket 1073: a conversation found on disk that no listed Nunchiro session ran (started in a terminal): the same rail
 *  row with its title, its time, no run length, the muted "Started in a terminal" and a terminal glyph before the project.
 *  View opens it read-only (the tree's old row); Continue resumes its conversation id in a new session in its folder. */
function PastRow({ core, p, project, own, t }: { core: CoreClient; p: Past; project: string; own: boolean; t: T }) {
  const [fail, setFail] = useState<{ text: string; details: string } | null>(null);
  // A title is text an agent wrote: drawn as plain text, cut by CSS.
  const title = p.title || t('past.untitled');
  const view = () => (setFail(null), openPast(core, p).catch((e) => setFail({ text: t('past.failed', { error: plainError(t, e) }), details: rawError(e) })));
  // The start Continue sends is restart.ts `restartRequest` of an ended agent session with this conversation id.
  const resume = () => continueSession({ id: `imported:${p.id}`, kind: p.agent, project, cwd: project, label: '', state: 'closed', agent_session_id: p.agent === 'codex' ? conversationOf(p).slice(-36) : conversationOf(p), completion_seq: 1 } as unknown as Session);
  const act = (key: 'history.view' | 'history.continue', mark: keyof typeof MARKS, run: () => void) => (
    <button type="button" aria-label={t(key)} data-tip={t(key)} data-tip-below="" onClick={run}>
      <Mark name={mark} />
    </button>
  );
  // Ticket 1073 round 3: a conversation a Nunchiro session ran (its row closed and gone) is a plain row: no terminal mark.
  const where = (
    <>
      {!own && (
        <span className="hr-tm" role="img" aria-label={t('history.outside')}>
          <Mark name="shell" />
        </span>
      )}
      {base(project)}
    </>
  );
  return (
    <li className="hr" data-history={p.id} data-end="done" data-outside={own ? undefined : ''} data-own={own ? '' : undefined} data-project={project}>
      <i className="hr-rail" aria-hidden />
      <span className="hr-ag" role="img" aria-label={agentName(p.agent)}>
        <AgentLogo kind={p.agent} />
      </span>
      <span className="hr-l1">
        <button type="button" className="hr-go" title={title} onClick={view}>
          <b>{title}</b>
        </button>
      </span>
      <span className="hr-meta">{where}</span>
      <span className="hr-t">
        <span className="hr-st">{clock(p.modified_ms)}</span>
      </span>
      <span className="hr-acts">
        {act('history.view', 'chat', view)}
        {act('history.continue', 'play', resume)}
      </span>
      <span className="hr-sum">{own ? '' : t('history.outside')}</span>
      <span className="hr-pj">{where}</span>
      {fail && (
        <span className="hr-fail" role="alert">
          {fail.text}
          <ErrorDetails t={t} details={fail.details} />
        </span>
      )}
    </li>
  );
}
/** A History entry: a finished Nunchiro session, or (ticket 1073) an on-disk conversation of a project. */
type Entry = { s: Session; at: number | null; day: number } | { p: Past; project: string; own: boolean; at: number; day: number };
const dayStart = (at: number | null) => (at === null ? 0 : new Date(at).setHours(0, 0, 0, 0));

/** The agents the segment always offers (the mockup's three); an ACP agent's cell shows once History has one. */
const KINDS: AgentKind[] = ['claude', 'codex', 'shell'];

export function HistoryView({ core, t, sessions, open, where, settled, places, projects: tree = [] }: { core: CoreClient; t: T; sessions: Session[]; open: (id: string) => void; where: 'side' | 'tab'; settled?: ReadonlySet<string>; places?: Place[]; projects?: string[] }) {
  const [, put] = useHistAt();
  const [query, setQuery] = useState('');
  const [project, setProject] = useState(() => takeWanted() ?? '');
  const [off, setOff] = useState<ReadonlySet<AgentKind>>(new Set());
  const [bad, setBad] = useState(false);
  const [outside, setOutside] = useState(false);
  const [hits, setHits] = useState<{ q: string; ids: Set<string>; done: boolean } | null>(null);
  const channel = useId();
  const seq = useRef(0);
  useEffect(() => onOpenHistory(() => setProject(takeWanted() ?? '')), []);
  // Days stay the day a run ended (tree-done-1022: "a session that ended yesterday is in History" under Yesterday); inside
  // a day, ticket 1041 lists rows by the time each shows (history-1121): newest start first, a row with no start by its end.
  const done = useMemo(() => sessions.filter((s) => finished(s, settled)).sort((a, b) => endDay(b) - endDay(a) || (shownAt(b) ?? 0) - (shownAt(a) ?? 0) || byEnd(a, b)), [sessions, settled]);
  // Ticket 1073: one list. The tree's local projects' conversations on disk join the finished sessions; one that a session
  // of the window ran (its agent_session_id), finished or live, is that session's and is not listed twice.
  const past = usePastChats(core, tree);
  const all = useMemo<Entry[]>(() => {
    const ran = new Set(sessions.flatMap((s) => (s.agent_session_id ? [s.agent_session_id] : [])));
    for (const id of ran) seenRan.add(id);
    // Round 3: one whose session left (closed, or replaced by its resume) is still Nunchiro's: the core's `ran` mark
    // (ran.json, any window, after a restart) or a snapshot of this window showed it.
    const disk = tree.flatMap((project) => (past[project] ?? []).filter((p) => !isConversation(p, ran)).map((p) => ({ p, project, own: !!p.ran || isConversation(p, seenRan), at: p.modified_ms, day: dayStart(p.modified_ms) })));
    const own = done.map((s) => ({ s, at: shownAt(s), day: endDay(s) }));
    // Days by the day a run ended (a conversation: last written); inside a day, newest shown time first. Sort is stable,
    // so the sessions keep their own order (byEnd) among equal times.
    return [...own, ...disk].sort((a, b) => b.day - a.day || (b.at ?? 0) - (a.at ?? 0));
  }, [done, sessions, past, tree]);
  const projOf = (e: Entry) => ('s' in e ? e.s.project : e.project);
  const projects = useMemo(() => [...new Set(all.map(projOf))].sort((a, b) => base(a).localeCompare(base(b))), [all]);
  const kinds = done.some((s) => s.kind === 'acp') ? [...KINDS, 'acp' as const] : KINDS;
  const picked = all.filter((e) => (!project || projOf(e) === project) && ('s' in e ? !outside && !off.has(e.s.kind) && (!bad || stoppedOrFailed(e.s)) : !off.has(e.p.agent) && !bad && (!outside || !e.own)));
  const q = query.trim().toLowerCase();
  // The conversation scan: after a pause in typing, over the picked agent sessions (a shell has no transcript).
  const scanIds = picked.flatMap((e) => ('s' in e && e.s.kind !== 'shell' ? [e.s.id] : [])).join(' ');
  useEffect(() => {
    const n = ++seq.current;
    if (!q || !scanIds) return setHits(null);
    const timer = setTimeout(() => {
      setHits({ q, ids: new Set(), done: false });
      const page = (rest: string[]) =>
        core.request({ op: 'sessions_search', query: q, sessions: rest, channel }).then(
          (reply) => {
            if (n !== seq.current) return;
            const r = reply as { scanned?: number; results?: { session: string; hits?: unknown[] }[] };
            const scanned = Math.min(r.scanned ?? rest.length, rest.length);
            const found = (r.results ?? []).filter((f) => f.hits?.length).map((f) => f.session);
            setHits((h) => h && { ...h, ids: new Set([...h.ids, ...found]), done: scanned >= rest.length || scanned < 1 });
            if (scanned >= 1 && scanned < rest.length) void page(rest.slice(scanned));
          },
          () => n === seq.current && setHits((h) => h && { ...h, done: true }), // a refused scan leaves the name matches
        );
      void page(scanIds.split(' '));
    }, PAUSE_MS);
    return () => clearTimeout(timer);
  }, [q, scanIds, core, channel]);
  const shown = !q ? picked : picked.filter((e) => ('s' in e ? [sessionName(e.s), e.s.label, base(e.s.project), base(e.s.cwd)].some((x) => x?.toLowerCase().includes(q)) || hits?.ids.has(e.s.id) : [e.p.title, base(e.project)].some((x) => x.toLowerCase().includes(q))));
  const now = Date.now();
  // A day's head: "Today" or "Yesterday" with its date, an older day by its weekday and date; one with no time is "Earlier".
  const lang = document.documentElement.lang || undefined;
  const dayOf = (e: Entry): [string, string, string] => {
    const at = 's' in e ? endedAt(e.s) : e.at;
    if (at === null) return ['', t('history.earlier'), ''];
    const d = daysAgo(at, now);
    const date = (o: Intl.DateTimeFormatOptions) => new Date(at).toLocaleDateString(lang, o);
    return [new Date(at).toDateString(), d < 1 ? t('history.today') : d === 1 ? t('history.yesterday') : date({ weekday: 'long' }), date(d < 2 ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' })];
  };
  const days: { key: string; word: string; date: string; list: Entry[] }[] = [];
  for (const e of shown) {
    const [key, word, date] = dayOf(e);
    const last = days.at(-1);
    if (last?.key === key) last.list.push(e);
    else days.push({ key, word, date, list: [e] });
  }
  const move = where === 'side' ? () => (put({ tab: true }), showHistTab()) : () => put({ open: true });
  const moveTo = where === 'side' ? t('lead.team.toTab') : t('lead.team.toSide');
  const moveBtn = (
    <button type="button" className="histv-ib" data-move={where === 'side' ? 'tab' : 'side'} aria-label={moveTo} data-tip={moveTo} onClick={move}>
      <Mark name="widen" />
    </button>
  );
  const count = t(shown.length === 1 ? 'history.sessions.one' : 'history.sessions.other', { n: shown.length });
  const clear = () => (setQuery(''), setProject(''), setOff(new Set()), setBad(false), setOutside(false));
  const flip = (k: AgentKind) => setOff((o) => new Set(o.has(k) ? [...o].filter((x) => x !== k) : [...o, k]));
  return (
    <div className="histv" data-where={where} data-history-view>
      {/* In the sidebar the title is the sidebar's own header: the button sits at its right end, as Schedules'. */}
      {where === 'side' && <div className="histv-head">{moveBtn}</div>}
      <div className="histv-bar">
        {where === 'tab' && <Icon name="history" size={16} />}
        {where === 'tab' && <b className="histv-title">{t('history.title')}</b>}
        <div className="histv-filters" role="group" aria-label={t('history.filters')}>
          <label className="histv-q">
            <Icon name="search" size={13} />
            <input {...PLAIN} type="search" placeholder={t('history.search')} aria-label={t('history.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {/* Ticket 1073: on the search field's line, which has room in a 250px sidebar (the controls' line has none). */}
          <button type="button" className="histv-tg" data-outside-filter="" aria-pressed={outside} aria-label={t('history.outsideOnly')} data-tip={t('history.outsideOnly')} data-tip-below="" onClick={() => setOutside((f) => !f)}>
            <Mark name="shell" />
          </button>
          {/* One line that never wraps: in a narrow sidebar the list gives way (its name is cut). */}
          <div className="histv-ctl">
            <span className="histv-sel" data-on={project ? '' : undefined}>
              <Icon name="file-directory" size={12} />
              {/* The words are drawn here and the native list lies over the whole box, unseen: a bare select sizes to
                  its text in Chromium only (field-sizing), and in the app's WebKit it cut "All projects" short. */}
              <span className="histv-sel-t" aria-hidden>
                {project ? base(project) : t('history.allProjects')}
              </span>
              <Icon name="chevron-down" size={12} />
              <select aria-label={t('history.project')} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">{t('history.allProjects')}</option>
                {/* A project asked for by the tree's count that has no finished session any more keeps its place. */}
                {(project && !projects.includes(project) ? [project, ...projects] : projects).map((p) => (
                  <option key={p} value={p}>
                    {base(p)}
                  </option>
                ))}
              </select>
            </span>
            <span className="histv-seg" role="group" aria-label={t('history.agent')}>
              {kinds.map((k) => (
                <button key={k} type="button" aria-pressed={!off.has(k)} aria-label={agentName(k)} data-tip={agentName(k)} data-tip-below="" data-kind={k} onClick={() => flip(k)}>
                  <Logo kind={k} name={agentName(k)} />
                </button>
              ))}
            </span>
            <button type="button" className="histv-tg" aria-pressed={bad} aria-label={t('history.stoppedOrFailed')} data-tip={t('history.stoppedOrFailed')} data-tip-below="" onClick={() => setBad((f) => !f)}>
              <RowIcon kind="fail" />
            </button>
            {/* How many are listed; none to count before the first session ends (the mockup's first empty state). */}
            {all.length > 0 && (
              <span className="histv-cnt" role="status" aria-label={count}>
                {where === 'tab' ? count : shown.length}
              </span>
            )}
          </div>
        </div>
        {where === 'tab' && moveBtn}
      </div>
      <div className="histv-body">
        {q && hits && !hits.done && (
          <p className="histv-note" role="status">
            {t('history.searching')}
          </p>
        )}
        {!shown.length &&
          (all.length ? (
            <div className="histv-empty" role="status">
              <Icon name="search" size={20} />
              <b>{t('history.noMatch')}</b>
              <button type="button" onClick={clear}>
                {t('history.clear')}
              </button>
            </div>
          ) : (
            <div className="histv-empty" role="status">
              <span className="dbar" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              <b>{t('history.none')}</b>
              <small>{t('history.noneHint')}</small>
            </div>
          ))}
        {days.map(({ key, word, date, list }) => (
          <section key={key} aria-label={`${word} ${date}`.trim()}>
            <h4 className="histv-day">
              <b>{word}</b>
              {date}
              {/* The tree's hollow bar and number (tree/done.css `.dbar`): how many this day. */}
              <span className="dbar">
                <i />
                <span className="num">{list.length}</span>
              </span>
            </h4>
            <ul className="histv-list">
              {list.map((e) => ('s' in e ? <Row key={e.s.id} core={core} s={e.s} t={t} open={open} ask={shown.indexOf(e) < SUMMARIES} places={places} /> : <PastRow key={e.p.id} core={core} p={e.p} project={e.project} own={e.own} t={t} />))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
