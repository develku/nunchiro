// Settings: the window's settings state, `t`, and the Agents sheet (split out of App.tsx, needs 183).
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { heights, load, save, type Settings, type SettingsPage } from '../settings';
import { htmlLang, makeT, type Key } from '../i18n';
import { setKindNames } from '../layout/model';
import { AGENTS_EVENT, SETTING_EVENT, USAGE_EVENT } from './agents/open';
import { ABOUT_EVENT } from '../features/about';
import { publishFeatures } from './useFeatureSetting';
import { openSchedules } from '../schedule/schedules';

const NAME_KEY: Record<string, Key> = Object.fromEntries(['tree', 'waiting', 'terminal', 'composer', 'diff', 'files', 'board', 'search', 'preview', 'artifacts', 'decisions', 'settings', 'layout', 'browser', 'team'].map((k) => [k, `shell.widget.${k}` as Key]).concat([['schedules', 'schedule.title'], ['history', 'history.title']]));

/** The window's settings (settings.json through `load`/`save`), its catalogue lookup `t` and what they set on the page. */
export function useAppSettings() {
  const [settings, setSettings] = useState<Settings>(() => {
    const s = load();
    publishFeatures(s.features, () => {}, false); // ticket 250: readable before anything draws; the writer follows below
    return s;
  });
  // Ticket 250: useFeatureSetting writes one key through this; the map follows every change of the store.
  const writeFeature = useCallback((key: string, v: unknown) => setSettings((s) => ({ ...s, features: { ...s.features, [key]: v } })), []);
  useEffect(() => publishFeatures(settings.features, writeFeature), [settings.features, writeFeature]);
  const [settingsFocus, setSettingsFocus] = useState<{ key: string; n: number; at?: string } | null>(null); // v1a-57: a setting opened from the palette
  const update = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  useEffect(() => save(settings), [settings]);
  // Density and tab font as CSS variables; the theme's tokens are set by useTheme (themes/apply.ts).
  useEffect(() => {
    const root = document.documentElement;
    const d = heights(settings); // ticket 162: a typed row height wins over the density's
    root.style.setProperty('--row', `${d.row}px`);
    root.dataset.density = settings.rowHeight === null ? settings.density : 'typed'; // the tree's book heights (tree.css)
    root.style.setProperty('--arow', `${d.arow}px`);
    root.style.setProperty('--tabh', `${d.tabh}px`);
    root.style.setProperty('--tabf', `${settings.tabFont}px`);
    root.style.setProperty('--chat-w', `${(700 * settings.chatWidth) / 100}px`); // v25-chat-calm
  }, [settings.density, settings.rowHeight, settings.tabFont, settings.chatWidth]);
  // Ticket 1071: the webview's own zoom in the app; data-ui-zoom is what a browser-run spec reads (and the browser slot).
  useEffect(() => {
    document.documentElement.dataset.uiZoom = String(settings.uiZoom);
    if ('__TAURI_INTERNALS__' in window) void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => getCurrentWebview().setZoom(settings.uiZoom)).catch(() => {});
  }, [settings.uiZoom]);
  // V2-14: the window's text language (same call as SettingsView); <html lang> follows the language actually shown.
  const t = useMemo(() => makeT(settings.language, navigator.language), [settings.language]);
  // V2.5-54 A12: widget names (rails, sidebar headers, zone tabs) in the UI language, read by WIDGET_LABEL and TITLE during this render.
  setKindNames((k) => (NAME_KEY[k] ? t(NAME_KEY[k]) : undefined));
  useEffect(() => void (document.documentElement.lang = htmlLang(settings.language, navigator.language)), [settings.language]);
  return { settings, setSettings, update, t, settingsFocus, setSettingsFocus };
}

/** V2-4b: Settings > Providers (ticket 391) opened by the AGENTS event, with one agent's card open when a name comes with it. */
export function useAgentsSheet({ setSettings, openSettings, setSettingsFocus }: { setSettings: Dispatch<SetStateAction<Settings>>; openSettings: () => void; setSettingsFocus: Dispatch<SetStateAction<{ key: string; n: number; at?: string } | null>> }) {
  // V2-4b: Settings > Agents, with one agent's setup sheet when a name comes with the request.
  const [agentSheet, setAgentSheet] = useState<{ name: string; n: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name;
      setSettings((s) => ({ ...s, settingsPage: 'providers' })); // ticket 391
      openSettings();
      if (name) setAgentSheet((d) => ({ name, n: (d?.n ?? 0) + 1 }));
    };
    window.addEventListener(AGENTS_EVENT, on);
    const usage = () => (setSettings((s) => ({ ...s, settingsPage: 'usage' })), openSettings()); // ticket 372
    window.addEventListener(USAGE_EVENT, usage);
    // Ticket 872: a note that names a setting opens it, the way the palette's settings command does.
    const field = (e: Event) => {
      const { page, key, at } = (e as CustomEvent<{ page: SettingsPage; key: string; at?: string }>).detail;
      if ((page as string) === 'schedule') return openSchedules(); // ticket 993: the old Schedules page is the widget
      setSettings((s) => ({ ...s, settingsPage: page }));
      openSettings();
      setSettingsFocus((d) => ({ key, at, n: (d?.n ?? 0) + 1 }));
    };
    window.addEventListener(SETTING_EVENT, field);
    // Ticket 262: the app menu's "About Nunchiro" (main.rs ABOUT_SCRIPT); the flag covers a window that was still loading.
    const w = window as { __NUNCHIRO_ABOUT__?: boolean };
    const about = () => {
      delete w.__NUNCHIRO_ABOUT__;
      setSettings((s) => ({ ...s, settingsPage: 'about' }));
      openSettings();
    };
    window.addEventListener(ABOUT_EVENT, about);
    if (w.__NUNCHIRO_ABOUT__) about();
    // Ticket 197: the app menu's "Settings…" (main.rs SETTINGS_SCRIPT) opens Settings on the page it was last on.
    const ws = window as { __NUNCHIRO_SETTINGS__?: boolean };
    const settings = () => (delete ws.__NUNCHIRO_SETTINGS__, openSettings());
    window.addEventListener('nunchiro:settings', settings);
    if (ws.__NUNCHIRO_SETTINGS__) settings();
    return () => (window.removeEventListener(AGENTS_EVENT, on), window.removeEventListener(ABOUT_EVENT, about), window.removeEventListener('nunchiro:settings', settings), window.removeEventListener(USAGE_EVENT, usage), window.removeEventListener(SETTING_EVENT, field));
  }, [openSettings, setSettings, setSettingsFocus]);
  return agentSheet;
}
