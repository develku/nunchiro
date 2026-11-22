// V2-9a: the three small dialogs of the project tree, all over the tree rather than in it, so opening one moves no row
// (needs 49): the group name field (create and rename), the group chooser ("Move to group") and the status picker.
import { PLAIN } from '../plainText';
import { useEffect, useRef, useState } from 'react';
import { moveProject, track } from './dragProject';
import { ADD_EVENT, askNew } from '../NewSession';
import { sessionName } from '../Sidebar';
import { agentName } from '../chat/conversation';
import { Icon } from '../icons/Icon';
import { basename, isAccountTab, listedName, pickerList, projectName, type Group, type ListedWorktree } from '../tree';
import type { Key } from '../i18n';
import { status, statusKey, type Session, type TreeEdit } from '../types';
import type { CoreClient } from '../api';
import { ProjectWizard } from './ProjectTools';
import type { Worktrees } from './worktrees';
import { ErrorDetails, plainError, rawError } from '../errors';
import { enT, plural, type ProjectTree, type T } from './state';
import './tree.css';
import './remove.css';

/** The core allows 64 characters; the field counts what the user sees (a Korean syllable or an emoji is one), so a cut never splits one. */
const NAME_MAX = 64;
const segments = new Intl.Segmenter();
const clip = (v: string) => [...segments.segment(v)].slice(0, NAME_MAX).map((x) => x.segment).join('');

