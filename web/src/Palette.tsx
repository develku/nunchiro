// Cmd+K palette: every command by name, plus "go to" each session.
import { PLAIN } from './plainText';
import { KeyChip } from './KeyChip';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { Bindings, Command } from './keys';
import type { Key } from './i18n';
import { commandTitle, commandWords, pageWord } from './i18n/lib/commandTitle';
import { pageFocus } from './pane/browser/view/bridge';
import { MENU_ONLY } from './menu/surfaces';

type T = (key: Key, args?: Record<string, string | number>) => string;

// V2.5-54 A11: words a command answers to besides the ones on its title. A "Show or hide" or "Fold or unfold" command is a
// toggle; "Close" and "Remove" hide. English only, as the ids are: a translated title keeps these keywords searchable.
const SYNONYMS: [RegExp, string][] = [
  [/show or hide|fold or unfold|maximi[sz]e or restore|\.toggle$/i, 'toggle show hide'],
  [/\b(close|remove)\b/i, 'close hide'],
];
const words = (c: Command, shown: (c: Command) => string, keywords: string) => `${shown(c)} ${c.title} ${c.id} ${c.branch ?? ''} ${keywords.replace(/\|/g, ' ')} ${SYNONYMS.filter(([re]) => re.test(`${c.title} ${c.id}`)).map(([, w]) => w).join(' ')}`.toLowerCase();
/** Ticket 610: the verbs and small words around what a user asks for; dropped only when the whole query matches nothing. */
const FILLER = new Set(['change', 'set', 'adjust', 'check', 'for', 'the', 'a', 'an', 'my', 'to', '바꾸기', '바꿔', '변경', '변경하기', '확인', '하기']);
const sessionName = (c: Command) => (c.name ?? c.title).toLowerCase();
const wordStart = (field: string, part: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(field);

/** Ticket 577: how well the shown name or a keyword fits the query, as T3 Code ranks its palette fields (CommandPalette.logic.ts):
 *  4 the whole name or keyword, 3 starts with the query, 2 every word starts a word, 1 anywhere (id, English title, synonyms). */
function fit(name: string, keywords: string, q: string, parts: string[]): number {
  const fields = [name, ...keywords.toLowerCase().split('|').filter(Boolean)];
  if (fields.some((f) => f === q)) return 4;
  if (fields.some((f) => f.startsWith(q))) return 3;
  return parts.every((p) => fields.some((f) => wordStart(f, p))) ? 2 : 1;
}

/** Every word of the query matches; a session whose name is the query or starts with it comes first, then commands, other
 *  session matches, then settings. Inside a group the better fit comes first (`fit`); the sort is stable, so equal fits keep
 *  the list's order. With no query, session rows follow `recent` (session ids, newest first; ticket 377) and sessions never
 *  opened keep the list's order after them. `keywords` are the words a command carries in the window's language (ticket 577); `loose` words let a command match without raising its fit (ticket 579). */
export function rank(commands: Command[], query: string, recent: string[] = [], shown: (c: Command) => string = (c) => c.title, keywords: (c: Command) => string = () => '', loose: (c: Command) => string = () => ''): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    const at = (c: Command) => (c.id.startsWith('session.open.') && recent.includes(c.id.slice(13)) ? recent.indexOf(c.id.slice(13)) : recent.length);
    return commands.map((c, i) => [c, i] as const).sort(([a, i], [b, j]) => at(a) - at(b) || i - j).map(([c]) => c);
  }
  const parts = q.split(/\s+/);
  const tier = (c: Command) => {
    if (c.id.startsWith('session.open.')) return sessionName(c).startsWith(q) ? 0 : 2;
    return c.id.startsWith('settings.') ? 3 : 1;
  };
  // `own` leaves out the loose words: a row's own name, phrases, id and title.
  const rows = commands.map((c, i) => ((k) => ({ c, i, k, w: words(c, shown, `${k}|${loose(c)}`), own: words(c, shown, k) }))(keywords(c)));
  const all = (w: string, ps: string[]) => ps.every((p) => w.includes(p));
  // A plural also matches its singular ("updates"), in the fallbacks only.
  const loosely = (w: string, ps: string[]) => ps.every((p) => w.includes(p) || (p.length > 3 && p.endsWith('s') && w.includes(p.slice(0, -1))));
  const thing = parts.filter((p) => !FILLER.has(p));
  let hits = rows.filter(({ w }) => all(w, parts));
  // Ticket 610 (first-use walk 5): only when no row has every word, the words a request wraps around the thing are dropped
  // ("change font size", "check for updates", "언어 바꾸기").
  if (!hits.length) {
    hits = rows.filter(({ w }) => loosely(w, thing.length ? thing : parts));
  } else if (thing.length && thing.length < parts.length && !hits.some(({ own }) => all(own, parts))) {
    // Ticket 630 (walk 7 D4): every row matched only through a page name ("테마 바꾸기": the font rows, page 화면과 테마), so
    // the rows whose own words hold the thing ("테마") join them.
    hits = [...hits, ...rows.filter((e) => !hits.includes(e) && loosely(e.own, thing))];
  }
  // A row's own words above a page name (ticket 630): 2 every word, 1 the thing words, 0 only through a page name.
  const by = (own: string) => (all(own, parts) ? 2 : thing.length && loosely(own, thing) ? 1 : 0);
  return hits
    // Look 1117 v5 (q10b-2): a command named exactly the query beats one that only carries it as a synonym.
    // Ninth look (A N-S3-2): `n` is the fit of the shown name alone; of rows that fit alike through a keyword, the one whose
    // own name says the words comes first ("remove": Remove the project… before Close session, whose keyword is "remove session").
    .map((e) => ({ ...e, x: shown(e.c).toLowerCase() === q ? 1 : 0, m: by(e.own), f: fit(shown(e.c).toLowerCase(), e.k, q, parts), n: fit(shown(e.c).toLowerCase(), '', q, parts) }))
    // Eighth look (A): of rows that fit alike, one that can run now comes before one drawn off ("close": Close browser tab was first with no browser open).
    .sort((a, b) => tier(a.c) - tier(b.c) || b.x - a.x || b.m - a.m || b.f - a.f || b.n - a.n || Number(a.c.enabled === false) - Number(b.c.enabled === false) || a.i - b.i)
    .map((e) => e.c);
}

