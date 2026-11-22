// Script widgets (ticket v1b-19): mirrors crates/nunchiro-core/src/widgets/mod.rs (Reply::Widgets, Reply::WidgetRun).
// The window's whole widget surface is these requests plus the permission sheet's approval_status/grant.
import { useSyncExternalStore } from 'react';
import type { ApprovalCore, ApprovalState } from '../approval/types';
import { rawError } from '../errors';

export interface Listed {
  name: string;
  state: ApprovalState | null;
  kind: string | null;
  author: string | null;
  interval_secs: number | null;
  error: string | null;
  /** v1b-20: the `[act]` table while the widget holds a current act grant; rows are clickable only then. */
  act?: Act | null;
}
/** v1b-20: mirrors approval::Act; exactly one of `session` (a label) and `start` (an agent kind). */
export interface Act {
  template: string;
  session: string | null;
  start: 'claude' | 'codex' | null;
}
export interface WidgetList {
  enabled: boolean;
  unavailable: string | null;
  widgets: Listed[];
  /** v1b-22: the `web_widgets` setting; `enabled` and `unavailable` are about script widgets. */
  web_enabled?: boolean;
}
/** `json`: the whole output parsed as JSON in the core; `text` is exactly what it printed (key order kept). */
export type Output = { format: 'text' | 'json'; text: string };
export interface Run {
  name: string;
  project: string | null;
  ran_at_ms: number;
  interval_secs: number;
  running: boolean;
  output: Output | null;
  error: string | null;
}

export const PREFIX = 'widget:';
export const userKind = (name: string) => `${PREFIX}${name}`;

export const runWidget = (core: ApprovalCore, name: string, session: string | null) =>
  core.request({ op: 'widget_run', name, session }).then((r) => (r as { run: Run }).run);

// v1b-20: only a row click calls this. The core renders the text from its own cached run `ran_at_ms`; the window
// names the row, never the text.
export interface ActSend {
  session: string;
  send: { id: string; status: string; content: string };
}
export const actWidget = (core: ApprovalCore, name: string, session: string | null, row: number, ran_at_ms: number) =>
  core.request({ op: 'widget_act', name, session, row, ran_at_ms }).then((r) => r as ActSend);
/** Ticket 513: the locale for a widget's clock times. The system's own tag when it is in the window's language (an English
 *  window on a UK system keeps "15:04:05"), else the window's language (a Korean window on a US system shows "오후 3:04:05"). */
export const timeLocale = (windowLang: string, system: string) => {
  const lang = (windowLang || 'en').toLowerCase();
  const sys = system.toLowerCase();
  return sys === lang || sys.startsWith(`${lang}-`) ? system : windowLang || 'en';
};
export const actTarget = (act: Act) => (act.session ? `session “${act.session}”` : `a new ${act.start} session`);

/** One poll per client every POLL_MS, shared by the gallery and every placed widget: a new folder shows within 1 s
 * (half a second between polls leaves the rest for the request and the render). */
export const POLL_MS = 500;
class Poll {
  list: WidgetList | null = null;
  error = '';
  private subs = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private core: ApprovalCore) {}
  subscribe = (f: () => void) => {
    this.subs.add(f);
    if (!this.timer) {
      this.refresh();
      this.timer = setInterval(this.refresh, POLL_MS);
    }
    return () => {
      this.subs.delete(f);
      if (!this.subs.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  };
  snapshot = () => this.list;
  refresh = () => {
    this.core
      .request({ op: 'widget_list' })
      .then((r) => ((this.list = (r as { list: WidgetList }).list), (this.error = '')))
      .catch((e: Error) => (this.error = rawError(e)))
      .finally(() => this.subs.forEach((f) => f()));
  };
}
const polls = new WeakMap<ApprovalCore, Poll>();
export function useWidgetList(core: ApprovalCore) {
  let poll = polls.get(core);
  if (!poll) polls.set(core, (poll = new Poll(core)));
  const list = useSyncExternalStore(poll.subscribe, poll.snapshot);
  return { list, error: poll.error, refresh: poll.refresh };
}
