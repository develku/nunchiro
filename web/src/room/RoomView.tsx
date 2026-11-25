// Ticket 571 (room panel): the approved mockup docs/design/orchestration-room/index.html. Thread filter, the log grouped by thread
// ("name (agent) → recipient"), one composer (recipient, thread, text), and a right column of seats and pinned decisions.
// A body is shown as quoted plain text: it is data, so no markdown, no link and no HTML ever runs from it.
import { PLAIN } from '../plainText';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import { notePlain } from '../errors';
import { clean } from '../widgets/output'; // controls, escapes and bidi marks out of every text the room draws
import { sessionName } from '../Sidebar';
import { restartRequest } from '../chrome/restart';
import { askNew } from '../NewSession';
import { status, withResumed, type Session } from '../types';
import { basename, rowState, type ListedWorktree, type WorktreeFact } from '../tree';
import type { T } from '../i18n';
import { PERSON, endedSeats, num, reachedText, seatNames, seatsOf, stamp, type RoomMessage } from './room';
import { useTasks } from '../lead/tasks';
import { leadOf, useTeam } from '../lead/lead';
import { isLevel, LevelMark, pairShort, seatText, type Pair } from '../lead/level';
import './room.css';

/** Ticket 990: the worktrees and their facts, for each sender's colour bar (the tree row's own tone). */
export type RoomWorktrees = { list: ListedWorktree[]; facts: ReadonlyMap<string, WorktreeFact> };
type Props = { core: CoreClient; t: T; project: string; sessions: Session[]; byId: Map<string, Session>; messages: RoomMessage[]; pins: string[]; names?: Record<string, string>; delivery?: Record<string, number | null>; dropped: number; toggle: (id: string) => Promise<void>; refresh: () => Promise<void>; open: (id: string) => void; wt?: RoomWorktrees };

const NEW = '\0new';

/** "You" in the eight languages: a session labelled so is told apart from the person (the person's label comes from `created_by`). */
const YOU = new Set(['you', '나', '自分', '我', 'tú', 'vous', 'você']);
const ALL = '*all'; // the built-in filters hold a character a thread name cannot, so no thread can take their place
const MINE = '*mine';

