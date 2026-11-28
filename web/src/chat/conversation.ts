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
/** Ticket 990: a teammate's brief (the core's first message to a seat, team.rs `brief`) arrives as a user message. It is
 *  not what the person typed. */
const BRIEF = /^You are [^\n]{1,120}, a teammate of this user in Nunchiro\./;
/** Ticket 1085: every line the core types into a seat's box by itself, also arriving as user messages: a worker's wake
 *  line (sessions/wake.rs `line`), the room's notice (room.rs `notice`), and auto-advance's heartbeat and nudge
 *  (advance.rs `beat_line`, `nudge_line`, `stall_line`, `forward_line` to a Builder, and the dependency lines; the pattern's group 1, the core's team lines). crates/nunchiro-core/tests/fixtures/automatic-lines.json lists each form; a
 *  core test proves the core types only those, web/tests/wake-lines-1085.spec.ts that each one folds. */
const BEAT_PART = String.raw`\d+ (?:reports? waits? for review|approved waits? to merge|seats? stalled)`;
/** Task dependencies (advance.rs `landed_line`, `dropped_line`): what a landing freed, or who waited for a dropped task. */
const RELEASE = String.raw`".{1,200}?" (?:landed\.(?: .{1,2000}? no longer waits?: start (?:it|them) when you are ready\.)?(?: ".{1,200}?" still waits for \d+ tasks?\.)*|was dropped\.(?: ".{1,200}?" waited for it: stop waiting \(nunchiro task after t\d+ --none\) or drop it\.)+)`;
/** A stalled seat's card, told to the lead (advance.rs `stall_line`). */
const STALL = String.raw`Stalled: .{1,200}? \(\S{1,80}\): .{1,200}?, still after one nudge\. If \`nunchiro task show \S{1,80}\` still lists it as stalled, replace it now without asking the user: nunchiro session close \S{1,80}, then nunchiro task staff \S{1,80} .{1,80}? with its brief\. Ask the user instead only if your brief or the user says so, or it is a teammate you did not open\.`;
const AUTO = new RegExp(
  String.raw`^(?:worker .{1,200}? (?:done|blocked \((?:question|permission)\)|failed|exited|ended a turn \(no report yet\)|waits for your answer to its question in the room)(?:; report says: "[^"\n]*")?|\d+ new messages?: run nunchiro agent check|(Team: ${BEAT_PART}(?:, ${BEAT_PART})*\.|Lead: you have been quiet for \d+ minutes with the task open; finish it or say what blocks you\.|${STALL}|Review round \d+ of \d+ asked for changes at [0-9a-f ]{1,200}: .{0,4000}?\. .{1,200}? sends you the full findings as a room message \(agent send\): read them with \`nunchiro agent check\`, fix them, commit, and write REPORT\.md again\.|${RELEASE}))`,
);
const AUTO_LINE = new RegExp(`${AUTO.source}$`);

/** Ticket 1072 + 1085: a user message that starts with automatic lines: how many, how many of them are the core's team
 *  lines, and the rest (the owner's words). Older transcripts hold the owner's words after a line, on the next row or
 *  glued on the same row. Glued counts only when one complete form is followed at once by a letter or digit: the core
 *  put nothing between them, while the owner's own "worker 3 failed to start" or "worker w1 done, merge it" has a space
 *  or a mark and stays whole. A message that quotes a line stays whole. Null when it does not start with one. */
export function wakeSplit(raw: string): { n: number; team: number; rest: string } | null {
  let rest = raw.trim();
  let n = 0;
  let team = 0;
  for (;;) {
    const line = rest.split('\n', 1)[0];
    // A whole row first: a worker's name may hold words that also end a line.
    const whole = AUTO_LINE.exec(line);
    const m = whole ?? AUTO.exec(line);
    if (!m || (!whole && !/^[\p{L}\p{N}]/u.test(line.slice(m[0].length)))) break;
    n++;
    if (m[1]) team++;
    rest = rest.slice(m[0].length).replace(/^\n/, '');
    if (!whole) break; // the owner's words follow on this row
  }
  return n ? { n, team, rest: rest.trim() } : null;
}

export function userView(raw: string): { text: string; handoff?: string; brief?: string } {
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
  const side = new RegExp(`^\\s*<${SIDE_CONTEXT}>\\n?([\\s\\S]*?)\\n?</${SIDE_CONTEXT}>\\s*`).exec(text);
  if (side) return { text: text.slice(side[0].length), handoff: side[1] };
  // A handoff to another agent is the handoff text and then what was typed with it, as one message.
  if (/^\s*Handoff from \S.* \(\d+ turns?, session /.test(text)) return { text: '', handoff: text.trim() };
  return { text };
}
