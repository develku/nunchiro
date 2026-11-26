// Ticket 468 + 542 (scorecard D5): every text-like input, textarea and select has the app's one field look, the settings
// kit's (final.html .inp, styles.css "one text field look"), so none is left browser-default or styled its own way. Each
// screen and dialog with such a control is opened in dark and light; every visible one is compared with a bare reference
// input on the same page: border, radius, background, text colour and font. A field drawn by its wrapper (the input bare
// inside a stepper or a search box with its icon) is compared through that wrapper. A scan test makes the next
// `<textarea` or `<select` name the step that walks it.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { BUILTIN_PAGES } from '../src/features/builtin';
import { expect, openWindow, REPO, test } from './fixtures';
import { openSettings } from './settings-modal';
import { icon } from './d5b';
import { cardOf, seed } from './fixtures/board/coord';
import { fakes, gitRepo, PERMISSION, show } from './decision-rows-seed';

const SCHEMES = ['dark', 'light'] as const;

/** Controls that are designed on purpose, not text fields of the kit. Each needs a reason; anything else conforms. */
const EXCEPTIONS: { selector: string; reason: string; skip?: string[] }[] = [
  { selector: '.cbox textarea', reason: 'the chat composer is the one designed input: its own font and no border (claude-feel-2 .cmp)' },
  { selector: '.spill select, .bfc select', reason: 'a filter chip (Search Sessions, Board): the pill draws the control and its 12 px radius, the select is bare inside' },
  { selector: '.histv-sel select', reason: 'History\'s project list (lane w59, the approved mockup docs/design/history-1121 `.sel`): the box draws the control and its words, the native list lies over it unseen' },
  { selector: '.wtdlg .wtfld input, .wtdlg textarea', skip: ['size'], reason: 'the New worktree dialog keeps the approved WTDIALOGS mockup field size (12 px, pixel-tested in fidelity-worktree); every other property is compared' },
  { selector: '.palette.glass > input', reason: 'the command palette\'s search line (ticket 1041 lane 6, polish-1121 mockup `.pal`): a borderless 15 px line on the glass, the palette\'s own designed input' },
  { selector: '.newbot .nb-name, .newbot .nb-job', reason: 'the New bot and Hand to a bot dialogs keep the fields of the approved mockup docs/design/bots-1166.html (panel 3 `.bare`, `.area`): a bare 20 px name and a borderless box one tint step up' },
  { selector: '.xterm-helper-textarea', reason: 'the terminal library\'s off-screen keyboard sink: it takes the keys, it is never a field the user sees' },
];

type Look = { radius: string; bg: string; border: string; color: string; family: string; size: string };

/** Runs in the page: the settings kit's text field (`input.sinp` in the Settings region), the reference look for this scheme. */
const reference = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('input');
    probe.className = 'sinp';
    document.querySelector('.settings[role="region"]')!.append(probe); // not in a card: a card draws its rows' dividers
    const ref = getComputedStyle(probe);
    const look = { radius: ref.borderTopLeftRadius, bg: ref.backgroundColor, border: `${ref.borderTopWidth} ${ref.borderTopStyle} ${ref.borderTopColor}`, color: ref.color, family: ref.fontFamily, size: ref.fontSize };
    probe.remove();
    return look;
  });

