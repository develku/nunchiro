// Settings · Theme (needs 28, 55, 70, 146): one gallery of installed and online themes. Hover or arrow focus previews a
// theme in the whole window without saving; a click, Enter or Space applies and saves it at once, and the undo line offers
// "Back to <the old theme>" for 10 s (Cmd+Z too; D-20261108-12, owner F17: no Keep step to forget). Esc, the pointer leaving
// the grid or leaving the page ends a preview that was never picked. Two light and two dark themes show first, the rest
// behind Show all. System mode keeps a light and a dark pick and follows the OS (Ghostty `theme = light:X,dark:Y`); a
// card goes to the selected slot row, which is the one showing now until the user selects a row (ticket 364).
import { PLAIN } from '../../plainText';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CoreClient } from '../../api';
import type { Key } from '../../i18n';
import { DEFAULTS, IMPORTS_CAP, type Settings } from '../../settings';
import { previewTheme, useOsDark } from '../../themes/apply';
import { luminance } from '../../themes/derive';
import { parseGhostty, type ThemeColors } from '../../themes/ghostty';
import { DARK_PICK, LIGHT_PICK, type ThemePick } from '../../themes/nunchiro';
import { push as pushUndo } from '../../undo/store';
import { ImportTheme } from './ImportTheme';
import { retryFile, useIndex, useThemeFiles } from './online';
import { ThemeCard, type Item } from './ThemeCard';
import { ThemeLicences, type Licences } from './ThemeLicences';
import { Icon } from '../../icons/Icon';
import { Reset, Row, Seg, Select, Switch } from '../shell/Row';
import './theme.css';

type T = (key: Key, args?: Record<string, string | number>) => string;
type Loaded = { themes: ThemePick[]; licences: Licences; notices: string };
type Catalog = { state: 'loading' } | { state: 'error' } | ({ state: 'ok' } & Loaded);

// The curated catalog is a lazy chunk: it loads when this page first opens, never at startup.
let catalog: Promise<Loaded> | null = null;
const loadCatalog = () =>
  (catalog ??= Promise.all([import('../../themes/catalog/catalog.gen'), import('../../themes/catalog/NOTICES.md?raw')])
    .then(([m, n]) => ({
      themes: Object.entries(m.THEMES).map(([name, text]) => ({ id: `catalog:${name}`, name, colors: parseGhostty(text) })),
      licences: m.LICENCES,
      notices: n.default,
    }))
    .catch((e) => {
      catalog = null;
      throw e;
    }));

/** Online cards per screen: one page; the next page loads when the end of the grid is scrolled into view. */
const PAGE = 24;
const CHIPS = ['All', 'Dark', 'Light', 'Installed'] as const;
type Chip = (typeof CHIPS)[number];
const CHIP_NAME: Record<Chip, Key> = { All: 'settings.theme.chipAll', Dark: 'settings.theme.chipDark', Light: 'settings.theme.chipLight', Installed: 'settings.theme.chipInstalled' };
/** Dark or light for the chips: background relative luminance (WCAG) below or above 0.5. */
const darkBg = (c: ThemeColors) => luminance(c.background) < 0.5;
type Slot = 'themeLight' | 'themeDark' | 'themeFixed';

