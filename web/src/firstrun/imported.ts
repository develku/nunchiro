// Ticket 204 (needs 171 IMPORTOPEN A): an imported conversation opens read-only in a centre tab `imported:<id>`, from a
// first-run hit or an imported row. Mirrors files/open.ts: the tab id, an event App listens for, and the call that fires it.
// Opening is a view (needs 137): the tab only asks the core for `import_read`.
const PREFIX = 'imported:';
export const importedTabId = (id: string) => `${PREFIX}${id}`;
export const isImportedTab = (id: string | null) => !!id?.startsWith(PREFIX);
export const importedOfTab = (id: string | null) => (isImportedTab(id) ? id!.slice(PREFIX.length) : null);

export const OPEN_EVENT = 'nunchiro:import.open';

// The tab strip shows the conversation's title, which only the list and the read know. Ticket 448: the titles are kept across
// a restart (the newest 50), so a restored tab is not named by its file stem, a raw id; one never read has no title ('').
const KEY = 'nunchiro.imported.titles';
const stored = (): [string, string][] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') : [];
  } catch {
    return []; // no storage (node tests) or a broken value
  }
};
const titles = new Map<string, string>(stored());
export const importedTitle = (id: string) => titles.get(id) ?? '';
export const rememberTitle = (id: string, title: string) => {
  if (!title) return;
  titles.delete(id);
  titles.set(id, title);
  try {
    localStorage.setItem(KEY, JSON.stringify([...titles].slice(-50)));
  } catch {
    // the title stays for this run only
  }
};

/** Opens imported conversation `id` (`<agent>:<file stem>`) in its tab, focusing it if it is already open. */
export function openImported(id: string, title = '') {
  rememberTitle(id, title);
  window.dispatchEvent(new CustomEvent<{ id: string }>(OPEN_EVENT, { detail: { id } }));
}