/** Runs in the page: one line per input whose look differs from the reference field. */
const offenders = (page: Page, where: string, want: Look) =>
  page.evaluate(([where, want, exceptions]) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const TEXT = "input:not([type='checkbox'], [type='radio'], [type='range'], [type='file'], [type='hidden'], [type='color'], [type='button'], [type='submit'], [type='reset'], [type='image']), textarea, select";
    const MONO = /SF Mono|Menlo|monospace/;
    const path = (el: Element) => {
      const parts: string[] = [];
      for (let e: Element | null = el; e && e !== document.body && parts.length < 4; e = e.parentElement)
        parts.unshift(e.tagName.toLowerCase() + [...e.classList].map((c) => `.${c}`).join(''));
      return parts.join('>');
    };
    const out: string[] = [];
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>(TEXT))) {
      const skip = exceptions.filter((x) => input.matches(x.selector));
      if (skip.some((x) => !x.skip)) continue; // a whole exception
      const skipped = skip.flatMap((x) => x.skip!);
      const r = input.getBoundingClientRect();
      const st = getComputedStyle(input);
      if (r.width === 0 || r.height === 0 || st.visibility === 'hidden') continue;
      // A bare input inside a wrapper that draws the field: the wrapper carries the look.
      let box: Element = input;
      if (st.borderTopWidth === '0px' && st.backgroundColor === 'rgba(0, 0, 0, 0)')
        for (let a = input.parentElement; a; a = a.parentElement)
          if (getComputedStyle(a).borderTopWidth !== '0px') {
            box = a;
            break;
          }
      const b = getComputedStyle(box);
      const got = { radius: b.borderTopLeftRadius, bg: b.backgroundColor, border: `${b.borderTopWidth} ${b.borderTopStyle} ${b.borderTopColor}`, color: st.color, family: st.fontFamily, size: st.fontSize };
      const mono = MONO.test(got.family);
      const bad = [
        // WebKit reports 5px for the radius of a select that keeps its native arrow (appearance auto), whatever the page sets.
        got.radius !== want.radius && !(input.tagName === 'SELECT' && st.appearance !== 'none' && got.radius === '5px') && `radius ${got.radius}`,
        got.bg !== want.bg && `background ${got.bg}`,
        // A refused value draws its border in the error colour on purpose.
        input.getAttribute('aria-invalid') !== 'true' && got.border !== want.border && `border ${got.border}`,
        // A read-only or disabled value is dimmed on purpose.
        !input.readOnly && !input.disabled && got.color !== want.color && `color ${got.color}`,
        // Code values (paths, commands, keys) use the mono family at 12 px; everything else the UI font at the field size.
        !mono && got.family !== want.family && `font ${got.family}`,
        (mono ? got.size !== '12px' && got.size !== want.size : got.size !== want.size) && `size ${got.size}`,
      ].filter((b) => b && !skipped.some((k) => (b as string).startsWith(k)));
      if (bad.length) out.push(`${where}: ${path(input)}${box === input ? '' : ` (box ${path(box)})`} ${bad.join(', ')}`);
    }
    return out;
  }, [where, want, EXCEPTIONS] as const);

async function settingsPages(app: Page, found: string[]) {
  await openSettings(app);
  const want = await reference(app);
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  for (const id of [...BUILTIN_PAGES, 'extensions']) {
    await nav.locator(`button[data-page="${id}"]`).click();
    await expect(app.locator('.spage h1').first()).toBeVisible();
    // Closed folds hold inputs too (Terminal > Look > Advanced): open every one.
    await app.evaluate(() => document.querySelectorAll('.sbody details').forEach((d) => ((d as HTMLDetailsElement).open = true)));
    if (id === 'extensions') await expect(app.locator('form.ext-add input').first()).toBeVisible(); // the MCP form
    // The custom provider form holds a command textarea.
    if (id === 'providers') await app.getByRole('button', { name: 'Enter manually' }).click();
    found.push(...(await offenders(app, `settings ${id}`, want)));
    // A shipped skill's files open in a textarea.
    if (id === 'extensions') {
      await app.getByRole('button', { name: 'View the files of Nunchiro skill' }).click();
      await expect(app.locator('.extv-pane textarea')).toBeVisible();
      found.push(...(await offenders(app, 'settings extension file', want)));
    }
  }
  await app.getByRole('button', { name: 'Close Settings' }).click();
  return want;
}

