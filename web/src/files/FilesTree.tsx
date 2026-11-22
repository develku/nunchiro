// Files sidebar (▤): the focused session's folder or worktree as an ARIA tree. Folders load lazily through
// `files_list`; rows are virtualised, so a folder with 10,000 entries lists without freezing. Refreshes wait
// while the pointer or focus is inside, and so does a switch of the focused session: rows never move under the pointer
// (the projects tree's rule).
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import './files.css';
import { isGone, listDir, type Entry } from './api';
import { ensureSprite, iconFor } from './icons';
import { openFileAt, type FileRef } from './open';
import { Icon } from '../icons/Icon';
import { atPath } from '../images/nativeDrop';
import { Tr } from '../i18n';
import { ErrorDetails, plainError, tipError, rawError } from '../errors';
import { askNew } from '../NewSession';

const REFRESH_MS = 5000;

interface Row {
  path: string;
  entry: Entry;
  depth: number;
}
type Listing = Entry[] | { error: string };

interface Props {
  core: CoreClient;
  connected: boolean;
  /** The focused session: its id is the core's root. */
  session: Shown;
  /** Open folders per session id (window settings). */
  expanded: Record<string, string[]>;
  onExpanded: (root: string, paths: string[]) => void;
  /** The active file tab, marked in the tree when it belongs to the session shown. */
  selected: FileRef | null;
  /** v1a-65: the dock's side button, in the header. */
  action?: ReactNode;
}
type Shown = { id: string; cwd: string; label: string; machine?: string } | null;

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const rowPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 22;

