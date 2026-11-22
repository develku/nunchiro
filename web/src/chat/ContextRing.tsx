// CHAT-USAGE: informational context fill, refreshed only for the visible active conversation.
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { CoreClient, SessionContext } from '../api';
import { status, type Session } from '../types';
import type { T } from '../i18n';

type Entry = { at: number; value: SessionContext | null; pending?: Promise<SessionContext> };
const caches = new WeakMap<CoreClient, Map<string, Entry>>();
const rounded = (n: number) => n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

// Ticket 994: the model a session's agent reported, for a level chip whose slot leaves the model to the agent
// ("Default · Opus 5.5"), and the effort it ran at (look v9 S2-6: "effort high", "Opus · high", not "effort default").
// Known once this session's context was read (it is the visible conversation's read); kept by id for the tree's rows.
const heard = new Set<() => void>();
const hear = (f: () => void) => (heard.add(f), () => void heard.delete(f));
const reported = new Map<string, SessionContext>();
export function useReported(id: string | undefined, part: 'model' | 'effort'): string {
  const get = () => {
    const value = id ? reported.get(id) : undefined;
    return value && value.type !== 'unknown' ? (value[part] ?? '') : '';
  };
  // The same getter as the server snapshot: a row rendered to a string (a11y-names) threw without one.
  return useSyncExternalStore(hear, get, get);
}

/** The context read for the visible active conversation; B15 (ticket 991): the composer's model chip reads its `model` too. */
export function useSessionContext(core: CoreClient, session: Session | null, active: boolean, connected: boolean): SessionContext | null {
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const [result, setResult] = useState<{ id: string; value: SessionContext | null } | null>(null);
  const current = useRef<{ core: CoreClient; id: string | undefined } | null>(null);
  const before = useRef<{ id: string | undefined; eligible: boolean; working: boolean } | null>(null);
  const id = session?.id;
  const local = !!session && !session.machine && (session.kind === 'claude' || session.kind === 'codex');
  const eligible = local && active && connected && visible;
  const activity = session ? status(session) : null;
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    current.current = { core, id };
    return () => { current.current = null; };
  }, [core, id]);
  useEffect(() => {
    const previous = before.current;
    const working = activity === 'working';
    before.current = { id, eligible, working };
    if (!id || !eligible) return;
    if (previous?.id === id && previous.eligible && !(previous.working && (activity === 'idle' || activity === 'waiting'))) return;
    let cache = caches.get(core);
    if (!cache) { cache = new Map(); caches.set(core, cache); }
    let entry = cache.get(id);
    setResult({ id, value: entry?.value ?? null });
    // B15 (ticket 991): a value still unknown is read again at a turn end inside the 30 s bound: a new session's first turn
    // writes the transcript that names its model, and a quick first turn left the model chip without it.
    const ended = previous?.id === id && previous.working && !working;
    if (!entry || (!entry.pending && (Date.now() - entry.at >= 30_000 || (ended && (entry.value ?? { type: 'unknown' }).type === 'unknown')))) {
      // Keep every recent session's timestamp so switching many tabs cannot bypass the 30-second bound.
      for (const [key, old] of cache) if (key !== id && !old.pending && Date.now() - old.at >= 30_000) cache.delete(key);
      entry = { at: Date.now(), value: entry?.value ?? null };
      cache.set(id, entry);
      const saved = entry;
      saved.pending = core.sessionContext(id).catch(() => ({ type: 'unknown' as const })).then((value) => {
        saved.value = value;
        saved.pending = undefined;
        // Codex look w16: newest last, at most 500 sessions kept (a long day of opened chats must not grow it forever).
        // v11-A-S3-5: a read that cannot tell (a core restarting, a dropped socket) keeps what the agent last reported.
        const known = value.type !== 'unknown' ? value : reported.get(id);
        reported.delete(id);
        if (known) reported.set(id, known);
        if (reported.size > 500) reported.delete(reported.keys().next().value!);
        heard.forEach((f) => f());
        return value;
      });
    }
    entry.pending?.then((value) => {
      if (current.current?.core === core && current.current.id === id) setResult({ id, value });
    });
  }, [core, id, eligible, activity]);
  return local && active && result && result.id === id ? result.value : null;
}

export function ContextRing({ value, t }: { value: SessionContext | null; t: T }) {
  if (value?.type !== 'session_context' || value.window <= 0 || value.used < 0 || value.used > value.window) return null;
  const label = t('chat.context', { used: rounded(value.used), window: rounded(value.window) });
  return <span className="context-ring" role="img" title={label} aria-label={label} style={{ '--context-fill': `${value.used / value.window * 100}%` } as CSSProperties} />;
}
