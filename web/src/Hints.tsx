// Vimium-style hints (needs 25; ticket 389): labels over the clickable or focusable elements worth a click and over URLs and
// file paths in the visible xterm.js buffer. Typed by the letter shown (any layout or remap); with Korean or Chinese input
// on, the key's QWERTY letter. Projects read p1, sessions s1 (a tab and its rows alike), the rest one letter by screen
// region; Shift + a kind letter filters (hintLabels.ts).
import { useEffect, useState } from 'react';
import { assign, DEFAULT_HINT_KEYS, DRAWN, isRegion, KINDS, kindOfMark, soleTarget, typedKey, type HintItem, type HintKeys, type Kind } from './hintLabels';
import { tEn, type T } from './i18n';
import { isModifier } from './keys';
import { terminals } from './Terminal';
import { openLink, PATH_RE, URL_RE } from './terminal/links';
import { copyText } from './terminal/clipboard';
/** On-screen box; a target's own box lets its label move along it without leaving it. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Found extends Box {
  kind: 'element' | 'url' | 'path' | 'hash';
  el?: HTMLElement;
  text?: string;
  item: HintItem;
  /** Ticket 408: a control's first character, which its own label leaves readable. */
  first?: Box;
}

/** A found target placed once; its label depends on what is typed. */
interface Placed extends Found {
  /** Width reserved for the longest label this target can read, so a filtered (shorter) label never overlaps. */
  width: number;
}

// `[data-hint-kind]` adds what a mark names but focus skips, such as the tab strip's inactive tabs.
const SELECTOR = 'button:not(:disabled), a[href], input:not([type=hidden]):not(:disabled), textarea:not(.xterm-helper-textarea):not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"]), .term, [data-hint-kind]';
// A git hash: 7-40 hex with at least one letter and one digit, so plain numbers and words are skipped.
const HASH_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;

/**
 * Seen by the user: the topmost thing at the centre or an inner corner of its on-screen part is the element, so a
 * scroll parent's clip or a dock over all of it hides it, and a half-clipped one still counts.
 */
function shown(el: HTMLElement, r: DOMRect) {
  const l = Math.max(r.left, 0);
  const t = Math.max(r.top, 0);
  const rt = Math.min(r.right, innerWidth);
  const b = Math.min(r.bottom, innerHeight);
  if (rt - l < 1 || b - t < 1) return false;
  return [
    [(l + rt) / 2, (t + b) / 2],
    [l + 1, t + 1],
    [rt - 1, t + 1],
    [l + 1, b - 1],
    [rt - 1, b - 1],
  ].some(([x, y]) => shownAt(el, x, y));
}
// The prefix badge is still on screen while hints collect and gone once they show, so it hides nothing.
const shownAt = (el: HTMLElement, x: number, y: number) => {
  const top = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementsFromPoint(x, y).find((e) => !e.closest('.prefix-armed')) : null;
  return !!top && el.contains(top);
};

/** The badge height from the one place that sets it (styles.css `--hint-h`), so labels stacked by it never overlap. */
const labelH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hint-h')) || 18;
/** Slightly wider than the 11 px mono label with its padding and border, so a placed label never overlaps by rounding. */
const labelW = (label: string) => label.length * 7 + 8;

/**
 * First spot touching the target (its leading top corner, then inside its top edge, then around it) where the label is on screen and meets no placed
 * label, preferring one that leaves every tab and project name readable; else a spot pulled on screen that still leaves
 * the target's first character readable (its own top-left when nothing does): every target keeps its label.
 */