for (const scheme of SCHEMES)
  test(`inputs_one_style ${scheme}: every text input, textarea and select on settings, board, search and pairing has the kit's field look`, async ({ app, core, browser }) => {
    test.setTimeout(120_000);
    core.shell(core.project('demo'), 'one');
    seed(core, [{ id: 'c1', title: 'A card', column: 'todo' }]);
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app);
    const found: string[] = [];
    const want = await settingsPages(app, found);

    await icon(app, 'left', 'Search').click();
    await expect(app.locator('aside.sbar[data-side="left"] .sbh b')).toHaveText('Search');
    found.push(...(await offenders(app, 'search', want)));
    await app.getByRole('radio', { name: 'Sessions' }).click();
    await expect(app.locator('.sfilt select').first()).toBeVisible();
    found.push(...(await offenders(app, 'search sessions', want)));

    // Ticket 993: the Schedules widget's form, with its date field too.
    await app.locator('#icon-schedules').click();
    await app.locator('.schedv .schedv-add').click();
    await expect(app.locator('.schedv .sched-form textarea')).toBeVisible();
    found.push(...(await offenders(app, 'schedules widget', want)));
    await app.locator('.schedv .sched-form input[name="sched-mode"][value="once"]').check();
    found.push(...(await offenders(app, 'schedules widget once', want)));
    await app.locator('#icon-schedules').click();

    await app.getByRole('button', { name: /^Board/ }).first().click();
    const board = app.locator('.board');
    await expect(board).toBeVisible();
    found.push(...(await offenders(app, 'board', want)));
    await board.getByRole('button', { name: 'Edit board widget' }).click();
    await expect(app.getByRole('dialog', { name: 'Edit board widget' })).toBeVisible();
    found.push(...(await offenders(app, 'board edit', want)));
    await app.keyboard.press('Escape');
    await expect(app.getByRole('dialog', { name: 'Edit board widget' })).toHaveCount(0);
    // Esc also closes the board widget (it is a popover over the page): open it again.
    if (!(await board.isVisible())) await app.getByRole('button', { name: /^Board/ }).first().click();
    await app.mouse.move(2, 2); // the board holds still while the pointer is over it (needs 26)
    await cardOf(app, 'A card').locator('.btt').click();
    await expect(app.getByRole('dialog', { name: 'Edit card' })).toBeVisible();
    found.push(...(await offenders(app, 'card editor', want)));

    // The pairing page a browser sees before it is paired: the core's listener marks its copy of the page (pairing/boot.ts).
    const ctx = await browser.newContext({ colorScheme: scheme });
    const phone = await ctx.newPage();
    await phone.route('**/', async (r) => {
      const res = await r.fetch();
      r.fulfill({ response: res, body: (await res.text()).replace('<head>', '<head><meta name="nunchiro-browser">') });
    });
    await phone.goto(app.url());
    await expect(phone.locator('.pairing input').first()).toBeVisible();
    // The phone page sets its whole text one step larger (pairing.css): its field keeps the look at that size.
    const size = await phone.locator('.pairing').evaluate((e) => getComputedStyle(e).fontSize);
    found.push(...(await offenders(phone, 'pairing', { ...want, size })));
    await ctx.close();

    expect(found).toEqual([]);
  });

