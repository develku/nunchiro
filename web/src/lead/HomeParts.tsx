// Home view (2026-11-17, docs/design/leader-room/home-view-1117.html): the parts of the Home lead's Team view that a
// project's lead has not. Projects: one row per registered project from the core's digest (`task digest`; no agent
// writes a number). Assistants: the Home teammates with their job, next scheduled run and last report. The chip's
// "N projects · M need you" reads the same digest.
import { useEffect, useState } from 'react';
import type { CoreClient } from '../api';
import { ago } from '../board/WatchGrid';
import { knownOrRaw, rawError } from '../errors';
import { Icon } from '../icons/Icon';
import { failedRunCard, openSchedules, ranOnce, useScheduleList } from '../schedule/schedules';
import type { T } from '../i18n';
import { pressSetting } from '../settings/agents/open';
import { basename, rowState } from '../tree';
import { placeOfCard, stateLine, waitingItems, type Waiting } from '../tree/decisions';
import { sessionName } from '../sessionNames';
import { status, withResumed, type Decision, type Session } from '../types';
import type { RoomMessage } from '../room/room';
import { askLeader } from './LeaderDialog';
import { openSeat, restKey, seatOf, type Team, type Teammate } from './lead';
import { Avatar, hue, urgent } from './LeadHead';
import { LevelChip } from './level';
import './lead.css';

/** crates/nunchiro-core/src/ledger.rs `DigestRow`. */
export type DigestRow = { project: string; lead?: string; lead_state?: string; open: number; needs: number; oldest?: string; working: number; at: number; line: string; merged: number; decisions: number };
/** Ticket 993 rule 6, `FailedRun`: a schedule whose last run failed or could not start; it needs the user as a decision does. */
export type FailedRun = { schedule: string; line: string; reason: string; at: number; session?: string };
export type Digest = { projects: DigestRow[]; failed: FailedRun[] };

/** When this window last showed the Projects part (ms): "since you looked" counts from it. Per viewer, so browser storage. */
const SEEN = 'nunchiro.homeSeen';
const readSeen = () => {
  try {
    return Number(localStorage.getItem(SEEN)) || 0;
  } catch {
    return 0;
  }
};
/** The tree's "a leader can run these" line, closed once (Sidebar.tsx LEAD_OFF): the rows offer no leader either. */
const leadOff = () => {
  try {
    return localStorage.getItem('nunchiro.leadSuggestOff') === '1';
  } catch {
    return false;
  }
};

// As useTasks: read again on a room change, a seat's change, a decision's change, coming back to the window, and a slow poll.
const POLL_MS = 15_000;
export function useDigest(core: CoreClient, on: boolean, sessions: Session[], owner: Decision[], since = 0): Digest | null {
  const [rows, setRows] = useState<Digest | null>(null);
  const [read, setRead] = useState(0);
  useEffect(() => {
    setRows(null);
    if (!on) return;
    // A change reads the digest now and once more a second later: one answer moves several stores (the room line, the
    // card, the lead's seat), and the first read can land between them (the chip kept "1 need you" after Send).
    let later: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      setRead((n) => n + 1);
      clearTimeout(later);
      later = setTimeout(() => setRead((n) => n + 1), 1000);
    };
    const timer = setInterval(tick, POLL_MS);
    const off = core.onRoom(tick);
    // Look 1117 v12 (Home S2-2): a read lost to a dropped connection was tried again only by a tick, and a window behind
    // others ticks never (hidden), so after a reopen Projects stayed blank until a click. The socket opening (and a
    // schedule's change: its failed runs are in the digest) reads it again, hidden or not.
    const offOpen = core.onSchedules(() => setRead((n) => n + 1));
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => (clearInterval(timer), clearTimeout(later), off(), offOpen(), document.removeEventListener('visibilitychange', tick), window.removeEventListener('focus', tick));
  }, [core, on]);
  // Ticket 993: a schedule's last run turning failed (or no longer failed) is a change too.
  const runs = (useScheduleList() ?? []).map((s) => (s.last?.result === 'failed' ? s.id : '')).join(',');
  const facts = sessions.map((s) => `${s.id}:${s.state}:${status(s)}:${s.pending.length}`).join(',') + owner.map((d) => d.id).join(',') + runs;
  useEffect(() => {
    if (!on) return;
    let live = true;
    let again: ReturnType<typeof setTimeout> | undefined;
    core.request({ op: 'task', operation: 'digest', text: String(since) }).then(
      (r) => live && setRows(((d) => ({ projects: d.projects ?? [], failed: d.failed_runs ?? [] }))(r as { projects?: DigestRow[]; failed_runs?: FailedRun[] })),
      // Look 1117 v13 (Home S2): the core refuses a read past its in-flight cap (MAX_JOBS) while the window's connect burst
      // runs, a bigger one when something needs you, and only the 15 s tick read again: read again in a second. Any other
      // refusal (a core without the digest) shows nothing new.
      (e: unknown) => void (live && rawError(e).includes('in flight') && (again = setTimeout(() => live && setRead((n) => n + 1), 1000))),
    );
    return () => void ((live = false), clearTimeout(again));
  }, [core, on, facts, read, since]);
  return rows;
}

