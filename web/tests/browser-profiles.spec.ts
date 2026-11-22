// Ticket 264 (needs 198, G05): browser profiles. The native view needs the app, so its bridge is faked here and every call is
// recorded; cookies really being shared or not is the app selftest's (scripts/browser-selftest.py), and what the app
// does with a stored profile is pinned by the Rust tests in app/src-tauri/src/browser/.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { agentsZone, expect, openWindow, REPO, test } from './fixtures';
import { icon } from './d5b';

type Row = { id: string; name: string; live: number };
type Fake = { __calls: [string, Record<string, unknown>][]; __profiles: { list: Row[]; default: string; picked: string | null }; __emit: (event: string, payload: unknown) => void };
const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as Fake & { __TAURI_INTERNALS__: unknown };
    const cbs = new Map<number, (e: unknown) => void>();
    const subs: [string, number][] = [];
    let next = 1;
    w.__calls = [];
    w.__profiles = { list: [{ id: 'default', name: '', live: 0 }], default: 'default', picked: null };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb: (e: unknown) => void) => (cbs.set(next, cb), next++),
      invoke: (cmd: string, args: Record<string, unknown>) => {
        w.__calls.push([cmd, args]);
        if (cmd === 'browser_profiles') return Promise.resolve(w.__profiles);
        if (cmd === 'plugin:event|listen') subs.push([args.event as string, args.handler as number]);
        return Promise.resolve(null);
      },
      metadata: {},
    };
    w.__emit = (event, payload) => subs.filter(([e]) => e === event).forEach(([, h]) => cbs.get(h)?.({ event, id: 1, payload }));
  });
const setProfiles = (page: Page, list: Row[]) => page.evaluate((l) => void ((window as unknown as Fake).__profiles.list = l), list);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as Fake).__calls.filter((x) => x[0] === c).map((x) => x[1]), cmd);
const emit = (page: Page, event: string, payload: unknown) => page.evaluate(([e, p]) => (window as unknown as Fake).__emit(e as string, p), [event, payload] as const);
const features = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).features ?? {};
const rows = (id: string, live = 0): Row[] => [
  { id: 'default', name: '', live: 0 },
  { id, name: 'Work', live },
];

test.beforeEach(({ core }) => agentsZone(core));

const openPage = async (app: Page) => {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.locator('.settings > nav button[data-page="inapp-browser"]').click();
  await expect(app.getByRole('region', { name: 'Browser profiles' })).toBeVisible();
};
/** Adds "Work" through the page and returns the id the core stored. */
const addWork = async (app: Page, home: string) => {
  const section = app.getByRole('region', { name: 'Browser profiles' });
  await section.getByRole('button', { name: 'Add profile' }).click();
  await section.getByLabel('Profile name').fill('Work');
  await section.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => features(home)['browser.profiles']?.list?.[0]?.id).toBeTruthy();
  return features(home)['browser.profiles'].list[0].id as string;
};
const pane = (page: Page) => page.locator('[data-side-pane]:not([hidden])');
const openPane = async (app: Page, id: string) => {
  await app.locator(`.tab[data-tab="${id}"]`).click();
  await icon(app, 'right', 'Terminal').click();
  await icon(app, 'right', 'Browser').click();
};

test('profiles_rows_on_inapp_browser_page_and_searchable', async ({ app, core }) => {
  await fakeApp(app);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openPage(app);
  const section = app.getByRole('region', { name: 'Browser profiles' });
  await expect(section.locator('.srow')).toHaveCount(1);
  await expect(section.getByText('Default profile')).toBeVisible();
  await expect(section.locator('.chip')).toHaveText('Default');
  // Add takes a name only; the id is made here and is one the app accepts.
  await section.getByRole('button', { name: 'Add profile' }).click();
  await section.getByLabel('Profile name').fill('Work');
  await section.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(section.locator('.srow')).toHaveCount(2);
  await expect.poll(() => features(core.home)['browser.profiles']?.list?.[0]?.name).toBe('Work');
  expect(features(core.home)['browser.profiles'].list[0].id).toMatch(/^[a-z0-9-]{1,32}$/);
  // Set default, rename.
  await section.getByRole('button', { name: 'Make default: Work' }).click();
  await expect.poll(() => features(core.home)['browser.profiles']?.default).toBe(features(core.home)['browser.profiles'].list[0].id);
  await section.getByRole('button', { name: 'Rename: Work' }).click();
  const rename = section.getByLabel('New name for Work');
  await rename.fill('Job');
  await rename.press('Enter');
  await expect(section.getByText('Job')).toBeVisible();
  await expect.poll(() => features(core.home)['browser.profiles']?.list?.[0]?.name).toBe('Job');
  // The built-in profile can never be removed.
  await expect(section.getByRole('button', { name: 'Remove: Default profile' })).toHaveCount(0);
  // Search reaches the section.
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('browser profiles');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: /Browser profiles/ }).click();
  await expect(app.locator('[data-setting="browserProfiles"]')).toBeFocused();
});