function place(t: Box & { first?: Box }, w: number, placed: Box[], names: Box[]) {
  const h = labelH();
  const meets = (x: number, y: number, boxes: Box[]) => boxes.some((p) => x < p.x + p.w && p.x < x + w && y < p.y + p.h && p.y < y + h);
  const free = (x: number, y: number) => x >= 0 && y >= 0 && x + w <= innerWidth && y + h <= innerHeight && !meets(x, y, placed);
  const spots: [number, number][] = [];
  // Ticket 408: a label at the corner that would cover the first character moves left over the leading border, ending where the character starts.
  if (t.first && meets(t.x, t.y, [t.first])) spots.push([t.first.x - w, t.y]);
  for (let x = t.x; x + w <= t.x + t.w || x === t.x; x += w) spots.push([x, t.y]);
  for (let y = t.y; y + h <= t.y + t.h; y += h) spots.push([t.x, y], [t.x + t.w - w, y]);
  // Beside the target, level with it: a diagonal corner spot would not touch it.
  for (let y = t.y; y < t.y + t.h || y === t.y; y += h) spots.push([t.x - w, y], [t.x + t.w, y]);
  for (let x = t.x; x < t.x + t.w || x === t.x; x += w) spots.push([x, t.y - h], [x, t.y + t.h]);
  // With no spot clear of every name, the free one hiding the least name (V1A-54: the first free one was a long name's start).
  const area = (x: number, y: number, boxes: Box[]) => boxes.reduce((a, p) => a + Math.max(0, Math.min(x + w, p.x + p.w) - Math.max(x, p.x)) * Math.max(0, Math.min(y + h, p.y + p.h) - Math.max(y, p.y)), 0);
  const hides = (x: number, y: number) => area(x, y, names);
  let spot: [number, number] | undefined;
  let least = Infinity;
  for (const [sx, sy] of spots) if (free(sx, sy) && hides(sx, sy) < least) [spot, least] = [[sx, sy], hides(sx, sy)];
  // Last resort, every target keeps its label: the target's own top-left pulled on screen. Ticket 408: a target with a
  // first character (text, not an icon or terminal text) instead takes the on-screen spot that leaves it readable (the
  // top-left, just past the character, or any spot), over the least placed label; the top-left when none does.
  const clamp = ([x, y]: [number, number]): [number, number] => [Math.min(Math.max(x, 0), innerWidth - w), Math.min(Math.max(y, 0), innerHeight - h)];
  const first = t.first;
  if (!spot && first) {
    const last = [[t.x, t.y] as [number, number], [first.x + first.w, t.y] as [number, number], ...spots].map(clamp);
    const cost = ([x, y]: [number, number]) => (meets(x, y, [first]) ? Infinity : area(x, y, placed));
    spot = last.reduce((a, b) => (cost(b) < cost(a) ? b : a));
  }
  spot ??= clamp([t.x, t.y]);
  placed.push({ x: spot[0], y: spot[1], w, h });
  return { x: spot[0], y: spot[1] };
}

/** Ticket 408: the first non-space character of a control's own text (not a nested control's), as a box. */
const CONTROL = 'button, a[href], [role="button"], [role="tab"]';
function firstGlyph(el: HTMLElement): Box | undefined {
  if (!el.matches(CONTROL)) return;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const at = n.textContent!.search(/\S/);
    if (at < 0 || n.parentElement?.closest(CONTROL) !== el) continue;
    const r = document.createRange();
    r.setStart(n, at);
    r.setEnd(n, at + String.fromCodePoint(n.textContent!.codePointAt(at)!).length);
    const b = r.getBoundingClientRect();
    if (b.width && b.height) return { x: b.left, y: b.top, w: b.width, h: b.height };
  }
}

/** Glyph boxes of tab, project and session row names (V1A-52): a label on the start of a 1-3 character name hid it whole. */
function nameBoxes(found: Found[]): Box[] {
  const out: Box[] = found.flatMap((f) => (f.first ? [f.first] : []));
  for (const { el } of found) {
    if (!el?.matches('[data-hint-kind="tab"], [data-hint-kind="project"], [data-hint-kind="agent"]')) continue;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      // A nested button (the tab's close x) is a target of its own, not part of the name.
      if (n.parentElement?.closest('button') !== (el.matches('button') ? el : null)) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const b of r.getClientRects()) out.push({ x: b.left, y: b.top, w: b.width, h: b.height });
    }
  }
  return out;
}

