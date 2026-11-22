// V2.5-15 (needs 139): a half-written prompt (text and an image) is stashed from one session's composer and applied in
// another's, from visible labelled buttons. Nothing is sent.
import type { Page } from '@playwright/test';
import { expect, openWindow, test as base, type Core } from './fixtures';

// Playwright's default WebKit context is ephemeral, and WebKit refuses Blobs in IndexedDB there. The app's webview keeps a
// persistent store, so WebKit runs on a persistent context here: the same condition as the real window.
const test = base.extend({
  context: async ({ context, browserName, playwright, baseURL, viewport }, use, info) => {
    if (browserName !== 'webkit') return use(context);
    const persistent = await playwright.webkit.launchPersistentContext(info.outputPath('webkit-profile'), { baseURL, viewport });
    await use(persistent);
    await persistent.close();
  },
});

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Ticket 371 item 24: the stash and unsent chips rest in IndexedDB. These read that store directly.
type Rec = { key: string; size: number };
/** Every stored record, with the bytes of the images it holds. */
const stored = (app: Page) =>
  app.evaluate(
    () =>
      new Promise<Rec[]>((resolve, reject) => {
        const open = indexedDB.open('nunchiro-composer-blobs');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const s = open.result.transaction('blobs').objectStore('blobs');
          const keys = s.getAllKeys();
          const all = s.getAll();
          all.onsuccess = () => {
            open.result.close();
            resolve(
              (all.result as { files?: File[]; file?: File }[]).map((v, i) => ({
                key: String(keys.result[i]),
                size: [...(v.files ?? []), ...(v.file ? [v.file] : [])].reduce((n, f) => n + f.size, 0),
              })),
            );
          };
        };
      }),
  );
const keys = async (app: Page) => (await stored(app)).map((r) => r.key.split(':')[0]).sort();
/** Replaces every stored image with bytes that claim to be a PNG and are not. */
const tamper = (app: Page) =>
  app.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('nunchiro-composer-blobs');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('blobs', 'readwrite');
          const s = tx.objectStore('blobs');
          const fake = (f: File) => new File(['<svg onload=alert(1)>'], f.name, { type: 'image/png' });
          s.openCursor().onsuccess = (e) => {
            const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!c) return;
            const v = c.value as { files?: File[]; file?: File };
            c.update({ ...v, ...(v.files ? { files: v.files.map(fake) } : {}), ...(v.file ? { file: fake(v.file) } : {}) });
            c.continue();
          };
          tx.oncomplete = () => (open.result.close(), resolve());
        };
      }),
  );

const cbox = (app: Page) => app.locator('.cbox:visible').first();
const area = (app: Page) => cbox(app).locator('textarea:not(.hoff-edit)');
const chips = (app: Page) => cbox(app).locator('.ichip');
const image = (name: string, buffer = PNG) => ({ name, mimeType: 'image/png', buffer });
const attach = (app: Page, f: ReturnType<typeof image>) => cbox(app).locator('input[type=file]').setInputFiles(f);
const stashBtn = (app: Page) => cbox(app).getByRole('button', { name: 'Save this draft for later' });
const drafts = (app: Page, n: number) => cbox(app).getByRole('button', { name: `Saved drafts (${n})` });

async function start(app: Page, core: Core) {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(area(app)).toBeEditable();
  return a;
}
async function reopen(app: Page, id: string) {
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.locator(`.tab[data-tab="${id}"]`).click();
  await expect(area(app)).toBeEditable();
}
/** Text and one image, stashed. */
async function stashOne(app: Page, text: string, name: string, buffer = PNG) {
  await area(app).fill(text);
  await attach(app, image(name, buffer));
  await expect(chips(app)).toHaveCount(1);
  await stashBtn(app).click();
  await expect(area(app)).toHaveValue('');
  await expect(chips(app)).toHaveCount(0);
}

test('stash_and_unsent_chip_survive_a_reload', async ({ app, core }) => {
  const a = await start(app, core);
  await stashOne(app, 'half a prompt', 'stashed.png');
  await attach(app, image('unsent.png'));
  await expect(chips(app)).toHaveCount(1);
  await expect.poll(() => keys(app)).toEqual(['chip', 'stash']);

  await reopen(app, a.id);
  await expect(drafts(app, 1)).toBeVisible();
  await expect(chips(app)).toHaveCount(1);
  await expect(chips(app)).toContainText('unsent.png');

  await drafts(app, 1).click();
  await cbox(app).getByRole('button', { name: /^Apply: half a prompt/ }).click();
  await expect(area(app)).toHaveValue('half a prompt');
  await expect(chips(app)).toHaveCount(2);
  await expect(chips(app).filter({ hasText: 'stashed.png' })).toHaveCount(1);
});