// The dialogs and popovers that hold a field and are not on a screen's first view. One real git project with two fake
// agents (decision-rows-seed): one asks for a permission, so the deny instruction and the card note can open.
for (const scheme of SCHEMES)
  test(`inputs_one_style_dialogs ${scheme}: every field in the palette, project, worktree, new session and decision dialogs has the kit's field look`, async ({ app, core }) => {
    test.setTimeout(120_000);
    fakes(core);
    const repo = gitRepo(core, 'repo');
    const agent = core.agent(repo, 'main-a', 'go-a');
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app);
    const found: string[] = [];
    const want = await settingsPages(app, []); // only the reference look; the pages are walked above
    const palette = async (command: string) => {
      await app.keyboard.press('Meta+KeyK');
      const p = app.getByRole('dialog', { name: 'Command palette' });
      await expect(p).toBeVisible();
      if (command === '') return p;
      await p.getByRole('combobox').fill(command);
      await app.keyboard.press('Enter');
    };

    await palette('');
    found.push(...(await offenders(app, 'palette', want)));
    await app.keyboard.press('Escape');

    await palette('Add project');
    await expect(app.getByRole('dialog', { name: 'Add project', exact: true })).toBeVisible();
    await app.getByRole('dialog', { name: 'Add project', exact: true }).getByRole('button', { name: /^Create new/ }).click();
    await expect(app.getByRole('dialog', { name: 'New project' })).toBeVisible();
    found.push(...(await offenders(app, 'new project', want)));
    await app.getByRole('dialog', { name: 'New project' }).getByRole('button', { name: 'Back' }).click();
    await app.getByRole('dialog', { name: 'Add project', exact: true }).getByRole('button', { name: /^Clone/ }).click();
    await expect(app.getByRole('dialog', { name: 'Clone a repository' })).toBeVisible();
    found.push(...(await offenders(app, 'clone', want)));
    await app.keyboard.press('Escape');

    await app.keyboard.press('Meta+KeyK');
    await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.new"]').click();
    await expect(app.getByRole('dialog', { name: 'New tab' })).toBeVisible();
    found.push(...(await offenders(app, 'new session', want)));
    await app.keyboard.press('Escape');

    await app.locator('.grp[data-project="repo"] .row.head').hover();
    await app.getByRole('button', { name: 'New worktree in repo', exact: true }).click();
    const wt = app.getByRole('dialog', { name: 'New worktree', exact: true });
    await expect(wt).toBeVisible();
    await wt.locator('.wtadvanced').click();
    // The prompt box shows once an agent starts with the worktree.
    const start = wt.locator('.wtstart input[type="checkbox"]');
    if (!(await start.isChecked())) await start.check();
    await expect(wt.locator('textarea')).toBeVisible();
    found.push(...(await offenders(app, 'worktree', want)));
    await app.keyboard.press('Escape');

    show(agent.cwd, 'go-a', PERMISSION('touch out-a'));
    const line = app.locator(`.q[data-line="${agent.id}"]`);
    await expect(line).toBeVisible({ timeout: 8000 });
    await line.locator('[data-act="deny"]').click();
    await expect(app.locator('.dn input')).toBeVisible();
    found.push(...(await offenders(app, 'deny instruction', want)));
    await line.locator('[data-act="details"]').click();
    await expect(app.locator('.deccard .dc-note')).toBeVisible();
    found.push(...(await offenders(app, 'decision card note', want)));

    expect(found).toEqual([]);
  });

// The chat surface: the handoff chip's text box opens from View/Edit once a handoff to another agent is picked.
for (const scheme of SCHEMES)
  test(`inputs_one_style_chat ${scheme}: the handoff chip's text box has the kit's field look`, async ({ app, core }) => {
    test.setTimeout(120_000);
    const fixtures = path.join(REPO, 'crates/nunchiro/tests/fixtures');
    fs.copyFileSync(path.join(fixtures, 'claude-picker'), path.join(core.home, 'bin/claude'));
    fs.copyFileSync(path.join(fixtures, 'codex-picker'), path.join(core.home, 'bin/codex'));
    core.cli('session', 'start', '--kind', 'claude', '--project', core.project('demo'), '--label', 'claude');
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app);
    const want = await settingsPages(app, []);
    await app.locator('[data-picker="model"]').click();
    await app.locator('[data-item="more"]').click(); // W35: the hand-off group is under More models ›
    await app.locator('[data-item="handoff-codex"]').click();
    await expect(app.locator('[data-handoff-chip]')).toContainText('prompts');
    await app.getByRole('button', { name: 'View/Edit' }).click();
    await expect(app.getByRole('textbox', { name: 'Handoff text' })).toBeVisible();
    expect(await offenders(app, 'handoff text', want)).toEqual([]);
  });

