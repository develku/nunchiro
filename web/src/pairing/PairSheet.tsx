// V2.5-15: the Mac window's side of browser access. A pairing waits for Allow or Deny here (only the window can answer
// it), and every change a browser makes is noted (needs 80: every phone action noticed on the Mac).
import { useEffect, useRef, useState } from 'react';
import { docT, ErrorLine } from '../errors';
import type { BrowserNotice, CoreClient, PairRequest } from '../api';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import './pairing.css';

const SHOWN_MS = 8000;

export function PairSheet({ core }: { core: CoreClient }) {
  const t = useHtmlLangT();
  const [pending, setPending] = useState<PairRequest[]>([]);
  const [notices, setNotices] = useState<BrowserNotice[]>([]);
  const [seen, setSeen] = useState<number | null>(null);
  const [error, setError] = useState<unknown>('');
  useEffect(() => {
    core.onBrowser = (p, n) => {
      setPending(p);
      setNotices(n);
      // The first event after connecting: what it already lists is history, not news.
      setSeen((seen) => seen ?? (n.at(-1)?.seq ?? 0));
    };
    return () => {
      core.onBrowser = () => {};
    };
  }, [core]);
  const last = notices.at(-1)?.seq ?? 0;
  const fresh = notices.filter((n) => seen !== null && n.seq > seen && Date.now() - n.at_ms < SHOWN_MS);
  useEffect(() => {
    if (!fresh.length) return;
    const t = setTimeout(() => setSeen(last), SHOWN_MS);
    return () => clearTimeout(t);
  }, [fresh.length, last]);
  const r = pending[0];
  const dialog = useRef<HTMLDivElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  // One answer per request: set from the call until a failure frees it (a success leaves it until the request is gone).
  const answered = useRef<string | null>(null);
  const answer = (allow: boolean) => {
    if (!r || answered.current === r.id) return;
    answered.current = r.id;
    return core.browserAccess({ op: 'answer', id: r.id, allow }).then(
      () => setError(''),
      (e: Error) => ((answered.current = null), setError(e)),
    );
  };
  // Focus goes inside when the dialog opens (on the dialog itself, not a button: a Space or Enter the owner was typing
  // elsewhere when it arrived answers nothing) and back to where it was when it is answered.
  const open = !!r;
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, [open]);
  useEffect(() => {
    if (r) dialog.current?.focus();
  }, [r?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Only a key the owner pressed counts: a keydown a page script or a widget frame dispatched is not trusted. Esc is
  // Deny, never Allow; Tab cycles the buttons inside the dialog and leaves the dialog itself for Deny; Space and Enter on the dialog
  // itself do nothing (on a button they are that button's click).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) e.preventDefault();
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void answer(false);
    } else if (e.key === 'Tab') {
      // Every Tab is moved here, never left to the browser: WebKit's Tab skips buttons (Safari's "Tab to links" off), so
      // a default move from Allow left the dialog in the Mac app.
      const keys = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
      if (!keys.length) return;
      e.preventDefault();
      const at = keys.indexOf(document.activeElement as HTMLElement);
      if (at < 0) deny.current?.focus();
      else keys[(at + (e.shiftKey ? -1 : 1) + keys.length) % keys.length].focus();
    }
  };
  return (
    <>
      {r && (
        <div ref={dialog} className="pair-sheet" role="dialog" aria-label={t('rest.pf.sheet.label')} tabIndex={-1} onKeyDown={onKeyDown}>
          <b>{t('rest.pf.sheet.asks', { name: r.name })}</b>
          <p>{r.loopback ? t('rest.pf.sheet.loopback') : t('rest.pf.sheet.peer', { peer: r.peer })}</p>
          <p>{t('rest.pf.sheet.showsCode')}</p>
          <p className="pair-code">{r.code}</p>
          <p className="dim">{t('rest.pf.sheet.can')}</p>
          <div className="browser-acts">
            <button className="pair-btn primary" onClick={() => void answer(true)}>
              {t('rest.pf.sheet.allow')}
            </button>
            <button ref={deny} className="pair-btn" onClick={() => void answer(false)}>
              {t('rest.pf.sheet.deny')}
            </button>
          </div>
          {pending.length > 1 && <p className="dim">{t('rest.pf.sheet.more', { n: pending.length - 1 })}</p>}
          <ErrorLine t={docT()} error={error} className="" />
        </div>
      )}
      {fresh.length > 0 && (
        <div className="browser-notices" role="status" aria-label={t('rest.pf.sheet.actions')}>
          {fresh.map((n) => (
            <p key={n.seq}>
              {t(n.action === 'answer' ? 'rest.pf.sheet.answered' : 'rest.pf.sheet.replied', { name: n.name })}
            </p>
          ))}
        </div>
      )}
    </>
  );
}
