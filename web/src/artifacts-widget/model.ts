// "This session" of the Artifacts widget (ticket v1b-13): what the session's chat events in this window name, oldest first.
// Attachments (`attachment`) are user `image` events and 05's saved-path lines; agent work (`by agent`) is 06's
// `artifact` events. One row per thing: a file is keyed by root and path (a fenced block's path is its hash), an
// inline image by its bytes. A repeat updates the row (latest title and time) where it stands, so a write arriving
// while the list is scrolled never moves the rows below it (needs 26).
import { targetOf } from '../artifacts/Card';
import type { Target, Type } from '../artifacts/host';
import type { ChatEvent } from '../chat/feed';
import { fileOf, nameOf, savedPaths, type Source } from '../images/Thumbnail';

interface Common {
  key: string;
  cursor: number;
  kind: Type;
  name: string;
  /** When this window received the event (ms), for events that arrived live; chat events carry no time. */
  at?: number;
}
export type Entry = (Common & { label: 'attachment'; source: Source }) | (Common & { label: 'by agent'; target: Target });

function imageKey(s: Source) {
  const f = fileOf(s);
  if (f) return `${f.root}:${f.path}`;
  if (s.type === 'path') return `p:${s.path}`;
  if (s.type === 'url') return `u:${s.url}`;
  return `b:${s.data?.length}:${s.data?.slice(0, 64)}:${s.data?.slice(-64)}`;
}

export function entries(session: string, events: ChatEvent[], at: ReadonlyMap<number, number>): Entry[] {
  const out = new Map<string, Entry>();
  // Map.set on a held key keeps its place.
  const put = (e: Entry) => out.set(e.key, e);
  for (const { cursor, data: d } of events) {
    const common = { cursor, at: at.get(cursor) };
    if (d.kind === 'artifact') {
      const target = targetOf(session, d);
      put({ ...common, key: `${target.root}:${target.path}`, kind: d.type, name: d.title, label: 'by agent', target });
    } else if ((d.kind === 'image' || d.kind === 'message') && d.role === 'user') {
      for (const source of d.kind === 'image' ? [d.source as Source] : savedPaths(d.text))
        put({ ...common, key: imageKey(source), kind: 'image', name: nameOf(source), label: 'attachment', source });
    }
  }
  return [...out.values()];
}
