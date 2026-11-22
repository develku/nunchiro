// CodeMirror for one file. Read-only unless `edit` is given: then `readOnly` and `editable` off, no input extensions, so
// typing, paste, drop and Cmd+Z have nothing to change. With `edit` (ticket 820, the file view's Edit) the text takes
// input, Cmd+Z / Shift+Cmd+Z step through this view's own edits, and Cmd+S asks the file view to save. shiki colours arrive
// later as mark decorations.
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, search, searchKeymap, SearchQuery, setSearchQuery } from '@codemirror/search';
import { Annotation, ChangeSet, Compartment, EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet, type Panel, type ViewUpdate } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { makeT, type Lang } from '../i18n';

const setSpans = StateEffect.define<DecorationSet>();
const spans = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (v, tr) => tr.effects.find((e) => e.is(setSpans))?.value ?? v.map(tr.changes),
  provide: (f) => EditorView.decorations.from(f),
});
const setTarget = StateEffect.define<number | null>();
const target = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    const e = tr.effects.find((x) => x.is(setTarget));
    if (!e) return v.map(tr.changes);
    if (e.value === null) return Decoration.none;
    return Decoration.set([Decoration.line({ class: 'cm-target' }).range(tr.state.doc.line(e.value).from)]);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Window tokens only, so both themes follow the window's own light/dark switch.
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--panel)', color: 'var(--text)', fontSize: 'var(--fs-12)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: "'SF Mono', Menlo, 'D2Coding', monospace", lineHeight: '18px', overflow: 'auto' },
  '.cm-content': { padding: '6px 0 24px' },
  '.cm-content:focus-visible': { outline: '1px solid var(--focus-ring)', outlineOffset: '-1px' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--muted)', borderRight: '1px solid var(--hover)' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '36px', padding: '0 8px 0 6px' },
  // Ticket 1041 lane 7b (15.2 item 5): the line you jumped to is the neutral selected step; orange stays "needs you".
  '.cm-target': { backgroundColor: 'var(--select-bg)' },
  // Find panel (ticket 200): window tokens only, so it follows the light/dark switch with the rest of the window. Ticket 1041:
  // a tint step under the panel; matches use the focus ring, which is the neutral --ring-focus inside the file view
  // (widget-quiet.css), so they are no longer the working blue.
  '.cm-panels': { backgroundColor: 'var(--page)', color: 'var(--text)', border: '0' },
  '.fv-find': { display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', fontSize: 'var(--fs-12)' },
  '.fv-find input': { flex: '0 1 240px', minWidth: '80px', height: '24px', padding: '0 8px', border: '1px solid var(--hover)', borderRadius: 'var(--r-6)', background: 'var(--panel)', color: 'var(--text)', font: 'inherit' },
  '.fv-find input:focus-visible, .fv-find button:focus-visible': { outline: '2px solid var(--focus-ring)', outlineOffset: '-1px' },
  '.fv-find button': { minWidth: '24px', height: '24px', padding: '0 6px', border: '0', borderRadius: 'var(--r-6)', background: 'transparent', color: 'var(--text)', font: 'inherit', cursor: 'pointer' },
  '.fv-find button:hover': { backgroundColor: 'var(--tint-1)' },
  '.fv-find button[aria-pressed="true"]': { backgroundColor: 'var(--select-bg)', color: 'var(--select-text)', fontWeight: '600' },
  '.fv-find .fv-count': { color: 'var(--muted)', minWidth: '7ch', whiteSpace: 'nowrap' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--focus-ring) 22%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--focus-ring) 45%, transparent)', outline: '1px solid var(--focus-ring)' },
});

const readOnlyTheme = EditorView.theme({ '.cm-content': { caretColor: 'transparent' } });