/** The Home lead's chip: "3 projects · 2 needs you". Its second part is the Decisions pane's own number
 *  (`waiting`: tree/decisions.ts `waitingCount`) and nothing else: two places never show two numbers (sixth and seventh
 *  look, Home S2). Eighth look (Home): in the words of the Team icon, the Team view's heading and a project lead's chip
 *  ("needs you"); the chip alone said "waiting" for the same number. */
export function homeCount(t: T, { projects: rows }: Digest, waiting: number) {
  const n = t(rows.length === 1 ? 'home.chip.one' : 'home.chip.other', { n: rows.length });
  return waiting ? `${n} · ${t('lead.tasks.needs', { n: waiting })}` : n;
}

type Group = 'needs' | 'broken' | 'working' | 'quiet';
/** A project row with nothing waiting: its lead can't start (look 1117 v11 Home S2-1: apart from Needs you, never counted), working or quiet. */
const groupOf = (r: DigestRow, failed = false): Group => (failed ? 'broken' : r.working > 0 ? 'working' : 'quiet');

/** Projects: needs you, a lead that can't start, working, quiet. A press opens the project's lead (or its most urgent
 *  session); Answer opens that decision in Decisions, the card it has everywhere. */
export function ProjectRows({ t, core, team, sessions, owner, open, decide }: { t: T; core: CoreClient; team: Team; sessions: Session[]; owner: Decision[]; open: (id: string) => void; decide: (id: string) => void }) {
  // The cursor is the one the part opened with; leaving the part moves it to now.
  const [since] = useState(readSeen);
  useEffect(
    () => () => {
      try {
        localStorage.setItem(SEEN, String(Date.now()));
      } catch {
        // no storage: every visit counts from nothing
      }
    },
    [],
  );
  const digest = useDigest(core, true, sessions, owner, since);
  const plans = useScheduleList() ?? [];
  const off = leadOff();
  // Look 1117 v11 Home S2-1: "Needs you · N" lists exactly the N things the chip, the Team icon and Decisions count (one
  // list, tree/decisions.ts `waitingItems`), each with its Answer: a failed run's card by its schedule (eighth look,
  // Home S2-B), a project's ask on that project's row, anything else (the Home lead's own question, a schedule it
  // proposes) on a row of its own.
  const items = waitingItems(sessions, owner);
  // Look 1117 v13 (Home S2): what waits is known from the snapshot before the digest is read: its rows show at once.
  if (!digest && !items.length) return null;
  const rows = digest?.projects ?? [];
  const rowOf = (x: Waiting) => rows.find((r) => r.project === (x.s ? x.s.project : placeOfCard(x.d)));
  const asked = new Set(items.map(rowOf));
  if (!rows.length && !items.length) return <p className="lead-empty">{t('home.empty')}</p>;
  // Ticket 993 rule 6: a failed scheduled run, with why; a press opens the Schedules widget on its row.
  const run = (d: Decision, f: NonNullable<ReturnType<typeof failedRunCard>>) => {
    const why = t('schedule.failedRun', { reason: knownOrRaw(t, f.reason) });
    // The run's own time (the schedule's `last.at`), never when the card was last read (eighth look, Home).
    const at = plans.find((s) => s.id === f.schedule)?.last?.at ?? d.observed_at;
    return (
      <div className="lead-row home-prow" key={d.id} data-failed-run={f.schedule} data-word="needs">
        <button className="lead-go" title={`${f.line} · ${why}`} onClick={() => openSchedules(f.schedule)}>
          <i className="lead-av" data-sm aria-hidden>
            <Icon name="clock" size={12} />
          </i>
          <b className="home-pname">{f.line.split(' · ')[0]}</b>
          {at > 0 && <span className="lead-tm">{ago(t, Date.now() - at)}</span>}
          <span className="lead-who">{why}</span>
        </button>
        <button className="lead-answer" onClick={() => decide(d.id)}>
          {t('lead.task.answer')}
        </button>
      </div>
    );
  };
  // Something no project's row stands for: a session's ask (a press opens the session) or a card the Home lead filed.
  const own = (x: Waiting) => {
    const mate = team.teammates.find((m) => (x.s ? m.id === x.s.teammate : m.lead && !m.project));
    const who = x.s ? sessionName(x.s) : (mate?.name ?? '');
    const what = stateLine(x.d, t).split('\n')[0];
    return (
      <div className="lead-row home-prow" key={x.d.id} data-ask={x.d.id} data-word="needs">
        <button className="lead-go" title={`${who} · ${what}`} onClick={() => (x.s ? open(x.s.id) : decide(x.d.id))}>
          {mate ? <Avatar letter={mate.name} label={mate.name} c={hue(mate.id)} face={null} small /> : <i className="lead-av" data-sm aria-hidden>–</i>}
          <b className="home-pname">{who}</b>
          <span className="lead-tm">{ago(t, Date.now() - x.d.observed_at)}</span>
          <span className="lead-who">{what}</span>
        </button>
        <button className="lead-answer" onClick={() => decide(x.d.id)}>
          {t('lead.task.answer')}
        </button>
      </div>
    );
  };
  const press = (r: DigestRow) => {
    const most = () => {
      const s = urgent(sessions.filter((x) => x.project === r.project && x.state !== 'closed' && !x.side_chat && !x.account_tab));
      if (s) open(s.id);
    };
    // Look v11 Home S3-4: a lead whose seat cannot open (its folder is gone) opens the project's most urgent session
    // (a failed seat there says why); the press did nothing.
    if (r.lead) return void openSeat(core, r.lead).then(({ session }) => open(session.id), most);
    most();
  };
  // Look 1117 v5 H-2: a lead whose seats all failed (as the tree shows them) needs the user, though no decision waits.
  const failed = (r: DigestRow) => {
    if (r.lead_state === 'failed' || r.lead_state === 'missing') return true; // the core's word (digest), else what the snapshot shows
    const seats = r.lead ? sessions.filter((s) => s.teammate === r.lead && s.state !== 'closed') : [];
    return seats.length > 0 && seats.every((s) => status(s) === 'failed');
  };
  // A project's row; `x`, one of its waiting items, puts it under Needs you with that item's words and Answer.
  const row = (r: DigestRow, x?: Waiting) => {
    const lead = r.lead ? team.teammates.find((m) => m.id === r.lead) : undefined;
    const name = basename(r.project);
    // Look 1117 v3 N1: a project is under Needs you for a decision that waits, never for having no leader; the row
    // says what waits first, and "no leader" (with its quiet link) belongs to a row with nothing to answer.
    // Look 1117 v4 N2: the ask in the card's own words (stateLine); a hook's permission is JSON and a framed screen
    // starts with a rule line, so the first line of the raw text read as either.
    const ask = x ? (x.s ? `${sessionName(x.s)}: ` : '') + stateLine(x.d, t) : '';
    const say = [
      // Look 1117 v9 Home S2-3: the project's folder was removed (the core's "missing").
      r.lead_state === 'missing' ? t('err.c.projectFolder') : lead && failed(r) ? `${lead.name} ${t('mw.status.failed')}` : '',
      ask,
      t(r.open === 1 ? 'lead.tasks.one' : 'lead.tasks.other', { n: r.open }),
      r.needs ? t('lead.tasks.needs', { n: r.needs }) : '',
      r.working ? t('home.row.working', { n: r.working }) : '',
      r.merged ? t('home.row.merged', { n: r.merged }) : '',
      r.decisions ? t('home.row.decisions', { n: r.decisions }) : '',
      lead || r.needs ? '' : t('home.row.noLead'),
      r.line,
    ].filter(Boolean);
    return (
      <div className="lead-row home-prow" key={x?.d.id ?? r.project} data-project={r.project} data-word={x ? 'needs' : groupOf(r, failed(r))}>
        {/* Two lines (look 1117 v3 N3): the name whole on the first, the time at its end; the counts on the second. */}
        <button className="lead-go" title={say.join(' · ')} onClick={() => press(r)}>
          {lead ? <Avatar letter={lead.name} label={lead.name} c={hue(lead.id)} face={null} small /> : <i className="lead-av" data-sm aria-hidden>–</i>}
          <b className="home-pname">{name}</b>
          {r.at > 0 && <span className="lead-tm">{ago(t, Date.now() - r.at)}</span>}
          <span className="lead-who">{say.join(' · ')}</span>
        </button>
        {x && (
          <button className="lead-answer" onClick={() => decide(x.d.id)}>
            {t('lead.task.answer')}
          </button>
        )}
        {!lead && !r.needs && !off && (
          <button className="home-add" onClick={() => askLeader(r.project)}>
            {t('lead.suggestAdd')}
          </button>
        )}
      </div>
    );
  };
  const item = (x: Waiting) => {
    const c = failedRunCard(x.d);
    if (c) return run(x.d, c);
    const r = rowOf(x);
    return r ? row(r, x) : own(x);
  };
  return (
    <>
      {(['needs', 'broken', 'working', 'quiet'] as const).map((g) => {
        const shown = g === 'needs' ? items.map(item) : rows.filter((r) => !asked.has(r) && groupOf(r, failed(r)) === g).map((r) => row(r));
        if (!shown.length) return null;
        const name = g === 'quiet' ? t('home.group.quiet') : g === 'broken' ? t('home.group.broken') : t(`lead.task.group.${g}`);
        const label = t('lead.task.group', { name, n: shown.length });
        return (
          <div className="lead-grp" key={g} data-group={g} role="group" aria-label={label}>
            <div className="lead-gh" aria-hidden>
              {label}
            </div>
            {shown}
          </div>
        );
      })}
    </>
  );
}

