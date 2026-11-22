// ticket 291 item 3, V2.5-34: the no-op click check does not click a choice that is already selected in a radio group,
// toggle or tab strip (a second click on it is meant to change nothing), and still clicks an unselected one.
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './fixtures';
import { list } from './noop-click-scan';
import { expect, seed, STATES, test } from './ux-states';

/** A page of pointer-cursor buttons with the given `attrs`; returns `<label>:<skipped>` for each, as the real scan lists them. */
async function scan(page: import('@playwright/test').Page, chatCore: Parameters<typeof seed>[1], body: string) {
  await seed(page, chatCore, true);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.evaluate((body) => {
    document.body.innerHTML = `<style>button{cursor:pointer;display:block;width:140px;height:24px}</style>${body}`;
  }, body);
  return (await list(page, '.never')).map((e) => `${e.line.split('|')[1]}:${e.skip || e.selected}`);
}

test('noop_click_selected_choice_is_not_noop', async ({ page, chatCore }) => {
  const got = await scan(
    page,
    chatCore,
    `<div role="radiogroup"><button role="radio" aria-checked="true">Files</button></div>
     <button aria-pressed="true">Shortcuts</button>
     <div role="tablist"><button role="tab" aria-selected="true">All</button></div>`,
  );
  expect(got).toEqual(['Files:true', 'Shortcuts:true', 'All:true']);
});

test('noop_click_dead_unselected_still_caught', async ({ page, chatCore }) => {
  const got = await scan(
    page,
    chatCore,
    `<div role="radiogroup"><button role="radio" aria-checked="false">Files</button></div>
     <button aria-pressed="false">Shortcuts</button>
     <div role="tablist"><button role="tab" aria-selected="false">All</button></div>
     <button>Plain</button>
     <div aria-selected="true"><button>Inside</button></div>`,
  );
  // The last one sits inside a selected element but is not the choice itself: it is still clicked.
  expect(got).toEqual(['Files:false', 'Shortcuts:false', 'All:false', 'Plain:false', 'Inside:false']);
});

test('noop_baseline_selected_lines_removed', () => {
  const lines = fs.readFileSync(path.join(REPO, 'scripts/noop-click.baseline'), 'utf8').split('\n');
  for (const gone of [
    'search|aside.spanel>div.sscope>div.sscopes>button|Files',
    'settings-keyboard|div.keys-page>section.keys-head>div.hk-tabs>button|Shortcuts',
    'settings-keyboard|section.kshort>div.kbar>div.kchips>button.kchip|All',
  ])
    expect(lines).not.toContain(gone);
});

// V2.5-34: in the overlay states an overlay (a menu, the palette's input) can lie over a control. The scan presses a point of
// the control that is on top (noop-click-check.spec.ts clickOne), else its centre, where the press lands on the overlay and is
// meant to do nothing (the one baseline line left, Side chat under the palette). The test below proves the second half.
const stateOf = (name: string) => STATES.find((s) => s.name === name)!;
const under = (page: import('@playwright/test').Page, sel: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { self: top === el || el.contains(top), overlay: !!top?.closest('.cmenu, .palette') };
  }, sel);

test('noop_side_chat_header_button', async ({ page, chatCore }) => {
  const c = await seed(page, chatCore, true);
  await page.setViewportSize({ width: 1440, height: 800 });
  await stateOf('palette').enter(c);
  expect(await under(page, '.shead button.hbtn')).toEqual({ self: false, overlay: true });
  await stateOf('session-note').enter(c);
  const before = c.sent.length;
  await page.locator('.shead button.hbtn', { hasText: 'Side chat' }).click();
  await expect.poll(() => c.sent.length > before || page.locator('[data-side-chat]').count().then((n) => n > 0)).toBeTruthy();
});
