// OS notification per new queue item, with a per-session level (needs 16): all, waiting only, muted. The
// level filters notifications only, never the queue. Stored per window (localStorage), like the other window
// settings: it is a window preference, and the core and the agent CLI never read it.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Key, T } from '../i18n';
import { kindKey, type BoardDecision, type Decision, type Session } from '../types';
import { boardWho } from './board'; // v1b-18
import { emitQueueFocus } from '../decisions/useDecisionJump';
import { cue } from '../sound'; // v1a-38
import { notifyDefault, notifyFocused, onNotifyDefault } from '../settings'; // B4
import { isViewed } from './turns';
import { ALERT_MACHINES, alertsOn } from '../features/small-rows-values'; // ticket 270 G30
import { useFeatureSetting } from '../settings/useFeatureSetting';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';

export type Level = 'all' | 'waiting' | 'muted';
const KEY = 'nunchiro.notify.v1';
const LEVELS: Level[] = ['all', 'waiting', 'muted'];
const WAITING = new Set(['permission', 'question', 'dialog', 'board']); // v1b-18: a board decision waits on the user
/** v1b-18: the level key for board decisions (they have no session); never a session id. */
export const BOARD_LEVEL = '@board';

function load(): Record<string, Level> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, l]) => LEVELS.includes(l as Level))) as Record<string, Level>;
  } catch {
    return {};
  }
}

// Claude's permission header ("Bash command", "Read file") and Codex's run prompt. Only these fixed names can
// reach a notification, so no command, argument or question text ever does.
const TOOL = /^(Bash|Read|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|Glob|Grep|Task|Agent)(?: command| file)?$/;
function tool(d: Decision) {
  if (d.kind !== 'permission') return null;
  for (const line of d.text.split('\n')) {
    const l = line.replace(/[│╭╮╰╯─┌┐└┘]/g, '').trim();
    const m = TOOL.exec(l);
    if (m) return m[1];
    if (/^would you like to run the following command/i.test(l)) return 'shell';
  }
  return null;
}

/** Title and body: kind, session, project and tool only. Notifications reach the lock screen and the
 * Notification Center database, so the prompt's text (it can hold a token) never goes there. */
export function note(s: Session, d: Decision, t: T) {
  const name = s.label || s.kind;
  const project = s.project.replace(/\/+$/, '').split('/').pop() || s.project;
  const kind = t(kindKey[d.kind]);
  return { title: `${name} · ${kind}`, body: [kind, name, project, tool(d)].filter(Boolean).join(' · ') };
}

// v1b-18 (ruling 01:41): a board decision names its kind, source and project only, never the question.
export function boardNote(b: BoardDecision, t: T) {
  const project = b.project ? b.project.replace(/\/+$/, '').split('/').pop() || b.project : null;
  const word = t('a11y.note.board');
  return { title: `${word} · ${boardWho(b)}`, body: [word, boardWho(b), project].filter(Boolean).join(' · ') };
}

/** Needs 170 (2): a turn ended on a session the user is not looking at. The session name and the word only, never transcript text. */
export function finishedNote(s: Session, t: T) {
  const name = s.label || s.kind;
  return { title: t('a11y.note.finishedTitle', { name }), body: t('a11y.note.finished', { name }) };
}

/** Ticket 372: a session already seen turned failed. The name and the word only, never problem.cause (it quotes agent text). */
export function failedNote(s: Session, t: T) {
  const name = s.label || s.kind;
  return { title: t('a11y.note.failedTitle', { name }), body: t('a11y.note.failed', { name }) };
}

export const wants = (level: Level, d: Decision) => level === 'all' || (level === 'waiting' && WAITING.has(d.kind));

/** Ticket 316: no sound or notification for the session in front of the user, unless Settings says otherwise. */
export const quietFor = (id: string, active: string | null) => notifyFocused() && isViewed(id, active);

/** Ticket 316: `default` is not asked yet; `unknown` is no answer (a dev binary has no bundle, no Notification API). */
export type Permission = NotificationPermission | 'unknown';
export type TestResult = 'sent' | 'blocked' | 'failed' | 'unconfirmed';

const shell = async () => ('__TAURI_INTERNALS__' in window ? (await import('@tauri-apps/api/core')).invoke : null);

/** The system's answer. In the app the shell asks macOS: the notification plugin always says granted on desktop. */
export async function readPermission(): Promise<Permission> {
  const invoke = await shell();
  if (invoke) return invoke<Permission>('notification_permission').catch(() => 'unknown');
  return 'Notification' in window ? Notification.permission : 'unknown';
}

export async function askPermission(): Promise<Permission> {
  const invoke = await shell();
  if (invoke) return invoke<Permission>('ask_notification_permission').catch(() => 'unknown');
  return 'Notification' in window ? Notification.requestPermission().catch(() => Notification.permission) : 'unknown';
}

/** B4 (ticket 217): one notification through the same path as a real one. Ticket 316: says what happened. The shell's `notify`
 *  cannot report delivery, so only a real grant counts as sent (Orca's NotificationsPane reports outcomes too, MIT, Copyright (c) 2026 Lovecast Inc.; idea only). */
