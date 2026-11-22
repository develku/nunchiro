// V2.5-15 (needs 139): the composer's Stash and Stashed drafts buttons. Stash moves the box's text and image chips into
// the stash; Apply puts one back into this box (after what is typed), whichever session it is for. Nothing is sent.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { MAX_IMAGES, type Images } from '../images/attach';
import type { T } from '../i18n';
import type { Session } from '../types';
import { drop, stash, useStash } from './stash';
import './composer-menu.css';

const CONTROL = 'input, textarea, select, button, a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

export function ComposerStash({ session, name, images, t }: { session: Session | null; name: string; images: Images; t: T }) {
  const root = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const all = useStash();
  // needs 172: opened with the mouse, focus may sit anywhere (or nowhere), so Esc and a press outside are heard on the document
  // (the picker's pattern, picker/Picker.tsx). Both hand focus back to the drafts button, except a press that landed on a
  // control (a field, a button, a link): focus stays where the user put it.
  useEffect(() => {
    if (!open) return;
    const back = () => root.current?.querySelector<HTMLElement>('.cib[aria-expanded]')?.focus();
    const away = (e: PointerEvent) => {
      if (root.current?.contains(e.target as Node)) return;
      setOpen(false);
      setTimeout(() => !document.activeElement?.matches(CONTROL) && back());
    };
    const esc = (e: KeyboardEvent) => {
      // An overlay over the composer (the image viewer is a modal <dialog>) takes its own Esc: the popover stays.
      if (e.code !== 'Escape' || e.isComposing || e.defaultPrevented || (e.target as Element | null)?.closest?.('dialog')) return;
      setOpen(false);
      back();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const area = () => root.current?.closest('.cbox')?.querySelector<HTMLTextAreaElement>('textarea:not(.hoff-edit)') ?? null;
  // Ticket 395 r2: whether the box holds text, read after each commit, never during render. The box is shared across tabs and
  // its ref callback swaps in the session's draft in this same commit (it sits before us in the tree, so it has run by now);
  // a read during render saw the session left behind, and nothing re-rendered. A change re-renders before paint.
  const [text, setText] = useState(false);
  const why = useId(); // Ticket 412: a disabled control names its reason to screen readers too (aria-describedby to a hidden span), not only in its tooltip.
  useLayoutEffect(() => {
    const has = !!area()?.value;
    if (has !== text) setText(has);
  });
  if (!session) return null;
  const live = session.state === 'running';
  const chips = images.of(session.id);
  const room = MAX_IMAGES - chips.length;
  const empty = !(chips.length || text);

  const put = () => {
    const el = area();
    if (!el || (!el.value && !chips.length)) return;
    stash({ text: el.value, files: chips.map((c) => c.blob as File), from: name });
    chips.forEach((c) => images.remove(session.id, c.id));
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true })); // the composer's own grow and draft handling
  };

  const toggle = () => root.current?.querySelector<HTMLElement>('.cib[aria-expanded]')?.focus(); // a removed row takes focus with it

  const apply = (id: string) => {
    const el = area();
    const s = all.find((x) => x.id === id);
    if (!el || !s || s.files.length > room) return; // the button is disabled then: the images would be cut off and lost
    el.value = [el.value, s.text].filter(Boolean).join('\n');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    if (s.files.length) void images.add(session.id, s.files);
    drop(id);
    if (all.length === 1) setOpen(false);

  };

  return (
    <span className="cmenus" ref={root} onBlur={(e) => e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)} // WebKit gives a clicked button no focus: a null target is not leaving
    onKeyDown={(e) => e.key === 'Escape' && open && (e.stopPropagation(), setOpen(false), toggle())}>
      {/* Ticket 395: nothing to stash and nothing stashed, the button is hidden; its place is kept (visibility, not removal) so
          the Stashed drafts button and the chips after it do not move when typing brings it back. */}
      <button className={`cib${empty && !all.length ? ' away' : ''}`} aria-label={t('drafts.stash')} title={t('drafts.stash')} disabled={!live || chips.some((c) => c.saving) || empty} onClick={put}>
        ⤓
      </button>
      <button className="cib" aria-label={t('drafts.open', { n: all.length })} title={t('drafts.open', { n: all.length })} aria-expanded={open} aria-haspopup="true" disabled={!live} onClick={() => setOpen((o) => !o)}>
        ⤒{all.length > 0 && <sup>{all.length}</sup>}
      </button>
      {open && (
        <div className="composer-menu" role="group" aria-label={t('drafts.title')}>
          <div className="gh" aria-hidden="true">
            {t('drafts.title')}
          </div>
          {all.map((s) => (
            <div key={s.id} className="i">
              <button className="apply" disabled={s.files.length > room} title={s.files.length > room ? t('drafts.noRoom') : undefined} aria-describedby={s.files.length > room ? why : undefined} onClick={() => apply(s.id)}>
                {t('drafts.apply')}: {s.text.slice(0, 60) || t('drafts.imagesOnly')}
                {/* Ticket 371 item 24: an image the budget took or the store could not give back is named here, never lost silently. */}
                <span className="d" style={s.dropped.length || s.unreadable.length ? { whiteSpace: 'normal' } : undefined}>
                  {[s.from, s.files.length ? t('drafts.images', { n: s.files.length }) : '', s.dropped.length ? t('drafts.dropped', { names: s.dropped.join(', ') }) : '', s.unreadable.length ? t('drafts.unreadable', { names: s.unreadable.join(', ') }) : ''].filter(Boolean).join(' · ')}
                </span>
              </button>
              <button className="discard" aria-label={t('drafts.discard')} title={t('drafts.discard')} onClick={() => (drop(s.id), toggle())}>
                ×
              </button>
            </div>
          ))}
          {all.some((s) => s.files.length > room) && (
            <span id={why} hidden>
              {t('drafts.noRoom')}
            </span>
          )}
          {!all.length && <div className="none">{t('drafts.none')}</div>}
        </div>
      )}
    </span>
  );
}
