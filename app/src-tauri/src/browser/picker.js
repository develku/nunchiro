// V2.5-22 (WP4): the owner's element picker, run by `annotate.rs` through callAsyncJavaScript in the isolated content world
// "nunchiro-picker" (threat model A10, A12): page script cannot redefine what this file calls, and cannot read its state.
// The body receives one string argument `a` (JSON {op}) and returns one JSON string. Ops: on, poll (same thing), off.
// `poll` re-installs the listeners after a navigation (a new document has none) and returns the pick made since the last
// poll, or null. Only a trusted click counts: a page that dispatches click events cannot make a pick for the owner. Every field
// that comes from the page is cut to 500 characters here as well as on the web side.
const req = JSON.parse(a);
const S = (globalThis.__nunchiroPick ||= { on: false, hooked: false, pick: null });
const CAP = 500;
const cut = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, CAP);
const STOP = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu'];

const selectorOf = (el) => {
  const parts = [];
  for (let e = el; e && e.nodeType === 1 && parts.length < 5; e = e.parentElement) {
    let part = e.tagName.toLowerCase();
    if (e.id) {
      parts.unshift(`${part}#${CSS.escape(e.id)}`);
      break;
    }
    const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`;
    parts.unshift(part);
  }
  return cut(parts.join(' > '));
};
const secret = (el) => el.tagName === 'INPUT' && ['password', 'hidden', 'file'].includes((el.type || '').toLowerCase());
const urlOf = () => {
  const u = new URL(location.href);
  return `${u.origin}${u.pathname}${u.search}`; // no credentials, no fragment
};
// A page form holds secrets in its descendants (a CSRF token, a password): copy the element, drop every secret input from
// the copy, and read the HTML and the text from the copy.
const stripped = (el) => {
  const copy = el.cloneNode(true);
  for (const s of copy.querySelectorAll('input')) if (secret(s)) s.remove();
  return copy;
};
const describe = (el) => {
  const r = el.getBoundingClientRect();
  const quiet = secret(el);
  const copy = quiet ? null : stripped(el);
  return {
    page: { sanitizedUrl: cut(urlOf()), viewportWidth: innerWidth, viewportHeight: innerHeight },
    target: {
      tagName: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      textSnippet: quiet ? '' : cut(el.innerText || copy.textContent),
      accessibleName: cut(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title')),
      cssClasses: cut(el.getAttribute('class')),
      htmlSnippet: quiet ? '' : cut(copy.outerHTML),
      rectViewport: { x: r.x, y: r.y, width: r.width, height: r.height },
    },
    nearbyText: el.parentElement
      ? [...el.parentElement.children].filter((c) => c !== el).slice(0, 3).map((c) => cut(c.innerText || c.textContent)).filter(Boolean)
      : [],
  };
};

const onClick = (e) => {
  if (!S.on) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.isTrusted && e.target && e.target.nodeType === 1) S.pick = describe(e.target);
};
const onOther = (e) => {
  if (S.on) (e.preventDefault(), e.stopImmediatePropagation());
};
const hook = () => {
  if (S.hooked) return;
  addEventListener('click', onClick, true);
  for (const t of STOP) addEventListener(t, onOther, true);
  S.hooked = true;
};
const unhook = () => {
  removeEventListener('click', onClick, true);
  for (const t of STOP) removeEventListener(t, onOther, true);
  S.hooked = false;
};

if (req.op === 'off') {
  S.on = false;
  S.pick = null;
  unhook();
  return JSON.stringify({ pick: null });
}
// on / poll: switch on (a new document starts switched off), then hand over the pick made since the last call.
S.on = true;
hook();
const pick = S.pick;
S.pick = null;
return JSON.stringify({ pick });