export async function sendTest(open: (id: string) => void): Promise<TestResult> {
  let p = await readPermission();
  if (p === 'default') p = await askPermission();
  if (p === 'denied') return 'blocked';
  if (!(await raise('', 'Nunchiro test', 'Notifications from Nunchiro reach you.', open, true))) return 'failed';
  return p === 'granted' ? 'sent' : 'unconfirmed';
}

// Ticket 372: ported from Orca src/shared/notification-burst-cooldown.ts (MIT, Copyright (c) 2026 Lovecast Inc.).
// One notification per session per 5 s: an agent's finish and its exit often land in the same snapshot.
export const NOTIFICATION_COOLDOWN_MS = 5000;
const MAX_RECENT_NOTIFICATION_KEYS = 50;
const recent = new Map<string, number>();

function pruneRecentNotifications(recentNotifications: Map<string, number>, now: number): void {
  if (recentNotifications.size <= MAX_RECENT_NOTIFICATION_KEYS) return;
  for (const [key, ts] of recentNotifications) if (now - ts >= NOTIFICATION_COOLDOWN_MS) recentNotifications.delete(key);
  while (recentNotifications.size > MAX_RECENT_NOTIFICATION_KEYS) {
    const oldest = recentNotifications.keys().next();
    if (oldest.done) break;
    recentNotifications.delete(oldest.value);
  }
}

export function reserveNotificationCooldown(recentNotifications: Map<string, number>, dedupeKey: string, now: number): boolean {
  const lastSentAt = recentNotifications.get(dedupeKey) ?? 0;
  if (now - lastSentAt < NOTIFICATION_COOLDOWN_MS) return false;
  recentNotifications.delete(dedupeKey);
  recentNotifications.set(dedupeKey, now);
  pruneRecentNotifications(recentNotifications, now);
  return true;
}
// end Orca port

/** False when nothing could be handed to the system. A repeat for the same session inside the cooldown is dropped
 *  (reported as handed over); the Settings test is an explicit, repeated action and bypasses it, as in Orca. */
async function raise(session: string, title: string, body: string, open: (id: string) => void, test = false): Promise<boolean> {
  if (!test && !reserveNotificationCooldown(recent, session, Date.now())) return true;
  const invoke = await shell();
  // The app shell shows it and, on click, focuses the window and sends `nunchiro:notify.click`.
  if (invoke) return invoke('notify', { session, title, body }).then(() => true, () => false);
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'default') await Notification.requestPermission().catch(() => {});
  if (Notification.permission !== 'granted') return false;
  const n = new Notification(title, { body });
  n.onclick = () => {
    window.focus();
    open(session);
  };
  return true;
}

/** v1b-18: focuses a board item's strip card, else its tree row (it has no session tab). */
const focusItem = (id: string) => emitQueueFocus({ id, session_id: '' });

