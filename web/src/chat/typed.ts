// The Assistant's folder grant counts only a message the owner typed (folder_grant.rs `named`). The composer box is
// clean while every change since it was last empty came from typing: `beforeinput` of insertText, an IME's
// insertCompositionText, a line break or a delete. A paste, a drop, an undo, an autocomplete, or text Nunchiro put in
// the box (a recalled prompt, a restored draft, a menu insert: no `beforeinput` at all, so the box no longer reads as
// last seen) makes it unclean until it is empty again; a message sent from an unclean box offers no folder.
const TYPED = /^(insertText|insertCompositionText|insertLineBreak|insertParagraph|delete\w*)$/;
const seen = new WeakMap<HTMLTextAreaElement, { last: string; clean: boolean }>();
const box = (t: EventTarget | null) => (t instanceof HTMLTextAreaElement && t.closest('.composer') ? t : null);

if (typeof document !== 'undefined') {
  document.addEventListener(
    'beforeinput',
    (e) => {
      const el = box(e.target);
      if (!el) return;
      const was = seen.get(el) ?? { last: '', clean: true };
      // An empty box holds nothing from anywhere: it starts clean.
      const start = el.value === '' ? { last: '', clean: true } : was;
      seen.set(el, { last: start.last, clean: start.clean && start.last === el.value && TYPED.test((e as InputEvent).inputType) });
    },
    true,
  );
  document.addEventListener(
    'input',
    (e) => {
      const el = box(e.target);
      const now = el && seen.get(el);
      if (el && now) seen.set(el, { last: el.value, clean: now.clean });
    },
    true,
  );
}

/** The box's text came from typing only, as it reads now. */
export const typedBox = (el: HTMLTextAreaElement) => {
  const s = seen.get(el);
  return !!s && s.clean && s.last === el.value && el.value !== '';
};
