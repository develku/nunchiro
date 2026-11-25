// needs 168 (plan strip): the session's newest plan (Claude TodoWrite, Codex update_plan) as a strip above the composer,
// folded to one 28 px line and expandable. A real core and a fake Claude / Codex; the strip reads the events already loaded.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO, codexFake } from './fixtures';
import { append, chat, expect, openChat, rec, test, type ChatCore } from './fixtures/chat/harness';

const OUT = path.join(REPO, '.scratch/plan-strip');
const strip = (page: Page, id: string) => chat(page, id).locator('[data-plan-strip]');
const head = (page: Page, id: string) => strip(page, id).getByRole('button').first();

const SEVEN: [string, string, string?][] = [
  ['Read the brief', 'completed'],
  ['Write the plan model', 'completed'],
  ['Write the strip', 'completed'],
  ['Wire the strip into the chat', 'in_progress', 'Wiring the strip into the chat'],
  ['Take the screenshots', 'pending'],
  ['Run the gate', 'pending'],
  ['Write the report', 'pending'],
];
const todos = (items: [string, string, string?][]) => ({ todos: items.map(([content, status, activeForm]) => ({ content, status, activeForm: activeForm ?? content })) });

/** A Claude chat with one turn written, so the composer sits in its zone below the chat column. */
async function claude(core: ChatCore, label = 'plan') {
  const s = core.chat(label, true, false, 'plans'); // ticket 570: one project, so the tabs share a strip
  append(s.file, rec.user('go'), rec.assistant('on it'));
  return s;
}

test('plan_strip_folded_line: after a Claude TodoWrite the page has one strip reading 3/7 · <step> in a 28 px line above the composer', async ({ page, chatCore }) => {
  const s = await claude(chatCore);
  await openChat(page, s.id);
  await expect(strip(page, s.id)).toHaveCount(0);
  append(s.file, rec.use('p1', 'TodoWrite', todos(SEVEN)));
  await expect(strip(page, s.id)).toHaveCount(1);
  await expect(head(page, s.id)).toHaveText('3/7 · Wiring the strip into the chat');
  await expect(strip(page, s.id)).toHaveAttribute('role', 'region');
  await expect(page.getByRole('region', { name: 'Plan' })).toHaveCount(1);
  await expect(head(page, s.id)).toHaveAttribute('aria-expanded', 'false');
  const box = (await strip(page, s.id).boundingBox())!;
  expect(Math.round(box.height)).toBe(28);
  const composer = (await page.locator('.composer').first().boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(composer.y);
  // A newer plan replaces it; everything done reads "7/7 · done".
  append(s.file, rec.use('p2', 'TodoWrite', todos(SEVEN.map(([c, , a]) => [c, 'completed', a] as [string, string, string?]))));
  await expect(head(page, s.id)).toHaveText('7/7 · done');
  await expect(strip(page, s.id)).toHaveCount(1);
});

// A fake Codex names its rollout to the core through its own hook token, as the real agent's SessionStart does.
const BIN = path.join(REPO, 'target/debug/nunchiro');
const fakeCodex = (home: string) => `#!/bin/sh
if [ "$1" = --version ]; then echo 'codex-cli 0.161.0'; exit; fi
printf 'fake codex\\r\\n'
n=0
until '${BIN}' hook SessionStart < "${home}/codex-next.json" >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 100 ] && break; sleep 0.05; done
while IFS= read -r line; do [ "$line" = EXIT ] && exit 0; done
`;
function codex(core: ChatCore) {
  const id = '11111111-0000-4000-8000-000000000168';
  const dir = path.join(core.home, 'codex-home/sessions/2026/11/01');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-01T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, '');
  fs.writeFileSync(path.join(core.home, 'codex-next.json'), JSON.stringify({ thread_id: id, transcript_path: file }));
  fs.writeFileSync(path.join(core.home, 'bin/codex'), codexFake(fakeCodex(core.home)), { mode: 0o700 });
  const s = core.cli('session', 'start', '--kind', 'codex', '--project', core.project('codex-plan'), '--label', 'codex-plan').session as { id: string; cwd: string };
  append(file, { type: 'session_meta', payload: { id, cwd: s.cwd } });
  return { ...s, file };
}

test('plan_strip_folded_line (Codex): an update_plan call reads the same way', async ({ page, chatCore }) => {
  const s = codex(chatCore);
  append(s.file, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } });
  append(s.file, {
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: 'plan-1',
      name: 'update_plan',
      arguments: JSON.stringify({ plan: [{ step: 'Read', status: 'completed' }, { step: 'Edit the file', status: 'in_progress' }, { step: 'Test', status: 'pending' }] }),
    },
  });
  await openChat(page, s.id);
  await expect(head(page, s.id)).toHaveText('1/3 · Edit the file');
  expect(Math.round((await strip(page, s.id).boundingBox())!.height)).toBe(28);
});

