// V2-4b: anything in the window can ask for Settings > Providers (ticket 391), optionally with one agent's card (a problem card's
// "Fix command", the picker's "Add or manage agents…"). App opens the Settings tab and passes the request on.
export const AGENTS_EVENT = 'nunchiro:agents';
/** Ticket 372: Settings opened on Usage (the status bar's limit chip). */
export const USAGE_EVENT = 'nunchiro:usage';
export const openUsage = (): void => void window.dispatchEvent(new CustomEvent(USAGE_EVENT));
export const openAgents = (name?: string): void => void window.dispatchEvent(new CustomEvent(AGENTS_EVENT, { detail: { name } }));
/** Ticket 872: Settings opened on one page, focused on one field (a `FIELDS` key), from anywhere in the window. Ticket 993:
 *  `at` finds a field that is in no list (Providers' Use switch, from the Schedules widget's form). */
export const SETTING_EVENT = 'nunchiro:settings.field';
export const openSetting = (page: string, key: string, at?: string): void => void window.dispatchEvent(new CustomEvent(SETTING_EVENT, { detail: { page, key, at } }));
/** Opens Settings on a page and presses one of its buttons once the page has drawn it (Team's Add, an onboarding step). */
export const pressSetting = (page: string, key: string, button: string): void => {
  openSetting(page, key);
  let tries = 0;
  const press = () => {
    const b = document.querySelector<HTMLButtonElement>(`.settings ${button}`);
    if (b) b.click();
    else if (tries++ < 20) requestAnimationFrame(press);
  };
  requestAnimationFrame(press);
};
/** Tickets 1032, 1034: the "Name your assistant" step of Settings > Onboarding, where the main assistant is set up. */
export const nameAssistant = (): void => pressSetting('onboarding', 'onboarding', '.ob-step[data-step="assistant"]');