// Ticket 820: this view's own undo, so no editing package is needed. Each entry is the inverse of a run of typing (changes
// under 500 ms apart are one step); an undo or redo moves it to the other list. Gone with the view: unsaved edits only.
const step = Annotation.define<'undo' | 'redo'>();
type Steps = { done: { c: ChangeSet; t: number }[]; undone: { c: ChangeSet; t: number }[] };
const steps = StateField.define<Steps>({
  create: () => ({ done: [], undone: [] }),
  update(h, tr) {
    if (!tr.docChanged) return h;
    const inv = { c: tr.changes.invert(tr.startState.doc), t: 0 };
    const kind = tr.annotation(step);
    if (kind === 'undo') return { done: h.done.slice(0, -1), undone: [...h.undone, inv] };
    if (kind === 'redo') return { done: [...h.done, inv], undone: h.undone.slice(0, -1) };
    const last = h.done.at(-1);
    const now = Date.now();
    if (last && now - last.t < 500) return { done: [...h.done.slice(0, -1), { c: inv.c.compose(last.c), t: now }], undone: [] };
    return { done: [...h.done, { c: inv.c, t: now }].slice(-500), undone: [] };
  },
});
const stepBack = (kind: 'undo' | 'redo') => (v: EditorView) => {
  const h = v.state.field(steps);
  const last = (kind === 'undo' ? h.done : h.undone).at(-1);
  if (last) v.dispatch({ changes: last.c, annotations: step.of(kind), scrollIntoView: true });
  return true;
};

/** The file view's side of an editable text: each change of the text, Cmd+S, and a `revision` bumped to put `text` back. */
export interface Edit {
  onChange: (doc: string) => void;
  onSave: () => void;
  revision: number;
  /** A save is in flight: typing is held, or the save's reply would replace text typed after it was sent. */
  busy?: boolean;
}

// The panel's words, in the language the window shows (<html lang>, as terminal/links.ts reads it). A compartment, so a language
// change reaches an open viewer without rebuilding it (scroll and selection stay).
const wording = new Compartment();
// The text's accessible name, also in the window language: a compartment, so a new label never rebuilds the view (an open
// Find panel, scroll and unsaved edits stay).
const named = new Compartment();
/** Ticket 375: Wrap, reconfigured in place so a toggle keeps the scroll, the find panel and the undo steps. */
const wrapping = new Compartment();
const nameAttrs = (label: string, editable: boolean) => EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': label, ...(editable ? {} : { 'aria-readonly': 'true' }) });
const phrases = () => {
  const t = makeT((document.documentElement.lang || 'en') as Lang, navigator.language);
  return EditorState.phrases.of({
    Find: t('fvfind.find'),
    'Find in file': t('fvfind.label'),
    next: t('fvfind.next'),
    previous: t('fvfind.previous'),
    'match case': t('fvfind.case'),
    close: t('fvfind.close'),
    'No matches': t('fvfind.none'),
    '$1 of $2': t('fvfind.of'),
    '$1+': t('fvfind.more'),
  });
};

const MATCH_CAP = 999;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text) n.textContent = text;
  return n;
};

