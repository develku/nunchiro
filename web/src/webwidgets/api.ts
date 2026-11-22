// Web widgets (ticket v1b-22): mirrors crates/nunchiro-core/src/widgets/web.rs (Reply::WidgetPage, the web form of
// widget_act). The web-widget host's whole core surface is these two requests (the list poll and the permission
// sheet are shared with script widgets).
import type { ApprovalCore } from '../approval/types';
import { artifactUrl } from '../sandbox/url';

export interface Context {
  projects: { name: string }[];
  sessions: { label: string; project: string; state: string }[];
}
export interface Page {
  name: string;
  hash: string;
  network: string[];
  act: boolean;
  entry: string;
  context: Context;
}
export type Target = { session: string } | { start: 'claude' | 'codex' };

/** Same rule as app/src-tauri/src/artifacts/widget_page.rs `id`: the app serves the entry only while the hash matches,
 * and (review-34) a `-act` id only while act is granted, a plain one only while it is not. */
export const frameId = (name: string, hash: string, act = false) => `w-${name}-${hash.slice(0, 16)}${act ? '-act' : ''}`;

export const widgetPage = (core: ApprovalCore, name: string) =>
  core.request({ op: 'widget_page', name }).then((r) => (r as { page: Page }).page);

/** Only the header confirm's Send calls this, with the text and target the confirm showed, the hash of the page it
 * was drawn for (the core refuses when the approval moved on) and (v1b-34 r2) that page's frame id, which the core
 * requires to be framed with act. */
export const actWebWidget = (core: ApprovalCore, name: string, session: string, text: string, target: Target, hash: string, frame: string) =>
  core.request({ op: 'widget_act', name, session, text, target, hash, frame }).then((r) => r as { session: string; send: { status: string } });

interface Host {
  src: (id: string) => string;
}
declare global {
  interface Window {
    /** Browser tests stand in for the app's scheme (Playwright cannot load it); see web/tests/fixtures/web-widgets. */
    __NUNCHIRO_WIDGET_HOST__?: Host;
  }
}
export const widgetSrc = (id: string) => (window.__NUNCHIRO_WIDGET_HOST__ ?? { src: artifactUrl }).src(id);
