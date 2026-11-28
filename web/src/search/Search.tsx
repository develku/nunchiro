// Search (⌕ sidebar and the `search` widget, ticket 10): the core's `files_search` over one session's folder or
// worktree, a literal case-sensitive substring that honours `.gitignore`. A hit opens V1B-09's viewer at the line.
// It runs on Enter or after 300 ms without typing, never mid-composition; one request is in flight per panel and the
// newest query wins, so a late reply (older query, earlier session) never replaces newer results.
// V2-7: scope chips switch to the Sessions scope (Sessions.tsx); both stay mounted. Ticket 493: the words typed in one
// scope go with the switch to the other, and a Files "No matches" offers the Sessions search for them.
import { PLAIN } from '../plainText';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import { baseName, openFileAt } from '../files/open';
import type { Session } from '../types';
import { SessionSearch } from './Sessions';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import './search.css';
import { lineError, rawError } from '../errors';
import { defineSetting, useFeatureSetting } from '../settings/useFeatureSetting';

/** The scope used last: Search opens on it. */
const SCOPE = defineSetting<'files' | 'sessions'>('search.scope', 'files', (v) => (v === 'files' || v === 'sessions' ? v : undefined));

const PAUSE_MS = 300;
const MAX_BYTES = 256;

interface Match {
  path: string;
  line: number;
  text: string;
}
type Shown = { id: string; cwd: string } | null;
type Found = { matches: Match[]; truncated: boolean; skipped_ignore_files?: string[] };
type Result = Found | { error: string; plain?: string } | { over: true } | null;
type Ask = { root: string; query: string };

const bytes = (s: string) => new TextEncoder().encode(s).length;
const same = (a: Ask | null, b: Ask | null) => !!a && !!b && a.root === b.root && a.query === b.query;

/** One file's hits in the order the core sent them. */
function groups(matches: Match[]) {
  const out = new Map<string, Match[]>();
  for (const m of matches) out.set(m.path, [...(out.get(m.path) ?? []), m]);
  return [...out];
}

/** The line as text nodes with the query in <mark>; a long line starts shortly before the first match. */
function Line({ text, query }: { text: string; query: string }) {
  const first = text.indexOf(query);
  const from = first > 40 ? first - 20 : 0;
  const parts = text.slice(from).split(query);
  return (
    <span className="stx">
      {from > 0 && '…'}
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && <mark>{query}</mark>}
        </span>
      ))}
    </span>
  );
}