export function ThemePage({ t, core, settings, update }: { t: T; core: CoreClient; settings: Settings; update: (patch: Partial<Settings>) => void }) {
  const osDark = useOsDark();
  const [picked, setPicked] = useState<'light' | 'dark' | null>(null);
  const target = picked ?? (osDark ? 'dark' : 'light');
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  const [chip, setChip] = useState<Chip>('All');
  const [more, setMore] = useState({ key: '', pages: 1 });
  const [note, setNote] = useState('');
  const [credits, setCredits] = useState(false);
  const [all, setAll] = useState(false);
  const [trial, setTrial] = useState<ThemePick | null>(null);
  const [cat, setCat] = useState<Catalog>({ state: 'loading' });
  const load = useCallback(() => {
    setCat({ state: 'loading' });
    loadCatalog().then(
      (loaded) => setCat({ state: 'ok', ...loaded }),
      () => setCat({ state: 'error' }),
    );
  }, []);
  useEffect(load, [load]);
  const [index, reloadIndex] = useIndex(core, settings.themeBrowse);

  const fixed = settings.themeMode === 'fixed';
  // Credits list each imported theme, plus a slot pick that could not join a full Imported list (a migrated one).
  const credited = [...settings.themesImported, settings.themeLight, settings.themeDark, settings.themeFixed].filter(
    (p, i, all) => p.id.startsWith('imported:') && all.findIndex((x) => x.id === p.id) === i,
  );
  const current = fixed ? settings.themeFixed : osDark ? settings.themeDark : settings.themeLight;
  const selectedPick = fixed ? settings.themeFixed : target === 'dark' ? settings.themeDark : settings.themeLight;
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const fits = (c: ThemeColors) => (chip === 'Dark' ? darkBg(c) : chip === 'Light' ? !darkBg(c) : true);
  const hidden = new Set(settings.themesHidden);
  const builtIns = [LIGHT_PICK, DARK_PICK, ...(cat.state === 'ok' ? cat.themes : [])];
  // A search or a chip looks through everything; otherwise the first two light and two dark built-ins (ticket 162).
  const expanded = all || !!q || chip !== 'All';
  const short = new Set(
    [false, true].flatMap((dark) =>
      builtIns
        .filter((p) => !hidden.has(p.id) && darkBg(p.colors) === dark)
        .slice(0, 2)
        .map((p) => p.id),
    ),
  );
  const hiddenCount = builtIns.filter((p) => hidden.has(p.id)).length;
  const have = new Set([...builtIns, ...settings.themesImported].map((p) => p.name));
  // Online cards wait for the bundled list, so a bundled theme never shows as one to install again.
  const online = !expanded || chip === 'Installed' || index.state !== 'ok' || cat.state !== 'ok' ? [] : index.themes.filter((e) => !have.has(e.name) && match(e.name));
  const key = `${q}\n${chip}`;
  const pages = more.key === key ? more.pages : 1;
  const shown = online.slice(0, pages * PAGE);
  // While a search is still being typed nothing is sent; then only the cards of the new result are.
  const files = useThemeFiles(core, typed === query ? shown.map((e) => e.name) : []);
  const items: Item[] = [
    ...builtIns.filter((p) => !hidden.has(p.id)).map((p): Item => ({ name: p.name, kind: 'builtin', pick: p, state: 'ok' })),
    ...settings.themesImported.map((p): Item => ({ name: p.name, kind: 'imported', pick: p, state: 'ok' })),
  ].filter((i) => (expanded || short.has(i.pick!.id)) && match(i.name) && fits(i.pick!.colors));
  // The short list reads two light, then two dark.
  if (!expanded) items.sort((a, b) => Number(darkBg(a.pick!.colors)) - Number(darkBg(b.pick!.colors)));
  for (const e of shown) {
    const f = files.get(e.name);
    if (!f) items.push({ name: e.name, kind: 'online', state: 'loading' });
    else if (f.state === 'error') items.push({ name: e.name, kind: 'online', state: 'error', error: f.error });
    else if (fits(f.pick.colors)) items.push({ name: e.name, kind: 'online', pick: f.pick, state: 'ok' });
  }
  const pageDone = shown.every((e) => files.has(e.name));
  const canMore = online.length > shown.length;
  const next = () => {
    if (!canMore || !pageDone) return false;
    setMore({ key, pages: pages + 1 });
    return true;
  };

  const revert = useCallback(() => setTrial(null), []);
  useEffect(() => previewTheme(trial), [trial]);
  useEffect(() => {
    // v25f: an Esc that ends a preview is taken (preventDefault), so the Settings modal around it stays open; with no preview it closes the modal.
    const esc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && trial && (e.preventDefault(), revert());
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [revert, trial]);
  useEffect(() => () => previewTheme(null), []); // leaving the page ends any preview
  // Hover or arrow focus on a card previews it; on the theme in use it ends the preview.
  const preview = useCallback((p: ThemePick) => setTrial(p.id === current.id ? null : p), [current.id]);

  // The next page: only on a scroll of the grid the user made (wheel, touch, keys, scrollbar drag) that shows its end,
  // or on the button. Layout shifts, filter changes and resizes move the grid too, but never fetch (ADR: no prefetch).
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLButtonElement>(null);
  const nextRef = useRef(next);
  nextRef.current = next;
  useEffect(() => {
    const el = scroller.current!;
    let intent = 0;
    let dragging = false;
    const user = () => (intent = performance.now());
    const down = (e: PointerEvent) => (dragging = e.target === el);
    const up = () => (dragging = false);
    const scrolled = () => {
      if (!dragging && performance.now() - intent > 600) return;
      const r = end.current?.getBoundingClientRect();
      const v = el.getBoundingClientRect();
      if (r && r.top < v.bottom && r.bottom > v.top && nextRef.current()) intent = 0;
    };
    const opts = { passive: true };
    el.addEventListener('wheel', user, opts);
    el.addEventListener('touchmove', user, opts);
    el.addEventListener('keydown', user, opts);
    el.addEventListener('pointerdown', down, opts);
    window.addEventListener('pointerup', up, opts);
    el.addEventListener('scroll', scrolled, opts);
    return () => {
      el.removeEventListener('wheel', user);
      el.removeEventListener('touchmove', user);
      el.removeEventListener('keydown', user);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('scroll', scrolled);
    };
  }, []);

  const s = useRef(settings);
  s.current = settings;
  // After Hide or Remove the card is gone with focus in it: focus the card now at its place (or the one before).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const grid = useRef<HTMLDivElement>(null);
  const refocus = useRef(-1);
  useEffect(() => {
    if (refocus.current < 0) return;
    const list = grid.current?.querySelectorAll<HTMLButtonElement>('.tpick:not(:disabled)') ?? [];
    list[Math.min(refocus.current, list.length - 1)]?.focus();
    refocus.current = -1;
  });
  const apply = useCallback(
    (p: ThemePick, slot?: 'light' | 'dark') => {
      const now = s.current;
      revert();
      const fresh = p.id.startsWith('imported:') && !now.themesImported.some((x) => x.id === p.id);
      if (fresh && now.themesImported.length >= IMPORTS_CAP) return setNote(t('settings.theme.installFull', { cap: IMPORTS_CAP }));
      const k: Slot = slot === 'light' ? 'themeLight' : slot === 'dark' ? 'themeDark' : now.themeMode === 'fixed' ? 'themeFixed' : target === 'dark' ? 'themeDark' : 'themeLight';
      const was = now[k];
      if (was.id === p.id) return;
      const patch: Partial<Settings> = { [k]: p };
      // Applying an online theme installs it (V1A-47 item 7: source and licence kept with it).
      if (fresh) patch.themesImported = [...now.themesImported, p];
      setNote('');
      update(patch);
      // D-20261108-12: the pick is saved at once; Back (or Cmd+Z) puts the old theme in the slot, and takes away the install
      // it brought if the slot still holds it.
      pushUndo({
        label: t('settings.theme.backTo', { name: was.name }),
        undo: () => {
          const cur = s.current;
          if (cur[k].id !== p.id) return;
          const back: Partial<Settings> = { [k]: was };
          if (fresh) back.themesImported = cur.themesImported.filter((x) => x.id !== p.id);
          update(back);
        },
      });
    },
    [target, revert, update, t],
  );
  const remove = useCallback(
    (p: ThemePick) => {
      const now = s.current;
      refocus.current = itemsRef.current.findIndex((i) => i.pick?.id === p.id);
      revert();
      const patch: Partial<Settings> = { themesImported: now.themesImported.filter((x) => x.id !== p.id) };
      const moved: string[] = [];
      if (now.themeLight.id === p.id) {
        patch.themeLight = LIGHT_PICK;
        moved.push(t('settings.theme.movedLight'));
      }
      if (now.themeDark.id === p.id) {
        patch.themeDark = DARK_PICK;
        moved.push(t('settings.theme.movedDark'));
      }
      if (now.themeFixed.id === p.id) {
        patch.themeFixed = darkBg(p.colors) ? DARK_PICK : LIGHT_PICK;
        moved.push(t('settings.theme.movedFixed', { name: patch.themeFixed.name }));
      }
      setNote(moved.length ? t('settings.theme.wasInUse', { name: p.name, moved: moved.join(', ') }) : '');
      update(patch);
      // V2-6a: Undo puts the theme back at its place and returns the slots it held (only those still on the fallback).
      const at = now.themesImported.findIndex((x) => x.id === p.id);
      pushUndo({
        label: t('settings.theme.undoRemoved', { name: p.name }),
        undo: () => {
          const cur = s.current;
          const list = cur.themesImported.filter((x) => x.id !== p.id);
          // Q9 ko-J14-1: a list filled again since the Remove takes no more (a longer stored list is refused whole).
          if (list.length >= IMPORTS_CAP) return setNote(t('settings.theme.importFull', { cap: IMPORTS_CAP }));
          list.splice(at, 0, p);
          const back: Partial<Settings> = { themesImported: list };
          if (patch.themeLight && cur.themeLight.id === patch.themeLight.id) back.themeLight = now.themeLight;
          if (patch.themeDark && cur.themeDark.id === patch.themeDark.id) back.themeDark = now.themeDark;
          if (patch.themeFixed && cur.themeFixed.id === patch.themeFixed.id) back.themeFixed = now.themeFixed;
          update(back);
          setNote('');
        },
      });
    },
    [revert, update, t],
  );
  // The card goes away with focus inside it, so no blur reaches the grid: end any preview here.
  const hide = useCallback(
    (p: ThemePick) => {
      refocus.current = itemsRef.current.findIndex((i) => i.pick?.id === p.id);
      revert();
      update({ themesHidden: [...s.current.themesHidden, p.id].slice(-200) }); // Q9 zh-hant-J13-2: the store keeps at most 200
      pushUndo({ label: t('settings.theme.undoHid', { name: p.name }), undo: () => update({ themesHidden: s.current.themesHidden.filter((id) => id !== p.id) }) }); // V2-6a
    },
    [revert, update, t],
  );

  // Arrow keys move focus card to card and preview each; Enter or Space on a card is its click and applies it.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 0, ArrowUp: 0 }[e.key];
    if (step === undefined) return;
    const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('.tpick:not(:disabled)')];
    const at = list.indexOf((e.target as Element).closest('.tcard')?.querySelector('.tpick') as HTMLButtonElement);
    const cols = list.filter((b) => b.offsetTop === list[0]?.offsetTop).length || 1;
    const to = list[Math.min(list.length - 1, Math.max(0, at < 0 ? 0 : at + (step || (e.key === 'ArrowDown' ? cols : -cols))))];
    if (!to) return;
    e.preventDefault();
    to.focus();
    const p = items[Number(to.dataset.idx)]?.pick;
    if (p) preview(p);
  };

  // final.html F.theme themeLight/themeDark: a slot lists the installed themes (the ⋯ menu also reaches online ones); a slot's
  // pick outside that list (hidden, or a migrated one) stays selectable.
  const slotRow = (slot: 'light' | 'dark') => {
    const cur = slot === 'light' ? settings.themeLight : settings.themeDark;
    const list = [...builtIns.filter((p) => !hidden.has(p.id)), ...settings.themesImported];
    if (!list.some((p) => p.id === cur.id)) list.push(cur);
    const label = t(slot === 'light' ? 'settings.theme.whenLight' : 'settings.theme.whenDark');
    const on = !fixed && target === slot;
    return (
      <Row
        sub
        className={on ? 'tslot on' : 'tslot'}
        reset={<Reset t={t} label={label} show={cur.id !== (slot === 'light' ? DEFAULTS.themeLight : DEFAULTS.themeDark).id} run={() => apply(slot === 'light' ? DEFAULTS.themeLight : DEFAULTS.themeDark, slot)} />}
        label={
          <button type="button" className="tslotbtn" aria-pressed={on} onClick={() => setPicked(slot)}>
            {label}
          </button>
        }
        control={
          // Opening a dropdown selects its row. Never on focus: tabbing past it must not move the selection.
          <span onPointerDown={() => setPicked(slot)} onKeyDown={(e) => [' ', 'Enter', 'ArrowUp', 'ArrowDown'].includes(e.key) && setPicked(slot)}>
            <Select label={label} value={cur.id} onChange={(id) => apply(list.find((p) => p.id === id)!, slot)}>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </span>
        }
      />
    );
  };

  // Ticket 250 r3: the final draft's Theme card: the mode as a segment, the gallery as one row, then browse and import.
  return (
    <section aria-labelledby="h-theme" className="tpage ssec">
      <h2 id="h-theme">{t('page.theme')}</h2>
      <div className="scard">
      <Row
        label={t('settings.theme.mode')}
        desc={t('settings.theme.modeDesc')}
        reset={<Reset t={t} label={t('settings.theme.mode')} show={settings.themeMode !== DEFAULTS.themeMode} run={() => update({ themeMode: DEFAULTS.themeMode })} />}
        control={<Seg name="theme-mode" label={t('settings.theme.mode')} value={fixed ? 'fixed' : 'system'} onChange={(v) => update({ themeMode: v })} options={[['system', t('settings.theme.follow')], ['fixed', t('settings.theme.one')]]} />}
      />
      {!fixed && slotRow('light')}
      {!fixed && slotRow('dark')}
      <Row
        label={t('settings.theme.pick')}
        desc={t('settings.theme.pickDesc')}
        control={
          <>
            <span className="tsearch">
              <Icon name="search" size={12} />
              <input {...PLAIN} type="search" placeholder={t('settings.theme.search')} aria-label={t('settings.theme.search')} data-setting="themes" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </span>
            {hiddenCount > 0 && (
              <button className="btn" onClick={() => update({ themesHidden: [] })}>
                {t('settings.theme.showHidden', { n: hiddenCount })}
              </button>
            )}
          </>
        }
      />
      <div className="stgallery">
      <div className="tfilter">
        <div className="tchips" role="group" aria-label={t('settings.theme.show')}>
          {CHIPS.map((c) => (
            <button key={c} className="chip" aria-pressed={chip === c} onClick={() => setChip(c)}>
              {t(CHIP_NAME[c])}
            </button>
          ))}
        </div>
      </div>
      {note && (
        <p className="lede" role="status">
          {note}
        </p>
      )}
      {cat.state === 'error' && (
        <p className="conflict" role="alert">
          {t('settings.theme.builtinFailed')}{' '}
          <button className="btn" onClick={load}>
            {t('settings.theme.tryAgain')}
          </button>
        </p>
      )}
      {/* The grid scrolls in its own area, so the settings below it stay put while pages load. */}
      <div className="tscroll" ref={scroller}>
        <div
          ref={grid}
          className="tcards"
          role="list"
          aria-label={t('settings.theme.themes')}
          onKeyDown={onKey}
          onPointerLeave={revert}
        >
          {items.map((i, n) => (
            <ThemeCard t={t} key={`${i.kind === 'online' ? 'imported' : i.kind}:${i.name}`} item={i} idx={n} applied={!!i.pick && i.pick.id === selectedPick.id} trial={!!i.pick && i.pick.id === trial?.id} onPreview={preview} onApply={apply} onRemove={remove} onHide={hide} onRetry={retryFile} />
          ))}
        </div>
        {items.length === 0 && cat.state === 'ok' && <p className="lede">{t('settings.theme.noMatch', { query })}</p>}
        <div className="tkeep">
          {!q && chip === 'All' && (
            <button className="btn" aria-expanded={all} onClick={() => setAll(!all)}>
              {t(all ? 'settings.theme.fewer' : 'settings.theme.moreThemes')}
            </button>
          )}
        </div>
        {canMore && (
          <button ref={end} className="btn tmore-page" disabled={!pageDone} aria-busy={!pageDone || undefined} onClick={next}>
            {t('settings.theme.more')}
          </button>
        )}
      </div>
      {index.state === 'loading' && (
        <p className="lede" role="status">
          {t('settings.theme.loading')}
        </p>
      )}
      {index.state === 'error' && (
        <p className="conflict" role="alert">
          {t('err.themeOffline')}.{' '}
          <button className="btn" onClick={reloadIndex}>
            {t('settings.theme.retry')}
          </button>
        </p>
      )}
      </div>
      <Row
        label={t('chatColours.title')}
        desc={t('chatColours.desc')}
        reset={<Reset t={t} label={t('chatColours.title')} show={settings.chatColours !== DEFAULTS.chatColours} run={() => update({ chatColours: DEFAULTS.chatColours })} />}
        control={<Seg name="chat-colours" label={t('chatColours.title')} value={settings.chatColours} onChange={(v) => update({ chatColours: v })} options={[['theme', t('chatColours.accents')], ['plain', t('chatColours.plain')]]} />}
      />
      <Row label={t('field.themeBrowse')} reset={<Reset t={t} label={t('field.themeBrowse')} show={settings.themeBrowse !== DEFAULTS.themeBrowse} run={() => update({ themeBrowse: DEFAULTS.themeBrowse })} />} desc={t('settings.theme.browseNote')} control={<Switch setting="themeBrowse" label={t('field.themeBrowse')} checked={settings.themeBrowse} onChange={(v) => update({ themeBrowse: v })} />} />
      <ImportTheme t={t} taken={settings.themesImported.map((p) => p.name)} onAdd={(p) => update({ themesImported: [...settings.themesImported, p] })} />
      {/* One inline run (ticket 483): as bare grid items the link wrapped alone onto its own line. A no-break space keeps
          the link with the "·" before it; a wrapped line starts at the left. */}
      <p className="tfoot srow">
        <span>
          {t('settings.theme.from')}{'\u00a0'}
          <button className="tlink" aria-expanded={credits} onClick={() => setCredits(!credits)}>
            {t('settings.theme.creditsLink')}
          </button>
        </span>
      </p>
      {credits && cat.state === 'ok' && <ThemeLicences t={t} licences={cat.licences} imported={credited} notices={cat.notices} />}
      </div>
    </section>
  );
}
