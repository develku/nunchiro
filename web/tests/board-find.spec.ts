// V2.5-60 (ticket 219, needs 178 lane L10): the "Hide idle" chip (B14), the board search field and the searchable
// project picker (C7b). Real core, board.json seeded with manual cards; project, note come through the snapshot overlay.
import { expect, test, type Core } from './fixtures';
import type { Page } from '@playwright/test';
import { cardOf, openBoard, overlay, seed } from './fixtures/board/coord';
import { defaultView, parseView, RIGHT } from '../src/board/views';
import { NO_FILTERS, type Card } from '../src/board/model';
import { matchesQuery } from '../src/board/tasks';
// The node runner has no import.meta.glob, so the merged catalogue holds no area: read the area file itself.
import * as card from '../src/i18n/areas/board-card';

const titles = (app: Page) => app.locator('.board .bcard .btt').allInnerTexts().then((l) => l.sort());

const FOUR = [
  { id: 'i1', title: 'Reconnect', column: 'working', moved: 14 },
  { id: 'i2', title: 'Fresh', column: 'working', moved: 9 },
  { id: 'i3', title: 'Backlog', column: 'todo', moved: 60 },
  { id: 'i4', title: 'Shipped', column: 'done', moved: 60 },
];

test('board_hide_idle_chip_off_by_default_and_filters: the chip hides exactly the cards that carry the stale badge, by click and by key', async ({ app, core }) => {
  seed(core, FOUR);
  const board = await openBoard(app, core);
  const chip = board.locator('.bstrip').getByRole('button', { name: /^Hide idle/ });
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => titles(app)).toEqual(['Backlog', 'Fresh', 'Reconnect', 'Shipped']);
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  // Idle is the stale badge's rule (needs 155): To do and Done never go stale, so only the 14 min Working card goes.
  await expect.poll(() => titles(app)).toEqual(['Backlog', 'Fresh', 'Shipped']);
  await chip.click();
  await expect.poll(() => titles(app)).toEqual(['Backlog', 'Fresh', 'Reconnect', 'Shipped']);
  // Keyboard path: Enter and Space on the focused chip toggle it.
  await chip.focus();
  await app.keyboard.press('Enter');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await app.keyboard.press('Space');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => titles(app)).toEqual(['Backlog', 'Fresh', 'Reconnect', 'Shipped']);
});

test('board_hide_idle_keeps_stale_badge: chip off keeps the badge; with the stale chip also on no card shows (hide wins)', async ({ app, core }) => {
  seed(core, FOUR);
  const board = await openBoard(app, core);
  await expect(cardOf(app, 'Reconnect').locator('.bstale')).toHaveText('stale 14 min');
  const chip = (name: string) => board.locator('.bstrip').getByRole('button', { name: new RegExp(`^${name}`) });
  await chip('stale').click();
  await expect.poll(() => titles(app)).toEqual(['Reconnect']);
  await chip('Hide idle').click();
  await expect.poll(() => titles(app)).toEqual([]);
  await expect(board.locator('.bcard')).toHaveCount(0);
});

test('board_hide_idle_survives_reload: the chip is part of the saved view; a view saved before it reads off', async ({ app, core }) => {
  seed(core, FOUR);
  const board = await openBoard(app, core);
  await board.locator('.bstrip').getByRole('button', { name: /^Hide idle/ }).click();
  await expect.poll(() => titles(app)).toEqual(['Backlog', 'Fresh', 'Shipped']);
  await app.reload();
  const again = app.locator('.board'); // the board is in front after the reload: no rail button to press
  await expect(again).toBeVisible();
  await expect(again.locator('.bstrip').getByRole('button', { name: /^Hide idle/ })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => titles(app)).toEqual(['Backlog', 'Fresh', 'Shipped']);
  // Pure: an old saved view has no hideIdle (reads false); a wrong type reads false too; true is kept.
  const old = JSON.stringify({ lane: 'group', filters: { you: true, role: [], stale: false, missing: false }, fields: {}, density: 'cards' });
  expect(parseView(old, 'centre').filters).toEqual({ ...NO_FILTERS, you: true, hideIdle: false });
  expect(parseView(JSON.stringify({ filters: { hideIdle: 'yes' } }), 'centre').filters.hideIdle).toBe(false);
  expect(parseView(JSON.stringify({ filters: { hideIdle: true } }), 'centre').filters.hideIdle).toBe(true);
  expect(defaultView(RIGHT).filters.hideIdle).toBe(false);
});

// ---- C7b-1: the board search field -------------------------------------------------------------------------------