test('a_malformed_stored_record_is_deleted_and_does_not_break_the_window', async ({ app, core }) => {
  const a = await start(app, core);
  await area(app).fill('a good one');
  await stashBtn(app).click();
  await expect.poll(() => keys(app)).toEqual(['stash']);
  const shape = { files: [], from: 'x', at: 1, dropped: [], unreadable: [] };
  await app.evaluate(
    (bad) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('nunchiro-composer-blobs');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('blobs', 'readwrite');
          bad.forEach((v, i) => tx.objectStore('blobs').put(v, `stash:bad${i}`));
          tx.oncomplete = () => (open.result.close(), resolve());
        };
      }),
    [
      { ...shape, id: 'bad0', text: 42 },
      { ...shape, id: 'bad1', text: 'x', from: { not: 'a name' } },
      { ...shape, id: 'bad2', text: 'x', dropped: 'not a list' },
      { ...shape, id: 'bad3', text: 'x', unreadable: [7] },
    ],
  );
  const crashes: string[] = [];
  app.on('pageerror', (e) => crashes.push(e.message));

  await reopen(app, a.id);
  await expect(drafts(app, 1)).toBeVisible();
  await drafts(app, 1).click();
  await expect(cbox(app).locator('.apply')).toHaveCount(1);
  await expect(cbox(app).locator('.apply')).toContainText('a good one');
  await expect.poll(() => keys(app)).toEqual(['stash']);
  expect(crashes).toEqual([]);
});

test('applied_removed_and_sent_images_leave_no_record', async ({ app, core }) => {
  await start(app, core);
  await stashOne(app, 'first', 'one.png');
  await expect.poll(() => keys(app)).toEqual(['stash']);

  // Apply: the stash record goes; the image is now an unsent chip, and removing it leaves nothing.
  await drafts(app, 1).click();
  await cbox(app).getByRole('button', { name: /^Apply: first/ }).click();
  await expect(chips(app)).toHaveCount(1);
  await expect.poll(() => keys(app)).toEqual(['chip']);
  await app.getByRole('button', { name: 'Remove image one.png' }).click();
  await expect.poll(() => keys(app)).toEqual([]);

  // Discard.
  await stashOne(app, 'second', 'two.png');
  await expect.poll(() => keys(app)).toEqual(['stash']);
  await drafts(app, 1).click();
  await cbox(app).getByRole('button', { name: 'Discard' }).click();
  await expect.poll(() => keys(app)).toEqual([]);
  await app.keyboard.press('Escape');

  // Send.
  await attach(app, image('three.png'));
  await expect.poll(() => keys(app)).toEqual(['chip']);
  await area(app).fill('look');
  await area(app).press('Enter');
  await expect(chips(app)).toHaveCount(0);
  await expect.poll(() => keys(app)).toEqual([]);
});

test('stash_keeps_twenty_entries', async ({ app, core }) => {
  const a = await start(app, core);
  for (let i = 0; i < 21; i++) {
    await area(app).fill(`draft ${i}.`);
    await stashBtn(app).click();
    await expect(area(app)).toHaveValue('');
  }
  await expect(drafts(app, 20)).toBeVisible();
  await expect.poll(async () => (await keys(app)).length).toBe(20);
  await reopen(app, a.id);
  await expect(drafts(app, 20)).toBeVisible();
  await drafts(app, 20).click();
  await expect(cbox(app).getByRole('button', { name: /^Apply: draft 0\./ })).toHaveCount(0); // the oldest went
  await expect(cbox(app).getByRole('button', { name: /^Apply: draft 1\./ })).toHaveCount(1);
  // Newest first, as before the reload.
  await expect(cbox(app).locator('.apply').first()).toContainText('draft 20.');
});

test('stash_byte_budget_holds_and_the_dropped_names_are_shown', async ({ app, core }) => {
  test.slow(); // 76 MiB through the page, four times over
  const a = await start(app, core);
  // Valid PNGs padded after their end, 19 MiB each: four are over the 64 MiB budget, so the oldest loses its image.
  const big = Buffer.concat([PNG, Buffer.alloc(19 * 1024 * 1024)]);
  for (const n of ['first', 'second', 'third', 'fourth']) await stashOne(app, `${n} draft`, `${n}.png`, big);
  await expect(drafts(app, 4)).toBeVisible();
  await expect.poll(async () => (await stored(app)).reduce((n, r) => n + r.size, 0)).toBeLessThanOrEqual(64 * 1024 * 1024);

  await reopen(app, a.id);
  await drafts(app, 4).click();
  const oldest = cbox(app).locator('.i').filter({ hasText: 'first draft' });
  await expect(oldest).toContainText('Not kept: first.png');
  await expect(cbox(app).locator('.i').filter({ hasText: 'second draft' })).not.toContainText('Not kept');

  // Its text is still whole, and nothing claims an image that is gone.
  await oldest.locator('.apply').click();
  await expect(area(app)).toHaveValue('first draft');
  await expect(chips(app)).toHaveCount(0);
});