export function Search({
  core,
  connected,
  session,
  autoFocus,
  action,
  sessions = [],
  onOpenSession,
  sessionsAsk,
}: {
  core: CoreClient;
  connected: boolean;
  session: Shown;
  autoFocus?: number;
  action?: ReactNode;
  sessions?: Session[];
  onOpenSession?: (id: string) => void;
  /** v2-7: the palette's "Search sessions": each new value shows the Sessions scope with its field focused. */
  sessionsAsk?: { n: number; only?: string };
}) {
  const t = useHtmlLangT(); // ticket 492: the panel gets no catalogue from its zone
  const root = session?.id ?? null;
  const [scope, setScope] = useFeatureSetting(SCOPE); // v2-7
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<{ ask: Ask; result: Result } | null>(null);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  // Ticket 493: the words handed to the Sessions scope on a switch (n counts the hand-overs) and its words now.
  const [seed, setSeed] = useState({ text: '', n: 0 });
  const sessionsText = useRef('');
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The query to show, and whether a request is out: a reply that is not for `want` is dropped and `want` sent.
  const want = useRef<Ask | null>(null);
  const flight = useRef(false);
  const rootRef = useRef(root);
  rootRef.current = root;

  const send = () => {
    const ask = want.current;
    if (!ask || flight.current) return;
    flight.current = true;
    setBusy(true);
    const done = (result: Result) => {
      flight.current = false;
      setBusy(false);
      if (!same(ask, want.current)) return send();
      setShown({ ask, result });
      setAt(0);
    };
    core.request({ op: 'files_search', root: ask.root, query: ask.query, path: '' }).then(
      // A reply without a match list (a newer or broken core) is an error, never an empty list.
      (r) => done(Array.isArray((r as { matches?: unknown }).matches) ? (r as Found) : { error: 'unexpected search reply', plain: t('leftovers.search.badReply') }),
      (e) => done({ error: rawError(e) }),
    );
  };

  const run = (q = input.current?.value ?? query) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const r = rootRef.current;
    if (!r) return;
    if (!q.trim()) {
      want.current = null;
      setBusy(false);
      return setShown(null);
    }
    if (bytes(q) > MAX_BYTES) {
      want.current = null;
      setBusy(false);
      return setShown({ ask: { root: r, query: q }, result: { over: true } });
    }
    want.current = { root: r, query: q };
    setBusy(true); // also while it waits behind a reply still out
    send();
  };
  const later = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => !composing.current && run(), PAUSE_MS);
  };

  // A new focused session: its results only. The current query runs again against it.
  useEffect(() => {
    setShown(null);
    want.current = null;
    if (root && connected) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, connected]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (autoFocus && scope === 'files') input.current?.focus();
  }, [autoFocus, scope]);

  const result = shown && shown.ask.root === root ? shown.result : null;
  const matches = result && 'matches' in result ? result.matches : [];
  const files = groups(matches);
  const flat = files.flatMap(([, ms]) => ms);
  const focusHit = (i: number) => {
    const n = Math.max(0, Math.min(flat.length - 1, i));
    setAt(n);
    list.current?.querySelector<HTMLElement>(`[data-index="${n}"]`)?.focus();
  };
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter that commits a Hangul syllable is the IME's.
    if (e.nativeEvent.isComposing || composing.current) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      run(e.currentTarget.value);
    } else if (e.key === 'ArrowDown' && flat.length) {
      e.preventDefault();
      focusHit(at);
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusHit(at + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusHit(e.key === 'Home' ? 0 : flat.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const m = flat[at];
      if (m && root) openFileAt(root, m.path, m.line);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.current?.focus();
    }
  };

  const name = session ? baseName(session.cwd.replace(/\/+$/, '')) : '';
  const q = shown?.ask.query ?? '';
  // The status line; an error result shows as an alert instead.
  const statusLine = () => {
    if (!session) return t('mw.search.focus');
    if (!connected) return t('mw.disconnected');
    if (busy || !result) return busy ? t('mw.searching') : '';
    if ('over' in result) return t('mw.over', { n: MAX_BYTES });
    if (!('matches' in result)) return '';
    // The core also stops at its 2 s deadline, possibly before the first match.
    if (result.truncated) return matches.length ? t('mw.search.first', { n: matches.length }) : t('mw.search.stopped');
    if (!matches.length) return t('mw.search.none');
    const count = (k: 'match' | 'file', n: number) => t(n === 1 ? `mw.search.${k}.one` : `mw.search.${k}.other`, { n });
    return t('mw.search.matchesIn', { matches: count('match', matches.length), files: count('file', files.length) });
  };
  const line = statusLine();
  // Ticket 493: words from a conversation are not in the folder; say where they are.
  const none = !busy && !!result && 'matches' in result && !result.truncated && !matches.length;
  const skipped = result && 'matches' in result ? (result.skipped_ignore_files ?? []) : [];
  let index = 0;
  // v2-7: Files | Sessions, under each scope's own field (draft 06 A).
  const pick = (to: 'files' | 'sessions') => {
    // Ticket 493: the words go with the switch; an empty field does not wipe the other scope's.
    if (to === 'sessions' && scope === 'files' && query.trim()) setSeed((v) => ({ text: query, n: v.n + 1 }));
    const back = sessionsText.current;
    if (to === 'files' && scope === 'sessions' && back.trim() && back !== query) {
      setQuery(back);
      run(back);
    }
    setScope(to);
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`#${CSS.escape(listId)}-${to} input[type="search"]`)?.focus());
  };
  useEffect(() => {
    if (sessionsAsk?.n) pick('sessions');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsAsk?.n]);
  const chips = (
    <div className="sscopes" role="radiogroup" aria-label={t('mw.search.scope')}>
      {(['files', 'sessions'] as const).map((k) => (
        <button key={k} role="radio" aria-checked={scope === k} tabIndex={scope === k ? 0 : -1} onClick={() => pick(k)} onKeyDown={(e) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.preventDefault(), pick(k === 'files' ? 'sessions' : 'files'))}>
          {t(k === 'files' ? 'mw.search.files' : 'mw.search.sessions')}
        </button>
      ))}
    </div>
  );

  return (
    <aside className="spanel" aria-label={t('mw.search.title')}>
      <div className="ph">
        {t('mw.search.title')}
        <span className="r" title={scope === 'files' ? session?.cwd : undefined}>
          {scope === 'files' ? name : ''}
        </span>
        {action}
      </div>
      <div className="sscope" id={`${listId}-files`} hidden={scope !== 'files'}>
      <div className="sfield">
        <input {...PLAIN}
          ref={input}
          type="search"
          aria-label={session ? t('mw.search.in', { name }) : t('mw.search.title')}
          aria-controls={listId}
          placeholder={t('mw.search.placeholder')}
          disabled={!session}
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
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
      {chips}
      {result && 'error' in result ? (
        // Ticket 480: an OS or connection failure (a removed folder) reads plainly, its raw words the tooltip. Ticket 551:
        // the core's own sentences ("search busy", files/search.rs:63) are in the catalogue too.
        <div className="sstat" role="alert" title={result.plain ? undefined : result.error}>
          {result.plain ?? lineError(t, result.error)}
        </div>
      ) : (
        <div className="sstat" role="status" title={line}>
          {line}
        </div>
      )}
      {none && (
        <div className="sempty">
          <p>{t('search.files.noneHint')}</p>
          <div className="sacts">
            <button className="btn" onClick={() => pick('sessions')}>
              {t('search.files.trySessions')}
            </button>
          </div>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="snote" role="note" title={skipped.join('\n')}>
          {t('mw.search.gitignore', { names: skipped.join(', ') })}
        </div>
      )}
      <div className="hits" ref={list} role="listbox" id={listId} aria-label={t('mw.search.matches')} onKeyDown={onListKey}>
        {files.map(([path, ms]) => {
          const slash = path.lastIndexOf('/');
          return (
            <div key={path} role="group" aria-label={path}>
              <div className="sfile" data-path={path} data-tip={path} data-tip-clip="" aria-hidden>
                <span className="n">{path.slice(slash + 1)}</span>
                {slash > 0 && <span className="d">{path.slice(0, slash)}</span>}
              </div>
              {ms.map((m) => {
                const i = index++;
                return (
                  <div
                    key={m.line}
                    data-index={i}
                    data-path={m.path}
                    data-line={m.line}
                    className="hit"
                    role="option"
                    data-menu="search" // V2-6a
                    data-menu-arg={m.path}
                    aria-selected={i === at}
                    aria-label={t('mw.search.lineLabel', { path: m.path, line: m.line, text: m.text })}
                    // Roving focus; -2 rather than -1 so hints still reach every row (see FilesTree).
                    tabIndex={i === at ? 0 : -2}
                    data-tip={m.text.trim()}
                    data-tip-clip=""
                    onClick={() => (setAt(i), root && openFileAt(root, m.path, m.line))}
                  >
                    <span className="sln">{m.line}</span>
                    <Line text={m.text} query={q} />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      </div>
      <div className="sscope" id={`${listId}-sessions`} hidden={scope !== 'sessions'}>
        <SessionSearch
          core={core}
          connected={connected}
          sessions={sessions}
          scope={chips}
          shown={scope === 'sessions'}
          autoFocus={autoFocus}
          onOpen={(id) => onOpenSession?.(id)}
          onFiles={() => pick('files')}
          seed={seed}
          ask={sessionsAsk}
          onText={(q) => void (sessionsText.current = q)}
        />
      </div>
    </aside>
  );
}