/** Five cards, each findable by one field only: title, note, ref, group, project folder (note and project come over the wire). */
const FIELDS = [
  { id: 'f1', title: 'Reconnect socket', column: 'todo' },
  { id: 'f2', title: 'Plain two', column: 'todo' },
  { id: 'f3', title: 'Plain three', column: 'working', ref: 'TKT-4242' },
  { id: 'f4', title: 'Plain four', column: 'working', group: 'Orbit' },
  { id: 'f5', title: 'Plain five', column: 'review' },
];
const extras: Record<string, Partial<Card>> = { f2: { note: 'remember the Zebra-Note' }, f5: { project: '/fixture/Quokka-Service' } };
const withExtras = (b: Record<string, unknown>) => ({ ...b, cards: (b.cards as Card[]).map((c) => ({ ...c, ...extras[c.id] })) });

test('board_search_filters_cards: title, note, ref, group and project folder each narrow cards and the summary; Esc and the clear button restore; not saved', async ({ app, core }) => {
  seed(core, FIELDS);
  await overlay(app, { board: withExtras });
  const board = await openBoard(app, core);
  const search = board.getByRole('textbox', { name: 'Search cards' });
  const summary = board.locator('.bsummary');
  await expect(summary).toHaveText('Board · 5 cards');
  await expect(search).toHaveAttribute('placeholder', 'Search cards');
  await expect(board.getByRole('button', { name: 'Clear search' })).toHaveCount(0);
  // Each field, with the case flipped, narrows to its one card.
  for (const [query, only] of [['RECONNECT', 'Reconnect socket'], ['zebra-note', 'Plain two'], ['tkt-4242', 'Plain three'], ['ORBIT', 'Plain four'], ['quokka-service', 'Plain five']] as const) {
    await search.fill(query);
    await expect.poll(() => titles(app), query).toEqual([only]);
    await expect(summary).toHaveText('Board · 1 card');
  }
  // The project's folder name matches, not its parent directory.
  await search.fill('fixture');
  await expect.poll(() => titles(app)).toEqual([]);
  // A query that matches nothing shows an empty board, no error.
  await search.fill('no such thing');
  await expect(board.locator('.bcard')).toHaveCount(0);
  await expect(summary).toHaveText('Board · 0 cards');
  await expect(board.locator('.bmsg')).toHaveText('');
  // The clear button clears and returns focus to the field.
  await board.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(summary).toHaveText('Board · 5 cards');
  await expect(board.getByRole('button', { name: 'Clear search' })).toHaveCount(0);
  // Esc clears too and keeps focus in the field.
  await search.fill('plain');
  await expect(summary).toHaveText('Board · 4 cards');
  await app.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(summary).toHaveText('Board · 5 cards');
  // Transient window state: not in the saved view, gone after a reload.
  await search.fill('orbit');
  const saved = await app.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('nunchiro.board')).map(([, v]) => v).join('|'));
  expect(saved).toContain('"lane"'); // the view is stored ...
  expect(saved).not.toContain('orbit'); // ... without the query
  await app.reload();
  await expect(app.locator('.board')).toBeVisible();
  await expect(app.locator('.board').getByRole('textbox', { name: 'Search cards' })).toHaveValue('');
  await expect.poll(() => titles(app)).toHaveLength(5);
});