/** Raises one notification per item first seen after the window opened; returns the levels and a setter. */
export function useNotifications(sessions: Session[], open: (id: string) => void, board: Decision[] = [], active: string | null = null) {
  const [stored, setLevels] = useState(load);
  const t = useHtmlLangT(); // ticket 740: the kind word in the window's language
  // B4: a session with no stored level takes the default from Settings > Notifications. App (held by another lane) reads
  // `levels[id] ?? 'all'` for the header chip, so the default is answered by the record itself: the chip shows it too.
  const fallback = useSyncExternalStore(onNotifyDefault, notifyDefault);
  const levels = useMemo(() => new Proxy(stored, { get: (l, k) => (typeof k !== 'string' ? Reflect.get(l, k) : Object.hasOwn(l, k) ? l[k] : fallback) }), [stored, fallback]);
  // Ticket 270 (G30): a machine switched off in Settings > Alerts raises no notification and no sound; the queue is untouched.
  const [machines] = useFeatureSetting(ALERT_MACHINES);
  const machineOn = useCallback((s: Session) => alertsOn(machines, s.machine), [machines]);
  const seen = useRef(new Set<string>());
  const opened = useRef(Date.now());
  const openRef = useRef(open);
  openRef.current = open;
  const activeRef = useRef(active); // read when an item arrives: changing tabs must not re-run the effect
  activeRef.current = active;

  useEffect(() => {
    for (const s of sessions)
      for (const d of s.pending) {
        if (seen.current.has(d.id)) continue;
        seen.current.add(d.id);
        // Items already waiting when the window opened are on screen, not new.
        if (d.observed_at < opened.current - 1000 || !wants(levels[s.id], d) || !machineOn(s) || quietFor(s.id, activeRef.current)) continue;
        const { title, body } = note(s, d, t);
        void raise(s.id, title, body, (id) => openRef.current(id));
        if (WAITING.has(d.kind)) cue('waiting'); // v1a-38
      }
  }, [sessions, levels, machineOn, t]);

  // v1b-18: board items have no session: they follow the board level; a click focuses the item's strip card.
  // Items seen in the window's first 1.5 s were already waiting when it opened: on screen, not new.
  useEffect(() => {
    for (const d of board) {
      if (seen.current.has(d.id)) continue;
      seen.current.add(d.id);
      if (d.observed_at < opened.current + 1500 || !d.board || !wants(levels[BOARD_LEVEL], d)) continue;
      const { title, body } = boardNote(d.board, t);
      // Ticket 197: the item id (`identity@updated_at`); the app shell's click sends it back as `item` (main.rs click_script).
      void raise(d.id, title, body, () => focusItem(d.id));
    }
  }, [board, levels, t]);

  // Ticket 197: a click that reopened the window waits, as a flag, for its item to arrive, for 10 s at most.
  useEffect(() => {
    const w = window as unknown as { __NUNCHIRO_FOCUS__?: { id: string; at: number } };
    const f = w.__NUNCHIRO_FOCUS__;
    if (!f) return;
    if (Date.now() - f.at > 10_000) return void delete w.__NUNCHIRO_FOCUS__;
    if (board.some((d) => d.id === f.id)) (delete w.__NUNCHIRO_FOCUS__, focusItem(f.id));
  }, [board]);

  useEffect(() => {
    const click = (e: Event) => {
      const { session, item } = (e as CustomEvent<{ session?: string; item?: string }>).detail;
      delete (window as unknown as { __NUNCHIRO_OPEN__?: string }).__NUNCHIRO_OPEN__;
      if (item) {
        delete (window as unknown as { __NUNCHIRO_FOCUS__?: unknown }).__NUNCHIRO_FOCUS__;
        return focusItem(item);
      }
      if (session) openRef.current(session);
    };
    window.addEventListener('nunchiro:notify.click', click);
    // A click that reopened the window arrives as a flag while the page was still loading.
    const w = window as unknown as { __NUNCHIRO_OPEN__?: string };
    if (w.__NUNCHIRO_OPEN__) openRef.current(w.__NUNCHIRO_OPEN__);
    delete w.__NUNCHIRO_OPEN__;
    return () => window.removeEventListener('nunchiro:notify.click', click);
  }, []);

  // Ticket 372 (T3's clear on focus, ThreadNotificationCoordinator.tsx:58-73): back in the window, Nunchiro's delivered
  // notifications leave Notification Center, unanswered ones too. The shell refuses outside a bundle; nothing to do then.
  useEffect(() => {
    const clear = () => void shell().then((invoke) => invoke?.('clear_notifications')).catch(() => {});
    window.addEventListener('focus', clear);
    return () => window.removeEventListener('focus', clear);
  }, []);

  // Ticket 270 (G30): the machine check for a turn end is useTurnCue's (the one caller), with the done sound.
  const finished = useCallback((s: Session) => {
    const { title, body } = finishedNote(s, t);
    void raise(s.id, title, body, (id) => openRef.current(id));
  }, [t]);

  // Ticket 372: the caller (useTurnCue) checks level, machine, view and side chat, with the waiting sound.
  const failed = useCallback((s: Session) => {
    const { title, body } = failedNote(s, t);
    void raise(s.id, title, body, (id) => openRef.current(id));
  }, [t]);

  const setLevel = useCallback((id: string, level: Level) => {
    setLevels((l) => {
      const next = { ...l, [id]: level };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage blocked: the level lasts for this window only.
      }
      return next;
    });
  }, []);
  return { levels, setLevel, finished, failed, machineOn };
}

/** Needs 130: a button and a menu like the composer's own chips, not a UA select (its native arrow and height
 *  looked foreign in the header). The three levels and their stored keys are the same. */
export function NotifyLevel({ session, label, level, onChange, t }: { session: string; label: string; level: Level; onChange: (id: string, l: Level) => void; t: T }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The menu pattern of menu/ContextMenu.tsx: focus goes in on open (on the current level), arrows move (wrapping), Esc closes and focus returns to the button.
  useEffect(() => void (open && (menu.current?.querySelector<HTMLElement>('[aria-current="true"]') ?? menu.current?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus()), [open]);
  const move = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => (e.preventDefault(), list[(i + list.length) % list.length]?.focus());
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.code === 'Escape' && !e.isComposing && (setOpen(false), button.current?.focus());
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span className="qlevel" ref={root}>
      {/* Ticket 1041 (the mockup's bell): the level's words are the tooltip and the name; muted crosses the bell out. */}
      <button ref={button} className="chip qlevel-btn" data-level={level} data-tip={open ? undefined : t(`chat.notify.${level}` as Key) /* no tip over its own open menu: Esc closes the menu */} aria-label={t('chat.notify.chip', { name: label, level: t(`chat.notify.${level}` as Key) })} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
          <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20.5h4" />
          {level === 'muted' && <path d="M4 4l16 16" />}
        </svg>
      </button>
      {open && (
        <div ref={menu} className="plusmenu qlevel-menu" role="menu" aria-label={t('chat.notify.label', { name: label })} onKeyDown={move}>
          {LEVELS.map((l) => (
            <button
              key={l}
              role="menuitem"
              aria-current={l === level}
              onClick={() => (setOpen(false), onChange(session, l))}
            >
              {t(`chat.notify.${l}` as Key)}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