/** Ticket 1002 (mockup frame 1): the Home lead's latest brief in one line above the Projects. The newest run of the
 *  lead's schedules, and the newest line its seat wrote to the user in Home's room since that run began; nothing
 *  before the first such line. The whole line is its tooltip. */
export function BriefLine({ t, lead, sessions, messages }: { t: T; lead: Teammate; sessions: Session[]; messages: RoomMessage[] }) {
  const plans = useScheduleList() ?? [];
  const last = plans
    .filter((p) => p.run.teammate === lead.id && p.last?.session)
    .map((p) => p.last!)
    .sort((a, b) => b.at - a.at)[0];
  if (!last) return null;
  const byId = withResumed(new Map(sessions.map((s) => [s.id, s])), sessions); // a resumed seat answers to its old ids too
  const seat = byId.get(last.session!);
  const said = [...messages].reverse().find((m) => m.kind !== 'team' && m.to === 'person' && m.ts >= last.at && (m.from === last.session || (!!seat && byId.get(m.from) === seat)));
  if (!said) return null;
  const time = new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const line = said.body.split('\n').find((l) => l.trim()) ?? '';
  const label = t('home.brief.label', { name: lead.name, time });
  return (
    <div className="home-brief" role="note" data-tip={`${label}. ${said.body}`}>
      <Avatar letter={lead.name} label={lead.name} c={hue(lead.name)} face={null} small />
      <span className="home-brief-w">
        <span className="sr">{label}: </span>
        <b aria-hidden>{time}</b> {line}
      </span>
    </div>
  );
}

