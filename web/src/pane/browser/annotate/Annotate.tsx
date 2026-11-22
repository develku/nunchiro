// V2.5-22 (WP4): element notes on the browser view. The app's guest picker reports a clicked element (`browser-picked`);
// The owner writes a note on each, and "Add to composer" puts the Orca-format Markdown block into the composer draft. It is
// never sent: the composer's own Enter does that (threat model A12).
import { PLAIN } from '../../../plainText';
import { useEffect, useRef, useState } from 'react';
import type { T } from '../../../i18n';
import { call } from '../view/bridge';
import { ErrorLine } from '../../../errors';
import { formatBrowserAnnotationsAsMarkdown, type PickedElement } from './output';
import { BIcon } from '../view/icons';
import './annotate.css';

interface Note {
  element: PickedElement;
  comment: string;
}

/** A pick the formatter can render; anything else is dropped, never half-shown. */
const wellFormed = (el: PickedElement | undefined): el is PickedElement =>
  !!el && typeof el.page?.sanitizedUrl === 'string' && typeof el.target?.selector === 'string' && typeof el.target?.tagName === 'string' && !!el.target.rectViewport && Array.isArray(el.nearbyText);

/** `tab`: ticket 328 part 2, the agent's tab the picker runs in (1: the space's own view). Ticket 997 L7: the toolbar's icon
 *  `button` and the `notes` under it, both null where Annotate is not `offered` (another session's space). */
/** Ticket 1038: `insert` absent means no session can take notes (the icon stays, inert, and says so); `to` names the
 *  session they go to; `page`: a page is open (the picker needs one). */
export function useAnnotate({ space, tab = 1, app, page, offered, insert, to, t }: { space: string; tab?: number; app: boolean; page: boolean; offered: boolean; insert?: (text: string) => void; to?: string; t: T }) {
  const at = tab > 1 ? { tab } : {};
  const [on, setOn] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<unknown>('');
  const live = useRef(false); // the picker is on in the page: leaving the tab switches it off, it must not outlive its button
  live.current = on;

  useEffect(() => {
    if (!app || !offered) return;
    let off: (() => void) | undefined;
    let gone = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ space: string; element: PickedElement }>('browser-picked', (e) => e.payload.space === space && wellFormed(e.payload.element) && setNotes((n) => [...n, { element: e.payload.element, comment: '' }])))
      .then((f) => (gone ? f() : (off = f)))
      .catch(() => {}); // a refused subscription leaves picking off; it never rejects unhandled
    return () => {
      gone = true;
      off?.();
    };
  }, [app, space, offered]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => void (live.current && call('browser_annotate', { space, ...at, on: false }).catch(() => {})), [space, tab]);

  const off = !app || !page || !insert;
  const toggle = () => {
    if (off && !on) return;
    setError('');
    const next = !on;
    call('browser_annotate', { space, ...at, on: next }).then(() => setOn(next), setError);
  };
  const send = () => {
    insert?.(formatBrowserAnnotationsAsMarkdown(notes.map((n) => ({ browserPageId: space, payload: n.element, comment: n.comment }))));
    setNotes([]);
  };

  if (!offered) return { button: null, notes: null, item: null, picks: 0 };
  const button = (
    // aria-disabled, not disabled: the icon keeps its focus and its tooltip, which says why it does nothing.
    <button type="button" className="bib bann" aria-label={t('browserPane.annotate')} data-tip={t(insert ? 'browserPane.annotateTip' : 'browserPane.annotateNoSession')} aria-pressed={on} aria-disabled={off && !on} onClick={toggle}>
      <BIcon name="annotate" />
    </button>
  );
  const panel = (on || notes.length > 0) && (
    <section className="bnotes" aria-label={t('browserPane.annotations')}>
      {to && <div className="bnotes-to">{t('browserPane.notesTo', { name: to })}</div>}
      <ErrorLine t={t} error={error} className="" />
      {notes.length === 0 && <div className="empty">{t('browserPane.pickHint')}</div>}
      {notes.map((n, i) => (
        <div key={i} className="bnote">
          <code>{n.element.target.selector}</code>
          <textarea {...PLAIN} aria-label={t('browserPane.note', { n: i + 1 })} rows={2} value={n.comment} onChange={(e) => setNotes(notes.map((x, j) => (j === i ? { ...x, comment: e.target.value } : x)))} />
          <button type="button" aria-label={t('browserPane.removeNote', { n: i + 1 })} onClick={() => setNotes(notes.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" disabled={notes.length === 0} onClick={send}>
        {t('browserPane.addToComposer')}
      </button>
    </section>
  );
  // The mockup's narrow rule: under about 260 px Annotate moves into ⋯ (browser-view.css), as Orca drops its label first.
  const item = (close: () => void) => (
    <button type="button" role="menuitemcheckbox" className="bmann" aria-checked={on} disabled={off && !on} onClick={() => (close(), toggle())}>
      {t('browserPane.annotate')}
      <small>{t(insert ? 'browserPane.annotateTip' : 'browserPane.annotateNoSession')}</small>
    </button>
  );
  // S3-1: `picks` lets the view close its More menu on a pick, a click the window itself never sees.
  return { button, notes: panel || null, item, picks: notes.length };
}