test('profile_clear_needs_window_approval_click', async ({ app, core }) => {
  await fakeApp(app);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openPage(app);
  const id = await addWork(app, core.home);
  const section = app.getByRole('region', { name: 'Browser profiles' });
  const clear = section.getByRole('button', { name: 'Clear cookies and site data: Work' });
  await clear.click();
  const sheet = app.getByRole('alertdialog', { name: 'Clear all cookies and site data in “Work”?' });
  await expect(sheet).toBeVisible();
  expect(await calls(app, 'browser_profile_clear')).toEqual([]); // the row's button only asks
  await sheet.getByRole('button', { name: 'Keep' }).click();
  await expect(sheet).toHaveCount(0);
  expect(await calls(app, 'browser_profile_clear')).toEqual([]);
  await clear.click();
  await app.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(await calls(app, 'browser_profile_clear')).toEqual([]);
  await clear.click();
  await sheet.getByRole('button', { name: 'Clear everything' }).click();
  await expect.poll(() => calls(app, 'browser_profile_clear')).toEqual([{ profile: id }]);
  await expect(section.getByRole('status')).toHaveText('“Work” is cleared.');
  await expect(sheet).toHaveCount(0);
});

test('profile_with_live_space_cannot_be_removed', async ({ app, core }) => {
  await fakeApp(app);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openPage(app);
  const id = await addWork(app, core.home);
  await setProfiles(app, rows(id, 2));
  const remount = async () => {
    await app.locator('.settings > nav button[data-page="general"]').click();
    await app.locator('.settings > nav button[data-page="inapp-browser"]').click();
  };
  await remount();
  const section = app.getByRole('region', { name: 'Browser profiles' });
  await expect(section.getByText('Open in 2 browser spaces')).toBeVisible();
  const remove = section.getByRole('button', { name: 'Remove: Work' });
  await expect(remove).toBeDisabled();
  // Ticket 475: the reason is the row's why line the button points at, not a tooltip.
  await expect(remove).not.toHaveAttribute('title');
  await expect(app.locator(`[id="${await remove.getAttribute('aria-describedby')}"][data-why]`)).toHaveText('First close the browser spaces that use this profile');
  expect(await calls(app, 'browser_profile_remove')).toEqual([]);
  // Once nothing is open it asks first, and the app's own check still decides (browser/mod.rs `profile_remove`).
  await setProfiles(app, rows(id, 0));
  await remount();
  await expect(remove).toBeEnabled();
  await remove.click();
  expect(await calls(app, 'browser_profile_remove')).toEqual([]);
  await app.getByRole('alertdialog').getByRole('button', { name: 'Remove profile' }).click();
  await expect.poll(() => calls(app, 'browser_profile_remove')).toEqual([{ profile: id }]);
  await expect(section.locator('.srow')).toHaveCount(1);
});

// Q9 zh-hant-J20-1: the Remove answers later than its click; a rename and Make default made meanwhile stay.
test('rename_and_default_made_while_a_remove_runs_stay', async ({ app, core }) => {
  await fakeApp(app);
  await app.addInitScript(() => {
    const w = window as unknown as { __release: () => void; __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } };
    const real = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (c, a) => (c === 'browser_profile_remove' ? real(c, a).then(() => new Promise((r) => (w.__release = () => r(null)))) : real(c, a));
  });
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openPage(app);
  const work = await addWork(app, core.home);
  const section = app.getByRole('region', { name: 'Browser profiles' });
  await section.getByRole('button', { name: 'Add profile' }).click();
  await section.getByLabel('Profile name').fill('Home');
  await section.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => features(core.home)['browser.profiles']?.list?.length).toBe(2);
  const home = features(core.home)['browser.profiles'].list[1].id as string;
  await section.getByRole('button', { name: 'Remove: Work' }).click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Remove profile' }).click();
  await expect.poll(() => calls(app, 'browser_profile_remove')).toEqual([{ profile: work }]);
  await section.getByRole('button', { name: 'Make default: Home' }).click();
  await expect.poll(() => features(core.home)['browser.profiles']?.default).toBe(home);
  await section.getByRole('button', { name: 'Rename: Home' }).click();
  await section.getByLabel('New name for Home').fill('House');
  await section.getByLabel('New name for Home').press('Enter');
  await expect.poll(() => features(core.home)['browser.profiles']?.list?.[1]?.name).toBe('House');
  await app.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(section.getByRole('status')).toHaveText('“Work” is removed.');
  await expect.poll(() => features(core.home)['browser.profiles']).toEqual({ default: home, list: [{ id: home, name: 'House' }] });
  await expect(section.locator('.srow')).toHaveCount(2);
});

