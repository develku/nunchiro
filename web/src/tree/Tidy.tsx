// V2-8g (WTDIALOGS Draft 3, "Merged / tidy"): the Tidy panel lists the worktrees of every project by state and removes
// the merged ones in one go. Only a merged worktree with a clean tree and no running session can be checked; the bulk
// action is the V2-8a clean remove (non-force, branch kept, Undo), so a dirty worktree is resolved through its own dialog.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKey } from 'react';
import type { WorktreeLoss } from '../api';
import { basename, rowState, listedName, type ListedWorktree, type WorktreeFact } from '../tree';
import type { Session } from '../types';
import './tidy.css';
import { Icon } from '../icons/Icon';
import type { Key } from '../i18n';
import { plural, type T } from './state';

type Kind = 'merged' | 'empty' | 'dirty' | 'gone';
interface Entry {
  l: ListedWorktree;
  kind: Kind;
  /** The row's state text. */
  text: string;
}

const GROUPS: { kind: Kind; title: Key }[] = [
  { kind: 'merged', title: 'dialog.tidy.group.merged' },
  { kind: 'empty', title: 'wtbase.group.empty' },
  { kind: 'gone', title: 'dialog.tidy.group.gone' },
  { kind: 'dirty', title: 'dialog.tidy.group.dirty' },
];
/** The same rule as auto-clean (`starts_with` on path components): a session in a subfolder keeps its worktree. */
const within = (cwd: string, dir: string) => cwd === dir || cwd.startsWith(dir.replace(/\/+$/, '') + '/');

/** What the core found when it refused a removal: the row's state text. */
export const lossText = (t: T, l: WorktreeLoss) =>
  l.uncommitted_total > 0 ? plural(t, 'dialog.tidy.unsavedFile', l.uncommitted_total) : l.ignored_total > 0 ? plural(t, 'dialog.tidy.ignored', l.ignored_total) : t('dialog.tidy.commitsOnly');

/**
 * The tidy candidates, one state each: merged (the tree row's own test, `rowState`, so the panel and "Merged - remove"
 * agree), folder gone, or needs a decision (unsaved work, or a removal the core refused: `held`). A worktree with a
 * running session, and a clean one that is not merged, are not candidates and are not listed.
 */
export function entriesOf(t: T, list: ListedWorktree[], facts: ReadonlyMap<string, WorktreeFact>, sessions: Session[], held: ReadonlyMap<string, WorktreeLoss> = new Map()): Entry[] {
  return list.flatMap((l): Entry[] => {
    const mine = sessions.filter((s) => within(s.cwd, l.path));
    const fact = facts.get(l.path);
    const n = l.facts?.uncommitted ?? 0;
    if (mine.some((s) => s.state === 'running')) return [];
    if (l.missing) return [{ l, kind: 'gone', text: t('dialog.tidy.recordOnly') }];
    if (held.has(l.path)) return [{ l, kind: 'dirty', text: lossText(t, held.get(l.path)!) }];
    if (n > 0) return [{ l, kind: 'dirty', text: plural(t, 'dialog.tidy.unsavedFile', n) }];
    if (rowState({ path: l.path, name: listedName(l, sessions), sessions: mine }, mine, fact).kind === 'merge') return [{ l, kind: 'merged', text: fact?.pr?.number ? t('dialog.tidy.mergedPr', { number: fact.pr.number }) : t('dialog.tidy.merged') }];
    // Ticket 374 (after T3 Code's StorageSettings rule, behaviour only): no commits past the project's current branch,
    // nothing uncommitted, a branch to keep for Undo, and no session that could come back. Not merged work: the row
    // starts unchecked, and its text says the count is against the current branch.
    if (l.branch && fact?.newBranch && n === 0 && mine.every((s) => s.state === 'closed' || s.state === 'exited')) return [{ l, kind: 'empty', text: t(mine.length ? 'wtbase.emptyClosed' : 'wtbase.emptyNone') }];
    return [];
  });
}

interface Props {
  list: ListedWorktree[];
  facts: ReadonlyMap<string, WorktreeFact>;
  sessions: Session[];
  project: string | null;
  t: T;
  /** Removes each path (the clean remove, or the record of a gone folder); resolves to the ones the core kept, with why. */
  onRemove: (paths: string[]) => Promise<Map<string, WorktreeLoss>>;
  onResolve: (path: string) => void;
  onOpen: (path: string) => void;
  onClose: () => void;
}

