// The composer's "+" (claude-feel-2 `.ib`): attach a file (in the app) or an image (browser build).
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChromeIcon } from './icons';
import { inApp, insertPaths, note } from '../images/nativeDrop';
import { pickFiles } from '../pickFolder';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import { tipError } from '../errors';

export function PlusMenu({ disabled, onFiles }: { disabled: boolean; onFiles: (files: File[]) => void }) {
  const [open, setOpen] = useState(false);
  const t = useHtmlLangT(); // ticket 492
  const root = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The menu pattern of menu/ContextMenu.tsx: focus goes in on open, arrows move (wrapping), Esc closes and focus returns to +.
  useEffect(() => void (open && menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()), [open]);
  const move = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => (e.preventDefault(), list[(i + list.length) % list.length]?.focus());
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.code === 'Escape' && !e.isComposing && (setOpen(false), button.current?.focus());
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  // Ticket 371 item 22: in the app a file of any type goes in as its path; the browser build keeps image chips.
  const attachFiles = () => {
    const box = root.current?.closest<HTMLElement>('.cbox');
    if (box) pickFiles().then((paths) => paths.length && insertPaths(box, paths), (e) => note(box, t('mw.plus.pickerFailed', { error: tipError(t, e) })));
  };
  return (
    <span className="plus" ref={root}>
      <button ref={button} className="cib" aria-label={t('mw.plus.add')} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <ChromeIcon name="plus" size={16} />
      </button>
      {open && (
        <div ref={menu} className="plusmenu" role="menu" aria-label={t('mw.plus.menu')} onKeyDown={move}>
          <button role="menuitem" onClick={() => (setOpen(false), inApp() ? attachFiles() : input.current?.click())}>
            {t(inApp() ? 'mw.plus.file' : 'mw.plus.image')}
          </button>
        </div>
      )}
      <input ref={input} type="file" accept="image/*" multiple hidden aria-hidden tabIndex={-1} onChange={(e) => (onFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />
    </span>
  );
}
