// Ticket 305: "this window has launched before" (localStorage, like settings.ts), so Settings > Onboarding opens by itself
// once; after that the palette's "First run" or the Settings nav reach it. The key predates the page: a window that has
// already run a session counts as launched.
const KEY = 'nunchiro.firstrun.started';
export const everStarted = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};
export const markStarted = () => {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Private window or blocked storage: the page opens on every launch.
  }
};