// Ticket 389: no label where nothing useful happens. Drag edges, marked duplicates (`data-hint-skip`, with what is inside),
// and the clickable parts inside a project or session row, which its own label already opens.
// Ticket 408: a control marked unusable (`aria-disabled`) gets none either.
const SKIP = '[hidden], .hints-layer, .hint-preview, .hk-board, .xterm, [data-hint-skip], [role="separator"], [aria-disabled="true"]';
const ROW = '[data-hint-kind="project"], [data-hint-kind="agent"], [data-hint-kind="session"]';

/**
 * `jump` is the tab strip order. A session's slot is its tab's place (s1 = Cmd-1), else after the tabs in tree order; its
 * tab and every row of it share the slot. A project's is its rank.
 */
function collect(copy: boolean, jump: string[]): Found[] {
  const out: Found[] = [];
  const slots = new Map<string, number>();
  let i = 0;
  let projects = 0;
  let loose = jump.length;
  for (const el of copy ? [] : document.querySelectorAll<HTMLElement>(SELECTOR)) {
    const r = el.getBoundingClientRect();
    // Ticket 408: an ended session's read-only terminal takes no input, so focusing it does nothing (its links still get labels).
    if (r.width < 3 || r.height < 3 || el.closest(SKIP) || el.parentElement?.closest(ROW) || el.matches('.roterm .term')) continue;
    // Invisible until hover (opacity 0) is not seen; WebKit before 17.4 has no checkVisibility and keeps the old rule.
    if (el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false || !shown(el, r)) continue;
    const order = i++;
    const { hintIcon, hintKind, hintSession, tab } = el.dataset;
    const region = el.closest<HTMLElement>('[data-hint-region]')?.dataset.hintRegion;
    let item: HintItem = { kind: 'other', order, region: isRegion(region) ? region : undefined, quiet: !!el.closest('[data-hint-quiet]') };
    const k = kindOfMark(hintKind);
    const session = k === 'session' ? hintSession : k === 'tab' ? tab : undefined;
    if (k === 'project') item = { kind: k, order: projects++ };
    else if (k && session) {
      if (!slots.has(session)) slots.set(session, jump.includes(session) ? jump.indexOf(session) : loose++);
      item = { kind: k, order: slots.get(session)! };
    } else if (k && k !== 'session' && k !== 'tab') item = { ...item, kind: k, icon: hintIcon };
    out.push({ x: r.left, y: r.top, w: r.width, h: r.height, kind: 'element', el, item, first: firstGlyph(el) });
  }
  for (const [, term] of terminals) {
    const el = term.element;
    if (!el || el.closest('[hidden]')) continue;
    const screen = el.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (!screen) continue;
    const cw = screen.width / term.cols;
    const ch = screen.height / term.rows;
    const buf = term.buffer.active;
    for (let row = 0; row < term.rows; row++) {
      const line = buf.getLine(buf.viewportY + row)?.translateToString(true) ?? '';
      const seen: [number, number][] = [];
      for (const [re, kind] of [
        [URL_RE, 'url'],
        [PATH_RE, 'path'],
        ...(copy ? ([[HASH_RE, 'hash']] as const) : []),
      ] as const) {
        for (const m of line.matchAll(re)) {
          const start = m.index ?? 0;
          if (seen.some(([a, b]) => start >= a && start < b)) continue;
          seen.push([start, start + m[0].length]);
          if (!shownAt(el, screen.left + start * cw + 1, screen.top + row * ch + 1)) continue;
          const [x, y] = [screen.left + start * cw, screen.top + row * ch];
          // Terminal text after every element, nearest the prompt first (bottom row up, then left to right), like kitty.
          out.push({ x, y, w: m[0].length * cw, h: ch, kind, text: m[0], item: { kind, order: 1e9 - Math.round(y) * 1e4 + Math.round(x) } });
        }
      }
    }
  }
  return out;
}

