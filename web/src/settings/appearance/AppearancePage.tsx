// Settings · Appearance and Terminal (needs 39, 54, 146; ticket 250 final draft): the Interface part (row height, tab font
// size, chat width, title bar) on Appearance, the Terminal part (font family and size; (v1a-35) copy on select and OSC 52
// clipboard writes) on its own Terminal page. All apply at once. The
// terminal font (V1A-64; needs 71) is picked from installed coding fonts or typed as a Custom… list. The Files and
// Search dock sides left with LAYOUT D5b (dbb7831b): a bar icon moves to either side in Layout.
import { PLAIN } from '../../plainText';
import type { Key } from '../../i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULTS, DENSITY, FONT, heights, ROW_MAX, ROW_MIN, type Density, type Osc52, type Settings } from '../../settings';
import { FontSample } from './sample';
import { TERM_PREFS } from '../../features/terminal';
import { CHAT_SIZE } from '../../features/chat-type';
import { useFeatureSetting } from '../useFeatureSetting';
import { RANGES, TERM_DEFAULTS } from '../../terminal/options';
import { Icon } from '../../icons/Icon';
import { Reset, Row, Sec, SecReset, Seg, StepBox, Stepper, Switch } from '../shell/Row';
import { loadFamilies, names } from './serve';
import { PageSummary } from '../shell/PageActions';
import { useOsDark } from '../../themes/apply';
import { allFonts, appFonts, CURATED, entryOf, installedFonts, SYMBOLS, termFontFor, type Family } from './fonts';

const OSC52: [Osc52, Key][] = [
  ['ask', 'settings.appearance.askTitle'],
  ['allow', 'settings.appearance.allowTitle'],
  ['deny', 'settings.appearance.denyTitle'],
];

const DEFAULT_ROW = DENSITY[DEFAULTS.density].row;

type T = (key: Key, args?: Record<string, string | number>) => string;
type Update = (patch: Partial<Settings>) => void;

export function AppearancePage({ t, settings, update, part }: { t: T; settings: Settings; update: Update; part: 'interface' | 'terminal' }) {
  const row = heights(settings).row;
  const osDark = useOsDark();
  const fixed = settings.themeMode === 'fixed';
  const [chatSize] = useFeatureSetting(CHAT_SIZE);
  // A typed height that is a density's own stores that density (its agent-row and tab heights), else the typed px.
  const typeRow = (v: number) => {
    const preset = (Object.keys(DENSITY) as Density[]).find((d) => DENSITY[d].row === v);
    update(preset ? { density: preset, rowHeight: null, densityPicked: true } : { rowHeight: v, densityPicked: true });
  };
  if (part === 'terminal') return <TerminalPart t={t} settings={settings} update={update} />;
  const theme = fixed ? settings.themeFixed : osDark ? settings.themeDark : settings.themeLight;
  // ticket 162: settings grouped by surface, as Zed and VS Code do (docs/research/settings-polish.md (b)). Ticket 250 r3:
  // the final draft's Interface card: steppers for the row height, tab font and chat width, the title bar as a segment.
  return (
    <Sec id="h-interface" title={t('settings.section.interface')}>
      <PageSummary parts={[[t('summary.theme'), theme.name, t(fixed ? 'summary.oneTheme' : 'summary.followsSystem')], [t('summary.rows'), `${row} px`], [t('summary.chatText'), `${chatSize} px`]]} />
      {/* owner 11-08 (D-20261108-07): the Density presets are gone; the row height is the one control. A typed preset
          height keeps that preset's agent-row and tab heights, so a stored density looks the same. */}
      <Row id="h-density" label={t('settings.density.rowHeight')} desc={`${t('settings.kit.default', { value: `${DEFAULT_ROW} px` })} · ${t('settings.density.rowNote', { min: ROW_MIN, max: ROW_MAX })}`} reset={<Reset t={t} label={t('settings.density.rowHeight')} show={row !== DEFAULT_ROW} run={() => update({ density: DEFAULTS.density, rowHeight: null })} />} control={<Stepper t={t} label={t('settings.density.rowHeight')} min={ROW_MIN} setting="density" max={ROW_MAX} step={1} value={row} onChange={typeRow} />} />
      <Row label={t('field.tabFont')} desc={t('settings.kit.default', { value: `${DEFAULTS.tabFont} px` })} reset={<Reset t={t} label={t('field.tabFont')} show={settings.tabFont !== DEFAULTS.tabFont} run={() => update({ tabFont: DEFAULTS.tabFont })} />} control={<Stepper t={t} setting="tabFont" label={t('field.tabFont')} min={10} max={15} step={0.5} value={settings.tabFont} onChange={(v) => update({ tabFont: v })} />} />
      <Row label={t('field.chatWidth')} desc={t('settings.chatWidth.note')} reset={<Reset t={t} label={t('field.chatWidth')} show={settings.chatWidth !== DEFAULTS.chatWidth} run={() => update({ chatWidth: DEFAULTS.chatWidth })} />} control={<Stepper t={t} setting="chatWidth" label={t('field.chatWidth')} min={60} max={160} step={5} unit="%" value={settings.chatWidth} onChange={(v) => update({ chatWidth: v })} />} />
      <Row
        id="h-titlebar"
        label={t('field.titleBar')}
        desc={t('settings.appearance.titleNote')}
        reset={<Reset t={t} label={t('field.titleBar')} show={settings.titleBar !== DEFAULTS.titleBar} run={() => update({ titleBar: DEFAULTS.titleBar })} />}
        control={<Seg name="titlebar" label={t('field.titleBar')} value={settings.titleBar} onChange={(v) => update({ titleBar: v })} options={[['always', t('settings.appearance.always')], ['auto', t('settings.appearance.auto')], ['hidden', t('settings.appearance.hidden')]]} />}
      />
    </Sec>
  );
}