test('a_failing_store_write_keeps_the_stash_usable_in_memory', async ({ app, core }) => {
  await app.addInitScript(() => {
    IDBObjectStore.prototype.put = () => {
      throw new DOMException('disk full', 'QuotaExceededError');
    };
  });
  await start(app, core);
  await stashOne(app, 'kept anyway', 'mem.png');
  await expect(drafts(app, 1)).toBeVisible();
  await drafts(app, 1).click();
  await cbox(app).getByRole('button', { name: /^Apply: kept anyway/ }).click();
  await expect(area(app)).toHaveValue('kept anyway');
  await expect(chips(app)).toHaveCount(1);
});

test('a_tampered_stored_image_fails_the_check_on_load_and_is_named_not_attached', async ({ app, core }) => {
  const a = await start(app, core);
  await stashOne(app, 'keep my words', 'stash-bad.png');
  await attach(app, image('chip-bad.png'));
  await expect(chips(app)).toHaveCount(1);
  await expect.poll(() => keys(app)).toEqual(['chip', 'stash']);
  await tamper(app);

  await reopen(app, a.id);
  await expect(cbox(app).locator('.ierr')).toContainText('chip-bad.png');
  await expect(chips(app)).toHaveCount(0);
  await drafts(app, 1).click();
  const row = cbox(app).locator('.i').filter({ hasText: 'keep my words' });
  await expect(row).toContainText('Could not be read back: stash-bad.png');
  await row.locator('.apply').click();
  await expect(area(app)).toHaveValue('keep my words');
  await expect(chips(app)).toHaveCount(0);
});

test('stash_and_apply_elsewhere', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  const b = core.agent(core.project('a'), 'x', 'beta');
  const sent: string[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && /"op":"send_(text|keys)"/.test(f.payload) && sent.push(f.payload)));
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const box = app.locator('.cbox:visible').first();
  const ta = box.locator('textarea:not(.hoff-edit)');
  await ta.fill('half a prompt');
  await box.locator('input[type=file]').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await expect(box.locator('.chip, .ichip, img').first()).toBeVisible();

  await box.getByRole('button', { name: 'Save this draft for later' }).click();
  await expect(ta).toHaveValue('');
  await expect(box.locator('img')).toHaveCount(0);

  await app.locator(`.tab[data-tab="${b.id}"]`).click();
  const box2 = app.locator('.cbox:visible').first();
  await box2.getByRole('button', { name: /Saved drafts \(1\)/ }).click();
  await box2.getByRole('button', { name: /^Apply: half a prompt/ }).click();
  await expect(box2.locator('textarea:not(.hoff-edit)')).toHaveValue('half a prompt');
  await expect(box2.locator('img')).toHaveCount(1);
  await box2.getByRole('button', { name: /Saved drafts \(0\)/ }).click();
  await expect(box2.getByText('No saved drafts.')).toBeVisible();
  expect(sent).toEqual([]); // applying never sends
});

test('stash_needs_a_draft_and_discard_keeps_the_menu', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const box = app.locator('.cbox:visible').first();
  const stashBtn = box.getByRole('button', { name: 'Save this draft for later' });
  await expect(stashBtn).toBeHidden(); // ticket 395: nothing to stash and nothing stashed
  for (const text of ['one', 'two']) {
    await box.locator('textarea:not(.hoff-edit)').fill(text);
    await stashBtn.click();
  }
  await box.getByRole('button', { name: /Saved drafts \(2\)/ }).click();
  await box.getByRole('button', { name: 'Discard' }).first().click();
  await expect(box.getByRole('group', { name: 'Saved drafts' })).toBeVisible();
  await expect(box.getByRole('button', { name: /Saved drafts \(1\)/ })).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(box.getByRole('group', { name: 'Saved drafts' })).toBeHidden();
});

