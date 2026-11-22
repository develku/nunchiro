// V2-3b: a conversation is one tab's chain of sessions joined by agent switches (core `Session.conversation`).
import { shownStatus, type AgentKind, type Session, type Shown } from '../types';
import type { WithLog } from '../picker/Picker';

export type Member = WithLog & { conversation?: string };
/** The agents a handoff can go to (ACP agents join this list after V2-4). */
export const AGENTS: AgentKind[] = ['claude', 'codex'];
export const agentName = (k: AgentKind, acp?: string | null) => (k === 'claude' ? 'Claude' : k === 'codex' ? 'Codex' : k === 'acp' ? (acp ? `${acp} (ACP)` : 'ACP agent') : 'Shell');

/** `s`'s conversation, earlier sessions by last activity and `s` last (the one before it is the one switched from);
 * just `s` before its first switch. */
export function chain(s: Session, all: Session[]): Session[] {
  const c = (s as Member).conversation;
  const earlier = c ? all.filter((x) => x.id !== s.id && (x as Member).conversation === c) : [];
  return [...earlier.sort((a, b) => a.attention.last_activity - b.attention.last_activity), s];
}

const URGENT: Shown[] = ['waiting', 'limited', 'failed', 'stale', 'working', 'asked', 'idle', 'done'];
/** A conversation tab's dot: its most urgent session, so an earlier session still working or waiting shows there. */
export const tabStatus = (sessions: Session[]): Shown => URGENT[Math.min(...sessions.map((x) => URGENT.indexOf(shownStatus(x))))];

/** The session a handoff to `kind` takes its model and account from: that agent's newest (the core's rule). */
export function lastOf(kind: AgentKind, all: Session[]): Member | undefined {
  return all.filter((x) => x.kind === kind).sort((a, b) => b.attention.last_activity - a.attention.last_activity)[0];
}

/** Fired by the picker, the palette and the chain's links; App holds the one pending handoff. */
export const HANDOFF_EVENT = 'nunchiro:handoff';
/** V2-4b: a hand-off to an ACP agent names its approved `agents.toml` entry (`acp`). */
export const handOff = (from: string, to?: AgentKind, acp?: string, through?: string) => window.dispatchEvent(new CustomEvent(HANDOFF_EVENT, { detail: { from, to, acp, through } }));

/** Ticket 371 item 20: fired by a message row's Rewind; useComposerSend opens the terminal and asks Claude for its picker. */
export const REWIND_EVENT = 'nunchiro:rewind';
export const rewind = (session: string) => window.dispatchEvent(new CustomEvent(REWIND_EVENT, { detail: session }));

/** B12 (ticket 991): a side chat's first message wraps the main session's handoff as reference only, so the side agent
 *  answers the question after it instead of picking the main session's requests up again. */
export const SIDE_CONTEXT = 'side-chat-context';
export const sideContext = (handoff: string) =>
  `<${SIDE_CONTEXT}>\nReference only: what the main session did. This is a side chat: do not continue, redo or check that work, and do not ask its questions again. Answer only the message after this block.\n\n${handoff}\n</${SIDE_CONTEXT}>`;

/** A long paste without its `<pasted_content …>` tags. Plain scanning, one pass (after one Codex look: a regex with
 *  lazy groups went cubic on an open tag followed by many spaces, in a render path). An open tag with no close stays. */
function unwrapPastes(raw: string): string {
  const OPEN = '<pasted_content';
  const CLOSE = '</pasted_content';
  let out = '';
  let at = 0;
  for (;;) {
    const open = raw.indexOf(OPEN, at);
    const openEnd = open < 0 ? -1 : raw.indexOf('>', open);
    const close = openEnd < 0 ? -1 : raw.indexOf(CLOSE, openEnd);
    const closeEnd = close < 0 ? -1 : raw.indexOf('>', close);
    // `<pasted_content` must end as a tag name ("<pasted_contents>" is not one).
    if (closeEnd < 0 || !/[\s>]/.test(raw[open + OPEN.length])) return out + raw.slice(at);
    out += raw.slice(at, open) + raw.slice(openEnd + 1, close).trim();
    at = closeEnd + 1;
  }
}

/** B11 (ticket 991): a user message as the user typed it. Claude records a slash command as `<command-name>` tags and a
 *  long paste as `<pasted_content>`; a handoff (or a side chat's context) folds into its own part. */
/** Ticket 990: a teammate's brief (the core's first message to a seat, team.rs `brief`), a worker's wake line
 *  (sessions/wake.rs `line`) and the room's notice (room.rs `NOTICE_TAIL`) arrive as user messages. None is what the
 *  person typed. */
const BRIEF = /^You are [^\n]{1,120}, a teammate of this user in Nunchiro\./;
const WAKE = /^(?:worker .{1,200} (?:done|blocked \((?:question|permission)\)|failed|exited)(?:; report says: ".*")?|\d+ new messages?: run nunchiro agent check)$/;

export function userView(raw: string): { text: string; handoff?: string; brief?: string; wake?: string } {
  // Plain scanning (a lazy regex rescans the rest of the message at every open tag): the first open tag, the first
  // close tag after it.
  const tag = (name: string) => {
    const open = raw.indexOf(`<${name}>`);
    const close = open < 0 ? -1 : raw.indexOf(`</${name}>`, open);
    return close < 0 ? undefined : raw.slice(open + name.length + 2, close).trim();
  };
  const command = tag('command-name');
  if (command) return { text: [command.startsWith('/') ? command : `/${command}`, tag('command-args')].filter(Boolean).join(' ') };
  const text = unwrapPastes(raw);
  // After the unwrapping: Claude records a long paste (a brief is one) inside `<pasted_content>` (seen in the real app:
  // the brief stayed a huge bubble).
  const whole = text.trim();
  if (BRIEF.test(whole)) return { text: '', brief: whole };
  if (!whole.includes('\n') && WAKE.test(whole)) return { text: '', wake: whole };
  const side = new RegExp(`^\\s*<${SIDE_CONTEXT}>\\n?([\\s\\S]*?)\\n?</${SIDE_CONTEXT}>\\s*`).exec(text);
  if (side) return { text: text.slice(side[0].length), handoff: side[1] };
  // A handoff to another agent is the handoff text and then what was typed with it, as one message.
  if (/^\s*Handoff from \S.* \(\d+ turns?, session /.test(text)) return { text: '', handoff: text.trim() };
  return { text };
}
