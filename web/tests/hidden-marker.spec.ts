// V2.5-49 (review SHOULD 1 of v25-decisions-hidden): when `plain()` removed hidden characters from a request, the Decisions
// card says so in one muted line. Display only: the line names the effect, never the removed code points, and the
// answer, the risky rule and the sent index stay the raw item's. The window's snapshot is patched (decision-rows-seed.ts)
// so the item text carries the characters whatever the core's own screen reader keeps.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { behind, fakes, gitRepo, pending, PERMISSION, proxy, QUESTION, show } from './decision-rows-seed';
import { icon, sidebar } from './d5b';
import { makeT } from './i18n-tables';

const HIDDEN = /[‮​\u{e0041}]/u;
const NOTE = 'Hidden characters were removed from this request';
const note = (item: ReturnType<Page['locator']>) => item.locator('.dc-hidden');

type Item = Parameters<Parameters<Awaited<ReturnType<typeof proxy>>['patch']>[0]>[0];
async function open(app: Page, core: Core, cmd: string, edit: (d: Item) => void) {
  fakes(core);
  const p = gitRepo(core, 'repo');
  const a = core.agent(p, 'wt-a', 'go-a', true);
  const px = await proxy(app);
  px.patch((d) => void edit(d));
  await openWindow(app);
  await behind(app, a.id); // ticket 1030: these check the Decisions card
  show(a.cwd, 'go-a', PERMISSION(cmd));
  await expect(app.locator(`.q[data-line="${a.id}"]`)).toBeVisible({ timeout: 8000 });
  await icon(app, 'right', 'Decisions').click();
  const side = sidebar(app, 'right');
  await expect(side).toHaveAttribute('data-widget', 'decisions');
  const item = side.locator('.dc-item').first();
  // The shown item is one the core holds now (a sidebar refit may re-file the prompt under a new id).
  await expect
    .poll(async () => {
      const shown = await item.getAttribute('data-item');
      return pending(core).some((d) => d.id === shown);
    })
    .toBe(true);
  return { item, px };
}

test('card_notes_removed_hidden_chars: a request with a zero-width space and a tag character shows the note and the stripped text', async ({ app, core }) => {
  const { item } = await open(app, core, 'touch out-a', (d) => void (d.text = d.text.replace('out', 'o​ut\u{e0041}')));
  await expect(item.locator('.dc-what')).toContainText('touch out-a');
  await expect(item.locator('.dc-code')).toContainText('touch out-a');
  await expect(note(item)).toHaveText(NOTE);
  if (process.env.HM_SHOTS)
    for (const scheme of ['light', 'dark'] as const) {
      await app.emulateMedia({ colorScheme: scheme });
      await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
      await item.screenshot({ path: `${process.env.HM_SHOTS}/hidden-note-${scheme}.png` });
    }
  // The note names the effect: no removed character and no code-point dump comes back onto the screen.
  const shown = (await item.textContent()) ?? '';
  expect(shown).not.toMatch(HIDDEN);
  expect(shown).not.toMatch(/u\+|\\u|e0041|200b/i);
});

test('card_no_note_for_clean_text: a clean request shows no note, a CRLF line break alone is not a removal', async ({ app, core }) => {
  const { item } = await open(app, core, 'touch out-a', (d) => void (d.text = d.text.replace(/\r?\n/g, '\r\n')));
  await expect(item.locator('.dc-what')).toContainText('touch out-a');
  await expect(note(item)).toHaveCount(0);
});

test('card_note_for_what_line: a right-to-left override only in the what line (JSON-escaped in d.text) shows the note', async ({ app, core }) => {
  // d.text holds the ASCII escape `‮`, so plain(d.text) === d.text; the command the card reads out of it carries U+202E.
  const { item } = await open(app, core, 'touch out-a', (d) => void (d.text = '{"command":"touch o\\u202eut-a"}'));
  await expect(item.locator('.dc-what')).toContainText('touch out-a');
  expect(await item.locator('.dc-what').textContent()).not.toMatch(HIDDEN);
  await expect(note(item)).toHaveText(NOTE);
});

test('hidden_note_is_not_clickable: the note is plain text and a click on it sends nothing', async ({ app, core }) => {
  const { item, px } = await open(app, core, 'touch out-a', (d) => void (d.text = d.text.replace('out', 'o​ut\u{e0041}')));
  const n = note(item);
  await expect(n).toHaveText(NOTE);
  await expect(item.locator('.dc-hidden:is(button, a, [role], [tabindex], [onclick])')).toHaveCount(0);
  expect(await n.evaluate((e) => getComputedStyle(e).cursor)).not.toBe('pointer');
  await n.click();
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
});

test('hidden_note_in_all_languages: the note has a real translation in all 8 languages', () => {
  const en = makeT('en', 'en')('decisions.hiddenRemoved');
  expect(en).toBe(NOTE);
  const seen = new Set<string>();
  for (const l of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const) {
    const text = makeT(l, l)('decisions.hiddenRemoved');
    expect(text.trim(), l).toBeTruthy();
    expect(text, l).not.toBe('decisions.hiddenRemoved');
    if (l !== 'en') expect(text, l).not.toBe(en);
    seen.add(text);
  }
  expect(seen.size).toBe(8);
});

test('card_note_for_choice_label: a hidden character only in a choice label shows the note', async ({ app, core }) => {
  // The request text, what and why are clean (and so is the screen the fake draws): only the label of option 1 in the item carries it.
  fakes(core);
  const p = gitRepo(core, 'repo');
  const a = core.agent(p, 'wt-a', 'go-a', true);
  const px = await proxy(app);
  px.patch((d) => void ((d.choices as { label: string }[])[0].label = 're\u200bd'));
  await openWindow(app);
  await behind(app, a.id); // ticket 1030: these check the Decisions card
  show(a.cwd, 'go-a', QUESTION);
  await expect(app.locator(`.q[data-line="${a.id}"]`)).toBeVisible({ timeout: 8000 });
  await icon(app, 'right', 'Decisions').click();
  const item = sidebar(app, 'right').locator('.dc-item').first();
  await expect(item.locator('[data-n="1"]')).toContainText('red');
  expect(await item.textContent()).not.toMatch(HIDDEN);
  await expect(note(item)).toHaveText(NOTE);
});

test('card_note_for_allow_always: a hidden character only in the always-allow option shows the note', async ({ app, core }) => {
  const { item } = await open(app, core, 'touch out-a', (d) => void (d.allow_always = 'Always al​low'));
  await expect(note(item)).toHaveText(NOTE);
});
