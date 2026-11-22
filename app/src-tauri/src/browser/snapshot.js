// V2.5-20 (WP2): the agent's view of a page, run by `agent.rs` through callAsyncJavaScript in the isolated content world
// "nunchiro-agent" (threat model A10): page script cannot redefine what this file calls. The body receives one string
// argument `a` (JSON {op, ...}) and returns one JSON string. Ops: snapshot, tree, info (`watch`: note the page's
// changes), point, value, select, scroll, signin, password. An op on element `i` that the B8 guard refuses returns
// {refused: 'ref_stale' | 'page_moved'} and does nothing.
//
// The element table (actionable, visible, in-viewport elements, each with a stable number (B8); password, file and
// hidden inputs left out; visible text up to 6,000 characters) is adapted from jev-ultrafast `jev_ultrafast/snapshot.js`
// (https://github.com/browser-use/jev-ultrafast, commit 1231850a): role, name and visibility rules kept, the guard and
// marker logic dropped, rows instead of JSON actions, select options folded into one row.
// MIT License, Copyright (c) 2026 Browser Use. Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
// of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
// TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
// OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
const req = JSON.parse(a);
// Ticket 998 L9 (B8): an element keeps its number for the life of its document, and a number is never given twice in
// a space: a new document starts a new table (this world's global is the document's own), but its numbers go on from
// `next`, the space's first unused one, which the app sends with each page read and keeps from each answer. The app
// also sends the read's `doc` with every number it acts on. `doc` is a random name for the document, not its
// timeOrigin: WebKit's timeOrigin of one document moved by 1 ms after the view was hidden and shown (998 L9 measure).
// Ticket 998 L10 (L9 security NOTE): `els` finds a number's element without a pass over the page (`node`); it holds
// each element weakly, and its entry goes when the element is collected, so it is as big as the numbered live elements.
const S = (globalThis.__nunchiro ||= {
  doc: String(Math.random()).slice(2),
  ids: new WeakMap(),
  els: new Map(),
  next: 1,
});
S.gone ||= new FinalizationRegistry((n) => S.els.delete(n));
const DOC = S.doc;
if (req.next > S.next) S.next = req.next;
const id = (e) => {
  if (!S.ids.has(e)) {
    const n = S.next++;
    S.ids.set(e, n);
    S.els.set(n, new WeakRef(e));
    S.gone.register(e, n);
  }
  return S.ids.get(e);
};
const TEXT_MAX = req.full ? 60000 : 6000;
const ROWS_MAX = req.full ? 1000 : 250;
// Ticket 998 L5 (B3, B4): a page picks its title, address, field values and option lists, so each is capped here; the
// app trims a whole answer to its byte budget (agent.rs `fit`).
const TITLE_MAX = 200, URL_MAX = 1000, VALUE_MAX = 200, OPTION_MAX = 80, OPTIONS_SHOWN = 5;
// Never half an emoji: a lone surrogate is invalid JSON for the app, which would refuse the whole answer.
const cut = (s, n) => s.slice(0, n).replace(/[\ud800-\udbff]$/, '');
const cap = (s, n) => (s.length > n ? cut(s, n) + '…' : s);
// B5: one line, quotes escaped: a page string cannot end its quote or start a row of its own in the `--tree` outline.
const q = (s) => '"' + String(s).replace(/\s+/g, ' ').trim().replace(/["\\]/g, '\\$&') + '"';
// A3: never listed, so never filled by an agent; a login is the owner's.
const safe = (e) => !['password', 'file', 'hidden'].includes((e.type || '').toLowerCase());
const visible = (e) =>
  !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
const name = (e, seen = new Set()) => {
  if (!e || seen.has(e)) return '';
  seen.add(e);
  const referenced = (e.getAttribute('aria-labelledby') || '')
    .split(/\s+/)
    .map((id) => name(document.getElementById(id), seen))
    .filter(Boolean)
    .join(' ');
  const full = (
    referenced ||
    e.getAttribute('aria-label') ||
    [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ') ||
    (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') ||
    e.getAttribute('alt') ||
    (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName)
      ? ''
      : [...e.childNodes]
          .map((n) =>
            n.nodeType === 3
              ? n.textContent
              : n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' && !['SELECT', 'TEXTAREA'].includes(n.tagName)
                ? name(n, seen)
                : '',
          )
          .join(' ')
          .trim()) ||
    e.getAttribute('title') ||
    e.getAttribute('placeholder') ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  return cut(full, 120);
};
const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio', 'option',
  'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
  roles.map((r) => '[role="' + r + '"]').join(',');
const role = (e) => {
  const explicit = e.getAttribute('role');
  if (roles.includes(explicit)) return explicit;
  if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
  if (e.tagName === 'A') return 'link';
  if (e.tagName === 'SELECT') return 'select';
  if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
  if (e.tagName === 'INPUT') {
    if (['checkbox', 'radio'].includes(e.type)) return e.type;
    if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
    if (e.type === 'search') return 'searchbox';
    if (e.type === 'number') return 'spinbutton';
    if (['text', 'email', 'url', 'tel', ''].includes(e.type)) return 'textbox';
  }
  return null;
};
const inView = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
const actionable = (e) => safe(e) && visible(e) && !e.matches(':disabled') && !e.closest('[aria-disabled="true"]');
// Every rule the table lists an element by, but the viewport: its role and box, or null. A number is acted on only while
// its element still passes (L9 round 2, security MUST: a listed field the page turns into a password is refused).
const listable = (e) => {
  if (!actionable(e)) return null;
  const r = e.getBoundingClientRect(), kind = role(e);
  if (!kind || r.width <= 0 || r.height <= 0) return null;
  if (kind === 'gridcell' && e.querySelector('button,[role="button"]')) return null;
  return [kind, r];
};
const page = () => ({ title: cap(document.title, TITLE_MAX), url: cap(location.href, URL_MAX) });
// B8 guard, in the same call as the action's own op: number `i` must come from this document (else page_moved) and
// still name an element the table would list, in or out of view (else ref_stale). Only the code crosses to the app; no other element is ever used.
class Refused {
  constructor(code) {
    this.code = code;
  }
}
const node = (i) => {
  if (req.doc !== DOC) throw new Refused('page_moved');
  const e = S.els.get(i)?.deref();
  // The element a scan of document.querySelectorAll(selector) would find: still in this document (not removed, not in a
  // shadow root) and of a listed kind; then every rule the table lists by.
  if (!e || S.ids.get(e) !== i || e.getRootNode() !== document || !e.matches(selector) || !listable(e)) {
    throw new Refused('ref_stale');
  }
  return e;
};
const describe = (e) => ({ role: role(e), label: name(e) || role(e) });
// Ticket 998 L8 (B6): from just before a click or key until the snapshot after it, the time of the page's last change.
// Only that time crosses to the app, which owns every deadline (no timer here). Attribute changes count for the ones that
// show or hide content; style and the rest are left out, as animations change them all the time.
const SHOWS = ['class', 'hidden', 'disabled', 'open', 'aria-expanded', 'aria-hidden', 'aria-selected', 'aria-checked',
  'aria-disabled', 'aria-busy'];
const watch = () => {
  S.mo ||= new MutationObserver(() => (S.last = performance.now()));
  S.mo.takeRecords();
  S.last = 0;
  S.mo.observe(document, { childList: true, subtree: true, characterData: true, attributeFilter: SHOWS });
};

function rows() {
  // B4: over ROWS_MAX the first 80% and the last 20% are listed and `cut` counts the rest, which get no number. Bounded
  // storage whatever the page's size (998 L5 round 2): the first `head` and a window of the latest elements, trimmed in
  // batches, with `k` counting them all.
  const head = Math.ceil(ROWS_MAX * 0.8), tail = ROWS_MAX - head, first = [];
  let last = [], k = 0;
  for (const e of document.querySelectorAll(selector)) {
    const l = listable(e);
    if (!l || (!req.full && !inView(l[1]))) continue;
    const kind = l[0];
    (first.length < head ? first : last).push([e, kind]);
    k++;
    if (last.length >= 2 * tail) last = last.slice(-tail);
  }
  const out = [], listed = new Map(), kept = [...first, ...last.slice(-tail)];
  kept.forEach(([e, kind]) => {
    const row = { i: id(e), role: kind, label: name(e) || kind };
    listed.set(e, row);
    if (['checkbox', 'radio'].includes(e.type)) row.checked = e.checked;
    else if (e.getAttribute('aria-checked') !== null) row.checked = e.getAttribute('aria-checked') === 'true';
    if (e.tagName === 'SELECT') {
      row.value = cap([...e.selectedOptions].map((o) => o.label).join(', '), VALUE_MAX);
      const opts = [];
      let more = 0;
      for (const o of e.options) {
        if (o.selected || o.disabled) continue;
        if (opts.length < OPTIONS_SHOWN) opts.push(cap(o.label, OPTION_MAX));
        else more++;
      }
      row.options = more ? [...opts, '… ' + more + ' more'] : opts;
    } else if (['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(kind)) {
      row.value = cap('value' in e ? String(e.value) : e.innerText.trim(), VALUE_MAX);
    }
    out.push(row);
  });
  return { rows: out, cut: k - kept.length, listed };
}

function text() {
  const words = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), range = document.createRange();
  let n, length = 0;
  while ((n = walker.nextNode()) && length < TEXT_MAX) {
    const value = n.textContent.replace(/\s+/g, ' ').trim(), parent = n.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template,select,option') || !visible(parent)) continue;
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (req.full || inView(r))) {
      words.push(value);
      length += value.length;
    }
  }
  return cut(words.join('\n'), TEXT_MAX);
}

// The role tree on demand (`--tree`): landmarks, headings, lists and tables as an indented outline, actionable
// elements with the same [ref=N] numbers as the table.
function tree() {
  const ref = rows().listed;
  const lines = [];
  const LAND = { HEADER: 'banner', NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', FOOTER: 'contentinfo',
    FORM: 'form', TABLE: 'table', UL: 'list', OL: 'list', DIALOG: 'dialog' };
  const walk = (e, depth) => {
    if (lines.length > ROWS_MAX * 2 || !(e instanceof Element) || !safe(e)) return;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(e.tagName) || !visible(e)) return;
    const pad = '  '.repeat(depth);
    let next = depth;
    if (ref.has(e)) {
      const row = ref.get(e);
      lines.push(pad + '- ' + row.role + ' ' + q(row.label) + (row.value ? ' value=' + q(row.value) : '') +
        ' [ref=' + row.i + ']');
      return;
    }
    if (/^H[1-6]$/.test(e.tagName)) {
      lines.push(pad + '- heading ' + q(name(e)) + ' [level=' + e.tagName[1] + ']');
      return;
    }
    const land = e.getAttribute('role') || LAND[e.tagName];
    if (land) {
      const label = e.getAttribute('aria-label');
      lines.push(pad + '- ' + q(land).slice(1, -1) + (label ? ' ' + q(cap(label, VALUE_MAX)) : ''));
      next = depth + 1;
    } else if (['P', 'LI', 'TD', 'TH', 'CAPTION', 'LABEL', 'PRE', 'CODE'].includes(e.tagName) && !e.querySelector(selector)) {
      const s = e.innerText.replace(/\s+/g, ' ').trim();
      if (s && (req.full || inView(e.getBoundingClientRect()))) lines.push(pad + '- text ' + q(cut(s, 200)));
      return;
    }
    for (const c of e.children) walk(c, next);
  };
  walk(document.body, 0);
  return lines.join('\n');
}

function result() {
  if (['snapshot', 'tree'].includes(req.op)) S.mo?.disconnect();
  switch (req.op) {
    case 'snapshot': {
      const t = rows(), height = document.documentElement.scrollHeight;
      return { ...page(), doc: DOC, next: S.next, rows: t.rows, cut: t.cut, text: text(),
        below: !req.full && scrollY + innerHeight < height - 2, above: !req.full && scrollY > 0 };
    }
    case 'tree': {
      const outline = tree();
      return { ...page(), doc: DOC, next: S.next, tree: outline };
    }
    case 'info':
      if (req.watch) watch();
      // The document's name and address: another key after an action means another page (B6).
      return { ...page(), key: DOC + ' ' + location.href, ready: document.readyState, shown: !document.hidden,
        idle: S.last ? performance.now() - S.last : null }; // ms since the last change seen, null: none since `watch`
    case 'point': {
      // Geometry is read just before input: the element is brought into view, then hit-tested at its centre.
      const e = node(req.i);
      let r = e.getBoundingClientRect();
      if (!inView(r) || r.top < 0 || r.bottom > innerHeight) {
        e.scrollIntoView({ block: 'center', inline: 'center' });
        r = e.getBoundingClientRect();
      }
      const x = r.left + Math.min(r.width / 2, Math.max(1, r.width - 1)), y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const covered = hit && hit !== e && !e.contains(hit) && !(e.labels && [...e.labels].some((l) => l.contains(hit)));
      return { ...describe(e), x, y, covered: covered ? name(hit) || hit.tagName.toLowerCase() : null,
        editable: ['textbox', 'searchbox', 'spinbutton'].includes(role(e)) && !e.readOnly };
    }
    case 'focus': {
      // Ticket 997 L7 round 4: a fill types only into its own field. The field takes the focus here, before any key is
      // sent, and says whether it holds it: text sent while another field has the focus would land there.
      const e = node(req.i);
      e.focus({ preventScroll: true });
      return { ...describe(e), focused: document.activeElement === e };
    }
    case 'value': {
      const e = node(req.i);
      return { ...describe(e), value: 'value' in e ? String(e.value) : e.innerText, focused: document.activeElement === e };
    }
    case 'select': {
      const e = node(req.i);
      if (e.tagName !== 'SELECT') throw new Error('Element [' + req.i + '] is not a select');
      const want = req.option.trim().toLowerCase();
      const o = [...e.options].find((o) => !o.disabled && (o.label.trim().toLowerCase() === want || o.value.toLowerCase() === want));
      if (!o) throw new Error('No option "' + req.option + '" in [' + req.i + ']');
      e.value = o.value;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return { ...describe(e), value: cap(o.label, OPTION_MAX) }; // B4: the done line quotes it
    }
    case 'signin': {
      // Ticket 264 (A3, a courtesy): would this click (element i, a submit control), Enter (the focused element) or Space
      // (`button`: a focused submit control) send a form whose visible password is still empty? Remember me, Forgot password
      // and Show password are not. A password field outside any form counts for the whole page.
      const click = req.i !== null && req.i !== undefined;
      const e = click ? node(req.i) : document.activeElement;
      const submit = !!e && ((e.tagName === 'BUTTON' && e.type === 'submit') || (e.tagName === 'INPUT' && ['submit', 'image'].includes(e.type)));
      if ((click || req.button) && !submit) return { signin: false };
      const form = e && (e.form || (e.closest && e.closest('form')));
      const asks = [...document.querySelectorAll('input[type="password"]')].filter((p) => visible(p) && !p.value);
      return { signin: !!e && asks.some((p) => !p.form || p.form === form) };
    }
    case 'password': {
      // Debug builds only (agent.rs `test_owner`, the scenario test playing the owner): where the owner would click to type.
      const e = [...document.querySelectorAll('input[type="password"]')].find(visible);
      if (!e) throw new Error('No password field on this page');
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    case 'scroll':
      scrollBy(0, (req.down ? 1 : -1) * Math.round(innerHeight * 0.8));
      return { ...page(), y: scrollY };
    default:
      throw new Error('unknown op');
  }
}
let answer;
try {
  answer = result();
} catch (e) {
  if (!(e instanceof Refused)) throw e;
  answer = { refused: e.code };
}
return JSON.stringify(answer);
