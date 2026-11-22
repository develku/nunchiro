// V2-7 Sessions scope of Search (draft 06 A): the core's `sessions_search` over the chat events of the sessions
// Nunchiro started, filtered here by project, agent, date and state. No index: the window sends the session ids in
// order and the core answers a page at a time (one session with results, or 250 ms of scanning), so results stream in
// with the scan's progress. One page is in flight per panel; a newer query drops older replies and the core cancels
// the older scan (`channel`). A hit opens that session's chat at once and asks the core for its event's chat cursor
// (`sessions_hit`, which builds the chat cache as opening the chat does), then scrolls there; a closed session opens
// read-only with Resume.
import { PLAIN } from '../plainText';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import { baseName } from '../files/open';
import { sessionName } from '../Sidebar';
import { Icon } from '../icons/Icon';
import type { Session } from '../types';
import { jumpTo } from './jump';
import { lineError, rawError, tipError } from '../errors';
import type { Key, T } from '../i18n';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';

const PAUSE_MS = 300;
const MAX_BYTES = 256;
const DAY_MS = 86_400_000;
/** The project pill's value for one chat (Q7 point 15). */
const ONE = 'session:';

interface Hit {
  /** Its place among the session's matching events, resolved to a chat cursor when opened. */
  n: number;
  kind: string;
  role?: string;
  text: string;
}
interface Found {
  session: string;
  status: 'ok' | 'missing' | 'untested' | 'error';
  error?: string;
  hits: Hit[];
  more: boolean;
}
interface Run {
  seq: number;
  query: string;
  total: number;
  scanned: number;
  found: Found[];
  done: boolean;
  days: number;
  error?: string;
  plain?: string; // an error that is already the window's own words (not the core's)
  over?: boolean;
}