/** A search field's Enter during an IME composition belongs to the composition (macOS reports keyCode 229). */
const typing = (e: React.KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

const STATUS: Record<string, Key> = {
  waiting: 'tree.status.waiting',
  limited: 'limit.row', // ticket 372
  failed: 'tree.status.failed',
  unread: 'tree.status.unread',
  working: 'tree.status.working',
  stale: 'tree.status.stale',
  idle: 'tree.status.idle',
};

interface Row {
  key: string;
  title: string;
  dim?: string;
  status?: string;
}

/** Palette-style list: a search field over options, arrows and Enter. `search` is what typing filters on. */
function ListDialog({ t, label, placeholder, rows, search, onPick, onClose }: { t: T; label: string; placeholder: string; rows: Row[]; search: (r: Row) => string; onPick: (r: Row) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  const list = rows.filter((r) => !q || search(r).toLowerCase().includes(q.toLowerCase()));
  useEffect(() => {
    input.current?.focus();
    const prev = back.current;
    return () => (prev as HTMLElement | null)?.focus?.();
  }, []);
  const pick = (r?: Row) => {
    if (!r) return;
    onClose();
    setTimeout(() => onPick(r), 0); // after focus returns, so a follow-up dialog keeps it
  };
  return (
    <div className="palette tpick" role="dialog" aria-modal="true" aria-label={label}>
      <input {...PLAIN}
        ref={input}
        role="combobox"
        aria-label={t('tree.list.search', { label })}
        aria-expanded="true"
        aria-controls="tpick-list"
        aria-activedescendant={list[sel] ? `tpick-${sel}` : undefined}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        onKeyDown={(e) => {
          if (typing(e)) return;
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(s + 1, list.length - 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
          else if (e.key === 'Enter') (e.preventDefault(), pick(list[sel]));
        }}
      />
      <ul id="tpick-list" role="listbox" aria-label={label}>
        {list.map((r, i) => (
          <li key={r.key} id={`tpick-${i}`} role="option" aria-selected={i === sel} data-key={r.key} onMouseEnter={() => setSel(i)} onClick={() => pick(r)}>
            {r.status && <i className="st" data-s={r.status} aria-hidden />}
            <span>{r.title}</span>
            {r.status && <span className="sr">{t(STATUS[r.status])}</span>}
            {r.dim && <span className="dim">{r.dim}</span>}
          </li>
        ))}
        {list.length === 0 && <li className="none">{t('tree.list.none')}</li>}
      </ul>
    </div>
  );
}

/** The new-group and rename field: Enter commits (not while composing), Esc cancels and nothing changes. */
function NameDialog({ t, title, initial, label, hint, blank, onSubmit, onClose }: { t: T; title: string; initial: string; label?: string; hint?: string; /** An empty field is a value (a project goes back to its folder name). */ blank?: boolean; onSubmit: (name: string) => Promise<string | null>; onClose: () => void }) {
  const [v, setV] = useState(initial);
  // Ticket 534: a refusal shows plain words (a known core sentence has its own line), its raw text under a closed Details.
  const [err, setErr] = useState<{ text: string; details?: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    const prev = back.current;
    return () => (prev as HTMLElement | null)?.focus?.();
  }, []);
  const busy = useRef(false);
  const commit = async () => {
    if (busy.current) return; // a second Enter while the edit is in flight
    const name = v.trim();
    if (!name && !blank) return setErr({ text: t('tree.group.needsName') });
    busy.current = true;
    const refused = await onSubmit(name);
    busy.current = false;
    if (refused) setErr({ text: plainError(t, refused), details: refused });
    else onClose();
  };
  return (
    <div className="palette gname" role="dialog" aria-modal="true" aria-label={title}>
      <input {...PLAIN}
        ref={input}
        aria-label={label ?? t('tree.group.name')}
        aria-describedby={err ? 'gname-err' : undefined}
        aria-invalid={err ? true : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={v}
        onChange={(e) => (setV(clip(e.target.value)), setErr(null))}
        onKeyDown={(e) => {
          if (typing(e)) return;
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter') (e.preventDefault(), void commit());
        }}
      />
      <p className="hint2">{hint ?? t('tree.group.hint', { title })}</p>
      {err && (
        <div id="gname-err" role="alert" className="err">
          {err.text}
          <ErrorDetails t={t} details={err.details} />
        </div>
      )}
    </div>
  );
}

/** 370: Cancel or Close first in the DOM takes the focus; Tab stays inside, Esc is the first button. Look 1117 v11 A S3-2:
 *  a worktree's remove questions (worktrees.tsx RemoveSheet) are this sheet too, `className` keeps their lists' look. */
export function AlertSheet({ label, wide, gone, className, onClose, children }: { label: string; wide?: boolean; /** Set once the row is removed: focus back on it would hold the tree (needs 49) with the row still in it. */ gone?: React.RefObject<boolean>; className?: string; onClose: () => void; children: React.ReactNode }) {
  const sheet = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    sheet.current?.querySelector<HTMLButtonElement>('.rmacts button')?.focus(); // Cancel or Close, not a step listed above it
    const prev = back.current;
    return () => {
      if (!gone?.current) (prev as HTMLElement | null)?.focus?.();
    };
  }, [gone]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return (e.preventDefault(), onClose());
    if (e.key !== 'Tab') return;
    const b = [...(sheet.current?.querySelectorAll('button') ?? [])].filter((x) => !x.disabled);
    const i = b.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    b[(i + (e.shiftKey ? -1 : 1) + b.length) % b.length]?.focus();
  };
  return (
    <div className="rmscrim">
      <div ref={sheet} className={`palette wtdlg rmdlg${wide ? '' : ' rmblocked'}${className ? ` ${className}` : ''}`} role="alertdialog" aria-modal="true" aria-label={label} onKeyDown={key}>
        <h2>{label}</h2>
        {children}
      </div>
    </div>
  );
}

/** What stands between a project and Remove, read from the core (never this window's copy), at open and again on confirm. */
type Removal = { sessions: Session[]; running: Session[]; worktrees: ListedWorktree[]; /** Worktree path to the title of its open task whose review passed (waits for a merge). */ merging: Record<string, string> };
type Task = { title: string; worktrees?: string[]; seats?: { worktree?: string }[]; closed?: unknown; review?: { pass: boolean } };
const rowsOf = async (core: ProjectTree['core'], project: string) => ((await core.request({ op: 'snapshot' })) as { sessions: Session[] }).sessions.filter((s) => s.project === project);
async function readRemoval(core: ProjectTree['core'], project: string): Promise<Removal> {
  const [rows, listed, tasks] = await Promise.all([
    rowsOf(core, project),
    core.worktree({ operation: 'list' }),
    // A core without the ledger, or a project without a lead, has no tasks.
    core.request({ op: 'task', operation: 'list', project }).then((r) => (r as { tasks?: Task[] }).tasks ?? [], () => [] as Task[]),
  ]);
  const merging: Record<string, string> = {};
  for (const x of tasks) if (!x.closed && x.review?.pass) for (const w of [...(x.worktrees ?? []), ...(x.seats ?? []).map((s) => s.worktree)]) if (w) merging[w] = x.title;
  const sessions = rows.filter((s) => !isAccountTab(s) && !s.machine && s.state !== 'closed');
  // `state`, not agentState: an agent that quit left the user's shell running, and Close would end it.
  // A listed worktree counts even when its folder is gone: withListed brings the head back for it all the same.
  return { sessions, running: sessions.filter((s) => s.state === 'running'), worktrees: (listed.worktrees ?? []).filter((w) => w.project === project), merging };
}
const COUNTS: [Session['state'], Key][] = [['resumable', 'tree.project.count.resumable'], ['exited', 'tree.project.count.exited'], ['failed', 'tree.project.count.failed']];
const fingerprint = (r: Removal) => r.sessions.map((s) => `${s.id}:${s.state}`).join();

function RemoveDialog({ t, pt, wt, project, onClose }: { t: T; pt: ProjectTree; wt: Pick<Worktrees, 'remove'>; project: string; onClose: () => void }) {
  const [live, setLive] = useState<Removal | null>(null);
  // Ticket 480: the plain line, and the raw reason for Details.
  const [err, setErr] = useState<{ text: string; details: string } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const gone = useRef(false);
  const { core, edit, tree } = pt;
  useEffect(() => void readRemoval(core, project).then(setLive, (e: Error) => setErr({ text: plainError(t, e), details: rawError(e) })), [core, project]);
  if (!live && !err) return null;
  const name = projectName(tree, project);
  const path = <div className="rmpath">{project}</div>;
  // Look 1117 v11 C-NC4: each session reads the state word its tree row reads (idle, working), not "running".
  const running = (list: Session[]) =>
    list.map((s) => (
      <div className="rmit" key={s.id}>
        <span>{sessionName(s)}</span>
        <span className="rmmuted">{t('tree.project.blockedRunningRow', { kind: s.side_chat ? t('chat.side.title') : s.kind === 'shell' ? t('firstrun.shell') : agentName(s.kind, s.acp_agent), state: t(statusKey(s)) })}</span>
      </div>
    ));
  // Look 1117 v13 (A NEW-S2-A1): the blocked dialog does the steps it can. Stop closes each running session (a running
  // session's close only stops it), then the list is read again; nothing else closes.
  const stop = async () => {
    if (!live) return;
    setBusy(true);
    setErr(null);
    let closed = 0;
    try {
      for (const s of live.running) {
        await core.request({ op: 'close', id: s.id });
        closed++;
      }
      setLive(await readRemoval(core, project));
    } catch (e) {
      setErr({ text: t('tree.project.removeFailed', { closed, total: live.running.length, error: plainError(t, e) }), details: rawError(e) });
    } finally {
      setBusy(false);
    }
  };
  // Look 1117 v10 (A): running sessions alone no longer block; the confirm lists them and its action stops them (Close stops a running session).
  if (!live || live.worktrees.length)
    return (
      <AlertSheet key="blocked" label={t('tree.project.blockedTitle', { name })} onClose={onClose}>
        {path}
        {!!live?.running.length && (
          <section className="rmwhy">
            <h3>{plural(t, 'tree.project.blockedRunning', live.running.length)}</h3>
            {running(live.running)}
            <p className="rmmuted">{t('tree.project.blockedRunningFix')}</p>
          </section>
        )}
        {!!live?.worktrees.length && (
          <section className="rmwhy">
            <h3>{plural(t, 'tree.project.blockedWorktrees', live.worktrees.length)}</h3>
            {live.worktrees.map((w) => (
              <div className="rmit" key={w.path}>
                <span>{listedName(w, live.sessions)}</span>
                {/* A worktree's own remove asks for what it would lose (its sessions, unsaved files); one waiting for a merge is said here first. */}
                <span className="rmmuted">{live.merging[w.path] ? t('tree.project.blockedWorktreeMerge', { title: live.merging[w.path] }) : t('tree.project.blockedWorktree')}</span>
                <button className="btn" disabled={busy} onClick={() => (onClose(), wt.remove(w.path))}>
                  {t('dialog.worktree.cmd.remove')}
                </button>
              </div>
            ))}
            <p className="rmmuted">{t('tree.project.blockedWorktreeFix')}</p>
          </section>
        )}
        {err && (
          <div role="alert" className="rmerr">
            {err.text}
            <ErrorDetails t={t} details={err.details} />
          </div>
        )}
        <p className="rmacts">
          <button className="btn" onClick={onClose}>
            {t('tree.project.removeClose')}
          </button>
          {!!live?.running.length && (
            <button className="btn x" disabled={busy} onClick={() => void stop()}>
              {plural(t, 'tree.project.blockedStop', live.running.length)}
            </button>
          )}
        </p>
      </AlertSheet>
    );
  const confirm = async () => {
    setBusy(true);
    setErr(null);
    setNote('');
    let closed = 0;
    let total = live.sessions.length;
    try {
      const now = await readRemoval(core, project);
      // Anything but the list the user read goes back to them: a worktree refuses, any other change is counted again.
      if (now.worktrees.length || fingerprint(now) !== fingerprint(live)) {
        if (!now.worktrees.length) setNote(t('tree.project.removeChanged'));
        return setLive(now);
      }
      total = now.sessions.length;
      for (const s of now.sessions) {
        await core.request({ op: 'close', id: s.id });
        closed++;
      }
      // Look 1117 v11 (C NC1), v12 (A S2-C): a Closed row (a running session's close only stops it, and a session closed
      // earlier) keeps its tab with Restart, which brought the project back; a close drops it, as Close session on a done row does.
      for (const s of await rowsOf(core, project)) if (s.state === 'closed' && !s.side_chat && !s.machine && !isAccountTab(s)) await core.request({ op: 'close', id: s.id });
      // Add false drops the project and the core's prune its pins and groups, but a `closed` row left behind (a side chat's close) keeps the project known and unpruned.
      const kept = (await rowsOf(core, project)).length > 0;
      const edits: TreeEdit[] = [
        ...(kept && tree.pins.includes(project) ? [{ op: 'pin', project, pinned: false } as const] : []),
        ...(kept && tree.groups.some((g) => g.projects.includes(project)) ? [{ op: 'project_move', project, group: null } as const] : []),
        { op: 'add', project, added: false },
        { op: 'project_name', project, name: '' }, // the name goes by its own edit, so a later re-add starts clean
      ];
      for (const one of edits) {
        const refused = await edit(one);
        if (refused) throw new Error(refused);
      }
      gone.current = true;
      onClose();
    } catch (e) {
      setErr({ text: t('tree.project.removeFailed', { closed, total, error: plainError(t, e) }), details: rawError(e) });
    } finally {
      setBusy(false);
    }
  };
  const count = (state: Session['state']) => live.sessions.filter((s) => s.state === state).length;
  const resumable = count('resumable');
  const counts = COUNTS.filter(([st]) => count(st) > 0).map(([st, key]) => t(key, { n: count(st) })).join(' · ');
  const cancel = () => void (busy || onClose()); // a run under way finishes or stops by itself; it cannot be left behind a closed dialog
  return (
    <AlertSheet key="confirm" wide gone={gone} label={t('tree.project.removeTitle', { name })} onClose={cancel}>
      {path}
      {live.sessions.length > 0 && (
        <p>
          <b>{plural(t, 'tree.project.removeCloses', live.sessions.length)}</b> <span className="rmmuted">{counts}</span>
        </p>
      )}
      {live.running.length > 0 && (
        <section className="rmwhy" aria-label={t('dialog.stopRemove.label')}>
          <h3>{t('dialog.stopRemove.label')}</h3>
          {running(live.running)}
        </section>
      )}
      {resumable > 0 && <div className="rmcall">{plural(t, 'tree.project.removeResumable', resumable)}</div>}
      <ul className="rmfacts">
        <li className="gone">
          <Icon name="x" size={14} />
          <span>{t('tree.project.removeHistory')}</span>
        </li>
        <li className="gone">
          <Icon name="x" size={14} />
          <span>{t('tree.project.removeNoUndo')}</span>
        </li>
        <li className="stay">
          <Icon name="check" size={14} />
          <span>{t('tree.project.removeStays')}</span>
        </li>
      </ul>
      {note && <p role="status">{note}</p>}
      {err && (
        <div role="alert" className="rmerr">
          {err.text}
          <ErrorDetails t={t} details={err.details} />
        </div>
      )}
      <p className="rmacts">
        <button className="btn" onClick={cancel}>
          {t('dialog.cancel')}
        </button>
        <button className="btn x" disabled={busy} onClick={() => void confirm()}>
          {live.running.length ? plural(t, 'dialog.stopRemove.action', live.running.length) : t('tree.project.removeAction')}
        </button>
      </p>
    </AlertSheet>
  );
}

export const REMOVE_EVENT = 'nunchiro:project.remove';
export const askRemoveProject = (project: string) => window.dispatchEvent(new CustomEvent(REMOVE_EVENT, { detail: project }));

export function ProjectDialogs({ core, pt, wt, projects, onOpen, t = enT }: { core: CoreClient; pt: ProjectTree; wt: Pick<Worktrees, 'remove'>; projects: Group[]; onOpen: (id: string) => void; t?: T }) {
  const { ask, setAsk, picking, setPicking, tree, edit, unread } = pt;
  const close = () => (setAsk(null), setPicking(false));
  track(pt); // always mounted: an Undo of a move made while the sidebar is hidden still reads the newest tree
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const open = () => setAdding(true);
    // Ticket 1040: Settings > Projects opens this same remove dialog, never a second one.
    const remove = (e: Event) => setAsk({ kind: 'remove', project: (e as CustomEvent<string>).detail });
    window.addEventListener(ADD_EVENT, open);
    window.addEventListener(REMOVE_EVENT, remove);
    return () => (window.removeEventListener(ADD_EVENT, open), window.removeEventListener(REMOVE_EVENT, remove));
  }, [setAsk]);
  if (adding) return <ProjectWizard core={core} onClose={() => setAdding(false)} projects={projects.filter((g) => !g.main.some((x) => x.machine)).map((g) => g.project)} t={t} />;
  if (picking) {
    const rows = pickerList(projects, tree, unread);
    const byKey = new Map(rows.map((r) => [r.group.project, r.group]));
    return (
      <ListDialog
        t={t}
        label={t('tree.picker.title')}
        placeholder={t('tree.picker.placeholder')}
        rows={rows.map((r) => ({ key: r.group.project, title: r.group.name, dim: r.groupName ?? undefined, status: statusOf(r.group, unread) }))}
        search={(r) => `${r.title} ${r.dim ?? ''}`}
        onPick={(r) => {
          const g = byKey.get(r.key)!;
          const id = (g.main[0] ?? g.worktrees[0]?.sessions[0])?.id;
          if (id) onOpen(id);
          else askNew(g.project); // an added project with no session yet
        }}
        onClose={close}
      />
    );
  }
  if (!ask) return null;
  if (ask.kind === 'remove') return <RemoveDialog key={ask.project} t={t} pt={pt} wt={wt} project={ask.project} onClose={close} />;
  if (ask.kind === 'move')
    return (
      <ListDialog
        t={t}
        label={t('tree.group.move')}
        placeholder={t('tree.group.name')}
        rows={[...tree.groups.map((g) => ({ key: `g:${g.name}`, title: g.name })), { key: 'new', title: t('tree.group.new') }]}
        search={(r) => r.title}
        onPick={(r) => (r.key === 'new' ? setAsk({ kind: 'create', project: ask.project }) : void moveProject(pt, t, ask.project, projectName(tree, ask.project), r.title))}
        onClose={close}
      />
    );
  if (ask.kind === 'name') {
    const title = t('tree.project.renameTitle');
    return <NameDialog t={t} title={title} initial={projectName(tree, ask.project)} label={t('tree.project.name')} hint={t('tree.project.renameHint', { title })} blank onSubmit={(name) => edit({ op: 'project_name', project: ask.project, name })} onClose={close} />;
  }
  const create = ask.kind === 'create';
  return (
    <NameDialog
      t={t}
      title={create ? t('tree.group.newTitle') : t('tree.group.rename')}
      initial={create ? '' : (ask.group ?? '')}
      onSubmit={(name) => edit(create ? { op: 'group_create', name, project: ask.project } : { op: 'group_rename', from: ask.group!, to: name })}
      onClose={close}
    />
  );
}

/** The word a project reads as in the picker: its most urgent session's status, `unread` after the work states. */
export function statusOf(g: Group, unread: ReadonlySet<string>): string {
  const all = [...g.main, ...g.worktrees.flatMap((w) => w.sessions)].map(status);
  if (g.counts.waiting || all.includes('waiting')) return 'waiting'; // N12-S2-4: asks only, as tree.ts counts them
  if (all.includes('limited')) return 'limited'; // ticket 372: right after waiting, never idle
  if (all.includes('failed')) return 'failed';
  if (unread.has(g.project)) return 'unread';
  return all.includes('working') ? 'working' : all.includes('stale') ? 'stale' : 'idle';
}

export { basename };