// The Browser pane (toolbar, the address field) and its annotation notes. The native webview is not there: the Tauri
// bridge is faked as in browser-annotate.spec.ts, and the guest picker's event is fed by hand.
type Bridge = { __cb: Record<number, (e: unknown) => void>; __on: Record<string, number>; __TAURI_INTERNALS__: unknown };
for (const scheme of SCHEMES)
  test(`inputs_one_style_browser ${scheme}: the Browser pane's address field and annotation note have the kit's field look`, async ({ app, core }) => {
    test.setTimeout(120_000);
    await app.addInitScript(() => {
      const w = window as unknown as Bridge;
      w.__cb = {};
      w.__on = {};
      let n = 0;
      w.__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: Record<string, unknown>) => {
          if (cmd === 'plugin:event|listen') w.__on[args.event as string] = args.handler as number;
          // Ticket 1038: a page is open (Annotate waits for one).
          if (cmd === 'browser_nav') return Promise.resolve({ url: 'http://127.0.0.1:5731/shop', title: 'Shop', back: false, forward: false, loading: false, progress: 1 });
          return Promise.resolve(cmd === 'plugin:event|listen' ? 1 : null);
        },
        transformCallback: (cb: (e: unknown) => void) => ((w.__cb[++n] = cb), n),
        metadata: {},
      };
    });
    const a = core.agent(core.project('a'), 'a', 'never-created', false);
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app, {}, core);
    const want = await settingsPages(app, []);
    await app.locator(`.tab[data-tab="${a.id}"]`).click();
    await icon(app, 'right', 'Terminal').click();
    await icon(app, 'right', 'Browser').click();
    const pane = app.locator('[data-side-pane]:not([hidden])');
    await expect(pane.getByRole('textbox', { name: 'Address' })).toBeVisible();
    const found = await offenders(app, 'browser pane', want);
    await pane.getByRole('button', { name: 'Annotate' }).click();
    await expect.poll(() => app.evaluate(() => Object.keys((window as unknown as Bridge).__on))).toContain('browser-picked');
    await app.evaluate((space) => {
      const w = window as unknown as Bridge;
      const element = { page: { sanitizedUrl: 'http://127.0.0.1:5731/shop', viewportWidth: 900, viewportHeight: 600 }, target: { tagName: 'button', selector: 'button.buy', textSnippet: 'Buy', rectViewport: { x: 10, y: 20, width: 80, height: 32 } }, nearbyText: [] };
      w.__cb[w.__on['browser-picked']]({ event: 'browser-picked', id: 1, payload: { space, element } });
    }, a.id);
    await expect(pane.getByRole('textbox', { name: 'Note 1' })).toBeVisible();
    found.push(...(await offenders(app, 'annotation note', want)));
    expect(found).toEqual([]);
  });