export function FilesTree({ core, connected, session: focused, expanded: allExpanded, onExpanded, selected, action }: Props) {
  const inside = useRef({ pointer: false, focus: false });
  // The session whose tree is shown: it follows the focused one only while the pointer and focus are outside.
  const [held, setHeld] = useState<Shown>(focused);
  const latest = useRef(focused);
  latest.current = focused;
  useEffect(() => {
    if (!inside.current.pointer && !inside.current.focus) setHeld(focused);
  }, [focused]);
  const release = () => !inside.current.pointer && !inside.current.focus && setHeld(latest.current);
  const session = held?.id === focused?.id ? focused : held;
  const root = session?.id ?? null;
  // Ticket 374: Files is not forwarded over SSH yet (server.rs refuses it on purpose): a plain state, no listing.
  const ssh = !!session?.machine;
  const t = useContext(Tr);
  const expanded = useMemo(() => (root && allExpanded[root]) || [], [root, allExpanded]);
  const [dirs, setDirs] = useState<{ root: string | null; map: Map<string, Listing> }>({ root, map: new Map() });
  const map = dirs.root === root ? dirs.map : new Map<string, Listing>();
  const [active, setActive] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const open = useMemo(() => new Set(expanded), [expanded]);
  useEffect(ensureSprite, []);

  // Replies can overtake each other (the core lists outside its lock): a listing older than one already shown for
  // that folder, or for a session no longer focused, is dropped.
  const current = useRef(root);
  current.current = root;
  const seq = useRef({ next: 0, shown: new Map<string, number>() });
  const load = useCallback(
    async (paths: string[]) => {
      if (!root || ssh) return;
      const n = ++seq.current.next;
      const got = await Promise.all(
        paths.map((p) =>
          listDir(core, root, p).then(
            (e): [string, Listing] => [p, e],
            (e): [string, Listing] => [p, { error: rawError(e) }],
          ),
        ),
      );
      if (current.current !== root || got.some(([, l]) => 'error' in l && /core disconnected/.test(l.error))) return;
      const shown = seq.current.shown;
      const fresh = got.filter(([p]) => (shown.get(`${root}\0${p}`) ?? -1) < n);
      for (const [p] of fresh) shown.set(`${root}\0${p}`, n);
      setDirs((d) => {
        const next = new Map(d.root === root ? d.map : []);
        for (const [p, l] of fresh) next.set(p, l);
        return { root, map: next };
      });
    },
    [core, root, ssh],
  );

  // The root and every open folder, now and every few seconds unless the pointer or focus is inside.
  const all = useMemo(() => ['', ...expanded], [expanded]);
  useEffect(() => {
    if (!connected) return;
    void load(all);
    const t = setInterval(() => {
      if (!inside.current.pointer && !inside.current.focus && document.visibilityState === 'visible') void load(all);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load, all, connected]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      const l = map.get(dir);
      if (!l || 'error' in l) return;
      for (const entry of l) {
        const path = join(dir, entry.name);
        out.push({ path, entry, depth });
        if (entry.kind === 'dir' && open.has(path)) walk(path, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [map, open]);

  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: rowPx, overscan: 12 });
  const at = Math.min(active, Math.max(0, rows.length - 1));

  const toggle = (path: string) => {
    if (!root) return;
    if (open.has(path)) onExpanded(root, expanded.filter((p) => p !== path && !p.startsWith(`${path}/`)));
    else {
      onExpanded(root, [...expanded, path]);
      void load([path]);
    }
  };
  const activate = (r: Row) => (r.entry.kind === 'dir' ? toggle(r.path) : root && openFileAt(root, r.path));
  const focusRow = (i: number) => {
    setActive(i);
    v.scrollToIndex(i);
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus());
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Backspace') e.preventDefault(); // see Code.tsx: never "go back" out of the window
    const r = rows[at];
    if (!r || e.nativeEvent.isComposing) return;
    const go = (i: number) => (e.preventDefault(), focusRow(Math.max(0, Math.min(rows.length - 1, i))));
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (e.key === 'ArrowRight' && r.entry.kind === 'dir') {
      e.preventDefault();
      if (!open.has(r.path)) toggle(r.path);
      else if (rows[at + 1]?.depth === r.depth + 1) focusRow(at + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (r.entry.kind === 'dir' && open.has(r.path)) toggle(r.path);
      else if (r.depth > 0) focusRow(rows.findIndex((x) => x.path === parentOf(r.path)));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(r);
    }
  };

  const top = map.get('');
  const message = !session
    ? t('files.noSession')
    : ssh
      ? t('diff.ssh.unavailable')
    : top && 'error' in top
      ? isGone(top.error)
        ? t('rest.pf.tree.gone')
        : plainError(t, top.error)
      : top && !top.length
        ? t('rest.pf.tree.empty')
        : null;
  const name = session ? session.cwd.replace(/\/+$/, '').split('/').pop() || session.cwd : '';

  return (
    <aside className="files" aria-label={t('rest.pf.tree.files')}>
      <div className="ph">
        <span className="pt">{t('rest.pf.tree.files')}</span>
        <span className="r" title={session?.cwd}>
          {name}
        </span>
        {action}
      </div>
      {message ? (
        <div className="empty" role="status">
          {/* One child: .empty spreads its children apart, which would drop the button to the bottom. */}
          <span>
            {message}
            {session && !ssh && top && 'error' in top && !isGone(top.error) && <ErrorDetails t={t} details={top.error} />}
            {!session && (
              <>
                {' '}
                <button type="button" className="btn" onClick={() => askNew()}>
                  {t('empty.startSession')}
                </button>
              </>
            )}
          </span>
        </div>
      ) : (
        <div
          className="tree ftree"
          ref={scroller}
          role="tree"
          aria-label={t('rest.pf.tree.filesIn', { name })}
          onKeyDown={onKey}
          onPointerEnter={() => (inside.current.pointer = true)}
          onPointerLeave={() => ((inside.current.pointer = false), release())}
          onFocus={() => (inside.current.focus = true)}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && ((inside.current.focus = false), release())}
        >
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((item) => {
              const r = rows[item.index];
              const dir = r.entry.kind === 'dir';
              const l = dir ? map.get(r.path) : undefined;
              return (
                <div
                  key={r.path}
                  data-index={item.index}
                  data-path={r.path}
                  className="row frow"
                  role="treeitem"
                  data-menu="files" // V2-6a
                  data-menu-arg={session ? `${session.cwd.replace(/\/+$/, '')}/${r.path}` : undefined} // ticket 375: Copy path, Reveal, Add to chat
                  aria-level={r.depth + 1}
                  aria-expanded={dir ? open.has(r.path) : undefined}
                  aria-selected={selected?.root === root && r.path === selected.path}
                  data-ignored={r.entry.ignored || undefined}
                  // Roving focus: one tab stop. Other rows use -2, not -1, so hints (Ctrl+Space f) still reach
                  // them: the hint selector skips only tabindex="-1".
                  tabIndex={item.index === at ? 0 : -2}
                  style={{ position: 'absolute', top: 0, transform: `translateY(${item.start}px)`, paddingLeft: 6 + r.depth * 12 }}
                  // v1a-65: the app tooltip; the path only when the name is cut off, a listing error always.
                  data-tip={l && 'error' in l ? tipError(t, l.error) : r.path}
                  data-tip-clip={l && 'error' in l ? undefined : ''}
                  // Ticket 371 item 22: dragged as text, so a composer's textarea takes the @path at the drop point by itself.
                  draggable={atPath(r.path) !== null}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', atPath(r.path) ?? '');
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => (setActive(item.index), activate(r))}
                >
                  <span className="chev" aria-hidden>
                    {dir && <Icon name={open.has(r.path) ? 'chevron-down' : 'chevron-right'} size={12} />}
                  </span>
                  <svg className="fi" aria-hidden="true" focusable="false">
                    <use href={`#fi-${iconFor(r.entry.name, r.entry.kind, open.has(r.path))}`} />
                  </svg>
                  <span className="n">{r.entry.name}</span>
                  {r.entry.kind === 'symlink' && <span className="dim" aria-label={t('rest.pf.tree.link')}>↗</span>}
                  {r.entry.git && (
                    <span className="r fgit" data-git={r.entry.git} aria-label={`git ${r.entry.git}`}>
                      {r.entry.git}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
