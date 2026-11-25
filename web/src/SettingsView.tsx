// Settings tab (spec Window (v1a); needs 54; V2-2a Accounts; V2-10c Artifact libraries; V2-14a Language; ticket 250: the
// approved final draft, 17 pages in 7 groups since D2 split Accounts and Usage): the pages of features/registry.ts, one shown at a time, chosen from the left nav.
import { PLAIN } from './plainText';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { merge, type Command } from './keys';
import { KeyChip } from './KeyChip';
import type { CoreClient } from './api';
import type { Session } from './types';
import { LifetimeSection } from './settings/lifetime/LifetimeSection';
import { AppearancePage } from './settings/appearance/AppearancePage';
import { LayoutPage } from './settings/layout/LayoutPage';
import { AlertsPage } from './settings/alerts/AlertsPage';
import { KeysPage } from './settings/keys/KeysPage';
import { ThemePage } from './settings/theme/ThemePage';
import { AccountsPage } from './settings/accounts/AccountsPage';
import { UsagePage } from './usage/UsagePage';
import { openSchedules } from './schedule/schedules';
import { LibsPage } from './settings/libs/LibsPage';
import { MachinesPage } from './settings/machines/MachinesPage';
import { BrowserAccessPage } from './settings/browser-access/BrowserAccessPage'; // V2.5-15
import { GitPage } from './settings/git/GitPage'; // v25f F7
import { LanguagePicker } from './settings/general/LanguagePicker';
import './settings/settings-ia.css';
import './settings/shell/shell.css'; // ticket 250: the final draft's look, after the older rules
import { EN, makeT, type Key } from './i18n';
import { fieldLabel, fieldMatches, fieldRank, FIELDS, PAGES, rankedMatches, resultLabel, ROW_TITLE, type Settings, type SettingsPage } from './settings';
import { navGroups, registeredPage, sectionsOf, useRegistry, type PageContext } from './features/registry';
import { CoreFeatureClient, useFeatureSetting } from './settings/useFeatureSetting';
import { ONBOARDING_MARKS } from './settings/onboarding/state';
import { ActionsSlot, SummarySlot } from './settings/shell/PageActions';
import { NavIcon } from './settings/shell/NavIcon';
import { Icon } from './icons/Icon';
import { Sec } from './settings/shell/Row';
import './features'; // V2.5-33d: loads every feature file, which registers its own page

interface Props {
  core: CoreClient;
  settings: Settings;
  commands: Command[];
  update: (patch: Partial<Settings>) => void;
  /** v1a-57: a setting to focus, from the palette; `n` repeats the same one. */
  focus?: { key: string; n: number; at?: string } | null;
  /** V2-4b: an agent whose card to open on the Providers page (a problem card's "Fix command", the picker); `n` repeats it. */
  agent?: { name: string; n: number } | null;
  toast?: (text: string) => void;
  hasProject: boolean;
  project: PageContext['project'];
  projects: string[];
  sessions?: Session[];
  current?: Session | null;
  onClose: () => void;
}

// An unlisted field (V1A-73) carries its DOM label; a listed one is named from the catalogue.
type Field = (typeof FIELDS)[number] & { label?: string };
/** The pages that predate the registry; a feature added later registers its own (features/registry.ts). */
// Ticket 250: each page draws the sections final.html puts on it.
const BUILTIN_VIEWS: Record<string, (c: PageContext) => ReactNode> = {
  general: ({ core, t, settings, update }) => (
    <>
      <Sec id="h-language" title={t('settings.section.language')}>
        <LanguagePicker t={t} settings={settings} update={update} />
      </Sec>
      <LifetimeSection core={core} t={t} part="general" />
    </>
  ),
  appearance: ({ t, core, settings, update }) => (
    <>
      <AppearancePage t={t} settings={settings} update={update} part="interface" />
      <ThemePage t={t} core={core} settings={settings} update={update} />
    </>
  ),
  terminal: ({ t, settings, update }) => <AppearancePage t={t} settings={settings} update={update} part="terminal" />,
  layout: ({ t, core, settings, update }) => <LayoutPage t={t} core={core} settings={settings} update={update} />,
  alerts: ({ t, settings, update }) => <AlertsPage t={t} settings={settings} update={update} />,
  keys: ({ t, settings, commands, update }) => <KeysPage t={t} settings={settings} commands={commands} update={update} />,
  // Ticket 391: Agents and Accounts as one page; the Codex reset blocks sit in the Codex card.
  providers: ({ t, core, agent, focus, reveal, projects, sessions }) => {
    const hooks = FIELDS.find((f) => f.key === 'hooks');
    return <AccountsPage t={t} core={core} open={agent} focus={focus} projects={projects} live={sessions} onViewUsage={(agent, id) => reveal('usage', `[data-limit="${CSS.escape(`${agent}:${id}`)}"]`)} onHooks={() => hooks && reveal(hooks.page, hooks.at)} />;
  },
  usage: ({ t, core }) => <UsagePage t={t} core={core} />,
  git: ({ core, t, settings }) => <GitPage core={core} t={t} bindings={settings.bindings} />,
  machines: ({ core, t, toast, closeSettings }) => <MachinesPage core={core} t={t} toast={toast} closeSettings={closeSettings} />,
  browser: ({ core, t }) => <BrowserAccessPage core={core} t={t} />,
  libraries: ({ t, core }) => <LibsPage t={t} core={core} />,
  history: ({ core, t }) => <LifetimeSection core={core} t={t} part="history" />,
};


