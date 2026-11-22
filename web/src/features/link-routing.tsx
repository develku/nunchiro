// Ticket 256 (needs 197, G06): Settings › In-app browser › Links, and the opener the terminal, chat and Files viewer
// link handlers call. Default: the user's browser (ADR 0001:122), unchanged. When set, a clicked http(s) link opens in
// the in-app browser of the clicked session's own space, never the user's "you" store (255's threats). Artifact frames and
// web widgets never come here: they keep `openExternal` whatever the setting (widget-check G06).
// The choices follow Orca's link routing settings (route, Shift+click flips, open in background):
// orca/src/renderer/src/components/settings/BrowserLinkRouting*Setting.tsx, MIT License, Copyright (c) 2026 Lovecast Inc.
// (choices and wording only; the rows are this app's own row kit, final.html builders).
import { createContext } from 'react';
import type { T } from '../i18n';
import { load } from '../settings';
import { registerSettingsSection } from './registry';
import { defineSetting, readFeature, useFeatureSetting } from '../settings/useFeatureSetting';
import { Reset, Row, Sec, SecReset, Seg, Switch } from '../settings/shell/Row';
import { route, type Origin, type Prefs } from '../pane/browser/route';
import { queueBrowserGo } from '../tree/browserGo';
import { isPaneShell, show } from '../pane/store';
import { YOU_SPACE } from '../pane/browser/view/spaces';
import { PAGE, SECTIONS } from './browser-prefs';

const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
// Window values (a view preference of this window).
export const LINKS_IN_APP = defineSetting('browser.links_in_app', false, bool);
export const SHIFT_FLIPS = defineSetting('browser.links_shift_flips', true, bool);
export const LINKS_BACKGROUND = defineSetting('browser.links_background', false, bool);

/** The values now, outside React (a terminal link handler): the window store as last saved (settings.ts `load`). */
function prefsNow(): Prefs {
  const f = load().features;
  const get = (key: string, fallback: boolean) => readFeature(f, key, fallback, bool);
  // shortcut: worktree labels (O-178) are not wired; the window does not know a session's worktree yet.
  return { inApp: get(LINKS_IN_APP, false), shiftFlips: get(SHIFT_FLIPS, true), background: get(LINKS_BACKGROUND, false), labels: false };
}

/** The Files viewer's session around its Markdown, so a link there knows its space and its origin. */
export const LinkSpace = createContext<string | null>(null);

/** The session's side pane can show its Browser tab now (App.tsx `paneSession`): an agent session, running, its tab in
 *  front. ChatView marks exactly that chat: no `data-readonly` (live), no `data-off` (active); a split's chat is not the pane's. */
const paneCanShow = (id: string) =>
  [...document.querySelectorAll(`.chat[data-session="${CSS.escape(id)}"]:not([data-readonly]):not([data-off])`)].some((el) => !el.closest('.side-chat-body'));

/** Opens a clicked http(s) link where the settings say. No session, the "you" space, a pane shell or a session that cannot
 *  show its Browser tab now (a shell tab, a stopped agent, a file tab in front): the user's browser, never a dropped link. */
export function openRouted(url: string, at: { session?: string | null; shift: boolean; origin: Origin }, external: (url: string) => unknown) {
  // shortcut: a shell the side pane holds has no space of its own and its agent is not known here, so it goes external.
  const space = at.session && at.session !== YOU_SPACE && !isPaneShell(at.session) && paneCanShow(at.session) ? at.session : null;
  const how = space ? route(prefsNow(), at.shift, at.origin) : 'external';
  if (how === 'external' || !space) return void external(url);
  // shortcut: a background link waits for the space's Browser tab to mount (no hidden native view); load it at once if missed.
  queueBrowserGo(space, url);
  if (how === 'pane') show(space, 'browser');
}

function Links({ t }: { t: T }) {
  const [inApp, setInApp] = useFeatureSetting(LINKS_IN_APP);
  const [flips, setFlips] = useFeatureSetting(SHIFT_FLIPS);
  const [background, setBackground] = useFeatureSetting(LINKS_BACKGROUND);
  return (
    <Sec
      id="h-lroute-links"
      title={t('lroute.links')}
      action={<SecReset t={t} section={t('lroute.links')} show={inApp !== false || flips !== true || background !== false} run={() => (setInApp(false), setFlips(true), setBackground(false))} undo={() => (setInApp(inApp), setFlips(flips), setBackground(background))} />}
    >
      <Row
        label={t('lroute.openIn')}
        desc={t('lroute.openInDesc')}
        setting="linksOpenIn"
        reset={<Reset t={t} label={t('lroute.openIn')} show={inApp !== false} run={() => setInApp(false)} />}
        control={<Seg name="lroute-open-in" label={t('lroute.openIn')} setting="linksOpenIn" value={inApp ? 'app' : 'system'} onChange={(v) => setInApp(v === 'app')} options={[['system', t('lroute.system')], ['app', t('lroute.inApp')]]} />}
      />
      <Row label={t('lroute.shift')} setting="linksShift" reset={<Reset t={t} label={t('lroute.shift')} show={flips !== true} run={() => setFlips(true)} />} control={<Switch checked={flips} onChange={setFlips} label={t('lroute.shift')} setting="linksShift" />} />
      <Row label={t('lroute.background')} desc={t('lroute.backgroundDesc')} setting="linksBackground" reset={<Reset t={t} label={t('lroute.background')} show={background !== false} run={() => setBackground(false)} />} control={<Switch checked={background} onChange={setBackground} label={t('lroute.background')} setting="linksBackground" />} />
    </Sec>
  );
}

registerSettingsSection({
  page: PAGE,
  id: SECTIONS.links,
  order: 20,
  fields: [
    { key: 'linksOpenIn', at: 'input[name="lroute-open-in"]' },
    { key: 'linksShift', at: '[data-setting="linksShift"]' },
    { key: 'linksBackground', at: '[data-setting="linksBackground"]' },
  ],
  render: ({ t }) => <Links t={t} />,
});