test('board_search_follows_chips_and_project: the query narrows after the chips; the narrow list header keeps the field inside its row', async ({ app, core }) => {
  seed(core, FOUR.map((c) => ({ ...c, title: `${c.title} job` })));
  const board = await openBoard(app, core);
  await board.getByRole('textbox', { name: 'Search cards' }).fill('job');
  await expect.poll(() => titles(app)).toHaveLength(4);
  await board.locator('.bstrip').getByRole('button', { name: /^Hide idle/ }).click();
  await expect.poll(() => titles(app)).toEqual(['Backlog job', 'Fresh job', 'Shipped job']);
  await expect(board.locator('.bsummary')).toHaveText('Board · 3 cards');
  // One-line list density at the right bar's narrowest width (208 px): the field is in the header row and shrinks.
  await board.getByRole('button', { name: 'Edit board widget' }).click();
  await app.getByRole('dialog', { name: 'Edit board widget' }).getByRole('group', { name: 'Show as' }).getByRole('button', { name: 'one-line list' }).click();
  await app.getByRole('dialog', { name: 'Edit board widget' }).getByRole('button', { name: 'Done', exact: true }).click();
  await board.evaluate((el) => ((el as HTMLElement).style.cssText = 'flex: none; width: 208px'));
  const search = board.getByRole('textbox', { name: 'Search cards' });
  await expect(search).toBeVisible();
  const [head, box] = [(await board.locator('.bhead').boundingBox())!, (await search.locator('..').boundingBox())!]; // the field's box: input plus its padding and border
  expect(box.width).toBeGreaterThanOrEqual(48);
  expect(box.x + box.width).toBeLessThanOrEqual(head.x + head.width);
  expect(await board.locator('.bhead').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await search.fill('shipped');
  await expect(board.locator('.bli .bltt')).toHaveText(['Shipped job']);
});

test('board_search_matcher: matchesQuery is case-insensitive over title, note, ref, group and the project folder name only', () => {
  const card = { title: 'Fix Login', note: 'ask Dana', ref: 'V2.5-60', group: 'Orbit', project: '/work/Quokka-Service/' } as Card;
  for (const q of ['fix login', 'DANA', 'v2.5-60', 'orbit', 'quokka', '  orbit  ', '']) expect(matchesQuery(card, q), q).toBe(true);
  for (const q of ['work', 'zzz', 'Quokka-Service/']) expect(matchesQuery(card, q), q).toBe(false);
  // Fields the card does not carry (an integration card) do not throw and do not match.
  expect(matchesQuery({ title: 'Bare' } as Card, 'orbit')).toBe(false);
  expect(matchesQuery({ title: 'Bare' } as Card, 'bare')).toBe(true);
});

// ---- C7b-2: the searchable project picker ------------------------------------------------------------------------

const PROJECTS: Record<string, string> = { p1: '/fixture/alpha-app', p2: '/fixture/alpha-app', p3: '/fixture/beta-api', p4: '/fixture/beta-api', p5: '/other/gamma-ui' };
const PICK = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id) => ({ id, title: `Card ${id}`, column: 'todo' }));
const withProjects = (b: Record<string, unknown>) => ({ ...b, cards: (b.cards as Card[]).map((c) => ({ ...c, project: PROJECTS[c.id] ?? null })) });
const options = (app: Page) => app.getByRole('listbox').getByRole('option').allInnerTexts();

async function pickerBoard(app: Page, core: Core) {
  seed(core, PICK);
  await overlay(app, { board: withProjects });
  const board = await openBoard(app, core);
  const trigger = board.locator('button.bproj');
  await expect(board.locator('.bsummary')).toHaveText('Board · 6 cards');
  return { board, trigger, input: app.getByRole('textbox', { name: 'Find project' }) };
}

test('board_project_picker_is_searchable: All projects first, typing narrows by basename and by full path, a pick narrows the board', async ({ app, core }) => {
  const { board, trigger, input } = await pickerBoard(app, core);
  await expect(trigger).toHaveText('All projects');
  await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => options(app)).toEqual(['All projects', 'alpha-app', 'beta-api', 'gamma-ui']);
  // The full path is on hover where the name is cut.
  await expect(app.getByRole('option', { name: 'beta-api' })).toHaveAttribute('title', '/fixture/beta-api');
  await input.fill('BETA');
  await expect.poll(() => options(app)).toEqual(['beta-api']);
  await input.fill('other/gamma');
  await expect.poll(() => options(app)).toEqual(['gamma-ui']);
  await input.fill('fixture');
  await expect.poll(() => options(app)).toEqual(['alpha-app', 'beta-api']);
  await input.fill('zzz');
  await expect(app.getByRole('option')).toHaveCount(0);
  await expect(app.getByRole('listbox')).toContainText('No project matches');
  // A click picks: the board narrows to that project and the trigger reads its basename.
  await input.fill('');
  await app.getByRole('option', { name: 'beta-api' }).click();
  await expect(app.getByRole('listbox')).toHaveCount(0);
  await expect(trigger).toHaveText('beta-api');
  await expect(board.locator('.bsummary')).toHaveText('Board · 2 cards');
  await expect.poll(() => titles(app)).toEqual(['Card p3', 'Card p4']);
  // The chosen option is marked; All projects resets.
  await trigger.click();
  await expect(app.getByRole('option', { name: 'beta-api' })).toHaveAttribute('aria-selected', 'true');
  await expect(app.getByRole('option', { name: 'All projects' })).toHaveAttribute('aria-selected', 'false');
  await app.getByRole('option', { name: 'All projects' }).click();
  await expect(trigger).toHaveText('All projects');
  await expect(board.locator('.bsummary')).toHaveText('Board · 6 cards');
});

