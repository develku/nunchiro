// Find bar over one terminal (v1a-35, @xterm/addon-search): the window's copy only (2000 lines), never the PTY.
import { PLAIN } from '../plainText';
import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';

export const FIND_EVENT = 'nunchiro:terminal.find';
/** Opens (or refocuses) the find bar of session `id`'s terminal. */
export const findIn = (id: string) => window.dispatchEvent(new CustomEvent<string>(FIND_EVENT, { detail: id }));

/** A theme token as #rrggbb[aa]: xterm decorations take hex only, so the browser resolves the token and we spell it out. */
const hex = (token: string, alpha?: number) => {
  const probe = document.body.appendChild(document.createElement('i'));
  probe.style.color = `var(${token})`;
  const [r, g, b] = getComputedStyle(probe).color.match(/[\d.]+/g)!.map(Number);
  probe.remove();
  return '#' + [r, g, b, ...(alpha === undefined ? [] : [alpha])].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
};
/** Read per search, so a theme change shows on the next match. */
const opts = (): ISearchOptions => ({
  decorations: {
    matchBackground: hex('--mark', 0x66),
    matchOverviewRuler: hex('--warn'),
    activeMatchBackground: hex('--mark-current', 0x99),
    activeMatchBorder: hex('--mark-current-line'),
    activeMatchColorOverviewRuler: hex('--mark-current-line'),
  },
});

export function FindBar({ term, search, nonce, onClose }: { term: Terminal; search: SearchAddon; nonce: number; onClose: () => void }) {
  const t = useHtmlLangT();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ resultIndex: number; resultCount: number } | null>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [nonce]);
  useEffect(() => {
    const sub = search.onDidChangeResults(setResult);
    return () => (sub.dispose(), search.clearDecorations());
  }, [search]);

  const find = (q: string, back = false) => {
    if (!q) return (search.clearDecorations(), setResult(null));
    if (back) search.findPrevious(q, opts());
    else search.findNext(q, opts());
  };
  const close = () => {
    search.clearDecorations();
    onClose();
    term.focus();
  };
  const count = !query || !result ? '' : result.resultCount === 0 ? t('fvfind.none') : result.resultIndex < 0 ? t('rest.st.matchesMore', { n: result.resultCount }) : t('rest.st.matchOf', { i: result.resultIndex + 1, n: result.resultCount });

  return (
    <div className="tfind glass" role="search" aria-label={t('rest.st.findTerm')}>
      <input {...PLAIN}
        ref={input}
        type="search"
        className="search"
        aria-label={t('rest.st.findTerm')}
        placeholder={t('fvfind.find')}
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value) search.findNext(e.target.value, { ...opts(), incremental: true });
          else find('');
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') (e.preventDefault(), find(query, e.shiftKey));
          else if (e.key === 'Escape') (e.preventDefault(), close());
        }}
      />
      <span role="status" className="dim">
        {count}
      </span>
      <button className="btn" aria-label={t('fvfind.previous')} title={t('rest.st.prevTip')} disabled={!query} onClick={() => find(query, true)}>
        ↑
      </button>
      <button className="btn" aria-label={t('fvfind.next')} title={t('rest.st.nextTip')} disabled={!query} onClick={() => find(query)}>
        ↓
      </button>
      <button className="btn" aria-label={t('fvfind.close')} title={t('rest.st.findCloseTip')} onClick={close}>
        ×
      </button>
    </div>
  );
}
