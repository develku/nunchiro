// The window's layout state: the saved layout (mirrors layout.toml), the edit-mode draft, and up to 3 undo steps.
// Every change goes through `run`, so the edit command line, drags, bindings and the CLI behave the same.
import type { LayoutFile } from '../api';
import { makeT, type Key, type Lang, type T } from '../i18n';
import { format } from './command';
import { apply, defaultLayout, dropCentreBoard, kindOf, leaves, type Kind, type Layout, type Measure, type Op } from './model';
import { docT, OwnWords, rawError } from '../errors';

/** The window's catalogue for words raised outside a component or without the window's `t` (a thrown refusal, a toast): App sets
 *  <html lang> from the language setting (useAppSettings). English where there is no document (a node test). */
export const words = (): T => makeT((typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en') as Lang, typeof navigator === 'undefined' ? 'en' : navigator.language);
/** A zone shows a session's chat: a terminal, following the open session or pinned to one (pinning the centre is allowed). */
const centre = (l: Layout) => leaves(l.root).some((z) => z.widgets.some((w) => kindOf(w) === 'terminal'));

export const HISTORY = 3;

const STRIP_STEP = 'nunchiro.layout.strip-left-chat.v1';
/** A22: true until the step is marked done in this browser profile. Without readable and writable storage it is never true,
 *  so a strip the user placed again can not be dropped on every start. */
function firstTime() {
  try {
    if (localStorage.getItem(STRIP_STEP) === '1') return false;
    localStorage.setItem(STRIP_STEP, '0'); // write probe ('0' = not done): a profile that cannot write never runs the step
    return true;
  } catch {
    return false;
  }
}
function markStripStep() {
  try {
    localStorage.setItem(STRIP_STEP, '1');
  } catch {
    /* storage went away: the step may run again next load */
  }
}

/** A22 (needs 107, 178): the layout without any `waiting` zone directly above the composer (the old default's place, where
 *  the strip draws nothing since needs 107), or null when it has none. */
export function dropStripAboveComposer(l: Layout): Layout | null {
  let cur = l;
  let changed = false;
  for (;;) {
    const hit = leaves(cur.root).find((z) => {
      const p = parentColumn(cur.root, z.id);
      const next = p && p.children[p.children.findIndex((c) => c.id === z.id) + 1];
      return !!next && z.widgets.some((w) => kindOf(w) === 'waiting') && leaves(next).some((c) => c.widgets.some((w) => kindOf(w) === 'composer'));
    });
    if (!hit) break;
    // Only the waiting tabs go; a zone that shares the place with other widgets keeps them.
    for (let i = hit.widgets.length - 1; i >= 0; i--) if (kindOf(hit.widgets[i]) === 'waiting') cur = apply(cur, { op: 'remove', zone: hit.id, tab: i + 1 });
    changed = true;
  }
  return changed ? cur : null;
}
function parentColumn(n: Layout['root'], id: string): { children: Layout['root'][] } | null {
  if (!('children' in n)) return null;
  if (n.split === 'column' && n.children.some((c) => c.id === id)) return n;
  for (const c of n.children) {
    const r = parentColumn(c, id);
    if (r) return r;
  }
  return null;
}

/** Key-order-independent equality (the core writes fields in its own order). */
export function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, norm(x)])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export const count = (l: Layout, kind: Kind) => leaves(l.root).reduce((n, z) => n + z.widgets.filter((w) => kindOf(w) === kind).length, 0);

export class LayoutStore {
  saved: Layout = defaultLayout();
  draft: Layout | null = null;
  history: Layout[] = [];
  /** layout.toml does not parse: the window keeps its last good layout and names the line. */
  fileError: string | null = null;
  saveError: string | null = null;
  /** Another window, the CLI or a hand edit changed the file while this window was editing. */
  outside = false;
  /** Status-bar note: an outside change cleared the undo history. */
  notice = '';
  echo = '';
  private before: Layout[] = [];
  private subs = new Set<() => void>();
  private version = 0;
  private stripTried = false;
  /** v25f: the last load took a Board tab out of the centre zone; the window opens the Board modal and clears it. */
  boardMoved = false;

  /** `say`: the words of a refusal; the window's language by default (a node test passes its own tables). */
  constructor(
    private persist: (l: Layout) => Promise<unknown>,
    private say: (key: Key) => string = (key) => words()(key),
  ) {}