/** Assistants: each standing Home assistant, its job's first line, its next scheduled run and the last line it wrote in
 *  Home's room. A press opens its seat; "Add an assistant…" opens Settings > Team's add form. */
export function AssistantRows({ t, core, mates, sessions, messages, open }: { t: T; core: CoreClient; mates: Teammate[]; sessions: Session[]; messages: RoomMessage[]; open: (id: string) => void }) {
  // The window's one copy of the schedules (schedule/schedules.ts), kept current by the rails. Ticket 993: one that is
  // switched off has no next run.
  const plans = useScheduleList() ?? [];
  const byId = withResumed(new Map(sessions.map((s) => [s.id, s])), sessions); // a resumed seat answers to its old ids too (look v10 N10-S2-3)
  // The page draws after Settings opens: its own Add button opens the form.
  const add = () => pressSetting('team', 'team', '[data-setting="team"]');
  return (
    <div className="lead-grp" role="group" aria-label={t('home.part.assistants')}>
      {!mates.length && <p className="lead-empty">{t('home.mates.none')}</p>}
      {mates.map((m) => {
        const seat = seatOf(sessions, m.id);
        const st = seat ? rowState({ path: '', name: '', sessions: [seat] }, [seat]) : null;
        const next = plans.filter((p) => p.run.teammate === m.id && p.next_ms > 0 && !p.paused && !ranOnce(p)).sort((a, b) => a.next_ms - b.next_ms)[0];
        const said = [...messages].reverse().find((x) => byId.get(x.from)?.teammate === m.id && x.kind !== 'team');
        const word = seat ? t(`mw.status.${status(seat)}`) : t(restKey(sessions, m.id));
        const say = [m.job.split('\n')[0], next ? t('home.mates.next', { when: new Date(next.next_ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) }) : '', said ? said.body.split('\n')[0] : ''].filter(Boolean);
        return (
          <div className="lead-row" key={m.id} data-mate={m.id}>
            <button className="lead-go" onClick={() => (seat ? open(seat.id) : void openSeat(core, m.id).then(({ session }) => open(session.id), () => {}))}>
              <i className="room-rail" data-tone={st?.tone ?? 'idle'} aria-hidden />
              <b data-tip={m.name} data-tip-clip>{m.name}</b>
              {/* Its own span: the job is not drawn at all where fewer than about 8 characters of it fit (lead.css). */}
              <span className="lead-who">
                <span>{say.join(' · ')}</span>
              </span>
              <span className="lead-st" data-tip={word} data-tip-clip>
                {word}
              </span>
            </button>
            {/* Ticket 992: the seat's level, and the menu for the bot's next task (a button holds no button). */}
            {seat?.level && <LevelChip t={t} core={core} session={seat} />}
          </div>
        );
      })}
      <div className="lead-row" data-add-mate>
        <button className="lead-go" onClick={add}>
          <span className="lead-who">{t('home.mates.add')}</span>
        </button>
      </div>
    </div>
  );
}