// The core's rule: a query of only quotes, backslashes and control characters has nothing to prefilter the transcripts by.
const hasPlain = (s: string) => /[^"\\\p{Cc}]/u.test(s);
const bytes = (s: string) => new TextEncoder().encode(s).length;
// ASCII-only folding, as the core matches: every index in the folded text is an index in the original.
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const count = (t: T, k: 'hit' | 'session', n: number, more = false) => (more ? t('mw.ss.hitMore', { n }) : t(n === 1 ? `mw.ss.${k}.one` : `mw.ss.${k}.other`, { n }));
const WHO: Record<string, string> = { tool_use: 'tool', tool_result: 'output', task_result: 'task', thinking: 'thinks', edit: 'edit', final_text: 'agent', artifact: 'file' };
const who = (t: T, h: Hit) => {
  const w = h.role === 'user' ? 'you' : h.role === 'assistant' ? 'agent' : WHO[h.kind];
  return w ? t(`mw.ss.who.${w}` as Key) : h.kind;
};
const NOTE: Record<string, Key> = { missing: 'mw.ss.missing', untested: 'mw.ss.untested' };

/** The snippet as text nodes with every match in <mark>. */
function Marked({ text, query }: { text: string; query: string }) {
  const hay = fold(text);
  const q = fold(query);
  const out: ReactNode[] = [];
  let at = 0;
  for (let i = hay.indexOf(q); q && i >= 0; i = hay.indexOf(q, i + q.length)) {
    out.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  out.push(text.slice(at));
  return <span className="stx">{out}</span>;
}

function age(t: T, s: Session) {
  if (s.state === 'running') return t('mw.ss.running');
  const days = s.attention.last_activity ? Math.floor((Date.now() - s.attention.last_activity) / DAY_MS) : null;
  return days === null ? t('mw.ss.closed') : days < 1 ? t('mw.ss.closedToday') : t('mw.ss.closedDays', { n: days });
}

export function SessionSearch({
  core,
  connected,
  sessions,
  scope,
  shown,
  autoFocus,
  onOpen,
  onFiles,
  seed,
  ask,
  onText,
}: {
  core: CoreClient;
  connected: boolean;
  sessions: Session[];
  scope: ReactNode;
  shown: boolean;
  autoFocus?: number;
  onOpen: (id: string) => void;
  onFiles: () => void;
  /** Ticket 493: words handed over from the Files scope; each new `n` searches them here. */
  seed?: { text: string; n: number };
  /** Q7 point 15: the palette's ask; with `only`, the search covers that one chat (the project pill shows its name). */
  ask?: { n: number; only?: string };
  /** Ticket 493: this scope's words as they change, for the way back to Files. */
  onText?: (q: string) => void;
}) {
  const t = useHtmlLangT(); // ticket 492
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  const [agent, setAgent] = useState('');
  const [days, setDays] = useState(30);
  const [closed, setClosed] = useState(true);
  const [run, setRun] = useState<Run | null>(null);
  const [at, setAt] = useState(0);
  const [note, setNote] = useState('');
  const channel = useId();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const agents = useMemo(() => sessions.filter((s) => s.kind !== 'shell'), [sessions]);
  const projects = useMemo(() => [...new Set(agents.map((s) => s.project))].sort((a, b) => baseName(a).localeCompare(baseName(b))), [agents]);
  // Read at run time, so a filter change and the query both search with the latest of each.
  const now = useRef({ sessions: agents, project, agent, days, closed });
  now.current = { sessions: agents, project, agent, days, closed };

  const page = (n: number, q: string, rest: string[]) => {
    core.request({ op: 'sessions_search', query: q, sessions: rest, channel }).then(
      (reply) => {
        if (n !== seq.current) return;
        const r = reply as { scanned?: unknown; results?: unknown };
        // A reply without a page shape (a newer or broken core) is an error, never an empty result.
        if (typeof r.scanned !== 'number' || r.scanned < 1 || !Array.isArray(r.results))
          return setRun((x) => x && { ...x, done: true, error: 'unexpected search reply', plain: t('leftovers.search.badReply') });
        const scanned = Math.min(r.scanned, rest.length);
        const found = r.results as Found[];
        setRun((x) => x && (x.seq === n ? { ...x, scanned: x.scanned + scanned, found: [...x.found, ...found], done: scanned >= rest.length } : x));
        if (scanned < rest.length) page(n, q, rest.slice(scanned));
      },
      (e) => n === seq.current && setRun((x) => x && { ...x, done: true, error: rawError(e) }),
    );
  };

  const go = (q = input.current?.value ?? query) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const n = ++seq.current;
    setAt(0);
    const f = now.current;
    if (!q.trim()) return setRun(null);
    const base = { seq: n, query: q, total: 0, scanned: 0, found: [], days: f.days };
    if (bytes(q) > MAX_BYTES) return setRun({ ...base, done: true, over: true });
    if (!hasPlain(q)) return setRun({ ...base, done: true, error: 'no plain characters', plain: t('mw.ss.noPlain') });
    const since = f.days ? Date.now() - f.days * DAY_MS : 0;
    const ids = f.sessions
      .filter((s) => (f.project.startsWith(ONE) ? s.id === f.project.slice(ONE.length) : (!f.project || s.project === f.project) && (!f.agent || s.kind === f.agent) && (f.closed || s.state === 'running') && s.attention.last_activity >= since))
      .sort((a, b) => b.attention.last_activity - a.attention.last_activity)
      .slice(0, 10_000) // the core's limit per search
      .map((s) => s.id);
    setRun({ ...base, total: ids.length, done: !ids.length });
    if (ids.length) page(n, q, ids);
  };
  const later = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => !composing.current && go(), PAUSE_MS);
  };

  // Ticket 493: words handed over from Files replace this field's and search at once.
  useEffect(() => {
    if (!seed?.n) return;
    setQuery(seed.text);
    onText?.(seed.text);
    if (seed.text !== query || !run) go(seed.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.n]);
  // Q7 point 15: "Find in this chat" scopes to that chat; a plain "Search sessions" lifts the scope.
  useEffect(() => {
    if (!ask?.n) return;
    if (ask.only) setProject(ONE + ask.only);
    else setProject((p) => (p.startsWith(ONE) ? '' : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.n]);
  // A filter change searches again with the current text.
  useEffect(() => {
    if (input.current?.value.trim()) go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, agent, days, closed]);
  // Unmounted: drop a late reply (it would ask for the next page) and the pending pause.
  useEffect(
    () => () => {
      seq.current++;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (autoFocus && shown) input.current?.focus();
  }, [autoFocus, shown]);

  const found = run?.found ?? [];
  const flat = found.flatMap((f) => (f.status === 'ok' ? f.hits.map((h) => ({ session: f.session, hit: h })) : []));
  const groups = found.filter((f) => f.status !== 'ok' || f.hits.length);
  const more = found.some((f) => f.more);
  const hitSessions = found.filter((f) => f.status === 'ok' && f.hits.length).length;

  const open = (i: number) => {
    const h = flat[i];
    if (!h || !run) return;
    setAt(i);
    setNote('');
    onOpen(h.session);
    core.request({ op: 'sessions_hit', session: h.session, query: run.query, n: h.hit.n, text: h.hit.text }).then(
      (r) => {
        const cursor = (r as { cursor?: unknown }).cursor;
        if (typeof cursor === 'number') jumpTo(h.session, cursor);
        else setNote(t('mw.ss.eventGone'));
      },
      (e) => setNote(t('mw.ss.openedNotEvent', { error: tipError(t, e) })),
    );
  };
  const focusHit = (i: number) => {
    const n = Math.max(0, Math.min(flat.length - 1, i));
    setAt(n);
    list.current?.querySelector<HTMLElement>(`[data-index="${n}"]`)?.focus();
  };
  // The Enter that commits a Hangul syllable is the IME's (Safari reports keyCode 229 without isComposing).
  const ime = (e: KeyboardEvent) => e.nativeEvent.isComposing || composing.current || e.keyCode === 229;
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (ime(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      go(e.currentTarget.value);
    } else if (e.key === 'ArrowDown' && flat.length) {
      e.preventDefault();
      focusHit(at);
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    if (ime(e)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusHit(at + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusHit(e.key === 'Home' ? 0 : flat.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(at);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.current?.focus();
    }
  };

  const hitsLine = t('mw.ss.hitsIn', { hits: count(t, 'hit', flat.length, more), sessions: count(t, 'session', hitSessions) });
  const statusLine = () => {
    if (!connected) return t('mw.disconnected');
    if (!run) return '';
    if (run.over) return t('mw.over', { n: MAX_BYTES });
    if (!run.done) return t('mw.ss.scanned', { what: flat.length ? hitsLine : t('mw.searching'), n: run.scanned, total: run.total });
    return flat.length ? hitsLine : t('mw.ss.noHits', { query: run.query });
  };
  const line = statusLine();
  const empty = !!run?.done && !run.over && !run.error && !flat.length;
  const span = (d: number) => (d ? t('mw.ss.spanDays', { n: d }) : t('mw.ss.spanAny'));
  let index = 0;

  // Hidden behind the Files scope: nothing in the DOM (the Files panel stays as it was), state kept for the way back.
  if (!shown) return null;
  return (
    <>
      <div className="sfield">
        <input {...PLAIN}
          ref={input}
          type="search"
          aria-label={t('mw.ss.label')}
          aria-controls={listId}
          placeholder={t('mw.ss.placeholder')}
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onText?.(e.target.value);
            if (!composing.current && !(e.nativeEvent as InputEvent).isComposing) later();
          }}
          onCompositionStart={() => {
            composing.current = true;
            if (timer.current) clearTimeout(timer.current);
          }}
          onCompositionEnd={() => {
            composing.current = false;
            later();
          }}
          onKeyDown={onFieldKey}
        />
      </div>
      {scope}
      <div className="sfilt">
        <span className="spill">
          <select aria-label={t('mw.ss.project')} value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">{t('mw.ss.allProjects')}</option>
            {project.startsWith(ONE) && byId.has(project.slice(ONE.length)) && <option value={project}>{sessionName(byId.get(project.slice(ONE.length))!)}</option>}
            {projects.map((p) => (
              <option key={p} value={p}>
                {baseName(p)}
              </option>
            ))}
          </select>
          <Icon name="triangle-down" size={12} />
        </span>
        <span className="spill">
          <select aria-label={t('mw.ss.agent')} value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">{t('mw.ss.allAgents')}</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          <Icon name="triangle-down" size={12} />
        </span>
        <span className="spill">
          <select aria-label={t('mw.ss.date')} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>{t('mw.ss.last7')}</option>
            <option value={30}>{t('mw.ss.last30')}</option>
            <option value={0}>{t('mw.ss.anyDate')}</option>
          </select>
          <Icon name="triangle-down" size={12} />
        </span>
        <label className="sclosed">
          <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
          {t('mw.ss.closedToo')}
        </label>
      </div>
      {run?.error ? (
        <div className="sstat" role="alert" title={run.plain ? undefined : run.error}>
          {run.plain ?? lineError(t, run.error)}
        </div>
      ) : (
        <div className="sstat" role="status" aria-live="polite" title={line}>
          {line}
        </div>
      )}
      {note && (
        <div className="snote" role="note" title={note}>
          {note}
        </div>
      )}
      {empty && (
        <div className="sempty">
          <p>
            {t('mw.ss.searched', { sessions: count(t, 'session', run.total), span: span(run.days) })}
          </p>
          <p>{t('mw.ss.onlyNunchiro')}</p>
          <div className="sacts">
            {run.days > 0 && (
              <button className="btn" onClick={() => setDays(0)}>
                {t('mw.ss.allDates')}
              </button>
            )}
            <button className="btn" onClick={onFiles}>
              {t('mw.ss.filesInstead')}
            </button>
          </div>
        </div>
      )}
      <div className="hits sh" ref={list} role="listbox" id={listId} aria-label={t('mw.ss.hits')} onKeyDown={onListKey}>
        {groups.map((f) => {
          const s = byId.get(f.session);
          const name = s ? sessionName(s) : f.session.slice(0, 6);
          return (
            <div key={f.session} className="sgrp" data-session={f.session} role="group" aria-label={name}>
              <div className="sgh" aria-hidden>
                {s && <i className="sgd" data-state={s.state === 'running' ? 'running' : 'closed'} />}
                <span className="n">{name}</span>
                {s && (
                  <span className="k">
                    {s.kind} · {age(t, s)}
                  </span>
                )}
                {f.status === 'ok' && <span className="c">{f.hits.length + (f.more ? '+' : '')}</span>}
              </div>
              {s && (
                <div className="sgp" aria-hidden>
                  {baseName(s.project)}
                </div>
              )}
              {f.status !== 'ok' && <div className="sgnote">{NOTE[f.status] ? t(NOTE[f.status]) : t('mw.ss.notSearched', { error: f.error ? lineError(t, f.error) : t('mw.ss.error') })}</div>}
              {f.status === 'ok' &&
                f.hits.map((h) => {
                  const i = index++;
                  return (
                    <div
                      key={h.n}
                      data-index={i}
                      data-n={h.n}
                      className="hit"
                      role="option"
                      aria-selected={i === at}
                      aria-label={`${name}, ${who(t, h)}: ${h.text}`}
                      // Roving focus; -2 rather than -1 so hints still reach every row (see FilesTree).
                      tabIndex={i === at ? 0 : -2}
                      data-tip={h.text}
                      data-tip-clip=""
                      onClick={() => open(i)}
                    >
                      <span className="sln">{who(t, h)}</span>
                      <Marked text={h.text} query={run?.query ?? ''} />
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </>
  );
}