test('plan_strip_expands: click, Enter and Space toggle it, the list shows seven items with three status icons, Esc collapses and keeps focus, a tab switch keeps it open', async ({ page, chatCore }) => {
  const s = await claude(chatCore, 'one');
  const other = chatCore.chat('two', true, false, 'plans');
  append(other.file, rec.user('hi'), rec.assistant('hello'));
  append(s.file, rec.use('p1', 'TodoWrite', todos(SEVEN)));
  await openChat(page, s.id);
  const h = head(page, s.id);
  const items = strip(page, s.id).locator('ol > li');
  await expect(items).toHaveCount(0);
  await h.click();
  await expect(h).toHaveAttribute('aria-expanded', 'true');
  await expect(items).toHaveCount(7);
  await expect(items.locator('xpath=self::*[@data-status="completed"]')).toHaveCount(3);
  await expect(items.locator('xpath=self::*[@data-status="in_progress"]')).toHaveCount(1);
  await expect(items.locator('xpath=self::*[@data-status="pending"]')).toHaveCount(3);
  await expect(strip(page, s.id).locator('li[data-status="completed"] svg[data-icon="check-circle"]')).toHaveCount(3);
  await expect(strip(page, s.id).locator('li[data-status="in_progress"] svg[data-icon="work"]')).toHaveCount(1);
  await expect(strip(page, s.id).locator('li[data-status="pending"] svg[data-icon="circle"]')).toHaveCount(3);
  await expect(items.nth(0)).toHaveText('Read the brief');
  // The current item takes the header's weight.
  const weight = (l: ReturnType<typeof items.nth>) => l.evaluate((e) => getComputedStyle(e).fontWeight);
  expect(await weight(items.nth(3))).toBe(await h.evaluate((e) => getComputedStyle(e).fontWeight));
  expect(await weight(items.nth(0))).not.toBe(await weight(items.nth(3)));
  await h.click();
  await expect(h).toHaveAttribute('aria-expanded', 'false');
  await expect(items).toHaveCount(0);
  // Keyboard: Enter and Space on the focused header.
  await h.focus();
  await page.keyboard.press('Enter');
  await expect(h).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Space');
  await expect(h).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Space');
  await expect(h).toHaveAttribute('aria-expanded', 'true');
  // Esc inside the expanded strip collapses it and keeps focus on the header.
  await page.keyboard.press('Escape');
  await expect(h).toHaveAttribute('aria-expanded', 'false');
  await expect(h).toBeFocused();
  // The expansion belongs to the session: away and back, it is still open.
  await h.click();
  await expect(items).toHaveCount(7);
  await page.locator(`.tab[data-tab="${other.id}"]`).click();
  await expect(chat(page, other.id)).toBeVisible();
  await expect(page.locator('[data-plan-strip]:visible')).toHaveCount(0);
  await page.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect(head(page, s.id)).toHaveAttribute('aria-expanded', 'true');
  await expect(items).toHaveCount(7);
});

test('plan_strip_hidden_without_plan: no plan call, or a newest call with an empty list, renders no strip and takes no height', async ({ page, chatCore }) => {
  const none = await claude(chatCore, 'none');
  const cleared = await claude(chatCore, 'cleared');
  append(cleared.file, rec.use('p1', 'TodoWrite', todos(SEVEN)));
  await openChat(page, none.id);
  await expect(strip(page, none.id)).toHaveCount(0);
  const feed = (id: string) => chat(page, id).locator('.cscroll');
  const before = (await feed(none.id).boundingBox())!.height;
  await page.locator(`.tab[data-tab="${cleared.id}"]`).click();
  await expect(head(page, cleared.id)).toHaveText('3/7 · Wiring the strip into the chat');
  const withPlan = (await feed(cleared.id).boundingBox())!.height;
  expect(withPlan).toBeLessThan(before - 20); // the strip takes its line from the feed
  append(cleared.file, rec.use('p2', 'TodoWrite', todos([])));
  await expect(strip(page, cleared.id)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Plan' })).toHaveCount(0);
  expect((await feed(cleared.id).boundingBox())!.height).toBeCloseTo(before, 0); // nothing left in its place
});

test('plan_strip_composer_does_not_move: the composer box is the same before the strip, with it, and expanded', async ({ page, chatCore }) => {
  const s = await claude(chatCore);
  await openChat(page, s.id);
  const composer = page.locator('.composer').first();
  await expect(composer).toBeVisible();
  const at = async () => (await composer.boundingBox())!;
  const a = await at();
  append(s.file, rec.use('p1', 'TodoWrite', todos(SEVEN)));
  await expect(head(page, s.id)).toBeVisible();
  const b = await at();
  await head(page, s.id).click();
  await expect(strip(page, s.id).locator('ol > li')).toHaveCount(7);
  const c = await at();
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(b[k] - a[k]), `folded ${k}`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(c[k] - a[k]), `expanded ${k}`).toBeLessThanOrEqual(0.5);
  }
  // Expanded, the strip stays above the composer.
  const box = (await strip(page, s.id).boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(c.y);
});

