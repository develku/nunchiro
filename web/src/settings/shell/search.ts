// Ticket 516: the Settings search box from outside SettingsView (the `settings.search` command, ⌘F while Settings is open).

/** Focuses the open Settings window's search box and selects its text; nothing when Settings is closed. */
export function focusSettingsSearch() {
  const box = document.querySelector<HTMLInputElement>(".settings[role='region'] > nav > .snavsearch > input.search");
  box?.focus();
  box?.select();
}