/** Ticket 250: the Terminal page's font and clipboard cards (r3: the final draft's rows). */
function TerminalPart({ t, settings, update }: { t: T; settings: Settings; update: Update }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [prefs] = useFeatureSetting(TERM_PREFS);
  return (
    <>
      <PageSummary parts={[[t('summary.font'), `${names(settings.termFont)[0]} ${settings.termFontSize} px`], [t('summary.scrollback'), t('summary.lines', { n: prefs.scrollback.toLocaleString('en') })], [t('summary.copyOnSelect'), t(settings.copyOnSelect ? 'summary.on' : 'summary.off')]]} />
      <Sec
        id="h-term-font"
        title={t('settings.section.font')}
        action={<SecReset t={t} section={t('settings.section.font')} show={settings.termFont !== DEFAULTS.termFont || settings.termFontSize !== DEFAULTS.termFontSize} run={() => update({ termFont: DEFAULTS.termFont, termFontSize: DEFAULTS.termFontSize })} undo={() => update({ termFont: settings.termFont, termFontSize: settings.termFontSize })} />}
      >
        <TermFont t={t} value={settings.termFont} update={update} preview={setPreview} />
        <Row
          label={t('field.termFontSize')}
          desc={t('settings.appearance.termDefault')}
          reset={<Reset t={t} label={t('field.termFontSize')} show={settings.termFontSize !== DEFAULTS.termFontSize} run={() => update({ termFontSize: DEFAULTS.termFontSize })} />}
          control={
            <>
              <Stepper t={t} setting="termFontSize" label={t('field.termFontSize')} min={10} max={20} step={1} value={settings.termFontSize} onChange={(v) => update({ termFontSize: v })} />
              <FontSample family={preview ?? settings.termFont} size={settings.termFontSize} t={t} />
            </>
          }
        />
      </Sec>
      <Sec id="h-scrollback" title={t('settings.section.scrollback')}>
        <Scrollback t={t} />
      </Sec>
      {/* ticket 162: copy on select is on, as in Ghostty and iTerm2; OSC 52 keeps Ask as its default (needs 56). */}
      <Sec id="h-clipboard" title={t('settings.appearance.clipboard')}>
        <Row label={t('field.copyOnSelect')} desc={t('settings.clip.copyNote')} reset={<Reset t={t} label={t('field.copyOnSelect')} show={settings.copyOnSelect !== DEFAULTS.copyOnSelect} run={() => update({ copyOnSelect: DEFAULTS.copyOnSelect })} />} control={<Switch setting="copyOnSelect" label={t('field.copyOnSelect')} checked={settings.copyOnSelect} onChange={(v) => update({ copyOnSelect: v })} />} />
        <Row
          top
          id="h-osc52"
          reset={<Reset t={t} label={t('settings.clip.osc52')} show={settings.osc52 !== DEFAULTS.osc52} run={() => update({ osc52: DEFAULTS.osc52 })} />}
          label={t('settings.clip.osc52')}
          desc={t('settings.appearance.clipboardNote')}
          control={<Seg name="osc52" label={t('settings.clip.osc52')} value={settings.osc52} onChange={(v) => update({ osc52: v })} options={OSC52.map(([v, title]): [Osc52, string] => [v, t(title)])} />}
        />
      </Sec>
    </>
  );
}