test('plan_strip_no_child_list_and_no_colour_misuse: plan items only, and neither the orange nor the red token anywhere in it', async ({ page, chatCore }) => {
  const s = await claude(chatCore);
  append(s.file, rec.use('p1', 'TodoWrite', todos(SEVEN)), rec.use('k1', 'Task', { description: 'a child agent', prompt: 'do it' }));
  await openChat(page, s.id);
  await head(page, s.id).click();
  const items = strip(page, s.id).locator('ol > li');
  await expect(items).toHaveCount(7);
  await expect(strip(page, s.id)).not.toContainText('a child agent');
  const used = await strip(page, s.id).evaluate((root) => {
    const probe = document.createElement('i');
    document.body.append(probe);
    const resolve = (v: string) => ((probe.style.color = `var(${v})`), getComputedStyle(probe).color);
    const banned = [resolve('--you'), resolve('--bad')];
    probe.remove();
    const colours = new Set<string>();
    for (const e of [root, ...root.querySelectorAll('*')]) {
      const c = getComputedStyle(e);
      for (const v of [c.color, c.backgroundColor, c.borderTopColor, c.borderBottomColor, c.outlineColor, c.fill, c.stroke]) colours.add(v);
    }
    return { banned, colours: [...colours] };
  });
  for (const b of used.banned) expect(used.colours).not.toContain(b);
});

test('plan_strip_text_is_inert: markup and Markdown in a plan item render as literal text', async ({ page, chatCore }) => {
  const s = await claude(chatCore);
  const evil = '<img src=x onerror="window.__plan_xss=1"> and **bold**';
  append(s.file, rec.use('p1', 'TodoWrite', todos([[evil, 'in_progress'], ['<b>x</b>', 'pending']])));
  await openChat(page, s.id);
  await head(page, s.id).click();
  const items = strip(page, s.id).locator('ol > li');
  await expect(items.nth(0)).toHaveText(evil);
  await expect(items.nth(1)).toHaveText('<b>x</b>');
  await expect(strip(page, s.id).locator('img, b, strong')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __plan_xss?: number }).__plan_xss)).toBeUndefined();
});

test('plan_strip_screenshots: folded and expanded, light and dark, at 1440x900', async ({ page, chatCore }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const s = await claude(chatCore);
  append(s.file, rec.assistant('Here is the plan. I am wiring the strip into the chat view now.'), rec.use('p1', 'TodoWrite', todos(SEVEN)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChat(page, s.id);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const h = head(page, s.id);
    if ((await h.getAttribute('aria-expanded')) === 'true') await h.click();
    await expect(strip(page, s.id).locator('ol')).toHaveCount(0);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, `folded-${scheme}.png`) });
    await h.click();
    await expect(strip(page, s.id).locator('ol > li')).toHaveCount(7);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, `expanded-${scheme}.png`) });
  }
  for (const f of ['folded-light', 'folded-dark', 'expanded-light', 'expanded-dark']) {
    const file = path.join(OUT, `${f}.png`);
    expect(fs.existsSync(file), file).toBe(true);
    expect(fs.statSync(file).size, file).toBeGreaterThan(10_000);
  }
});

// v25-area-chat r3 review SHOULD (ticket 198): the folded line cuts a long step, and the tooltip holds the step whole.
test('plan_step_tooltip: a truncated plan step carries its whole text as the tooltip, and the app tooltip shows it on hover', async ({ page, chatCore }) => {
  const s = await claude(chatCore);
  const long = `Wiring the strip into the chat column ${'and checking every width down to the narrowest '.repeat(5)}once more`;
  append(s.file, rec.use('p1', 'TodoWrite', todos([['Read the brief', 'completed'], [long, 'in_progress', long], ['Run the gate', 'pending']])));
  await openChat(page, s.id);
  const step = strip(page, s.id).locator('.pt');
  await expect(step).toHaveText(`1/3 · ${long}`);
  expect(await step.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true); // cut
  await expect(step).toHaveAttribute('data-tip', long);
  await step.hover();
  await expect(page.locator('#app-tip')).toBeVisible();
  await expect(page.locator('#app-tip')).toHaveText(long);
});