export function RoomView({ core, t, project, sessions, byId: rows, messages, pins, names = {}, delivery = {}, dropped, toggle, refresh, open, wt }: Props) {
  const team = useTeam(core, true);
  const byId = useMemo(() => withResumed(rows, sessions), [rows, sessions]); // a resumed seat answers to its old ids too
  const leadMate = leadOf(team, team.home && project === team.home ? '' : project)?.id; // ticket 990: the place's lead teammate
  const { seats, lead } = useMemo(() => seatsOf(project, sessions, byId, leadMate), [project, sessions, byId, leadMate]);
  // The lead first, then the others in the session list. A seat started by a live seat of the room is a worker; the session record
  // holds no reviewer role, so none is shown.
  const ordered = useMemo(() => (lead ? [lead, ...seats.filter((s) => s.id !== lead.id)] : seats), [seats, lead]);
  // Seats that ended but spoke in this room stay in the column with their ended state (their asks show `lost`).
  const gone = useMemo(() => endedSeats(project, sessions, byId, messages), [project, sessions, byId, messages]);
  const role = (s: Session) => (s.id === lead?.id ? ('lead' as const) : s.parent && byId.has(s.parent) ? ('worker' as const) : null);
  const [filter, setFilter] = useState(ALL);
  const [to, setTo] = useState('');
  const [thread, setThread] = useState(NEW);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { tasks } = useTasks(core, project, true, sessions);
  const seatName = useMemo(() => seatNames(tasks), [tasks]);

  const nameOf = (id: string) => {
    if (id === PERSON) return t('room.you');
    const s = byId.get(id);
    const name = clean(s ? sessionName(s) : (seatName.get(id) ?? names[id] ?? '')).trim() || id.slice(0, 6); // names: a removed teammate's gone seat
    return YOU.has(name.toLowerCase()) || name.toLowerCase() === t('room.you').toLowerCase() ? `${name} (${id.slice(0, 4)})` : name;
  };
  // A line the core wrote (a worker's "done" it typed for the worker) is the app's, whoever it speaks for (look 1117 v3).
  const fromOf = (m: RoomMessage) => (m.created_by === 'person' ? t('room.you') : m.created_by === 'core' ? t('home.origin.core') : nameOf(m.from));
  const byAgent = (m: RoomMessage) => m.created_by === 'agent';
  // Home is no project: its empty room says whose room it is (look 1117 v3).
  const empty = team.home && project === team.home ? t('home.room.empty') : t('room.empty');
  const agentOf = (id: string) => (id === PERSON ? '' : (byId.get(id)?.kind ?? ''));
  // Home view: every line says who wrote it. A teammate's seat says what it is (the Home lead, a lead, an assistant); the
  // core's own lines say they are the app's.
  const originOf = (id: string) => {
    const mate = team.teammates.find((x) => x.id === byId.get(id)?.teammate);
    if (!mate) return '';
    return mate.lead ? t(mate.project ? 'home.origin.lead' : 'home.origin.homeLead') : mate.project ? '' : t('home.origin.assistant');
  };
  // Ticket 990: a sender's colour bar is its worktree row's tone in the tree; main, Home and the person are the quiet one.
  const toneOf = (id: string) => {
    const at = byId.get(id)?.cwd;
    const w = at ? wt?.list.find((l) => l.path === at) : undefined;
    if (!w) return 'idle';
    const inIt = sessions.filter((s) => s.cwd === w.path && s.state !== 'closed');
    return rowState({ path: w.path, name: '', sessions: inIt }, inIt, wt!.facts.get(w.path)).tone;
  };
  // A team line written by the core reads in the window's words, from what it is about (its body is English).
  const noteOf = (m: RoomMessage) => {
    const n = m.team;
    if (!n) return clean(m.body);
    const name = clean((n.what === 'told' && n.seat && byId.get(n.seat) ? nameOf(n.seat) : '') || n.name || n.branch || basename(n.worktree ?? ''));
    if (n.what === 'memory_masked') return clean(m.body); // ticket 1005: its count is in the body only (English)
    if (n.what === 'removed') return t(n.merged ? 'lead.note.removedMerged' : 'lead.note.removedKept', { name });
    // A goal the user sent from Home: where it came from, then the goal itself (the body after its fixed English head).
    if (n.what === 'goal') return `${t('lead.note.goal', { name })}: ${clean(m.body.slice(m.body.indexOf(': ') + 2))}`;
    return t(`lead.note.${n.what}` as const, { name });
  };
  // The narrow room is a chat: it opens at its newest line and stays there while the reader is at the end (seen in the
  // real app: it opened at the oldest line, and new lines arrived out of sight).
  // N29 (look 1117 v3): the wide room's thread log opens at its newest line too; CSS shows one of the two logs.
  const chat = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const atEnd = useRef(new Map<HTMLElement, boolean>());
  useEffect(() => {
    const els = [chat.current, log.current].filter((e): e is HTMLDivElement => !!e);
    const offs = els.map((el) => {
      const on = () => atEnd.current.set(el, el.scrollHeight - el.scrollTop - el.clientHeight < 40);
      el.addEventListener('scroll', on, { passive: true });
      return () => el.removeEventListener('scroll', on);
    });
    return () => offs.forEach((f) => f());
  }, []);
  useEffect(() => {
    for (const el of [chat.current, log.current]) if (el && atEnd.current.get(el) !== false) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  // A room drawn while hidden (the Team view's Room tab not yet chosen, or after a relaunch) has no height to scroll:
  // once it shows, it opens at its newest line too (look 1117 home S3).
  useEffect(() => {
    const el = chat.current;
    if (!el) return;
    const ro = new ResizeObserver(() => atEnd.current.get(el) !== false && (el.scrollTop = el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Ticket 1089: a line not written today shows its day in the narrow room too ("Yesterday 09:12").
  const timeOf = (m: RoomMessage) => stamp(t, m.ts);
  // The narrow room's second meta line: the role and agent words a name does not already say, and a typed line's addressee.
  const rolesOf = (m: RoomMessage) => (byAgent(m) ? [originOf(m.from), agentOf(m.from)].filter((w) => w && w.toLowerCase() !== fromOf(m).toLowerCase()) : []);
  const toOf = (m: RoomMessage) => (m.kind === 'typed' ? `→ ${nameOf(m.to)}` : '');
  const hasTo = (m: RoomMessage) => rolesOf(m).length > 0 || !!toOf(m);
  // Ticket 1089: beside the written time, when the line reached its seat ("delivered 14:07") or that it still waits there.
  const reachedOf = (m: RoomMessage) => {
    const r = reachedText(t, delivery[m.id], m.ts);
    return r && <span className="room-meta room-reached" data-reached={r.waiting ? 'waiting' : 'delivered'}>{r.text}</span>;
  };
  // Threads in the order of their first message; each with its messages.
  const threads = useMemo(() => {
    const by = new Map<string, RoomMessage[]>();
    for (const m of messages) by.set(m.thread, [...(by.get(m.thread) ?? []), m]);
    return [...by];
  }, [messages]);
  // A thread needs the person while an ask, a timeout (an ask nobody answered in time) or a round-limit note to them has no message from them after it, whatever else lands in the thread.
  // An ask whose seat ended (a later `lost` event naming it) needs nothing: no answer can reach that seat. Nor does a timed-out ask once the seat it went to answers late.
  const needs = (list: RoomMessage[]) =>
    list.some((m, i) => {
      if (m.to !== PERSON || !(m.kind === 'ask' || m.kind === 'cap' || m.kind === 'timeout')) return false;
      const askedSeat = m.kind === 'timeout' ? list.find((a) => a.id === m.reply_to)?.to : undefined;
      return !list.slice(i + 1).some((x) => x.created_by === 'person' || (x.kind === 'lost' && x.reply_to === m.id) || (!!askedSeat && x.from === askedSeat && (x.kind === 'reply' || x.kind === 'message')));
    });
  const shown = threads.filter(([name, list]) => filter === ALL || (filter === MINE ? list.some((m) => m.to === PERSON || m.created_by === 'person') : filter === name));
  const target = to && seats.some((s) => s.id === to) ? to : (lead?.id ?? '');

  const send = async () => {
    const body = text.trim();
    if (!body || !target || sending) return;
    setSending(true);
    setNote('');
    try {
      await core.request({ op: 'room_send', project, to: target, body, ...(thread === NEW || !threads.some(([n]) => n === thread) ? {} : { thread }) });
      setText((cur) => (cur.trim() === body ? '' : cur)); // Q9 es-J20-1: a next line typed while this one was sending stays
      await refresh();
    } catch (e) {
      setNote(t('room.notSent', { error: notePlain(t, e) }));
    } finally {
      setSending(false);
    }
  };

  // Ticket 594: a seat ended with an ask open. Until the person writes in the thread, a card gives one next action: answer the
  // seat still waiting in its place, or, when that is the person, open the ended seat's tab (its Restart starts it again).
  const lostCard = (m: RoomMessage, list: RoomMessage[]) => {
    if (list.slice(list.indexOf(m) + 1).some((x) => x.created_by === 'person')) return null;
    const waiting = seats.some((s) => s.id === m.to);
    const ended = rows.get(m.from); // the ended row itself: a resumed one is gone
    return (
      <div className="room-lost" data-lost={m.id} role="note">
        <span>{t('room.lostCard', { name: nameOf(m.from) })}</span>
        {waiting ? (
          <button
            onClick={() => {
              setThread(m.thread);
              setTo(m.to);
              input.current?.focus();
            }}
          >
            {t('room.lostAnswer', { name: nameOf(m.to) })}
          </button>
        ) : ended ? (
          // Ticket 640: a resume keeps the parent (and the room); a fresh start has no parent, so it runs without its lead.
          <button onClick={() => open(ended.id)}>
            {t(ended.parent && restartRequest(ended).resume === null ? 'room.lostRestartFresh' : 'room.lostRestart', { name: nameOf(ended.id) })}
          </button>
        ) : (
          // Ticket 772: the ended seat's record is gone (its tab was closed), so nothing can start it again; the person
          // writes in the thread to a live seat instead. Ticket 830: with no live seat, a new session in the project is one.
          target ? (
            <button
              onClick={() => {
                setThread(m.thread);
                setTo(target);
                input.current?.focus();
              }}
            >
              {t('room.lostWrite', { name: nameOf(target) })}
            </button>
          ) : (
            <button onClick={() => askNew(project)}>{t('a11y.room.lostNew')}</button>
          )
        )}
      </div>
    );
  };
  const pinned = pins.map((id) => messages.find((m) => m.id === id)).filter((m): m is RoomMessage => !!m);
  return (
    <section className="room" aria-label={t('room.label')}>
      <div className="room-main">
        {/* A message sent with no thread name is its own thread, named by its id (m3, m4, …): it gets no chip (22 of them in a real run); All shows it. */}
        <div className="room-filters" role="group" aria-label={t('room.filters')}>
          {[[ALL, t('room.filterAll')], ...threads.filter(([n]) => !/^m\d+$/.test(n)).map(([n]) => [n, clean(n)]), [MINE, t('room.filterMine')]].map(([k, label]) => (
            <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="room-log" ref={log}>
          {messages.length === 0 && <p className="room-empty">{empty}</p>}
          {shown.map(([name, list]) => (
            <div className="room-thread" key={name} data-thread={name}>
              <div className="room-thead">
                {/* A thread named only by its message id (m3) shows who wrote in it, not the id (real-app look 11-17). */}
                {!/^m\d+$/.test(name) && <b>{clean(name)}</b>}
                <span>{[...new Set(list.map(fromOf))].join(', ')}</span>
                <span className="sp" />
                {needs(list) && <span className="room-state">{t('room.needs')}</span>}
              </div>
              {list.map((m) => m.kind === 'team' ? (
                <p className="room-tnote" key={m.id} data-msg={m.id} data-team={m.team?.what}>
                  <span className="room-meta" data-origin="core">{t('home.origin.core')} · </span>
                  {noteOf(m)}
                </p>
              ) : (
                <div className="room-msg" key={m.id} data-msg={m.id} data-created-by={m.created_by} data-from={m.from === PERSON ? 'person' : 'agent'}>
                  <span className="room-who" data-you={m.created_by === 'person' ? '' : undefined}>
                    {fromOf(m)}
                    {byAgent(m) && originOf(m.from) && <span className="room-meta" data-origin> · {originOf(m.from)}</span>}
                    {byAgent(m) && agentOf(m.from) && <span className="room-meta"> ({agentOf(m.from)})</span>}
                  </span>
                  <span className="room-meta">→ {nameOf(m.to)}</span>
                  <time className="room-meta" title={new Date(m.ts).toLocaleString(document.documentElement.lang || undefined)}>{stamp(t, m.ts)}</time>
                  {reachedOf(m) ?? <span className="room-reached" /> /* keeps the pin in the last column */}
                  <button className="room-pin" aria-pressed={pins.includes(m.id)} aria-label={`${pins.includes(m.id) ? t('room.unpin') : t('room.pin')} ${m.id}`} onClick={() => void toggle(m.id).catch((e) => setNote(t('room.notPinned', { error: notePlain(t, e) })))}>
                    {pins.includes(m.id) ? t('room.unpin') : t('room.pin')}
                  </button>
                  <div className="room-text">
                    <span className="room-kind" data-kind={m.kind}>
                      {t(`room.kind.${m.kind}` as const)}
                    </span>
                    <blockquote>{clean(m.body)}</blockquote>
                  </div>
                  {m.kind === 'lost' && lostCard(m, list)}
                </div>
              ))}
            </div>
          ))}
        </div>
        {/* Ticket 990: the narrow room (a pane beside the leader) reads as a chat in time order; CSS shows one of the two logs. */}
        <div className="room-chat" role="log" aria-label={t('room.label')} ref={chat}>
          {messages.length === 0 && <p className="room-chatempty">{empty}</p>}
          {messages.map((m) =>
            m.kind === 'team' ? (
              <p className="room-tnote" key={m.id} data-msg={m.id} data-team={m.team?.what}>
                <span className="room-meta" data-origin="core">{t('home.origin.core')} · </span>
                {noteOf(m)} <time>{timeOf(m)}</time>
              </p>
            ) : (
              <div className="room-line" key={m.id} data-msg={m.id} data-you={m.created_by === 'person' ? '' : undefined}>
                <i className="room-rail" data-tone={m.created_by === 'person' ? 'idle' : toneOf(m.from)} aria-hidden />
                <div>
                  <div className="room-line-head">
                    <b data-origin={m.created_by === 'core' ? 'core' : undefined}>{fromOf(m)}</b>
                    <time className="room-meta">{timeOf(m)}</time>
                    {!hasTo(m) && reachedOf(m)}
                    {/* A thread the core named by an id (a worker's question: q-<uuid>) is no name to read. */}
                    {m.thread !== m.id && !/^q-[0-9a-f-]{20,}$/.test(m.thread) && <span className="room-ttag">{clean(m.thread)}</span>}
                  </div>
                  {/* Look 1117 v12/v13 B N12-S3-3: one head line cut every word at once ("Lead L. c.. -> Builder . ..."). The role
                      and agent words and the addressee (a line typed into another seat's terminal: a lead's prompt to one worker)
                      have a line of their own, cut only at its end; a role the name already says is not repeated ("Lead Lead"). */}
                  {/* Ticket 1089: the delivery word sits at the end of this line, kept whole while the role words give way, then the addressee (in the head
                      it cut the time off: "delivered"). A line without this line has it in the head. */}
                  {hasTo(m) && (
                    <div className="room-meta room-line-to">
                      {rolesOf(m).length > 0 && <span className="room-line-roles">{rolesOf(m).join(' ')}</span>}
                      {toOf(m) && <span className="room-line-addr">{toOf(m)}</span>}
                      {reachedOf(m)}
                    </div>
                  )}
                  {/* A long line (a lead's prompt with its paths) is cut to six lines here; the wide Room tab has it whole. */}
                  <blockquote title={m.body.length > 300 ? clean(m.body) : undefined}>{clean(m.body)}</blockquote>
                </div>
              </div>
            ),
          )}
        </div>
        <div className="room-composer">
          <select aria-label={t('room.to')} value={target} onChange={(e) => setTo(e.target.value)} disabled={!seats.length}>
            {lead ? <option value={lead.id}>{t('room.lead', { name: nameOf(lead.id) })}</option> : <option value="">{t('room.noLeadShort')}</option>}
            {ordered.filter((s) => s.id !== lead?.id).map((s) => (
              <option key={s.id} value={s.id}>
                @{nameOf(s.id)}
              </option>
            ))}
          </select>
          <select aria-label={t('room.thread')} value={thread} onChange={(e) => setThread(e.target.value)}>
            {threads.map(([n]) => (
              <option key={n} value={n}>
                {t('room.thread')}: {clean(n)}
              </option>
            ))}
            <option value={NEW}>{t('room.threadNew')}</option>
          </select>
          <input
            {...PLAIN}
            ref={input}
            aria-label={t('room.input')}
            placeholder={lead ? t('home.room.to', { name: nameOf(lead.id) }) : t(team.home && project === team.home ? 'home.room.noLead' : leadMate ? 'room.leadAway' : 'room.noLead')} // look 1117 v5 H-3: Home is no project, and its sentence stays Home's when its assistant is away (v11-A-S3-11 is a project's)
            title={lead ? t('room.placeholder') : undefined}
            value={text}
            disabled={!target}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && void send()}
          />
          <button onClick={() => void send()} disabled={!target || !text.trim() || sending}>
            {t('room.send')}
          </button>
        </div>
        {note && (
          <p className="room-note" role="alert">
            {note}
          </p>
        )}
      </div>
      <aside className="room-side">
        <h3>{t('room.seats')}</h3>
        {[...ordered, ...gone].map((s) => {
          const mine = threads.filter(([, list]) => list.some((m) => m.from === s.id || m.to === s.id)).map(([n]) => n);
          const last = [...messages].reverse().find((m) => m.from === s.id);
          // Q7 point 9: a seat that waits on you shows its open ask (the tree row's own words) in place of its last line.
          const st = rowState({ path: '', name: '', sessions: [s] }, [s], undefined, Date.now(), undefined, t);
          const ask = st.kind === 'ask' || st.kind === 'hand' ? st.tip[0] : '';
          return (
            <div className="room-seat" key={s.id} data-seat={s.id}>
              <div className="room-seat-top">
                <i className="st" data-s={status(s)} />
                <button className="room-seat-name" onClick={() => open(s.id)}>
                  {nameOf(s.id)}
                </button>
                {/* Look v9 B N-S3-6: a seat started at a level (a teammate's, a role's on a task) shows its bars and what
                    it runs, as its tree row does; any other session its agent. */}
                {isLevel(s.level) ? <LevelMark t={t} level={s.level} text={seatText(t, s)} short={pairShort(s.kind, s as Pair, s.acp_agent)} /> : <span className="room-meta">{s.kind}</span>}
                {role(s) && <span className="room-role">{t(`room.role.${role(s)!}` as const)}</span>}
              </div>
              <div className="room-meta">{t(`mw.status.${status(s)}`)}</div>
              {ask ? <div className="room-meta room-last room-ask">{clean(ask)}</div> : last && <div className="room-meta room-last">{t('room.seatLast', { text: [...clean(last.body)].length > 80 ? `${[...clean(last.body)].slice(0, 80).join('')}…` : clean(last.body) })}</div>}
              <div className="room-meta">{mine.length ? t('room.seatThreads', { list: mine.map(clean).join(', ') }) : t('room.seatNoThreads')}</div>
            </div>
          );
        })}
        <h3>{t('room.pins')}</h3>
        {pinned.length ? (
          pinned.sort((a, b) => num(a) - num(b)).map((m) => (
            <blockquote className="room-pinned" key={m.id} data-pinned={m.id}>
              {clean(m.body)}
              <span className="room-meta"> {fromOf(m)} · {clean(m.thread)}</span>
            </blockquote>
          ))
        ) : (
          <p className="room-meta">{t('room.pinsNone')}</p>
        )}
        {dropped > 0 && (
          <p className="room-meta" data-pins-dropped role="status">
            {t('room.pinsDropped', { n: dropped })}
          </p>
        )}
        <p className="room-meta">{t('room.pinsNote')}</p>
      </aside>
    </section>
  );
}