// Ticket 563: four fields that need data or a paired phone to open: the first-run import search, the PR merge-method select, the
// paired phone's reply box and the Browser pane's profile picker. Each is drawn with the markup its component renders (the
// wrapper classes that carry its own CSS), in the real page with the real stylesheets, and compared like every other field.
// The drift check below fails when a component's field no longer carries the wrapper named here, so a copy cannot go stale.
const UNOPENED: { file: string; wrapper: string; html: string }[] = [
  { file: 'firstrun/ImportStep.tsx', wrapper: 'className="fr-import-search"', html: '<div class="fr-import-search"><input aria-label="probe import" /></div>' },
  { file: 'pr/PrView.tsx', wrapper: 'className="pr-merge"', html: '<div class="pr-merge"><select aria-label="probe merge"><option>Merge commit</option></select></div>' },
  { file: 'pairing/BrowserApp.tsx', wrapper: 'className="browser-reply"', html: '<main class="browser-app"><form class="browser-reply"><label>Reply <textarea rows="2"></textarea></label></form></main>' },
  { file: 'pane/browser/view/BrowserView.tsx', wrapper: 'className="bprofile"', html: '<div class="bview"><div class="bslot"><div class="empty"><label class="bprofile">Profile <select><option>Default</option></select></label></div></div></div>' },
  { file: 'room/RoomView.tsx', wrapper: 'className="room-composer"', html: '<div class="room-composer"><select aria-label="To"><option>Lead</option></select><select aria-label="Thread"><option>Thread: main</option></select><input aria-label="Message"></div>' },
  { file: 'bots/BotsView.tsx', wrapper: 'className="bot-card" data-bot-soul', html: '<section class="bot-card" data-bot-soul><form><textarea aria-label="probe soul"></textarea></form></section>' },
];
for (const scheme of SCHEMES)
  test(`inputs_one_style_unopened ${scheme}: the import search, merge-method select, phone reply box, profile picker, room composer and bot soul box have the kit's field look`, async ({ app, core, browser }) => {
    test.setTimeout(120_000);
    core.shell(core.project('demo'), 'one');
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app);
    const want = await settingsPages(app, []);
    const found: string[] = [];
    for (const u of UNOPENED.filter((u) => !u.file.startsWith('pairing/'))) {
      await app.evaluate((html) => document.body.insertAdjacentHTML('beforeend', `<div id="probe-563">${html}</div>`), u.html);
      found.push(...(await offenders(app, u.file, want)));
      await app.evaluate(() => document.getElementById('probe-563')!.remove());
    }
    // The paired phone's page: its own browser context, as in inputs_one_style.
    const ctx = await browser.newContext({ colorScheme: scheme });
    const phone = await ctx.newPage();
    await phone.route('**/', async (r) => {
      const res = await r.fetch();
      r.fulfill({ response: res, body: (await res.text()).replace('<head>', '<head><meta name="nunchiro-browser">') });
    });
    await phone.goto(app.url());
    await expect(phone.locator('.pairing input').first()).toBeVisible();
    await phone.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), UNOPENED.find((u) => u.file.startsWith('pairing/'))!.html);
    const size = await phone.locator('.browser-app').evaluate((e) => getComputedStyle(e).fontSize);
    found.push(...(await offenders(phone, 'phone reply box', { ...want, size })));
    await ctx.close();
    expect(found).toEqual([]);
  });

test('inputs_one_style_unopened_drift: each of the six components still draws its field inside the wrapper the probe copies', () => {
  const src = path.join(import.meta.dirname, '../src');
  for (const u of UNOPENED) expect(fs.readFileSync(path.join(src, u.file), 'utf8'), u.file).toContain(u.wrapper);
});

