// Ticket 392: a project's past Claude and Codex conversations, one quiet row under the project (mock providers-391 scene e).
// Read-only (needs 137): the core lists only transcripts recorded in exactly this folder, and only for a project its tree
// holds; a click imports that one id (the import gate stays as it is) and opens the existing read-only tab.
// Round 2 (bounds): one request, one core scan, for every local project; asked once the window has drawn.
import { Fragment, useEffect, useState, useSyncExternalStore } from 'react';
import type { CoreClient } from '../api';
import { ageText } from '../chat/PrChip';
import { openImported } from '../firstrun/imported';
import type { T } from '../i18n';
import { Icon } from '../icons/Icon';
import type { Machine } from '../tree';
import { AgentLogo } from './AgentLogo';
import { ErrorDetails, plainError, rawError } from '../errors';

type Item = { id: string; agent: 'claude' | 'codex'; title: string; modified_ms: number; imported: boolean };
const SHOWN = 5;
const DAY = 86_400_000;

const MAX_PROJECTS = 200; // the core's cap on one listing

// One store for the window: the last lists (per project) and at most one ask in flight. A refusal, busy or real, keeps
// the last lists. Ticket 402: `answered` is the set and connection of the last answer; the set is asked again when it
// changes or a new connection has drawn.
let lists: Record<string, Item[]> = {};
let answered: { key: string; on: number } | null = null;
let flying = false;
let next: { core: CoreClient; projects: string[] } | null = null; // the newest wanted set
let version = 0;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

function pump() {
  if (flying || !next) return;
  const { core, projects } = next;
  const key = projects.join('\n');
  // Not in the connect burst: only once this connection's first snapshot is drawn.
  if (!core.snapped || core.snapped !== core.opened) return;
  if (answered?.key === key && answered.on === core.snapped) return;
  const on = core.snapped;
  flying = true;
  core
    .request({ op: 'import_list', projects })
    .then(
      (r) => void (lists = (r as { projects: Record<string, Item[]> }).projects),
      () => {},
    )
    .finally(() => {
      answered = { key, on };
      flying = false;
      version++;
      for (const f of subs) f();
      pump(); // the newest wanted set, if it changed while this one was asked
    });
}

// The local projects the tree draws, sorted (a machine's are never asked); one computation per drawn tree.
const locals = new WeakMap<Machine[], string[]>();
function localProjects(live: Machine[]) {
  let out = locals.get(live);
  if (!out) {
    const groups = live.flatMap((m) => m.groups).filter((g) => ![...g.main, ...g.worktrees.flatMap((w) => w.sessions)].some((s) => s.machine));
    // shortcut: past MAX_PROJECTS local projects the rest get no row; page the ask if a tree ever holds that many.
    out = [...new Set(groups.map((g) => g.project))].sort().slice(0, MAX_PROJECTS);
    locals.set(live, out);
  }
  return out;
}

/** "3 h ago", then "yesterday" and "3 days ago" within the week, then the date ("Oct 28"). */
function age(ms: number, now: number, t: T) {
  const lang = document.documentElement.lang || undefined;
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / DAY);
  if (days < 1) return ageText(new Date(ms).toISOString(), now, t);
  if (days < 7) return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-days, 'day');
  return new Date(ms).toLocaleDateString(lang, { month: 'short', day: 'numeric' });
}

export function PastChats({ core, project, live, t }: { core: CoreClient; project: string; live: Machine[]; t: T }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [fail, setFail] = useState<{ id: string; text: string; details: string } | null>(null);
  useSyncExternalStore(subscribe, () => version);
  const projects = localProjects(live);
  const key = projects.join('\n');
  // Every block wants the same set: the store asks once. Again when the set changes or a new connection has drawn.
  useEffect(() => void ((next = { core, projects }), pump()), [core, key, core.snapped]); // eslint-disable-line react-hooks/exhaustive-deps
  // N11 (look 1117 v4): a conversation still live in a session of this project is no past one.
  const liveIds = new Set(live.flatMap((m) => m.groups.filter((g) => g.project === project).flatMap((g) => [...g.main, ...g.worktrees.flatMap((w) => w.sessions)])).filter((s) => s.state !== 'closed' && s.agent_session_id).map((s) => s.agent_session_id!));
  const items = lists[project]?.filter((i) => !liveIds.has(i.id.slice(i.id.indexOf(':') + 1)));
  // No row while the count is unknown or zero.
  if (!items?.length) return null;
  const now = Date.now();
  const openOne = async (i: Item) => {
    setFail(null);
    try {
      if (!i.imported) {
        await core.request({ op: 'import_add', ids: [i.id] });
        i.imported = true;
      }
      openImported(i.id, i.title);
    } catch (e) {
      setFail({ id: i.id, text: t('past.failed', { error: plainError(t, e) }), details: rawError(e) });
    }
  };
  const label = t('past.label', { n: items.length });
  return (
    <>
      <button type="button" className="row quiet past" data-hint-quiet aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        <span className="chev">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={10} />
        </span>
        <Icon name="clock" size={14} />
        <span className="n">{t('past.title')}</span>
        <span className="c">{t('past.count', { n: items.length })}</span>
      </button>
      {open && (
        <div className="pastlist" role="group" aria-label={label}>
          {items.slice(0, all ? undefined : SHOWN).map((i) => {
            // A title is text an agent wrote: drawn as plain text, cut by CSS.
            const title = i.title || t('past.untitled');
            const when = age(i.modified_ms, now, t);
            return (
              <Fragment key={i.id}>
                <button type="button" className="row pitem" data-past={i.id} aria-label={t('past.item', { title, agent: i.agent === 'claude' ? 'Claude' : 'Codex', age: when })} title={title} onClick={() => void openOne(i)}>
                  <AgentLogo kind={i.agent} size={12} />
                  <span className="n">{title}</span>
                  <span className="tm">{when}</span>
                </button>
                {fail?.id === i.id && (
                  <div className="pastfail" role="alert">
                    {fail.text}
                    <ErrorDetails t={t} details={fail.details} />
                  </div>
                )}
              </Fragment>
            );
          })}
          {!all && items.length > SHOWN && (
            <button type="button" className="row pitem more" onClick={() => setAll(true)}>
              {t('past.more', { n: items.length - SHOWN })}
            </button>
          )}
        </div>
      )}
    </>
  );
}
