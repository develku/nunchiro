// Chat frames of the window WebSocket (crates/nunchiro-core/README.md, "Chat events", schema 1).
// shortcut: this is a second socket on the same /ws endpoint, token and Origin gate as CoreClient (api.ts is
// 07a's and has no hook for non-terminal events); fold it into CoreClient when that file gains an event hook.
import type { Boot } from '../api';
import { rawError } from '../errors';
import type { ArtifactData } from '../artifacts/host'; // v1b-06
import type { PrChipData } from './PrChip'; // v2-8b

export type Data =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string; note?: boolean }
  | { kind: 'image'; role: 'user' | 'assistant'; source: { type: string; media_type?: string; url?: string; path?: string } }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; tool_id: string; name: string; input: unknown }
  | { kind: 'tool_result'; tool_id: string; output: unknown; is_error: boolean; at?: string } // at: V2-8b
  | {
      kind: 'edit';
      tool_id: string;
      path: string;
      added: number;
      removed: number | null;
      hunks: unknown[];
      operation?: 'delete' | 'move';
      destination?: string;
    }
  | { kind: 'task_result'; tool_id: string; text: string }
  | { kind: 'turn'; turn_id: string | null; state: 'started' | 'completed' | 'interrupted' }
  | { kind: 'skipped'; count: number }
  | { kind: 'version_banner'; agent: string; version: string }
  | { kind: 'final_text'; turn_id: string; text: string }
  | { kind: 'shell'; command?: string; output?: string } // ticket 1087: a "!" command the person ran (core chat/mod.rs shell_command)
  | ArtifactData; // v1b-06

export interface ChatEvent {
  schema_version: number;
  cursor: number;
  data: Data;
}

export interface Page {
  schema_version: number;
  generation: number;
  events: ChatEvent[];
  before: number | null;
  end: number;
  banner: ChatEvent | null;
  skipped: number;
  /** Ticket 212 (A5): why the core found no transcript to read (chat/service.rs); absent while one is read. */
  no_transcript?: string;
}

/** `open`: reply to a subscribe (also after a reconnect); `reset`: the core started a new generation. */
export type PageKind = 'open' | 'live' | 'reset';
export interface Listener {
  page: (p: Page, kind: PageKind) => void;
  error: (message: string) => void;
}

type Pending = { resolve: (p: never) => void; reject: (e: Error) => void };
/** One socket and what the core holds for it: requests in flight and the sessions it watches. */
interface Conn {
  ws: WebSocket;
  pending: Map<number, Pending>;
  watched: Set<string>;
}

/**
 * The core has no chat unsubscribe frame and caps watches at 64 per socket, so a closed tab's watch lives as long
 * as its socket. When stale watches (closed tabs) reach STALE_MAX, or the next watch would hit the cap, the next new
 * tab starts a fresh socket that subscribes only the open tabs; the old one closes and the core drops its watches.
 * Many open tabs alone never trigger it, so they are not re-read on every new tab.
 */
const MAX_WATCHES = 64;
const STALE_MAX = 16;

export class ChatFeed {
  private conn: Conn | null = null;
  private next = 1;
  private listeners = new Map<string, Set<Listener>>();
  private closed = false;

  constructor(private boot: Boot) {}