test('board_project_picker_keyboard_and_focus: input takes focus; arrows wrap, Home/End jump, Enter picks, Esc returns focus, an outside press closes; names on every part', async ({ app, core }) => {
  const { board, trigger, input } = await pickerBoard(app, core);
  const open = async () => (await trigger.click(), await expect(input).toBeFocused());
  await open();
  // Names (needs 172): the trigger, the field, the list and every option.
  await expect(trigger).toHaveAccessibleName(/Project.*All projects/);
  await expect(app.getByRole('listbox', { name: 'Project filter' })).toBeVisible();
  for (const o of await app.getByRole('option').all()) expect(await o.getAttribute('title') ?? (await o.innerText())).toBeTruthy();
  await expect(app.getByRole('option', { name: 'All projects' })).toBeVisible();
  // ArrowDown, then Enter: the second option; focus goes back to the trigger.
  await app.keyboard.press('ArrowDown');
  await app.keyboard.press('Enter');
  await expect(trigger).toHaveText('alpha-app');
  await expect(trigger).toBeFocused();
  await expect(board.locator('.bsummary')).toHaveText('Board · 2 cards');
  // ArrowUp from the top wraps to the last; Home and End jump.
  await trigger.click();
  await expect(input).toBeFocused();
  await app.keyboard.press('Home');
  await app.keyboard.press('ArrowUp');
  await app.keyboard.press('Enter');
  await expect(trigger).toHaveText('gamma-ui');
  await open();
  await app.keyboard.press('End');
  await app.keyboard.press('ArrowDown'); // wraps to the first: All projects
  await app.keyboard.press('Enter');
  await expect(trigger).toHaveText('All projects');
  await open();
  await app.keyboard.press('End');
  await app.keyboard.press('Enter');
  await expect(trigger).toHaveText('gamma-ui');
  // Typing highlights the first match, so Enter picks it.
  await open();
  await input.fill('beta');
  await app.keyboard.press('Enter');
  await expect(trigger).toHaveText('beta-api');
  // Esc closes without picking and returns focus to the trigger.
  await open();
  await input.fill('alpha');
  await app.keyboard.press('Escape');
  await expect(app.getByRole('listbox')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText('beta-api');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  // A pointer-down outside closes without picking and does not steal focus from where the user pressed.
  await open();
  await board.getByRole('textbox', { name: 'Search cards' }).click();
  await expect(app.getByRole('listbox')).toHaveCount(0);
  await expect(board.getByRole('textbox', { name: 'Search cards' })).toBeFocused();
  await expect(trigger).toHaveText('beta-api');
});

// Ticket 219 SHOULD 2: Tab out of the open picker closes it, like Esc and an outside press; focus moves on, nothing is picked.
test('board_project_picker_closes_on_tab_out', async ({ app, core, browserName }) => {
  const { trigger, input } = await pickerBoard(app, core);
  const alt = browserName === 'webkit' ? 'Alt+' : ''; // WebKit's Tab skips buttons, as Safari's does ("Tab to links" off; ticket 531)
  const tabOut = async (key: string) => {
    await trigger.click();
    await expect(input).toBeFocused();
    await input.fill('beta');
    await app.keyboard.press(key);
    await expect(app.getByRole('listbox')).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toHaveText('All projects'); // the highlighted match was not picked
  };
  // Ticket 533: plain Tab and Shift+Tab close the list in both engines; only where focus lands needs Alt+ on WebKit.
  await tabOut('Tab');
  await tabOut('Shift+Tab');
  await tabOut(`${alt}Tab`); // focus goes on to the next control, not to the page
  expect(await app.evaluate(() => !!document.activeElement?.closest('.board') && !document.activeElement.closest('.bprojw'))).toBe(true);
  await tabOut(`Shift+${alt}Tab`); // back to the trigger
  await expect(trigger).toBeFocused();
});

test('board_new_strings_8_languages: the six keys of this lane exist in all eight languages and none is empty; English says what the brief fixed', () => {
  const KEYS = ['board.filter.hideIdle', 'board.search.label', 'board.search.placeholder', 'board.search.clear', 'board.project.find', 'board.project.none'];
  const en: Record<string, string> = card.en;
  expect(KEYS.map((k) => en[k])).toEqual(['Hide idle', 'Search cards', 'Search cards', 'Clear search', 'Find project', 'No project matches']);
  const langs = { en: card.en, ko: card.ko, ja: card.ja, zhHans: card.zhHans, zhHant: card.zhHant, es: card.es, fr: card.fr, pt: card.pt } as Record<string, Record<string, string>>;
  expect(Object.keys(langs)).toHaveLength(8);
  for (const [lang, table] of Object.entries(langs)) for (const k of KEYS) expect(table[k]?.trim(), `${lang} ${k}`).toBeTruthy();
});
