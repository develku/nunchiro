// Ticket 255 (needs 197, G04): Settings › In-app browser. The page holds fixed section ids that later tickets add to
// (256 links, 264 profiles, 274 recordings, 275 remote); this file draws `inapp-browser.defaults`. Values live in the core's
// `settings.json` `features` under `browser.*` (the app reads them for each new view and checks them again there:
// app/src-tauri/src/browser/view.rs `Prefs`), except "show the browser" which is this window's (pane/auto.ts).
// The rows follow Orca's browser settings (search engine, home page, default zoom, user agent, site permissions):
// orca/src/renderer/src/components/settings/Browser*Setting.tsx, MIT License, Copyright (c) 2026 Lovecast Inc.
// (choices and wording only; the rows are this app's own row kit, final.html builders).
import { PLAIN } from '../plainText';
import { Icon } from '../icons/Icon';
import { useEffect, useState, type FormEvent } from 'react';
import { TABLES, type Key, type T } from '../i18n';
import { registerSettingsPage, registerSettingsSection } from './registry';
import { useCoreFeature, useFeatureSetting } from '../settings/useFeatureSetting';
import { Reset, Row, Sec, SecReset, Seg, Select, Stepper, Switch, Why, WhyFix } from '../settings/shell/Row';
import { PANE_URLS } from './macos-perms';
import { SHOW_ON_AGENT_NAV } from '../pane/auto';
import { PageSummary } from '../settings/shell/PageActions';

export const PAGE = 'inapp-browser';
/** Section ids of this page, fixed by ticket 255 (later tickets register theirs). */
export const SECTIONS = { defaults: 'inapp-browser.defaults', links: 'inapp-browser.links', profiles: 'inapp-browser.profiles', recordings: 'inapp-browser.recordings', remote: 'inapp-browser.remote' } as const;

// The lists the app accepts (view.rs ENGINES, USER_AGENTS, SITE_KINDS, SITE_DECISIONS); anything else reads as the default there.
const ENGINES: [string, string][] = [
  ['google', 'Google'],
  ['duckduckgo', 'DuckDuckGo'],
  ['bing', 'Bing'],
  ['kagi', 'Kagi'],
];
const VIEWPORTS = ['1280x800', '1440x900', '1920x1080', '1024x768', '390x844'];
// Camera and microphone only: wry's macOS backend never routes location or notification requests to the app's handler,
// so a row for them would do nothing (review round 2). view.rs still reads all four.
const KINDS = ['camera', 'microphone'] as const;
const DECISIONS = ['allow', 'ask', 'deny'] as const;
type Site = { host: string; kind: (typeof KINDS)[number]; decision: (typeof DECISIONS)[number] };

/** A site as typed: lowercase host letters, digits, dots and dashes (the app's own check, view.rs `site_host`). */
export const siteHost = (s: string): string | null => {
  const h = s.trim().replace(/^https?:\/\//i, '').replace(/[/:].*$/, '').replace(/\.$/, '').toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(h) ? h : null;
};
/** The home page as stored: an http(s) address, a bare host getting https; null for anything else. */
export const homeUrl = (s: string): string | null => {
  const text = s.trim();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return /^https?:$/.test(u.protocol) && u.hostname ? u.href : null;
  } catch {
    return null;
  }
};
const sitesOf = (v: unknown): Site[] =>
  Array.isArray(v)
    ? v.filter((r): r is Site => !!r && typeof r === 'object' && typeof r.host === 'string' && KINDS.includes(r.kind) && DECISIONS.includes(r.decision))
    : [];

// shortcut: layout only, inline (no colour or size); move to a stylesheet when a page CSS file is in Own.
const LINE = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6 } as const;
const LIST = { listStyle: 'none', padding: 0, margin: 0 } as const;
const GROW = { flex: 1 } as const;

function Home({ t }: { t: T }) {
  const [home, setHome] = useCoreFeature<string>('browser.home_page', '');
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? home;
  const bad = text.trim() !== '' && !homeUrl(text);
  const save = () => {
    if (draft === null || bad) return;
    void setHome(draft.trim() ? homeUrl(draft) : null).then((ok) => ok && setDraft(null)); // a refused write keeps the typed text
  };
  return (
    <Row
      label={t('bprefs.home')}
      desc={bad ? <span role="alert">{t('bprefs.homeBad')}</span> : t('bprefs.homeDesc')}
      setting="browserHome"
      reset={<Reset t={t} label={t('bprefs.home')} show={home !== ''} run={() => void setHome(null).then(() => setDraft(null))} />}
      control={
        <input {...PLAIN}
          type="url"
          className="sinp" // the kit's row field (it was the search box's 26 px look)
          aria-label={t('bprefs.home')}
          aria-invalid={bad}
          data-setting="browserHome"
          placeholder="https://"
          value={text}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
      }
    />
  );
}

/** Ticket 351: macOS's camera and microphone answer for the app (app/src-tauri/src/permissions.rs `media_status`, read
 *  only). In the app only: a plain browser has no app to ask, and its rows still store. */