test('new_space_offers_profile_picker_only_with_two_profiles', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await openPane(app, a.id);
  await expect(pane(app).getByLabel('Address')).toBeVisible();
  await expect(pane(app).getByLabel('Profile')).toHaveCount(0);
  // A second profile appears: the next new space offers the picker.
  await setProfiles(app, rows('work'));
  await pane(app).locator('select.bspace').selectOption('you'); // the user's own space is a new space too
  const picker = pane(app).getByLabel('Profile');
  await expect(picker).toBeVisible();
  await expect(picker.locator('option')).toHaveText(['Default profile', 'Work']);
  await picker.selectOption('work');
  const bar = pane(app).getByLabel('Address');
  await bar.fill('http://127.0.0.1:5731/a');
  await bar.press('Enter');
  await expect.poll(async () => (await calls(app, 'browser_show')).length).toBeGreaterThan(0);
  expect((await calls(app, 'browser_show'))[0]).toMatchObject({ space: 'you', profile: 'work' });
  // The space exists now: the picker is gone.
  await expect(pane(app).getByLabel('Profile')).toHaveCount(0);
});

test('permission_prompt_in_agent_space_hands_off_to_user', async ({ app, core }) => {
  await fakeApp(app);
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await openPane(app, a.id);
  await expect(pane(app).locator('.bhb')).toHaveCount(0); // ticket 991 C12: no page yet, no driver named
  await expect.poll(async () => (await calls(app, 'browser_control')).length).toBeGreaterThan(0); // asked only once subscribed
  // What `permit` sends through `control::take` when a page asks for the camera.
  await emit(app, 'browser-control', { space: a.id, user: true, reason: 'the page asks for the camera' });
  // Ticket 997 L7: one orange button in the toolbar row; the reason is in its name and tooltip.
  const back = pane(app).getByRole('button', { name: 'You have control: the page asks for the camera · Hand back' });
  await expect(back).toHaveAttribute('data-tip', /the page asks for the camera/);
  await back.click();
  await expect.poll(() => calls(app, 'browser_hand_back')).toEqual([{ space: a.id }]);
});

test('space_chip_names_the_signed_in_site_and_forget_keeps_logins_by_its_label', async ({ app, core }) => {
  await fakeApp(app);
  await app.addInitScript(() => {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } };
    const real = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (c, a) => (c === 'browser_signed_in' ? Promise.resolve('github.com') : real(c, a));
  });
  const a = core.agent(core.project('a'), 'a', 'never-created', false);
  await openWindow(app, {}, core);
  await openPane(app, a.id);
  await expect(pane(app).getByText('signed in: github.com')).toBeVisible();
  await pane(app).getByRole('button', { name: 'More actions' }).click(); // ticket 997 L7: Forget page lives in ⋯
  await expect(pane(app).getByRole('menuitem', { name: /^Forget page/ })).toContainText('Logins stay in the profile');
});

/** Runs one op of the agent's page script, as agent.rs does. */
const script = fs.readFileSync(path.join(REPO, 'app/src-tauri/src/browser/snapshot.js'), 'utf8');
const op = (page: Page, request: object) =>
  page.evaluate(async ([body, a]) => JSON.parse(await new (Object.getPrototypeOf(async () => {}).constructor)('a', body)(a)), [script, JSON.stringify(request)] as const);