// English keywords a page is also found by: old page names (Lifetime, Usage, Hints) and what the whole page holds. A keyword
// matches every setting on its page, so it names the page, never one setting on it (ticket 427): "Theme" (the old page name)
// tagged all 23 Appearance settings, "Language" all of General, "Codex resets" and "Agent reset policy" every Providers
// setting; those settings' own labels already carry the words.
const ALIAS: Partial<Record<SettingsPage, string>> = {
  general: 'Lifetime Sessions and startup',
  providers: 'Agents Accounts Sign in',
  usage: 'Tokens Cost Limits',
  keys: 'Keys Hints Shortcuts',
  machines: 'Machines SSH Remote',
  browser: 'Browser access Pairing',
  libraries: 'Libraries Extensions',
  history: 'History Scrollback',
  extensions: 'Hooks Orchestration Advanced Agent extensions',
};

/** A13: the last deep link an open took (App keeps the last one in its state, so a link seen before is not this open's). */
const linked = { focus: 0, agent: 0 };

export function SettingsView({ core, settings, commands, update, focus, agent, toast, hasProject, project, projects, sessions, current, onClose }: Props) {
  const page = settings.settingsPage;
  const t = makeT(settings.language, navigator.language); // V2-14a
  useRegistry(); // a page registered after this drew joins the nav
  // A registered page with `settings.page.<id>` / `settings.desc.<id>` in its area file shows them in the window's language
  // (ticket 262: About); else its English title and own description.
  const own = (p: SettingsPage, k: 'page' | 'desc') => !registeredPage(p) || Object.hasOwn(EN, `settings.${k}.${p}`);
  const TITLES = Object.fromEntries(PAGES.map((p) => [p, own(p, 'page') ? t(`settings.page.${p}` as Key) : registeredPage(p)!.title])) as Record<SettingsPage, string>;
  // Ticket 492: a registered page's own getters read <html lang>, which changes after this render; its catalogue key wins.
  const describe = (p: SettingsPage) => (registeredPage(p) && own(p, 'desc') ? t(`settings.desc.${p}` as Key) : (registeredPage(p)?.description ?? (own(p, 'desc') ? t(`settings.desc.${p}` as Key) : '')));
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [sumSlot, setSumSlot] = useState<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const chosen = useRef<'key' | 'quiet' | null>(null);
  // Focus follows a chosen page to its heading. Ticket 414 L: only a page opened from the keyboard (Enter or Space on its nav
  // button) draws the ring there. A mouse click or an accessibility press marks the heading quiet until it loses the focus:
  // an engine may still match :focus-visible (it carries the search box's ring over a press that moved no pointer).
  useEffect(() => {
    const by = chosen.current;
    const h = title.current;
    chosen.current = null;
    if (!by || !h) return;
    if (by === 'quiet') {
      h.dataset.quiet = '';
      h.addEventListener('blur', () => delete h.dataset.quiet, { once: true });
    } else delete h.dataset.quiet;
    h.focus({ focusVisible: by === 'key' } as FocusOptions);
  }, [page]);
  const keyed = useRef<SettingsPage | null>(null); // the nav button Enter or Space went down on
  // v1a-57 (needs 69): one search over every page's settings; a match opens its page focused on the field.
  const [query, setQuery] = useState('');
  const [want, setWant] = useState<{ key: string; n: number; at?: string } | null>(null);
  const box = useRef<HTMLInputElement>(null);
  // A13: opening Settings focuses the search box, unless this open carries a new deep link (a field from the palette, an
  // agent's setup sheet), whose focus goes where it went before.
  const deepOpen = useRef(!!(focus && focus.n > linked.focus) || !!(agent && agent.n > linked.agent));
  useEffect(() => void (deepOpen.current || box.current?.focus()), []);
  useEffect(() => {
    if (!focus || focus.n <= linked.focus) return;
    linked.focus = focus.n;
    setWant(focus);
  }, [focus]);
  useEffect(() => void (agent && (linked.agent = Math.max(linked.agent, agent.n))), [agent]);
  useEffect(() => {
    if (!want) return;
    const at = want.at ?? FIELDS.find((x) => x.key === want.key)?.at ?? `[data-setting="${CSS.escape(want.key)}"]`;
    // The Lifetime page reads the core first, so its fields may come a little later.
    let frame = 0;
    const until = performance.now() + 3000;
    const tick = () => {
      const els = [...(body.current?.querySelectorAll<HTMLInputElement>(at) ?? [])];
      const el = els.find((e) => e.checked) ?? els[0];
      // A field inside a closed fold cannot take focus: the search hit opens the fold first.
      if (el) (el.closest('details')?.setAttribute('open', ''), el.focus(), found(el));
      else if (performance.now() < until) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [want]);
  const q = query.trim().toLowerCase();
  // The listed fields, plus any field the shown page marks with data-setting that the list lacks yet (V1A-73), named by
  // its own label. Read after the page commits, on each query or page change.
  const [unlisted, setUnlisted] = useState<Field[]>([]);
  useLayoutEffect(() => {
    const found: Field[] = [];
    for (const el of body.current?.querySelectorAll<HTMLElement>('[data-setting]') ?? []) {
      const key = el.dataset.setting!;
      const label = (el.getAttribute('aria-label') ?? el.closest('label')?.textContent ?? el.textContent ?? key).trim();
      if (![...FIELDS, ...found].some((f) => f.key === key)) found.push({ page, key, label, at: `[data-setting="${CSS.escape(key)}"]` });
    }
    setUnlisted(found);
  }, [q, page]);
  const fields = [...FIELDS, ...unlisted];
  // Ticket 991 C14: a result reads as its row's own title; the field's longer name stays a search word.
  const labelOf = (f: Field) => f.label ?? resultLabel(t, f.key);
  // Ticket 516: the words a user would type for a row (`searchWords.<key>`), in the window's language and in English.
  const wordsOf = (f: Field) => {
    const k = `searchWords.${f.key}`;
    const named = ROW_TITLE[f.key] ? `, ${fieldLabel(t, f.key)}` : '';
    if (!Object.hasOwn(EN, k)) return named.slice(2);
    const own = t(k as Key);
    return (own === EN[k as Key] ? own : `${own}, ${EN[k as Key]}`) + named;
  };
  // Ticket 427: a setting's own label first, then its search words, then its page's title, then the page's keywords.
  const matches = q ? rankedMatches(fields, (f) => fieldRank(q, TITLES[f.page], ALIAS[f.page] ?? '', labelOf(f), wordsOf(f))) : [];
  // B17 (Orca's settings search, idea only): the nav keeps the pages with a match, a page whose title or alias matches shows
  // whole, and the shown page keeps only its matching rows. The chosen page stays shown while it has a match.
  const wholePage = (p: SettingsPage) => !!q && fieldMatches(q, TITLES[p], ALIAS[p] ?? '', '');
  // Ticket 993: Schedules left Settings for its own widget; a search for it offers the one result that opens it. With no
  // other match the pages stay as they are under that result.
  const sched = !!q && fieldMatches(q, t('schedule.title'), 'Schedules Scheduled', '');
  const goSchedules = () => (onClose(), openSchedules());
  const hits = q ? PAGES.filter((p) => wholePage(p) || matches.some((f) => f.page === p)) : PAGES;
  const hitPages = !hits.length && sched ? PAGES : hits;
  // No match anywhere: the chosen page stays drawn (hidden), so a row only it marks (V1A-73) can still be found on it.
  const none = !hitPages.length;
  const shown: SettingsPage = hitPages.includes(page) ? page : (hitPages[0] ?? page);
  // Ticket 391: onboarding counts 화면과 테마 and 권한 as done once they were shown, however they were reached.
  const [marks, setMarks] = useFeatureSetting(ONBOARDING_MARKS);
  useEffect(() => {
    const seen = none ? null : shown === 'appearance' ? 'appearance' : shown === 'permissions' ? 'permissions' : null;
    if (seen && !marks.includes(seen)) setMarks([...marks, seen]);
  }, [shown, none, marks, setMarks]);
  const rows = q && !none && !wholePage(shown) ? matches.filter((f) => f.page === shown).map((f) => f.at).join('\n') : '';
  useLayoutEffect(() => {
    const root = body.current;
    if (!root) return;
    const apply = () => {
      for (const el of root.querySelectorAll('[data-sfilter]')) el.removeAttribute('data-sfilter');
      if (rows) filterRows(root, rows.split('\n'));
    };
    apply();
    if (!rows) return;
    // Core-backed pages draw their rows a little later; a row drawn while the query stands is filtered too.
    const watch = new MutationObserver(apply);
    watch.observe(root, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [rows, shown]);
  const clear = () => {
    setQuery('');
    box.current?.focus();
  };
  const open = (settingsPage: SettingsPage, key: string, at?: string) => {
    setQuery('');
    update({ settingsPage });
    setWant((d) => ({ key, at, n: (d?.n ?? 0) + 1 }));
  };
  const openField = (f: Field) => open(f.page, f.key);
  // A click from Enter or Space follows the key on the same button and has no click count (detail 0).
  const choose = (p: SettingsPage, detail: number) => {
    const byKey = keyed.current === p && detail === 0;
    keyed.current = null;
    chosen.current = p === page ? null : byKey ? 'key' : 'quiet'; // the shown page again moves nothing
    update({ settingsPage: p });
  };
  const keyOn = (p: SettingsPage) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') keyed.current = p;
  };
  const results = useRef<HTMLUListElement>(null);
  // Search keys (ticket 202, needs 172): Enter opens the first match (not while an IME composes: keyCode 229 covers browsers
  // that clear isComposing first), Down reaches the results, Esc clears and keeps focus here. Esc on an empty box bubbles as before.
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (!matches.length && !sched) return;
      e.preventDefault();
      if (sched) goSchedules();
      else openField(matches[0]);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.stopPropagation(); // not the page list's arrows (onNavKey)
      e.preventDefault();
      if (e.key === 'ArrowDown') results.current?.querySelector('button')?.focus();
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    }
  };
  const onResultKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      clear();
      return;
    }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation(); // the results sit in the nav: not the page list's arrows (onNavKey)
    const buttons = [...e.currentTarget.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i + step < 0) box.current?.focus();
    else buttons[Math.min(i + step, buttons.length - 1)]?.focus();
  };
  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const buttons = [...e.currentTarget.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + step + buttons.length) % buttons.length]?.focus();
  };
  const bindings = merge(settings.bindings);
  const searchKey = bindings['settings.search']?.[0];
  const ctx: PageContext = { core, t, settings, commands, update, focus: want, agent, toast, reveal: (p, at) => open(p, at, at), hasProject, project, projects, closeSettings: onClose, sessions, current };
  return (
    <div className="settings" role="region" aria-label={t('settings.region')}>
      <nav aria-label={t('settings.nav')} onKeyDown={onNavKey}>
        <div className="snavsearch">
          <Icon name="search" size={14} />
        <input {...PLAIN}
            ref={box}
            className="search"
            type="search"
            placeholder={t('settings.searchField')} // short: the key chip beside the field cut "Search settings" at 900 pt
            aria-label={t('settings.search')}
            // A13: macOS autocorrect drew its chip over the page.
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {/* Ticket 516: the key that brings the focus back here (settings.search, rebindable on the Keys page). */}
          {searchKey && <KeyChip binding={searchKey} bindings={bindings} />}
        </div>
        {/* B17: the matches sit in the nav, not over the page; one opens its page focused on the field. Ticket 991 C14: right
            under the search field while a query is typed, not below every page name. */}
        {(matches.length > 0 || sched) && (
          <ul className="smatches" aria-label={t('settings.matches')} ref={results} onKeyDown={onResultKey}>
            {sched && (
              <li>
                <button className="smatch" data-match="schedules" title={`${t('schedule.title')} · ${t('schedule.found')}`} onClick={goSchedules}>
                  {t('schedule.title')} <span className="dim">· {t('schedule.found')}</span>
                </button>
              </li>
            )}
            {matches.map((f) => (
              <li key={f.key}>
                <button className="smatch" title={`${labelOf(f)} · ${TITLES[f.page]}`} onClick={() => openField(f)}>
                  {labelOf(f)} <span className="dim">· {TITLES[f.page]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="sgroups">
          {navGroups(hitPages).map(({ group, pages }) => (
            // The first group has no heading in the draft, and no name: "General" would also name its first page, and an
            // accessibility press on that name pressed the group's middle, Onboarding (look 1117 v16 C).
            <div key={group} role="group" className="sgrp" data-group={group} {...(group === 'general' ? {} : { 'aria-labelledby': `sgrp-${group}` })}>
              {group !== 'general' && <h3 id={`sgrp-${group}`}>{t(`settings.navGroup.${group}` as Key)}</h3>}
              {pages.map((p) => (
                <button key={p} id={`snav-${p}`} data-page={p} aria-current={p === shown ? 'page' : undefined} onKeyDown={keyOn(p)} onClick={(e) => choose(p, e.detail)}>
                  <NavIcon page={p} />
                  {TITLES[p]}
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>
      <div className="smain">
        <div className="spage">
          {!none && (
            <header className="phd">
              <div className="tt">
                <h1 ref={title} tabIndex={-1}>
                  {TITLES[shown]}
                </h1>
                <div className="ssum" ref={setSumSlot} />
                {describe(shown) && <p>{describe(shown)}</p>}
              </div>
              <div className="acts" ref={setSlot} />
            </header>
          )}
          <div className={none ? 'sbody snone' : 'sbody'} ref={body}>
            {none && (
              <section className="sempty" aria-label={t('settings.results')}>
                <p role="status">{t('settings.none', { query })}</p>
                <button className="btn" onClick={clear}>
                  {t('settingsA.clear')}
                </button>
              </section>
            )}
            <CoreFeatureClient.Provider value={core}>
              <ActionsSlot.Provider value={none ? null : slot}>
                <SummarySlot.Provider value={none ? null : sumSlot}>
                  {(BUILTIN_VIEWS[shown] ?? registeredPage(shown)?.render)?.(ctx)}
                  {sectionsOf(shown).map((sec) => (
                    <Fragment key={sec.id}>{sec.render(ctx)}</Fragment>
                  ))}
                </SummarySlot.Provider>
              </ActionsSlot.Provider>
            </CoreFeatureClient.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * B17: hides, in place, every block of the shown page that holds none of the matching rows. A block is a section's direct
 * child; a kept block keeps the headings right above it and its group heading (h3), and a section keeps its title (h2).
 * The mark is a data attribute no component renders, so React never resets it; the caller clears it first.
 */
/** Ticket 516: the row a search hit (or a deep link) focused is scrolled into view and highlighted for about 1.5 s
 *  (shell.css `[data-found]`; with reduced motion the outline alone, no fade). */
let foundTimer = 0;
function found(el: HTMLElement) {
  const row = el.closest<HTMLElement>('.srow') ?? el.closest<HTMLElement>('[data-setting]') ?? el;
  for (const r of document.querySelectorAll('[data-found]')) r.removeAttribute('data-found');
  row.scrollIntoView({ block: 'nearest' });
  row.setAttribute('data-found', '');
  clearTimeout(foundTimer);
  foundTimer = window.setTimeout(() => row.removeAttribute('data-found'), 1500);
}

function filterRows(root: HTMLElement, at: string[]) {
  const hits = at.flatMap((sel) => [...root.querySelectorAll(sel)]);
  for (const sec of root.querySelectorAll('section')) {
    const kids = [...sec.children];
    const keep = new Set(kids.filter((k) => hits.some((h) => k.contains(h))));
    if (!keep.size) {
      sec.setAttribute('data-sfilter', '');
      continue;
    }
    for (const k of [...keep]) {
      const at = kids.indexOf(k);
      for (let i = at - 1; i >= 0 && /^H[2-6]$/.test(kids[i].tagName); i--) keep.add(kids[i]);
      const group = kids.slice(0, at).reverse().find((h) => h.tagName === 'H3');
      if (group) keep.add(group);
    }
    const title = kids.find((h) => h.tagName === 'H2');
    if (title) keep.add(title);
    for (const k of kids) if (!keep.has(k)) k.setAttribute('data-sfilter', '');
  }
}