/** `copy` labels terminal text only and puts the chosen text on the clipboard instead of opening or pasting it. */
export function Hints({
  copy,
  hintKeys = DEFAULT_HINT_KEYS,
  jump = [],
  t,
  onStart,
  onDone,
  onPath,
  onCopied,
  onLetters,
}: {
  copy?: boolean;
  /** Ignored since needs 118 (icons no longer read their own binding); App still passes it. */
  bindings?: unknown;
  hintKeys?: HintKeys;
  jump?: string[];
  /** The window's language, for the "letters do not match?" line; without it the line never shows. */
  t?: T;
  onStart: () => void;
  onDone: () => void;
  onPath: (p: string) => void;
  onCopied?: (ok: boolean) => void;
  /** Opens Settings > Keyboard > Hints at the letters field. */
  onLetters?: () => void;
}) {
  const [targets] = useState<Placed[]>(() => {
    const found = collect(!!copy, jump);
    const its = found.map((f) => f.item);
    const global = assign(its, hintKeys);
    const own = new Map(KINDS.map((k) => [k, assign(its, hintKeys, k)]));
    const placed: Box[] = [];
    const names = nameBoxes(found);
    // Room for the longer of its two labels (all, or its kind alone); labelled targets take spots before quiet ones.
    const width = (i: number) => labelW([global[i], own.get(found[i].item.kind)![i]].reduce((a, b) => (b.length > a.length ? b : a)).join(''));
    const at = found.map((_, i) => i).sort((a, b) => +!global[a].length - +!global[b].length || a - b);
    const spots = new Map(at.map((i) => [i, place(found[i], width(i), placed, names)]));
    return found.map((t, i) => ({ ...t, ...spots.get(i)!, width: width(i) }));
  });
  const items = targets.map((t) => t.item);
  const [kind, setKind] = useState<Kind | null>(null);
  const [typed, setTyped] = useState<string[]>([]);
  // Letters typed that start no label. Two in one session show the "letters do not match?" line, once (owner 11-10).
  const [misses, setMisses] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(onStart, []);
  // Shift + a kind letter filters and relabels only that kind from the alphabet start, quiet targets included.
  const labels = assign(items, hintKeys, kind ?? undefined);

  useEffect(() => {
    const pick = (hit: Placed) => {
      onDone();
      if (copy) {
        if (hit.text) void copyText(hit.text).then((ok) => onCopied?.(ok));
        return;
      }
      if (hit.kind === 'element' && hit.el) {
        if (hit.el.classList.contains('term')) terminals.get(hit.el.dataset.session ?? '')?.focus();
        else if (hit.el.matches('input, textarea, select')) hit.el.focus();
        else {
          hit.el.focus();
          hit.el.click();
        }
      } else if (hit.kind === 'url' && hit.text) void openLink(hit.text);
      else if (hit.text) onPath(hit.text);
    };
    const onKey = (e: KeyboardEvent) => {
      // A composing input method, a lone modifier or a chord with ⌘ ⌃ ⌥ is not a hint key.
      if (e.isComposing || isModifier(e.code) || e.metaKey || e.ctrlKey || e.altKey) return;
      const esc = e.key === 'Escape' || e.code === 'Escape';
      const back = e.key === 'Backspace' || e.code === 'Backspace';
      // The letter typed (any layout or remap); with Korean or Chinese on (key 'Process', keyCode 229) the key's QWERTY letter.
      const k = typedKey(e);
      // Shift + a kind letter is a filter, never a label key: with no target of that kind it does nothing.
      const shiftKind = e.shiftKey && !kind && !typed.length ? KINDS.find((kk) => hintKeys.kinds[kk] === k) : undefined;
      const named = shiftKind && items.some((it) => it.kind === shiftKind) ? shiftKind : undefined;
      if (shiftKind && !named) return;
      // Tab, arrows and other keys no label can use are ignored.
      if (!(esc || back || named || DRAWN.has(k))) return;
      e.preventDefault();
      e.stopPropagation();
      // A held key's auto-repeat is one keystroke: kept from the page, but it never types, picks or counts as a miss.
      if (e.repeat) return;
      if (esc) return onDone();
      if (back) return typed.length ? setTyped(typed.slice(0, -1)) : setKind(null);
      if (named) {
        const sole = soleTarget(items, named);
        if (sole !== null) return pick(targets[sole]);
        return setKind(named);
      }
      const next = [...typed, k];
      const key = next.join(' ');
      // A tab and its session's rows share a label: the tab is the one picked.
      const hits = targets.filter((_, i) => labels[i].join(' ') === key);
      if (hits.length) return pick(hits.find((h) => h.item.kind === 'tab') ?? hits[0]);
      if (labels.some((l) => l.join(' ').startsWith(`${key} `))) setTyped(next);
      // A letter no label starts with stays in hint mode: it may be a layout or remap mismatch, not a cancel.
      else setMisses((m) => m + 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [typed, kind, targets, labels, items, hintKeys, copy, onDone, onPath, onCopied]);

  // Labels stay put as keys are typed (no renumbering); the ones the typed letters do not start dim.
  const shownTargets = targets.flatMap((t, i) => (labels[i].length ? [{ t, keys: labels[i], dim: !typed.every((c, j) => labels[i][j] === c) }] : []));
  // Test seam, built in only for the suite (VITE_FEATURE_FIXTURES, as menu/ContextMenu.tsx): the element each shown label names.
  if (import.meta.env.VITE_FEATURE_FIXTURES) (window as unknown as { __hintTargets: unknown }).__hintTargets = shownTargets.map(({ t: x, keys }) => ({ el: x.el, label: keys.join('') }));
  const [before, after] = t ? t('hints.mismatch', { link: '\u0001' }).split('\u0001') : ['', ''];
  return (
    <div className="hints-layer" role="status" aria-label={(t ?? tEn)(shownTargets.length === 1 ? 'rest.shell.hints.aria.one' : 'rest.shell.hints.aria.other', { n: shownTargets.length })}>
      {shownTargets.map(({ t: target, keys, dim }, n) => {
        const label = keys.join('');
        const typedText = dim ? '' : typed.join('');
        return (
          <span
            key={n}
            className="hint"
            data-dim={dim || undefined}
            data-hint={label}
            data-keys={keys.join(' ')}
            data-kind={target.kind}
            data-hint-kind={target.item.kind}
            data-hint-icon={target.item.icon}
            data-text={target.text}
            // The box placement reserved, so a label beside its target touches it and meets no other label.
            style={{ left: target.x, top: target.y, width: target.width, opacity: dim ? 0.3 : undefined }}
          >
            <span className="typed">{typedText}</span>
            {label.slice(typedText.length)}
          </span>
        );
      })}
      {t && onLetters && misses >= 2 && (
        <p className="hint-miss" style={{ position: 'fixed', left: '50%', bottom: 36, transform: 'translateX(-50%)', margin: 0, padding: '4px 10px', borderRadius: 'var(--r-6)', background: 'var(--panel)', color: 'var(--muted)', border: '1px solid var(--line)', font: '12px/1.4 system-ui', pointerEvents: 'auto', zIndex: 1 }}>
          {before}
          <button type="button" className="linkbtn" style={{ font: 'inherit', color: 'var(--run)', background: 'none', border: 0, padding: 0, textDecoration: 'underline', cursor: 'pointer' }} onClick={() => (onDone(), onLetters())}>
            {t('hints.mismatchLink')}
          </button>
          {after}
        </p>
      )}
    </div>
  );
}
