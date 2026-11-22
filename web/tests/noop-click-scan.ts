// The clickable list of the no-op click check (web/tests/noop-click-check.spec.ts), kept in a module so
// noop-click-selected.spec.ts can test the real thing. Importing one spec file from another would register its tests twice.
import type { Page } from '@playwright/test';
import type { Ux } from './ux-states';

// A radio group, toggle or tab strip: the choice that is already on. Clicking it again is meant to change nothing
// (Orca's scope switch and herdr's mode tabs do the same), so the scan does not click it. Only the element itself counts,
// never what sits inside it: a Stop button inside the selected tab row is still clicked.
// A native radio that is checked is the same choice (its state is the `checked` property, no aria attribute): Settings >
// Keyboard's session order Seg (d71f1d86) was the first one the scan met. A checkbox is not: clicking it unchecks it.
export const SELECTED = '[aria-checked="true"], [aria-pressed="true"], [aria-selected="true"], input[type="radio"]:checked';

/** Runs in the page: one entry per clickable (`skip`: the named skip list; `selected`: the element's own aria state is on), keyed `<css path>|<text>#<n>` (n counts equal keys, so each is addressable). */
export const list = (page: Page, skip: string) =>
  page.evaluate(
    ([skip, selected]) => {
      const ux = (window as unknown as { __ux: Ux }).__ux;
      const seen = new Map<string, number>();
      return ux.clickables().map((el) => {
        const base = `${ux.css(el)}|${ux.label(el)}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return { key: `${base}#${n}`, line: base, skip: el.matches(skip) || !!el.closest(skip), selected: el.matches(selected) };
      });
    },
    [skip, SELECTED],
  );