/** − and + step through these (look 1117 v15 Q6-11: one stepper in place of 5K/10K/25K/50K beside a field). */
const PRESETS = [5000, 10000, 25000, 50000];

/** Needs 191: presets or a typed count. A typed count applies on leaving the field: applying 1200 on the way to 12000 would trim open terminals. */
function Scrollback({ t }: { t: T }) {
  const [prefs, set] = useFeatureSetting(TERM_PREFS);
  const value = String(prefs.scrollback);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const [min, max] = RANGES.scrollback;
  const n = Number(draft);
  const ok = draft.trim() !== '' && Number.isInteger(n) && n >= min && n <= max;
  // Only once the field is left: every number on the way to a valid one is out of range while typing.
  const [left, setLeft] = useState(false);
  const showError = left && !ok;
  const label = t('field.scrollback');
  const stops = [min, ...PRESETS, max];
  const down = [...stops].reverse().find((v) => v < prefs.scrollback);
  const up = stops.find((v) => v > prefs.scrollback);
  const go = (v: number | undefined) => (v === undefined ? null : () => set({ ...prefs, scrollback: v }));
  // Closing Settings removes the field without a blur, so a valid draft is saved on the way out.
  const latest = useRef({ ok, n, prefs, set });
  latest.current = { ok, n, prefs, set };
  useEffect(
    () => () => {
      const l = latest.current;
      if (l.ok && l.n !== l.prefs.scrollback) l.set({ ...l.prefs, scrollback: l.n });
    },
    [],
  );
  return (
    <Row
      label={label}
      desc={t('settings.scrollback.desc')}
      reset={<Reset t={t} label={label} show={prefs.scrollback !== TERM_DEFAULTS.scrollback} run={() => set({ ...prefs, scrollback: TERM_DEFAULTS.scrollback })} />}
      extra={
        <>
          {showError && (
            <p id="scrollback-err" className="conflict" role="alert">
              {t('settings.scrollback.invalid')}
            </p>
          )}
          <div className="sds sinfo">
            <Icon name="info" size={12} />
            <span>{t('settings.scrollback.restart')}</span>
          </div>
        </>
      }
      control={
        <StepBox t={t} label={label} unit={t('settings.scrollback.lines')} down={go(down)} up={go(up)}>
          <input
            type="number"
            aria-label={label}
            data-setting="scrollback"
            min={min}
            max={max}
            step={1}
            value={draft}
            aria-invalid={!ok}
            aria-describedby={showError ? 'scrollback-err' : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setLeft(false);
            }}
            onBlur={() => {
              setLeft(true);
              if (ok) set({ ...prefs, scrollback: n });
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </StepBox>
      }
    />
  );
}

const CUSTOM = 'Custom…'; // also the picker's sentinel value; shown through the catalogue

function TermFont({ t, value, update, preview }: { t: T; value: string; update: Update; preview: (family: string | null) => void }) {
  // One detection per page open; the result is not stored. V1A-67: the app adds the fonts its webview cannot see.
  const [installed, setInstalled] = useState(installedFonts);
  // Every installed family: null until asked, empty when there is no list (browser, error) and the curated detection stands.
  const [all, setAll] = useState<Family[] | null>(null);
  useEffect(() => {
    let live = true;
    void allFonts().then(async (every) => {
      if (!live) return;
      setAll(every);
      if (every.length > 0) return;
      const more = await appFonts();
      if (!live || more.length === 0) return;
      setInstalled((have) => [...CURATED, SYMBOLS].filter((n) => have.includes(n) || more.includes(n)));
    });
    return () => {
      live = false;
    };
  }, []);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(value);
  const fonts = (all?.length ? all : installed.map((name) => ({ name, mono: true }))).filter((f) => f.name !== SYMBOLS);
  const entry = custom ? null : entryOf(value, fonts.map((f) => f.name));
  // Until the list answers, a stored pick is not yet known to be Custom…: show its name and hold back the raw list.
  const pending = all === null && !custom;
  const ok = FONT.test(draft);
  const write = (next: string) => {
    setDraft(next);
    update({ termFont: next });
  };
  const pick = (f: string) => {
    setCustom(f === CUSTOM);
    if (f === CUSTOM) setDraft(value);
    // needs 192 (7): the bundled symbols face is an always-on fallback behind the picked font (no toggle).
    else write(termFontFor(f, true));
  };
  const showCustom = entry === null && !pending;
  const note = all?.length === 0; // This note says coding fonts: true of the curated list only.
  return (
    <Row
      label={<label htmlFor="term-font" id="term-font-label">{t('field.termFont')}</label>}
      desc={t('settings.appearance.fontNote')}
      reset={<Reset t={t} label={t('field.termFont')} show={value !== DEFAULTS.termFont} run={() => (setCustom(false), write(DEFAULTS.termFont))} />}
      control={<FontPicker t={t} fonts={fonts} current={entry ?? (pending ? names(value)[0] : CUSTOM)} pick={pick} preview={(f) => preview(f && termFontFor(f, true))} />}
      extra={
        (note || showCustom) && (
          <div className="font-row">
            {note && <p className="cap font-note">{t('settings.appearance.fontsInstalled')}</p>}
            {showCustom && (
        <>
          <input {...PLAIN}
            className="search"
            aria-label={t('settings.appearance.customList')}
            value={draft}
            spellCheck={false}
            aria-invalid={!ok}
            aria-describedby={ok ? undefined : 'term-font-err'}
            onChange={(e) => {
              setDraft(e.target.value);
              if (FONT.test(e.target.value)) update({ termFont: e.target.value });
            }}
          />
          {draft !== DEFAULTS.termFont && (
            <button className="btn" onClick={() => write(DEFAULTS.termFont)}>
              {t('settings.appearance.default')}
            </button>
          )}
          {!ok && (
            <p id="term-font-err" className="conflict" role="alert">
              {t('settings.appearance.fontError', { value })}
            </p>
          )}
        </>
            )}
          </div>
        )
      }
    />
  );
}

/** A searchable dropdown whose rows render in their own faces (a native select draws its menu in the system font). */
function FontPicker({ t, fonts, current, pick, preview }: { t: T; fonts: Family[]; current: string; pick: (f: string) => void; preview: (f: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pointer = useRef('');
  const label = (f: string) => (f === CUSTOM ? t('settings.appearance.custom') : f);
  const face = (f: string) => (f === CUSTOM ? undefined : `"${f}", monospace`);
  const matches = (f: string) => label(f).toLowerCase().includes(query.toLowerCase());
  const mono = fonts.filter((f) => f.mono).map((f) => f.name);
  const rest = fonts.filter((f) => !f.mono).map((f) => f.name);
  const shownMono = mono.filter(matches);
  const shownRest = rest.filter(matches);
  const items = [...shownMono, ...shownRest, ...(matches(CUSTOM) ? [CUSTOM] : [])];
  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  // The list opens right-aligned to the button and steps left to clear the preview sample (under the button) when there is
  // room; the scroller (.sbody) clips it, so fitting inside the scroller wins, and the list is capped to that room.
  const [shift, setShift] = useState(0);
  const [room, setRoom] = useState<number>();
  useLayoutEffect(() => {
    const sample = document.querySelector('.fsample')?.getBoundingClientRect();
    const edge = button.current?.getBoundingClientRect();
    const pop = list.current?.parentElement;
    if (!open || !edge || !pop) return;
    const gap = 8;
    const left = Math.max(button.current?.closest('.sbody')?.getBoundingClientRect().left ?? 0, 0) + gap;
    const cap = Math.max(0, edge.right - left);
    setRoom(cap);
    const wide = Math.min(pop.offsetWidth, cap); // offsetWidth does not depend on `right`
    const clear = sample ? edge.right - sample.left + gap : 0;
    setShift(Math.max(0, Math.min(clear, edge.right - left - wide)));
  }, [open, query, fonts]);
  useEffect(() => {
    // Only the list scrolls: scrollIntoView would also move the page, and the preview sample with it.
    const row = open && document.getElementById(`term-font-o${at}`)?.getBoundingClientRect();
    const box = list.current;
    if (!row || !box) return;
    const edge = box.getBoundingClientRect();
    if (row.top < edge.top) box.scrollTop += row.top - edge.top;
    else if (row.bottom > edge.bottom) box.scrollTop += row.bottom - edge.bottom;
  }, [open, at, query]);
  // A family's file loads when its row first shows; loadFamilies asks once per family.
  useEffect(() => {
    if (!open || !list.current) return;
    const seen = new IntersectionObserver(
      (rows) => loadFamilies(rows.filter((r) => r.isIntersecting).map((r) => (r.target as HTMLElement).dataset.family!)),
      { root: list.current },
    );
    list.current.querySelectorAll('[data-family]').forEach((row) => seen.observe(row));
    return () => seen.disconnect();
  }, [open, query, fonts]);
  const show = () => {
    setQuery('');
    setAt(Math.max(0, [...mono, ...rest, CUSTOM].indexOf(current)));
    setOpen(true);
  };
  const shut = () => {
    setOpen(false);
    preview(null);
  };
  const close = () => {
    shut();
    button.current?.focus();
  };
  const choose = (f: string) => {
    pick(f);
    close();
  };
  const go = (i: number) => {
    setAt(i);
    preview(items[i] === CUSTOM ? null : items[i]);
  };
  const option = (f: string, i: number) => (
    <div
      key={f}
      id={`term-font-o${i}`}
      role="option"
      aria-selected={f === current}
      data-family={f === CUSTOM ? undefined : f}
      className={i === at ? 'at' : undefined}
      style={{ fontFamily: face(f) }}
      onMouseMove={(e) => {
        // Not mouseenter: browsers also fire hovers when rows move under a still pointer, as they do while typing.
        const spot = `${e.clientX},${e.clientY}`;
        if (spot === pointer.current) return;
        pointer.current = spot;
        go(i);
      }}
      onClick={() => choose(f)}
    >
      {label(f)}
      {f !== CUSTOM && <span className="cap" aria-hidden>
          {' '}
          0O 1lI {'{}'} =&gt; 가나</span>}
      {f === current && <span aria-hidden> ✓</span>}
    </div>
  );
  const group = (title: string, names: string[], from: number) =>
    names.length > 0 && (
      <div role="group" aria-label={title}>
        <div className="font-group" aria-hidden>{title}</div>
        {names.map((f, i) => option(f, from + i))}
      </div>
    );
  return (
    <div className="font-pick">
      <button
        ref={button}
        id="term-font"
        data-setting="termFont"
        className="btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby="term-font-label term-font"
        // While the list is open, keep focus in it so its blur does not close it before this click toggles it shut.
        onMouseDown={(e) => open && e.preventDefault()}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            show();
          }
        }}
      >
        <span style={{ fontFamily: face(current) }}>{label(current)}</span> <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        // Focus stays in the search box, also through a press on a row, a header or the scrollbar.
        <div className="font-pop" style={{ right: shift, maxWidth: room }} onMouseDown={(e) => e.target !== search.current && e.preventDefault()} onMouseLeave={() => preview(null)}>
          <input {...PLAIN}
            ref={search}
            className="search"
            role="combobox"
            aria-expanded
            aria-controls="term-font-list"
            aria-autocomplete="list"
            aria-label={t('field.fontSearch')}
            aria-activedescendant={items.length ? `term-font-o${at}` : undefined}
            placeholder={t('field.fontSearch')}
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setAt(0);
              preview(null);
            }}
            onBlur={shut}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (items.length) go(Math.min(items.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1))));
              } else if (e.key === 'Enter') {
                if (items[at]) choose(items[at]);
              } else if (e.key === 'Escape') close();
              else if (e.key === 'Tab') shut();
              else return;
              if (e.key !== 'Tab') e.preventDefault();
              e.stopPropagation();
            }}
          />
          <div ref={list} id="term-font-list" role="listbox" aria-label={t('field.termFont')}>
            {group(t('field.fontMonospace'), shownMono, 0)}
            {group(t('field.fontAll'), shownRest, shownMono.length)}
            {matches(CUSTOM) && option(CUSTOM, items.length - 1)}
          </div>
          {items.length === 0 && <p className="cap font-none" role="status">{t('field.fontNone')}</p>}
        </div>
      )}
    </div>
  );
}