// The next `<textarea` or `<select` cannot be added unnoticed: each file that has one is listed here with the step that
// walks it (or the reason it is not a field of the kit), and the shared rule must name both elements. A file with more
// of them than listed, or an unlisted file, fails.
const WALKED: Record<string, { count: number; by: string }> = {
  'board/CardEditor.tsx': { count: 3, by: 'inputs_one_style: card editor' },
  'bots/BotsView.tsx': { count: 1, by: 'inputs_one_style_unopened: bot soul box (opens on Edit)' },
  'bots/FirstChat.tsx': { count: 1, by: 'the shared :where(textarea) rule; not walked (the SOUL card of a bot\'s first chat opens it on Edit; tests/bots-new.spec.ts first_chat_cards fills it)' },
  'bots/HandBot.tsx': { count: 1, by: 'exception: the Hand to a bot dialog\'s box (EXCEPTIONS); tests/bots-new.spec.ts hand_worktree_to_bot fills it' },
  'bots/NewBot.tsx': { count: 1, by: 'exception: the New bot dialog\'s sentence box (EXCEPTIONS); tests/bots-new.spec.ts new_bot_one_step fills it' },
  'board/EditPanel.tsx': { count: 1, by: 'the shared :where(select) rule; not walked (the Done days select of the board edit panel, ticket 1066; named by its label)' },
  'chat/ComposerWidget.tsx': { count: 1, by: 'exception: the chat composer (EXCEPTIONS)' },
  'chat/HandoffChip.tsx': { count: 1, by: 'inputs_one_style_chat' },
  'features/extension-files.tsx': { count: 1, by: 'inputs_one_style: settings extension file' },
  'features/team.tsx': { count: 1, by: 'the shared :where(textarea) rule; not walked (the Job box opens on Add teammate; tests/team.spec.ts fills it)' },
  'features/setup-scripts.tsx': { count: 1, by: 'the shared :where(textarea) rule; not walked (the script box needs a project chosen in Git & Worktrees, ticket 259)' },
  'features/wt-files.tsx': { count: 1, by: 'the shared :where(textarea) rule; not walked (the sparse-checkout box needs a project chosen in Git & Worktrees)' },
  'history/HistoryView.tsx': { count: 1, by: 'exception: the project filter pill (EXCEPTIONS); tests/history-rail-1029.spec.ts history_filter_row picks from it' },
  'pairing/BrowserApp.tsx': { count: 1, by: 'inputs_one_style_unopened: phone reply box' },
  'pane/browser/annotate/Annotate.tsx': { count: 1, by: 'inputs_one_style_browser: annotation note' },
  'pane/browser/view/BrowserView.tsx': { count: 2, by: 'inputs_one_style_browser: the space picker; inputs_one_style_unopened: the profile picker' },
  'pr/PrView.tsx': { count: 1, by: 'inputs_one_style_unopened: merge-method select' },
  'room/RoomView.tsx': { count: 2, by: 'inputs_one_style_unopened: room composer (ticket 571c)' },
  'schedule/ScheduleForm.tsx': { count: 1, by: 'inputs_one_style: schedules widget (the task box, ticket 981; the selects are the kit Select, ticket 991 C15)' },
  'search/Sessions.tsx': { count: 3, by: 'exception: filter chips (EXCEPTIONS); walked in inputs_one_style: search sessions' },
  'settings/accounts/providers.tsx': { count: 1, by: 'inputs_one_style: settings providers (Enter manually)' },
  'settings/machines/MachinesPage.tsx': { count: 1, by: 'the shared :where(select) rule; not walked (Share this Mac picks a host only when the Mac has more than one, ticket 1050; aria-label machines.shareHost)' },
  'settings/onboarding/OnboardingPage.tsx': { count: 1, by: 'exception: the Quick setup folder select is transparent inside its .ob-sel box, which draws the field and its focus ring (ticket 1123, onboarding.css); tests/first-use-1123.spec.ts walks it' },
  'settings/shell/Row.tsx': { count: 1, by: 'inputs_one_style: every Settings page' },
  'settings/theme/ImportTheme.tsx': { count: 1, by: 'inputs_one_style: settings appearance' },
  'tree/worktrees.tsx': { count: 1, by: 'inputs_one_style_dialogs: worktree' },
};

test('inputs_one_style_scan: every textarea and select in web/src is named, and the shared rule reaches both', () => {
  const src = path.join(import.meta.dirname, '../src');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const have: Record<string, number> = {};
  for (const f of files(src)) {
    const n = (fs.readFileSync(f, 'utf8').match(/<(textarea|select)\b/g) ?? []).length;
    if (n) have[path.relative(src, f)] = n;
  }
  expect(Object.fromEntries(Object.entries(have).map(([f, n]) => [f, n]))).toEqual(Object.fromEntries(Object.entries(WALKED).map(([f, w]) => [f, w.count])));
  const css = fs.readFileSync(path.join(src, 'styles.css'), 'utf8');
  const shared = css.slice(css.indexOf('one text field look'), css.indexOf('button {'));
  expect(shared).toContain(':where(textarea');
  expect(shared).toContain('select');
});