// V2.5-56 (ticket 215 B12): the list shows three groups, each under a header, in this order; `rank` orders the rows inside one.
const GROUPS = ['sessions', 'commands', 'settings'] as const;
const groupOf = (c: Command) => (c.id.startsWith('session.open.') ? 'sessions' : c.id.startsWith('settings.') ? 'settings' : 'commands');

export function Palette({ commands, recent, bindings, onClose, t }: { commands: Command[]; recent?: string[]; bindings: Bindings; onClose: () => void; t: T }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  // Ticket 991 A4: Enter on a disabled row says why instead of doing nothing.
  const [said, setSaid] = useState('');
  const why = (c: Command) => c.why ?? t(c.id.startsWith('board.card.') ? 'palette.cardOnly' : 'palette.unavailable');
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  // Ticket 492: a command shows its title in the window's language; the English title and id stay searchable.
  const shown = (c: Command) => commandTitle(t, c.id, c.title);
  const ranked = rank(commands.filter((c) => !MENU_ONLY.has(c.id)), q, recent, shown, (c) => commandWords(t, c.id), (c) => pageWord(t, c.id));
  const list = GROUPS.flatMap((g) => ranked.filter((c) => groupOf(c) === g)); // a header is no row: Up, Down and `sel` count rows only
  useEffect(() => {
    input.current?.focus();
    const prev = back.current;
    return () => (prev as HTMLElement | null)?.focus?.();
  }, []);
  // The selected row stays in view on Up and Down in a long list (needs 171); `nearest` moves the list only when the row is out of it.
  useEffect(() => {
    document.getElementById(`cmd-${sel}`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  // V2.5-34 (finding 27): Esc (wherever focus is) and a press outside the palette close it, as running a command does.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Ticket 535: Esc closes without acting, so a page the palette was opened from gets its keys back.
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !e.isComposing && (e.stopPropagation(), pageFocus(true), onClose());
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && onClose();
    window.addEventListener('keydown', esc, true);
    document.addEventListener('pointerdown', away, true);
    return () => (window.removeEventListener('keydown', esc, true), document.removeEventListener('pointerdown', away, true));
  }, [onClose]);
  const run = (c?: Command) => {
    if (c?.enabled === false) return setSaid(why(c));
    if (!c) return;
    pageFocus(false);
    onClose();
    // After the palette unmounts and focus returns, so commands that move focus win.
    setTimeout(() => c.run(), 0);
  };
  return (
    <div ref={root} className="palette glass" role="dialog" aria-modal="true" aria-label={t('palette.dialog')}>
      <input {...PLAIN}
        ref={input}
        role="combobox"
        aria-label={t('palette.search')}
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={list[sel] ? `cmd-${sel}` : undefined}
        placeholder={t('palette.placeholder')}
        // A search field, not prose: no macOS autocorrect bubble or spelling marks (V1A-54).
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0), setSaid(''))}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'ArrowDown') (e.preventDefault(), setSaid(''), setSel((s) => Math.min(s + 1, list.length - 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setSaid(''), setSel((s) => Math.max(s - 1, 0)));
          else if (e.key === 'Enter') (e.preventDefault(), run(list[sel]));
        }}
      />
      <p role="status" className="psaid">
        {said}
      </p>
      <ul id="palette-list" role="listbox" aria-label={t('palette.list')}>
        {list.map((c, i) => (
          <Fragment key={c.id}>
            {(i === 0 || groupOf(list[i - 1]) !== groupOf(c)) && (
              <li role="presentation" className="gh" data-group={groupOf(c)}>
                {t(`palette.group.${groupOf(c)}`)}
              </li>
            )}
            <li
              id={`cmd-${i}`}
              role="option"
              aria-selected={i === sel}
              aria-disabled={c.enabled === false}
              data-command={c.id}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
              style={c.enabled === false ? { opacity: 0.5 } : undefined}
            >
              {c.state && <i className="pdot" data-state={c.state} role="img" aria-label={t(`palette.state.${c.state}`)} />}
              <span>{shown(c)}</span>
              {c.enabled === false && <span className="why">{why(c)}</span>}
              {c.branch && <span className="branch" data-tip={c.branch} data-tip-clip="">{c.branch}</span>}
              {/* A session row's id is the session's internal id, not a command's name (look 1117 v6r, A S3-1). */}
              {c.name === undefined && <span className="id">{c.id}</span>}
              <span className="k">
                {(bindings[c.id] ?? []).slice(0, 1).map((b) => (
                  <KeyChip key={b} binding={b} bindings={bindings} />
                ))}
              </span>
            </li>
          </Fragment>
        ))}
        {!list.length && (
          <li role="status" className="empty" style={{ color: 'var(--muted)', cursor: 'default' }}>
            {t('palette.empty')}
          </li>
        )}
      </ul>
    </div>
  );
}