/** Read-only find: a field, the match count, match case, previous, next, close. No replace (the viewer cannot edit). */
class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private field = el('input', { type: 'search', name: 'search', 'main-field': 'true', autocomplete: 'off', spellcheck: 'false' });
  private count = el('span', { role: 'status', class: 'fv-count' });
  private matchCase = el('button', { type: 'button', 'aria-pressed': 'false' }, 'Aa');
  private shown = ''; // the field's name now: when the phrases change, the panel names itself again
  private query: SearchQuery;
  // Each named control: its phrase key and the key hint after the name in the house tooltip (`data-tip`, not the slow `title`).
  private named: [HTMLElement, string, string][] = [];

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.field.value = this.query.search;
    const button = (label: string, glyph: string, run: () => void, keyHint = '') => {
      const b = el('button', { type: 'button' }, glyph);
      b.addEventListener('click', run);
      this.named.push([b, label, keyHint]);
      return b;
    };
    this.matchCase.addEventListener('click', () => this.commit(!this.query.caseSensitive));
    this.named.push([this.matchCase, 'match case', '']);
    this.dom = el('div', { class: 'fv-find', role: 'search' });
    this.dom.append(
      this.field,
      this.count,
      this.matchCase,
      button('previous', '↑', () => findPrevious(view), ' (⇧↵)'),
      button('next', '↓', () => findNext(view), ' (↵)'),
      button('close', '×', () => closeSearchPanel(view), ' (esc)'),
    );
    this.relabel();
    this.field.addEventListener('input', () => this.commit(this.query.caseSensitive, true));
    this.dom.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && e.target === this.field) (e.preventDefault(), (e.shiftKey ? findPrevious : findNext)(view));
      else if (e.key === 'Escape') (e.preventDefault(), closeSearchPanel(view)); // the library hands focus back to the text
    });
    this.sync();
  }

  mount() {
    this.field.focus();
    this.field.select();
  }

  /** Every name from the editor's current phrases, so a language change reaches a panel that is already open. */
  private relabel() {
    const p = (k: string) => this.view.state.phrase(k);
    this.shown = p('Find');
    this.field.setAttribute('aria-label', this.shown);
    this.field.placeholder = this.shown;
    this.dom.setAttribute('aria-label', p('Find in file'));
    for (const [b, key, hint] of this.named) (b.setAttribute('aria-label', p(key)), b.setAttribute('data-tip', p(key) + hint));
  }

  update(u: ViewUpdate) {
    if (this.view.state.phrase('Find') !== this.shown) this.relabel();
    for (const tr of u.transactions)
      for (const e of tr.effects)
        if (e.is(setSearchQuery) && !e.value.eq(this.query)) {
          this.query = e.value;
          this.field.value = e.value.search;
        }
    this.sync();
  }

  private commit(caseSensitive: boolean, reveal = false) {
    const q = new SearchQuery({ search: this.field.value, caseSensitive, literal: true });
    this.query = q;
    this.view.dispatch({ effects: setSearchQuery.of(q) });
    // Typing selects the first match from the caret on, so the count reads "1 of n" and Enter steps from there.
    if (reveal && q.valid && q.search) {
      const st = this.view.state;
      const first = (c: ReturnType<SearchQuery['getCursor']>) => {
        const m = c.next();
        return m.done ? null : m.value;
      };
      const hit = first(q.getCursor(st, st.selection.main.from)) ?? first(q.getCursor(st)); // wraps to the top
      if (hit) this.view.dispatch({ selection: EditorSelection.single(hit.from, hit.to), effects: EditorView.scrollIntoView(hit.from, { y: 'center' }) });
    }
    this.sync();
  }

  private sync() {
    const q = this.query;
    this.matchCase.setAttribute('aria-pressed', String(q.caseSensitive));
    const sel = this.view.state.selection.main;
    let n = 0;
    let at = 0;
    if (q.search && q.valid) {
      const cur = q.getCursor(this.view.state);
      for (let m = cur.next(); !m.done && n < MATCH_CAP; m = cur.next()) {
        n++;
        if (m.value.from === sel.from && m.value.to === sel.to) at = n;
      }
    }
    const st = this.view.state;
    const total = n >= MATCH_CAP ? st.phrase('$1+', n) : String(n);
    this.count.textContent = !q.search ? '' : n === 0 ? st.phrase('No matches') : at ? st.phrase('$1 of $2', at, total) : total;
  }
}

/** shiki colours for the document now. Offsets come from CodeMirror's own text with `\n` breaks (it counts a break as one). */
function paint(v: EditorView, name: string) {
  const doc = v.state.doc;
  void import('./highlight')
    .then(({ highlight }) => highlight(doc.sliceString(0, doc.length, '\n'), name))
    .then((list) => {
      // A view destroyed or changed meanwhile keeps what it has (the marks map through edits).
      if (!v.dom.isConnected || v.state.doc !== doc || !list.length) return;
      const b = new RangeSetBuilder<Decoration>();
      for (const s of list) b.add(s.from, s.to, Decoration.mark({ attributes: { style: `color:${s.color}` }, class: 'sh' }));
      v.dispatch({ effects: setSpans.of(b.finish()) });
    })
    .catch(() => {}); // Plain text stays readable when a grammar fails to load.
}

