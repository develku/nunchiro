// The Settings nav's built-in pages, in one place for every spec that checks the nav (coordinator, ticket 267). The list is
// BUILTIN_PAGES itself (src/features/builtin.ts), so a new built-in page is added there once; settings-shell.spec.ts checks
// that list against final.html. A feature page registered through the ticket 250 seams (features/*.tsx, absorb tickets
// 251-278) joins its group after that group's built-in pages, so the specs check the built-in pages in final order and
// allow registered pages after them, instead of pinning the whole nav.
import type { Locator } from '@playwright/test';
import { BUILTIN_PAGES } from '../src/features/builtin';
import { en as common } from '../src/i18n/areas/common';
import { en as settingsArea } from '../src/i18n/areas/settings';

const LABELS: Record<string, string> = { ...common, ...settingsArea };

/** The built-in pages' English nav titles, in nav order. */
export const BUILTIN_TITLES = BUILTIN_PAGES.map((id) => LABELS[`settings.page.${id}`]);

/** Every built-in page button (a selector list matches in document order). */
export const BUILTIN_BUTTONS = BUILTIN_PAGES.map((id) => `button[data-page="${id}"]`).join(', ');

/** In each nav group: [built-in ids, registered ids, whether every registered page comes after the group's built-ins]. */
export const groupsOf = (nav: Locator) =>
  nav.getByRole('group').evaluateAll(
    (groups, builtin) =>
      groups.map((g) => {
        const ids = [...g.querySelectorAll('button[data-page]')].map((b) => b.getAttribute('data-page')!);
        const mine = ids.filter((id) => !builtin.includes(id));
        return { builtin: ids.filter((id) => builtin.includes(id)), registered: mine, after: ids.every((id, i) => builtin.includes(id) || ids.slice(i).every((x) => !builtin.includes(x))) };
      }),
    BUILTIN_PAGES,
  );