export function TidyPanel({ list, facts, sessions, project, t, onRemove, onResolve, onOpen, onClose }: Props) {
  const [only, setOnly] = useState(project);
  // Rows whose box differs from their group's start (merged and gone start checked, no commits unchecked).
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const on = (kind: Kind, path: string) => kind !== 'dirty' && (kind === 'empty') === flipped.has(path);
  const [held, setHeld] = useState<ReadonlyMap<string, WorktreeLoss>>(new Map());
  const [menu, setMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  const shown = entriesOf(t, list, facts, sessions, held).filter((e) => !only || e.l.project === only);
  const picked = shown.filter((e) => on(e.kind, e.l.path));
  const projects = new Set(shown.map((e) => e.l.project)).size;
  const title = t('dialog.tidy.title', { worktrees: plural(t, 'dialog.tidy.worktree', shown.length), projects: plural(t, 'dialog.tidy.project', projects) });
  const remove = () => {
    if (!picked.length || busy) return;
    setBusy(true);
    // The panel stays open when the core kept some: they are now rows that need a decision.
    void onRemove(picked.map((e) => e.l.path)).then((kept) => (kept.size ? (setHeld((h) => new Map([...h, ...kept])), setBusy(false)) : onClose()));
  };
  useEffect(() => {
    // Focus waits one frame: a palette that opened the panel is still closing and would take it back.
    const t = window.setTimeout(() => box.current?.querySelector<HTMLElement>('.acts .btn')?.focus());
    const prev = back.current;
    return () => (window.clearTimeout(t), (prev as HTMLElement | null)?.focus?.());
  }, []);
  const key = (e: ReactKey) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return menu ? setMenu(null) : onClose();
    }
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') return (e.preventDefault(), remove());
    if (e.key !== 'Tab') return;
    const f = [...(box.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [])];
    const i = f.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
  };
  return (
    <div ref={box} className="palette gname wtdlg tidy" role="dialog" aria-modal="true" aria-label={title} onKeyDown={key}>
      <p className="wtttl">
        <span>{title}</span>
        {project && (
          <button className="btn" aria-pressed={!only} onClick={() => setOnly(only ? null : project)}>
            {t('dialog.tidy.allProjects')}
          </button>
        )}
      </p>
      {shown.length === 0 && <p className="wthint">{t('dialog.tidy.nothing')}</p>}
      {GROUPS.map(({ kind, title: groupTitle }) => {
        const rows = shown.filter((e) => e.kind === kind);
        if (!rows.length) return null;
        return (
          <section key={kind} aria-label={t('dialog.tidy.groupLabel', { title: t(groupTitle), count: rows.length })}>
            <p className="wtcap">{t('dialog.tidy.groupLabel', { title: t(groupTitle), count: rows.length })}</p>
            <ul>
              {rows.map(({ l, text }) => {
                const name = (
                  <span className="tn">
                    {basename(l.project)} · {listedName(l, sessions)} <small>{text}</small>
                  </span>
                );
                return (
                  <li key={l.path}>
                    <label>
                      {/* A dirty row cannot be picked in bulk, so its box is drawn disabled: the names still line up. */}
                      <input
                        type="checkbox"
                        disabled={kind === 'dirty'}
                        checked={on(kind, l.path)}
                        onChange={() => setFlipped((o) => new Set(o.has(l.path) ? [...o].filter((p) => p !== l.path) : [...o, l.path]))}
                      />
                      {name}
                    </label>
                    {kind === 'dirty' && (
                      <span className="resolve">
                        <button className="btn" aria-haspopup="menu" aria-expanded={menu === l.path} onClick={() => setMenu(menu === l.path ? null : l.path)}>
                          {t('dialog.tidy.resolve')} <Icon name="triangle-down" size={7} />
                        </button>
                        {menu === l.path && (
                          <span role="menu" aria-label={t('dialog.tidy.resolveFor', { name: listedName(l, sessions) })} className="rmenu glass">
                            <button role="menuitem" className="btn" onClick={() => (setMenu(null), onOpen(l.path))}>
                              {t('dialog.tidy.openShell')}
                            </button>
                            <button role="menuitem" className="btn" onClick={() => onResolve(l.path)}>
                              {t('dialog.tidy.discard')}
                            </button>
                          </span>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <p className="acts wtacts">
        <button className="btn" onClick={onClose}>
          {t('dialog.cancel')}
        </button>
        <button className="btn" disabled={!picked.length || busy} onClick={remove}>
          {t('dialog.tidy.removeSelected', { n: picked.length })}
        </button>
      </p>
    </div>
  );
}