type Media = 'granted' | 'not_granted' | 'not_asked' | 'unknown';
function useMediaStatus(): { camera: Media; microphone: Media } | null {
  const [status, setStatus] = useState<{ camera: Media; microphone: Media } | null>(null);
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in globalThis)) return;
    let live = true;
    void import('@tauri-apps/api/core')
      .then((c) => c.invoke<{ camera: Media; microphone: Media }>('media_status'))
      .then((s) => live && setStatus(s), () => {});
    return () => {
      live = false;
    };
  }, []);
  return status;
}
const openPane = (url: string) => void import('@tauri-apps/plugin-opener').then((o) => o.openUrl(url)).catch(() => {});

function Sites({ t }: { t: T }) {
  const [stored, setStored] = useCoreFeature<unknown[]>('browser.site_permissions', []);
  const sites = sitesOf(stored);
  const [host, setHost] = useState('');
  const [bad, setBad] = useState(false);
  const write = (next: Site[]) => void setStored(next.length ? next : null);
  // Owner 2026-11-16: a site is added once, with both on; each kind is then one button on its line. On stores Allow, off
  // stores Deny (the line stays); a stored Ask reads as on, since Allow asks each time as well.
  const hosts = [...new Set(sites.map((x) => x.host))];
  const on = (h: string, k: Site['kind']) => sites.some((x) => x.host === h && x.kind === k && x.decision !== 'deny');
  const set = (h: string, k: Site['kind'], allow: boolean) => write([...sites.filter((x) => !(x.host === h && x.kind === k)), { host: h, kind: k, decision: allow ? 'allow' : 'deny' }]);
  const add = (e: FormEvent) => {
    e.preventDefault();
    const h = siteHost(host);
    if (!h) return setBad(true);
    setBad(false);
    setHost('');
    write([...sites.filter((x) => x.host !== h), ...KINDS.map((kind) => ({ host: h, kind, decision: 'allow' as const }))]);
  };
  const kindName = (k: Site['kind']) => t(`bprefs.${k}` as Key);
  // Ticket 475's why line, once per kind macOS refuses: an Allow row for it cannot work until the owner turns it on there.
  const media = useMediaStatus();
  const blocked = KINDS.filter((k) => media?.[k] === 'not_granted');
  const why = blocked.length > 0 && (
    <>
      {blocked.map((k) => (
        <Why key={k} id={`why-media-${k}`} reason={t(k === 'camera' ? 'bprefs.cameraBlocked' : 'bprefs.micBlocked')} fix={<WhyFix label={t('perms.open')} run={() => openPane(PANE_URLS[k])} />} />
      ))}
    </>
  );
  return (
    <Row
      top
      label={t('bprefs.sites')}
      desc={t('bprefs.sitesDesc')}
      setting="browserSites"
      why={why}
      extra={
        <div className="bprefs-sites">
          {sites.length === 0 ? (
            <p className="sds">{t('bprefs.noSites')}</p>
          ) : (
            <ul aria-label={t('bprefs.sites')} style={LIST}>
              {hosts.map((h) => (
                <li key={h} style={LINE}>
                  <span>{h}</span>
                  {KINDS.map((k) => (
                    <button key={k} type="button" className={`btn${on(h, k) ? ' p' : ''}`} aria-pressed={on(h, k)} aria-label={`${kindName(k)} · ${h}`} onClick={() => set(h, k, !on(h, k))}>
                      {/* Eighth look (C): the fill alone said on or off; a chip that is on has a check mark too (aria-pressed says it to a reader). */}
                      {on(h, k) && <span aria-hidden>✓ </span>}
                      {kindName(k)}
                    </button>
                  ))}
                  <button type="button" className="btn" aria-label={t('bprefs.remove', { host: h })} onClick={() => write(sites.filter((x) => x.host !== h))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* Look 1117 v15/v16 Q6-11: the kit's inline add (MCP servers, Provider models): a row field with the house Add (plus) beside it. */}
          <form onSubmit={add} style={LINE}>
            <input {...PLAIN} className="sinp" style={GROW} aria-label={t('bprefs.site')} aria-invalid={bad} data-setting="browserSites" placeholder="meet.example.com" value={host} spellCheck={false} onChange={(e) => (setHost(e.target.value), setBad(false))} />
            <button type="submit" className="btn withicon">
              <Icon name="plus" size={14} />
              {t('bprefs.add')}
            </button>
            {bad && <span role="alert">{t('bprefs.siteBad')}</span>}
          </form>
        </div>
      }
    />
  );
}

function Defaults({ t }: { t: T }) {
  const [engine, setEngine, , , engineRead] = useCoreFeature('browser.search_engine', 'google');
  const [zoom, setZoom, , , zoomRead] = useCoreFeature('browser.zoom', 100);
  const [viewport, setViewport, , , viewportRead] = useCoreFeature('browser.viewport', '1280x800');
  const [appearance, setAppearance] = useCoreFeature('browser.appearance', 'app');
  const [ua, setUa] = useCoreFeature('browser.user_agent', 'default');
  const [showPane, setShowPane] = useFeatureSetting(SHOW_ON_AGENT_NAV);
  const differs = engine !== 'google' || zoom !== 100 || viewport !== '1280x800' || appearance !== 'app' || ua !== 'default' || showPane !== true;
  return (
    <Sec
      id="h-bprefs-defaults"
      title={t('bprefs.defaults')}
      action={<SecReset t={t} section={t('bprefs.defaults')} show={differs} run={() => (void setEngine(null), void setZoom(null), void setViewport(null), void setAppearance(null), void setUa(null), setShowPane(true))} undo={() => (void setEngine(engine), void setZoom(zoom), void setViewport(viewport), void setAppearance(appearance), void setUa(ua), setShowPane(showPane))} />}
    >
      <PageSummary parts={[[t('summary.search'), engineRead && (ENGINES.find(([v]) => v === engine)?.[1] ?? engine)], [t('summary.zoom'), zoomRead && `${zoom} %`], [t('summary.viewport'), viewportRead && viewport.replace('x', ' × ')]]} />
      <Row label={t('bprefs.engine')} desc={t('bprefs.engineDesc')} setting="browserEngine" reset={<Reset t={t} label={t('bprefs.engine')} show={engine !== 'google'} run={() => void setEngine(null)} />} control={<Select value={engine} label={t('bprefs.engine')} setting="browserEngine" onChange={(v) => void setEngine(v)}>{ENGINES.map(([v, name]) => <option key={v} value={v}>{name}</option>)}</Select>} />
      <Home t={t} />
      <Row label={t('bprefs.zoom')} setting="browserZoom" reset={<Reset t={t} label={t('bprefs.zoom')} show={zoom !== 100} run={() => void setZoom(null)} />} control={<Stepper t={t} label={t('bprefs.zoom')} setting="browserZoom" min={50} max={300} step={10} unit="%" value={zoom} onChange={(v) => void setZoom(v)} />} />
      <Row label={t('bprefs.viewport')} desc={t('bprefs.viewportDesc')} setting="browserViewport" reset={<Reset t={t} label={t('bprefs.viewport')} show={viewport !== '1280x800'} run={() => void setViewport(null)} />} control={<Select value={viewport} label={t('bprefs.viewport')} setting="browserViewport" onChange={(v) => void setViewport(v)}>{VIEWPORTS.map((v) => <option key={v} value={v}>{v.replace('x', ' × ')}</option>)}</Select>} />
      <Row label={t('bprefs.appearance')} setting="browserAppearance" reset={<Reset t={t} label={t('bprefs.appearance')} show={appearance !== 'app'} run={() => void setAppearance(null)} />} control={<Seg name="bprefs-appearance" label={t('bprefs.appearance')} setting="browserAppearance" value={appearance} onChange={(v) => void setAppearance(v)} options={[['app', t('bprefs.appApp')], ['light', t('bprefs.appLight')], ['dark', t('bprefs.appDark')]]} />} />
      <Row label={t('bprefs.ua')} desc={t('bprefs.uaDesc')} setting="browserUserAgent" reset={<Reset t={t} label={t('bprefs.ua')} show={ua !== 'default'} run={() => void setUa(null)} />} control={<Select value={ua} label={t('bprefs.ua')} setting="browserUserAgent" onChange={(v) => void setUa(v)}><option value="default">{t('bprefs.uaDefault')}</option><option value="safari">Safari</option><option value="chrome">Chrome</option></Select>} />
      <Sites t={t} />
      <Row label={t('bprefs.showPane')} desc={t('bprefs.showPaneDesc')} setting="browserShowPane" reset={<Reset t={t} label={t('bprefs.showPane')} show={showPane !== true} run={() => setShowPane(true)} />} control={<Switch checked={showPane} onChange={setShowPane} label={t('bprefs.showPane')} setting="browserShowPane" />} />
    </Sec>
  );
}

// The nav shows a registered page's `title`; read it in the window's language (`<html lang>`), English otherwise.
const title = () => {
  const lang = document.documentElement.lang as keyof typeof TABLES;
  return TABLES[lang]?.['bprefs.title'] ?? TABLES.en['bprefs.title'] ?? 'In-app browser';
};
registerSettingsPage({
  id: PAGE,
  get title() {
    return title();
  },
  get description() {
    const lang = document.documentElement.lang as keyof typeof TABLES;
    return TABLES[lang]?.['bprefs.desc'] ?? TABLES.en['bprefs.desc'];
  },
  group: 'interface',
  order: 10,
  render: () => null,
});
registerSettingsSection({
  page: PAGE,
  id: SECTIONS.defaults,
  order: 10,
  fields: [
    { key: 'browserEngine', at: '[data-setting="browserEngine"]' },
    { key: 'browserHome', at: '[data-setting="browserHome"]' },
    { key: 'browserZoom', at: '[data-setting="browserZoom"]' },
    { key: 'browserViewport', at: '[data-setting="browserViewport"]' },
    { key: 'browserAppearance', at: 'input[name="bprefs-appearance"]' },
    { key: 'browserUserAgent', at: '[data-setting="browserUserAgent"]' },
    { key: 'browserSites', at: '[data-setting="browserSites"]' },
    { key: 'browserShowPane', at: '[data-setting="browserShowPane"]' },
  ],
  render: ({ t }) => <Defaults t={t} />,
});