// Ticket 395: the Stash button shows only with something to stash (text or an image chip) or a stashed draft. Hidden, it
// keeps its place, so the Saved drafts button never moves under the pointer when typing brings it back.
test('stash_button_hides_when_there_is_nothing_to_stash_and_keeps_its_place', async ({ app, core }) => {
  await start(app, core);
  const hidden = cbox(app).locator('.cmenus .cib.away');
  const at = async () => (await drafts(app, 0).boundingBox())!.x;
  await expect(drafts(app, 0)).toBeVisible();
  await expect(stashBtn(app)).toBeHidden();
  await expect(hidden).toHaveCount(1);
  await expect(hidden).toHaveCSS('visibility', 'hidden');
  const x = await at();
  // Out of the tab order too: one Shift+Tab back from the drafts button does not land on it.
  await drafts(app, 0).focus();
  await app.keyboard.press('Shift+Tab');
  await expect(hidden).not.toBeFocused();

  // Text: shown and enabled as before, and nothing beside it moved.
  await area(app).fill('a thought');
  await expect(stashBtn(app)).toBeVisible();
  await expect(stashBtn(app)).toBeEnabled();
  await expect(hidden).toHaveCount(0);
  expect(await at()).toBe(x);
  // The keyboard reaches it and stashes.
  await drafts(app, 0).focus();
  // WebKit's Tab skips buttons unless the system keyboard-navigation switch is on; Option+Tab reaches every control.
  await app.keyboard.press(app.context().browser()?.browserType().name() === 'webkit' ? 'Shift+Alt+Tab' : 'Shift+Tab');
  await expect(stashBtn(app)).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(area(app)).toHaveValue('');

  // A stashed draft and an empty box: shown, disabled, as before this ticket.
  await expect(drafts(app, 1)).toBeVisible();
  await expect(stashBtn(app)).toBeVisible();
  await expect(stashBtn(app)).toBeDisabled();

  // The last draft discarded: hidden again, still in place.
  await drafts(app, 1).click();
  await cbox(app).getByRole('button', { name: 'Discard' }).click();
  await app.keyboard.press('Escape');
  await expect(drafts(app, 0)).toBeVisible();
  await expect(stashBtn(app)).toBeHidden();
  expect(await at()).toBe(x);

  // Text typed and then cleared: hidden again.
  await area(app).fill('gone soon');
  await expect(stashBtn(app)).toBeVisible();
  await area(app).fill('');
  await expect(stashBtn(app)).toBeHidden();

  // An image chip alone is something to stash.
  await attach(app, image('only.png'));
  await expect(chips(app)).toHaveCount(1);
  await expect(stashBtn(app)).toBeVisible();
  await expect(stashBtn(app)).toBeEnabled();
  expect(await at()).toBe(x);
});

// Ticket 395 r2: the box is shared across tabs. Text left in one session shows Stash there again after a switch away and back.
test('stash_button_follows_the_session_on_a_tab_switch', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  const b = core.agent(core.project('a'), 'x', 'beta');
  await openWindow(app, {}, core);
  const go = async (id: string) => {
    await app.locator(`.tab[data-tab="${id}"]`).click();
    await expect(area(app)).toBeEditable();
  };
  await go(a.id);
  await expect(area(app)).toHaveValue('');
  await expect(stashBtn(app)).toBeHidden();

  await go(b.id);
  await area(app).fill('kept in beta');
  await expect(stashBtn(app)).toBeVisible();
  await expect(stashBtn(app)).toBeEnabled();

  await go(a.id);
  await expect(area(app)).toHaveValue('');
  await expect(stashBtn(app)).toBeHidden();

  // What the button is in the very task that swaps B's draft back in (the textarea's data-draft-for changes in that commit),
  // before any later render (a transcript load) could cover for a stale read.
  await area(app).evaluate((el) => {
    const w = window as unknown as { __swap: string[] };
    w.__swap = [];
    new MutationObserver(() => {
      const btn = el.closest('.cbox')?.querySelector('.cmenus .cib');
      w.__swap.push(`${(el as HTMLTextAreaElement).dataset.draftFor}:${btn?.classList.contains('away') ? 'hidden' : 'shown'}`);
    }).observe(el, { attributes: true, attributeFilter: ['data-draft-for'] });
  });
  await go(b.id);
  await expect(area(app)).toHaveValue('kept in beta');
  expect(await app.evaluate(() => (window as unknown as { __swap: string[] }).__swap)).toEqual([`${b.id}:shown`]);
  await expect(stashBtn(app)).toBeVisible();
  await expect(stashBtn(app)).toBeEnabled();
  // And it still stashes what B holds.
  await stashBtn(app).click();
  await expect(area(app)).toHaveValue('');
  await expect(drafts(app, 1)).toBeVisible();
});