  private connect(): Conn {
    // Ticket 620: a swapped core has a new port and token; the shell hands them over in window.__NUNCHIRO__ (as api.ts reads).
    this.boot = window.__NUNCHIRO__ ?? this.boot;
    const ws = new WebSocket(`ws://127.0.0.1:${this.boot.port}/ws`, ['nunchiro.v1', `nunchiro.token.${this.boot.token}`]);
    const c: Conn = { ws, pending: new Map(), watched: new Set() };
    // A new socket has no watches: subscribe every open tab (also after a reconnect).
    ws.onopen = () => {
      // V2.5-17: this side socket is not the window `nunchiro layout` commands go to.
      ws.send(JSON.stringify({ id: this.next++, layout_feed: true }));
      if (this.conn === c) [...this.listeners.keys()].forEach((s) => this.subscribe(s));
    };
    ws.onclose = () => {
      // Requests still queued for the open event settle too, so a caller never waits forever.
      for (const p of c.pending.values()) p.reject(new Error('core disconnected'));
      c.pending.clear();
      if (this.conn !== c) return;
      this.conn = null;
      if (!this.closed) setTimeout(() => !this.conn && this.listeners.size && this.connect(), 1000);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: { id?: number; response?: { Ok?: { page?: Page; chip?: PrChipData | null }; Err?: string }; event?: string; session?: string; page?: Page; error?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const p = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        if (!p || !msg.response) return;
        if (msg.response.Ok?.page) p.resolve(msg.response.Ok.page as never);
        else if (msg.response.Ok && 'chip' in msg.response.Ok) p.resolve((msg.response.Ok.chip ?? null) as never); // v2-8b
        else p.reject(new Error(String(msg.response.Err ?? 'unexpected reply')));
        return;
      }
      // A replaced socket's pushes are stale: the current one carries the same sessions.
      const set = this.conn === c && msg.session ? this.listeners.get(msg.session) : undefined;
      if (!set) return;
      if ((msg.event === 'chat' || msg.event === 'chat_reset') && msg.page)
        for (const l of set) l.page(msg.page, msg.event === 'chat' ? 'live' : 'reset');
      if (msg.event === 'chat_error') for (const l of set) l.error(String(msg.error ?? 'chat read failed'));
    };
    this.conn = c;
    return c;
  }

  /** Closes the current socket without a reconnect; the next request opens a new one. */
  private drop() {
    const c = this.conn;
    this.conn = null;
    c?.ws.close();
  }

  private request(session: string, before: number | null): Promise<Page> {
    return this.ask(before === null ? { chat: session } : { chat: session, before });
  }

  /** v2-8b: the PR badge for a session (window-only op; reads the local transcript, no network). */
  prChip(session: string): Promise<PrChipData | null> {
    return this.ask({ request: { op: 'pr_chip', id: session } });
  }

  private ask<T>(frame: object): Promise<T> {
    const c = this.conn ?? this.connect();
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      c.pending.set(id, { resolve: resolve as (p: never) => void, reject });
      const send = () => c.pending.has(id) && c.ws.send(JSON.stringify({ id, ...frame }));
      if (c.ws.readyState === WebSocket.OPEN) return void send();
      if (c.ws.readyState === WebSocket.CONNECTING) return c.ws.addEventListener('open', send, { once: true });
      c.pending.delete(id);
      reject(new Error('core disconnected'));
    });
  }

  private subscribe(session: string) {
    const c = this.conn ?? this.connect();
    c.watched.add(session);
    this.request(session, null).then(
      // A reply from a socket replaced meanwhile is older than the new socket's page: ignore it.
      (p) => this.conn === c && this.listeners.get(session)?.forEach((l) => l.page(p, 'open')),
      (e: Error) => rawError(e) !== 'core disconnected' && this.listeners.get(session)?.forEach((l) => l.error(rawError(e))),
    );
  }

  /** Newest page, then live pages. */
  open(session: string, l: Listener): () => void {
    let set = this.listeners.get(session);
    if (!set) {
      const w = this.conn?.watched;
      if (w && (w.size - this.listeners.size >= STALE_MAX || w.size + 1 >= MAX_WATCHES)) this.drop();
      this.listeners.set(session, (set = new Set()));
    }
    set.add(l);
    // Without an open socket, the next socket's open event subscribes every listener, this one included.
    if (this.conn?.ws.readyState === WebSocket.OPEN) this.subscribe(session);
    else this.conn ??= this.connect();
    return () => {
      set.delete(l);
      if (set.size) return;
      this.listeners.delete(session);
      // The last tab closed: the socket goes, and with it every watch the core held for it.
      if (!this.listeners.size) this.drop();
    };
  }

  /** Retry after a chat_error: the core dropped the watch, so subscribe again. */
  retry(session: string) {
    if (this.listeners.has(session)) this.subscribe(session);
  }

  older(session: string, before: number): Promise<Page> {
    return this.request(session, before);
  }

  close() {
    this.closed = true;
    this.drop();
  }
}

let shared: ChatFeed | null = null;
/** One chat socket per window. */
export function chatFeed(boot: Boot): ChatFeed {
  return (shared ??= new ChatFeed(boot));
}