  get current() {
    return this.draft ?? this.saved;
  }
  get editing() {
    return this.draft !== null;
  }
  subscribe = (f: () => void) => {
    this.subs.add(f);
    return () => void this.subs.delete(f);
  };
  snapshot = () => this.version;
  private emit() {
    this.version++;
    for (const f of this.subs) f();
  }

  fromFile(f: LayoutFile) {
    if (f.error) this.fileError = f.error;
    else {
      this.fileError = null;
      // A good file wins over a change this window could not save.
      this.saveError = null;
      const next = f.layout ?? defaultLayout();
      // The core sends no event for this window's own writes, so any other change is from outside.
      if (!same(next, this.saved)) {
        if (this.editing) this.outside = true;
        this.saved = next;
        // Undoing past someone else's change would silently drop it, so the history starts over.
        if (this.history.length || this.before.length) this.notice = docT()('own.layout.outside');
        this.history = [];
        this.before = [];
      }
    }
    // A22, once per profile: a strip zone left right above the composer by the old default goes; one Undo brings it back.
    if (!f.error && !this.editing && !this.stripTried && firstTime()) {
      this.stripTried = true; // one attempt per load, even while the write is in flight
      const moved = dropStripAboveComposer(this.saved);
      if (!moved) markStripStep();
      else {
        this.history = [this.saved];
        this.notice = 'The answer strip left the chat column (Layout > Widget library puts it back): Undo restores the old layout';
        // Marked only after the write lands, so a failed write tries again next load.
        void this.write(moved).then(markStripStep, () => {});
      }
    }
    // v25f (D-20261108-10): the Board is a modal now, never a centre tab; a saved centre Board goes and the modal opens.
    const unboarded = !f.error && !this.editing ? dropCentreBoard(this.saved) : null;
    if (unboarded) {
      this.boardMoved = true;
      void this.write(unboarded).catch(() => {}); // a failed write tries again on the next load
    }
    this.emit();
  }

  private async write(l: Layout) {
    this.saved = l;
    this.emit();
    try {
      await this.persist(l);
      this.saveError = null;
    } catch (e) {
      this.saveError = rawError(e);
      throw new Error(this.saveError);
    } finally {
      this.emit();
    }
  }

  /** Applies one action; outside edit mode it is saved at once. Returns the command text it ran. */
  async run(op: Op, measure?: Measure): Promise<string> {
    const cur = this.current;
    let next: Layout;
    if (op.op === 'undo') {
      const prev = this.history.at(-1);
      if (!prev) throw new OwnWords(`nothing to undo (up to ${HISTORY} steps)`);
      next = prev;
      this.history = this.history.slice(0, -1);
    } else {
      try {
        next = apply(cur, op, measure);
      } catch (e) {
        throw new OwnWords(rawError(e)); // the model's refusals are the window's own words
      }
      // rc2b-fb (needs 106: the window frame keeps the centre chat): the window refuses the step that takes away the last
      // terminal, the zone that shows a session's chat. The model (`apply`, the CLI's parse) stays permissive.
      if (centre(cur) && !centre(next)) throw new OwnWords(this.say('shell.centreStays'));
      this.history = [...this.history, cur].slice(-HISTORY);
    }
    this.echo = format(op);
    this.notice = '';
    if (this.draft) {
      this.draft = next;
      this.emit();
    } else await this.write(next);
    return this.echo;
  }

  /** Replaces the whole arrangement in one history step (a preset, A23). */
  async set(layout: Layout, echo: string) {
    const cur = this.current;
    const next = structuredClone(layout);
    this.history = [...this.history, cur].slice(-HISTORY);
    this.echo = echo;
    this.notice = '';
    if (this.draft) {
      this.draft = next;
      this.emit();
    } else await this.write(next);
  }

  edit() {
    if (this.editing) return;
    this.draft = structuredClone(this.saved);
    this.before = this.history;
    this.outside = false;
    this.echo = '';
    this.emit();
  }
  async done() {
    const d = this.draft;
    if (!d) return;
    this.draft = null;
    this.outside = false;
    await this.write(d);
  }
  cancel() {
    if (!this.draft) return;
    this.draft = null;
    this.history = this.before;
    this.outside = false;
    this.emit();
  }
}
