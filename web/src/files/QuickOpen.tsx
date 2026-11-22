// Ticket 821: ⌘P finds a file of the shown session's folder by part of its name and opens its file tab. The names come
// from the core's `files_search` with `names` (it leaves ignored files out); the look is the palette's (`.palette`).
import { PLAIN } from '../plainText';
import { useEffect, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import { label, type Bindings } from '../keys';
import type { Key } from '../i18n';
import { pageFocus } from '../pane/browser/view/bridge';
import { baseName, openFileAt } from './open';

type T = (key: Key, args?: Record<string, string | number>) => string;
type Found = { q: string; paths: string[]; more: boolean; failed?: boolean; skipped?: string[] };

const SHOWN = 50;
const WAIT_MS = 100; // one core walk per pause in typing, not per key

/** The name itself (with or without its extension) first, then a name that starts with the query, then one that holds
 *  it, then a match in the folder part only; inside one tier the shorter path, then A to Z. */
export function rankPaths(paths: string[], query: string): string[] {
  const q = query.toLowerCase();
  const tier = (p: string) => {
    const n = baseName(p).toLowerCase();
    return n === q || n.replace(/\.[^.]*$/, '') === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3;
  };
  return [...paths].sort((a, b) => tier(a) - tier(b) || a.length - b.length || a.localeCompare(b));
}

export function QuickOpen({ core, root, bindings, onClose, t }: { core: CoreClient; root: string | null; bindings: Bindings; onClose: () => void; t: T }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [found, setFound] = useState<Found | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  const query = q.trim();
  useEffect(() => {
    if (!root || !query) return;
    let live = true;
    const timer = setTimeout(
      () =>
        core.request({ op: 'files_search', root, query, path: '', names: true }).then(
          (r) => {
            const m = r as { matches?: { path: string }[]; truncated?: boolean; skipped_ignore_files?: string[] };
            if (live) setFound({ q: query, paths: rankPaths((m.matches ?? []).map((x) => x.path), query).slice(0, SHOWN), more: !!m.truncated || (m.matches?.length ?? 0) > SHOWN, skipped: m.skipped_ignore_files });
          },
          () => live && setFound({ q: query, paths: [], more: false, failed: true }),
        ),
      WAIT_MS,
    );
    return () => ((live = false), clearTimeout(timer));
  }, [core, root, query]);
  const shown = found && found.q === query ? found : null;
  const list = shown?.paths ?? [];
  useEffect(() => {
    input.current?.focus();
    const prev = back.current;
    return () => (prev as HTMLElement | null)?.focus?.();
  }, []);
  useEffect(() => {
    document.getElementById(`qo-${sel}`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  // As the palette: Esc (wherever focus is) and a press outside close it.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !e.isComposing && (e.stopPropagation(), pageFocus(true), onClose());
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    window.addEventListener('keydown', esc, true);
    document.addEventListener('pointerdown', away, true);
    return () => (window.removeEventListener('keydown', esc, true), document.removeEventListener('pointerdown', away, true));
  }, [onClose]);
  const open = (p?: string) => {
    if (!p || !root) return;
    pageFocus(false);
    onClose();
    setTimeout(() => openFileAt(root, p), 0); // after focus returns, so the file tab takes it
  };
  const searchKey = bindings['search.open']?.[0];
  const empty = !root ? t('quickOpen.noFolder') : !query ? t('quickOpen.type') : shown?.failed ? t('quickOpen.failed') : shown && !list.length ? [t('quickOpen.none', { q: query }), searchKey && t('quickOpen.searchText', { key: label(searchKey, bindings) })].filter(Boolean).join(' ') : '';
  return (
    <div ref={box} className="palette glass" role="dialog" aria-modal="true" aria-label={t('settings.kbd.cmd.files.quickOpen')}>
      <input {...PLAIN}
        ref={input}
        role="combobox"
        aria-label={t('quickOpen.search')}
        aria-expanded="true"
        aria-controls="quick-open-list"
        aria-activedescendant={list[sel] ? `qo-${sel}` : undefined}
        placeholder={t('quickOpen.type')}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(s + 1, list.length - 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
          else if (e.key === 'Enter') (e.preventDefault(), open(list[sel]));
        }}
      />
      <ul id="quick-open-list" role="listbox" aria-label={t('quickOpen.list')}>
        {list.map((p, i) => {
          const dir = p.slice(0, p.length - baseName(p).length).replace(/\/$/, '');
          return (
            <li key={p} id={`qo-${i}`} role="option" aria-selected={i === sel} data-path={p} onMouseEnter={() => setSel(i)} onClick={() => open(p)}>
              <span>{baseName(p)}</span>
              {dir && <span className="branch" data-tip={dir} data-tip-clip="">{dir}</span>}
            </li>
          );
        })}
        {empty && (
          <li role="status" className="empty" style={{ color: 'var(--muted)', cursor: 'default' }}>
            {empty}
          </li>
        )}
        {/* Round 2: the core leaves a folder out when its .gitignore is not applied; the Search panel's note says which. */}
        {!!shown?.skipped?.length && (
          <li role="note" className="empty" title={shown.skipped.join('\n')} style={{ color: 'var(--muted)', cursor: 'default' }}>
            {t('mw.search.gitignore', { names: shown.skipped.join(', ') })}
          </li>
        )}
        {shown?.more && (
          <li role="status" className="empty" style={{ color: 'var(--muted)', cursor: 'default' }}>
            {t('quickOpen.more')}
          </li>
        )}
      </ul>
    </div>
  );
}