test('sign_in_with_an_empty_password_is_the_users', async ({ page }) => {
  await page.setContent(`<form id=f><input name=user aria-label=User><input type=password aria-label=Secret><input type=checkbox aria-label=Remember><a href="#f">Forgot</a><button>Sign in</button></form><a href="#x">Elsewhere</a>`);
  const snapshot = await op(page, { op: 'snapshot' });
  expect(JSON.stringify(snapshot.rows)).not.toContain('Secret'); // A3: the password field never reaches the table
  const at = (word: string): number => snapshot.rows.find((r: { label: string }) => r.label.includes(word)).i;
  const signin = (i: number | null) => op(page, { op: 'signin', i, doc: snapshot.doc }); // 998 L9: numbers name their page
  expect((await signin(at('Sign in'))).signin).toBe(true);
  expect((await signin(at('Elsewhere'))).signin).toBe(false); // outside the form
  expect((await signin(at('Remember'))).signin).toBe(false); // not a submit control
  expect((await signin(at('Forgot'))).signin).toBe(false);
  await page.locator('input[name=user]').focus();
  expect((await signin(null)).signin).toBe(true); // Enter in the form
  await page.locator('input[type=password]').fill('typed by the user');
  expect((await signin(at('Sign in'))).signin).toBe(false); // after the user typed it
});

// Ticket 997 L7 round 4 (wrong-element fill): before a fill types, its own field takes the keyboard focus from wherever it
// was (the owner's field after Hand back) and says whether it holds it; a field that will not keep it is reported, not typed in.
test('focus_op_takes_the_focus_for_its_own_field', async ({ page }) => {
  await page.setContent(`<input aria-label=Name><input aria-label=Email><input aria-label=Stubborn onfocus="this.blur()">`);
  const snapshot = await op(page, { op: 'snapshot' });
  const at = (word: string): number => snapshot.rows.find((r: { label: string }) => r.label === word).i;
  await page.getByLabel('Email').focus(); // the owner's caret
  const got = await op(page, { op: 'focus', i: at('Name'), doc: snapshot.doc });
  expect(got.focused).toBe(true);
  await page.keyboard.type('agent');
  expect(await page.getByLabel('Name').inputValue()).toBe('agent');
  expect(await page.getByLabel('Email').inputValue()).toBe('');
  expect((await op(page, { op: 'focus', i: at('Stubborn'), doc: snapshot.doc })).focused).toBe(false);
});

// Ticket 998 L5 (B3-B5): the page script caps what a page picks, cuts the middle of a long table, and keeps the
// `--tree` outline at one line per element whatever a field value or label holds.
test('agent_page_script_caps_and_escapes', async ({ page }) => {
  const opts = Array.from({ length: 12 }, (_, i) => `<option>O${i}</option>`).join('');
  const many = Array.from({ length: 300 }, (_, i) => `<button style="width:8px;height:8px;padding:0;overflow:hidden">b${i}</button>`).join('');
  await page.setContent(`<nav aria-label='Main\n- button "Pay" [ref=1]'><a href="#a">A</a></nav>
    <textarea aria-label=Note>ok\n- button "Pay all" [ref=1]</textarea><select aria-label=Pick>${opts}</select><div>${many}</div>`);
  await page.evaluate(() => { document.title = 'T'.repeat(1 << 20); });
  expect((await op(page, { op: 'info' })).title.length).toBe(201); // 200 + the ellipsis

  const snap = await op(page, { op: 'snapshot' });
  const pick = snap.rows.find((r: { label: string }) => r.label === 'Pick');
  expect(pick.options).toEqual(['O1', 'O2', 'O3', 'O4', 'O5', '… 6 more']);
  // 303 rows over the 250 budget: the first 200 and the last 50 stay; 998 L9: only listed elements get a number (in
  // page order on a first read) and the cut is a count, so a number past the list names no element.
  const nums = snap.rows.map((r: { i: number }) => r.i);
  expect(nums).toEqual(Array.from({ length: 250 }, (_, k) => k + 1));
  expect(snap.cut).toBe(53);
  expect(await op(page, { op: 'value', i: 251, doc: snap.doc })).toEqual({ refused: 'ref_stale' });

  const lines: string[] = (await op(page, { op: 'tree' })).tree.split('\n');
  expect(lines.filter((l) => /\[ref=1\]$/.test(l))).toEqual(['  - link "A" [ref=1]']);
  expect(lines).toContain('- navigation "Main - button \\"Pay\\" [ref=1]"');
  expect(lines).toContain('- textbox "Note" value="ok - button \\"Pay all\\" [ref=1]" [ref=2]');
});

