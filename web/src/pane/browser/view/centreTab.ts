// Ticket 997 L1 (rule A6, owner 11-19): "+" -> Browser opens My browser as a full centre tab; the right-side widget stays the
// quick open-and-close look. One place at a time, as the Schedules tab (schedules.ts SCHED_AT): the app keeps one native view
// per space, placed by whichever slot shows it last (BrowserView.tsx `shown`), so opening the tab closes the widget and, while
// the tab exists, the Browser icon brings the tab instead of the widget.
import { defineSetting, useFeatureSetting, writeFeature } from '../../../settings/useFeatureSetting';
import { showYou } from '../../store';

const BROWSER_AT = defineSetting<boolean>('browser.tab', false, (v) => (typeof v === 'boolean' ? v : undefined));
/** Whether the window has the tab. */
export const useBrowserTab = () => useFeatureSetting(BROWSER_AT);
/** The centre tab's id. It is in no project's tab list: the strip draws it while it exists, in whichever project is shown. */
export const BROWSER_TAB = 'browser:';

// The centre strip owns the active tab; an ask from outside (the "+" row, the palette, the icon, ⇧⌘T) waits until it is drawn.
const asks = new Set<() => void>();
export const onShowBrowserTab = (f: () => void) => (asks.add(f), () => void asks.delete(f));
/** Opens the tab (or brings it to the front) and closes the widget, which shows the same space. */
export const openBrowserTab = () => (showYou(false), writeFeature(BROWSER_AT, true), asks.forEach((f) => f()));
/** ⌘W or its close button: the tab goes; the page stays loaded in its native view for the next open. */
export const closeBrowserTab = () => writeFeature(BROWSER_AT, false);