export function goToLine(view: EditorView, line: number) {
  const n = Math.max(1, Math.min(line, view.state.doc.lines));
  view.dispatch({ effects: [setTarget.of(n), EditorView.scrollIntoView(view.state.doc.line(n).from, { y: 'center' })] });
}

/** `jump.at` changes on every open-at-line request, so asking twice for the same line scrolls again. */
export function Code({ text, name, jump, label, onFind, edit, wrap = false }: { text: string; name: string; jump?: { line: number; at: number }; label: string; onFind?: (open: (() => void) | null) => void; edit?: Edit; wrap?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  const found = useRef(onFind);
  found.current = onFind;
  const edits = useRef(edit);
  edits.current = edit;
  const first = useRef(text);
  first.current = text;
  const wrapped = useRef(wrap);
  wrapped.current = wrap;
  const editable = !!edit;

  useEffect(() => {
    const text = first.current;
    const mode = editable
      ? [
          steps,
          keymap.of([
            { key: 'Mod-s', run: () => (edits.current?.onSave(), true) },
            { key: 'Mod-z', run: stepBack('undo') },
            { key: 'Mod-Shift-z', run: stepBack('redo') },
          ]),
          EditorState.transactionFilter.of((tr) => (tr.docChanged && edits.current?.busy && (tr.isUserEvent('input') || tr.isUserEvent('delete')) ? [] : tr)),
          EditorView.updateListener.of((u) => u.docChanged && edits.current?.onChange(u.state.sliceDoc())),
        ]
      : [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          // Some WebKit builds take Backspace outside a text field as "go back", which would leave the window.
          EditorView.domEventHandlers({ keydown: (e) => e.key === 'Backspace' && (e.preventDefault(), true) }),
          readOnlyTheme,
        ];
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          // A CRLF file keeps CRLF in its text (and in a save). shortcut: a file mixing line endings saves with CRLF
          // throughout; upgrade if one is ever edited here.
          ...(text.includes('\r\n') ? [EditorState.lineSeparator.of('\r\n')] : []),
          ...mode,
          // Focusable for keyboard scrolling and copy (still not editable without `edit`).
          named.of(nameAttrs(label, editable)),
          lineNumbers(),
          wrapping.of(wrapped.current ? EditorView.lineWrapping : []),
          // Find: Cmd+F with focus in the text (the editor's own keymap; the global Cmd+F is the terminal's).
          wording.of(phrases()),
          search({ top: true, createPanel: (view) => new FindPanel(view) }),
          keymap.of(searchKeymap.filter((b) => b.key === 'Mod-f' || b.key === 'F3' || b.key === 'Mod-g' || b.key === 'Escape')),
          spans,
          target,
          theme,
        ],
      }),
    });
    view.current = v;
    found.current?.(() => openSearchPanel(v));
    paint(v, name);
    return () => {
      found.current?.(null);
      v.destroy();
      view.current = null;
    };
  }, [name, editable]); // eslint-disable-line react-hooks/exhaustive-deps -- label goes through `named` below

  useEffect(() => {
    view.current?.dispatch({ effects: named.reconfigure(nameAttrs(label, editable)) });
  }, [label, editable]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  // A new text (Reload, a save's reply) or a Revert replaces the document in place; the same text leaves it alone, so a
  // save keeps the caret, scroll and undo steps.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.sliceDoc() === text) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    paint(v, name);
  }, [text, edit?.revision]); // eslint-disable-line react-hooks/exhaustive-deps -- name is the creation effect's

  useEffect(() => {
    const ob = new MutationObserver(() => view.current?.dispatch({ effects: wording.reconfigure(phrases()) }));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => ob.disconnect();
  }, []);

  useEffect(() => {
    if (jump && view.current) goToLine(view.current, jump.line);
  }, [jump, text]);

  return <div className="fv-code" ref={host} />;
}