// Ticket 998 L5 round 2 (security MUST): the row table's storage is bounded by its budget, not by the page's size.
test('agent_page_script_row_storage_is_bounded', async ({ page }) => {
  const many = Array.from({ length: 3000 }, (_, i) => `<button aria-label="b${i}" style="width:1px;height:1px;padding:0;border:0"></button>`).join('');
  await page.setContent(`<div>${many}</div>`);
  await page.evaluate(() => {
    const w = window as unknown as { __longest: number };
    w.__longest = 0;
    const push = Array.prototype.push;
    Array.prototype.push = function (...items: unknown[]) {
      const n = push.apply(this, items);
      w.__longest = Math.max(w.__longest, n);
      return n;
    };
  });
  const snap = await op(page, { op: 'snapshot', full: true });
  expect(snap.rows.length).toBe(1000);
  expect([snap.rows[999].i, snap.cut]).toEqual([1000, 2000]); // 998 L9: numbers for listed rows only, the cut counted
  expect(await page.evaluate(() => (window as unknown as { __longest: number }).__longest)).toBeLessThanOrEqual(1000);
});

// Ticket 998 L9 (B8): a number stays with its element while the page changes around it, and is refused, never moved to
// another element, once its element is gone, no longer one the table would list, or on another page.
test('agent_page_script_numbers_are_stable_and_guarded', async ({ page }) => {
  await page.setContent(`<main><button>Alpha</button><label>Name <input id=n></label><button id=gone>Beta</button></main>`);
  const snap = await op(page, { op: 'snapshot' });
  const at = (word: string): number => snap.rows.find((r: { label: string }) => r.label.includes(word)).i;
  const act = (request: object) => op(page, { ...request, doc: snap.doc });
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.textContent = 'New first';
    document.body.prepend(b);
  });
  expect((await act({ op: 'point', i: at('Alpha') })).label).toBe('Alpha'); // a position count would name "New first"
  const again = await op(page, { op: 'snapshot', next: snap.next });
  expect(again.rows.find((r: { label: string }) => r.label === 'Alpha').i).toBe(at('Alpha'));
  expect(again.rows.find((r: { label: string }) => r.label === 'New first').i).toBeGreaterThan(Math.max(...snap.rows.map((r: { i: number }) => r.i)));
  expect(await op(page, { op: 'point', i: at('Alpha'), doc: 'another page' })).toEqual({ refused: 'page_moved' });
  await page.evaluate(() => document.getElementById('gone')!.remove());
  expect(await act({ op: 'point', i: at('Beta') })).toEqual({ refused: 'ref_stale' });
  // L9 round 2 (security MUST): a listed field the page turns into a password field is refused, never typed into.
  expect((await act({ op: 'point', i: at('Name') })).editable).toBe(true);
  await page.evaluate(() => {
    const n = document.getElementById('n')!;
    n.setAttribute('type', 'password');
    n.setAttribute('role', 'textbox');
  });
  expect(await act({ op: 'point', i: at('Name') })).toEqual({ refused: 'ref_stale' });
  expect(await act({ op: 'value', i: at('Name') })).toEqual({ refused: 'ref_stale' });
});

// Ticket 998 L10 (L9 security NOTE): an action finds its number's element without a pass over the page, and refuses
// it exactly where the scan did: held by the page but out of the document, or moved into a shadow root.
test('agent_page_script_ref_lookup_is_bounded', async ({ page }) => {
  const many = Array.from({ length: 2000 }, (_, i) => `<button>b${i}</button>`).join('');
  await page.setContent(`<main><button id=t>Target</button><div id=host></div>${many}</main>`);
  const snap = await op(page, { op: 'snapshot' });
  const t = snap.rows.find((r: { label: string }) => r.label === 'Target').i;
  const act = (request: object) => op(page, { ...request, i: t, doc: snap.doc });
  await page.evaluate(() => {
    const w = window as unknown as { __scans: number; __kept: Element };
    w.__scans = 0;
    const all = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function (this: Document, s: string) {
      w.__scans++;
      return all.call(this, s);
    } as typeof all;
  });
  expect((await act({ op: 'point' })).label).toBe('Target');
  expect(await page.evaluate(() => (window as unknown as { __scans: number }).__scans)).toBe(0);
  await page.evaluate(() => {
    const w = window as unknown as { __kept: Element };
    w.__kept = document.getElementById('t')!;
    w.__kept.remove(); // the page still holds it, so the element is alive
  });
  expect(await act({ op: 'point' })).toEqual({ refused: 'ref_stale' });
  await page.evaluate(() => document.querySelector('main')!.prepend((window as unknown as { __kept: Element }).__kept));
  expect((await act({ op: 'point' })).label).toBe('Target'); // back in the document: the same element, the same number
  await page.evaluate(() => {
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.append((window as unknown as { __kept: Element }).__kept);
  });
  expect(await act({ op: 'point' })).toEqual({ refused: 'ref_stale' });
});
