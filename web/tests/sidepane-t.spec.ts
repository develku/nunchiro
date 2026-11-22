// V2.5-82 (v25-sidepane-t): the agent's side pane follows the window language. Its Browser space switcher (hover name, space names,
// "shown in another pane" reason) and the pane's own plain UI text were English whatever the language: SidePane mounted the
// switcher with no translator. Agent output and terminal content stay as they are (the PTY tag is a technical name).
// The disabled reason needs a second switcher on a space; the shipped layout never mounts one beside the pane, so
// tests/feature-fixtures/sidepane-t-taken.tsx (suite only) mounts a hidden one on "My browser".
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';
import { injectPending, item } from './agent-pane';
import { TABLES } from './i18n-tables';

const LANGUAGES = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const;
const OTHERS = LANGUAGES.filter((l) => l !== 'en');
const t = (lang: string, key: string, args: Record<string, string> = {}) =>
  Object.entries(args).reduce((s, [k, v]) => s.replace(`{${k}}`, v), (TABLES as Record<string, Record<string, string>>)[lang][key]);
const agent = (core: Core, label: string) => core.agent(core.project(label), label, 'never-created', false);

type Seed = { taken?: boolean; splits?: Record<string, unknown> };
/** A window in `language` with the agent's tab focused and its side pane open on the Browser tab (or the PTY, the pane's default). */
async function browserPane(app: Page, core: Core, language: string, a: { id: string }, seed: Seed = {}, tab: 'pty' | 'browser' = 'browser') {
  await app.addInitScript(
    ([l, s]) => {
      const k = 'nunchiro.settings.v1';
      localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), language: l }));
      if (s.taken) (window as { __NUNCHIRO_SIDEPANE_TAKEN__?: boolean }).__NUNCHIRO_SIDEPANE_TAKEN__ = true;
      if (s.splits) localStorage.setItem('nunchiro.splits.v1', JSON.stringify(s.splits));
    },
    [language, seed] as const,
  );
  await openAgent(app, core, language, a);
  await app.locator('#icon-terminal').click();
  if (tab === 'browser') await app.locator('#icon-browser').click();
  return app.locator('[data-side-pane]:not([hidden])');
}
async function openAgent(app: Page, core: Core, language: string, a: { id: string }) {
  await app.goto('/');
  await expect(app.locator('html')).toHaveAttribute('lang', language);
  const running = (core.cli('snapshot', '--json').sessions as { state: string }[]).filter((s) => s.state === 'running').length;
  await expect(app.locator('.tab[data-tab]')).toHaveCount(running);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
}

test('sidepane_switcher_translated_ko: hover name, space names and disabled reason are Korean', async ({ app, core }) => {
  const a = agent(core, 'planner');
  const pane = await browserPane(app, core, 'ko', a, { taken: true });
  const switcher = pane.getByLabel('브라우저 공간');
  await expect(switcher).toHaveAttribute('data-tip', '브라우저 공간');
  await expect(switcher.locator('option')).toHaveText(['내 브라우저 - 다른 패널에 표시 중', 'planner (에이전트)']);
  await expect(switcher.locator('option[value="you"]')).toBeDisabled();
  await switcher.hover();
  await expect(app.getByRole('tooltip')).toHaveText('브라우저 공간');
  await app.screenshot({ path: '../.scratch/sidepane-t-ko.png' }); // REPORT ## Shots
});

for (const lang of OTHERS)
  test(`sidepane_switcher_translated_all: ${lang}`, async ({ app, core }) => {
    const a = agent(core, 'planner');
    const pane = await browserPane(app, core, lang, a, { taken: true });
    const switcher = pane.getByLabel(t(lang, 'exitWidgets.spaces'));
    await expect(switcher).toHaveAttribute('data-tip', t(lang, 'exitWidgets.spaces'));
    await expect(switcher.locator('option')).toHaveText([
      t(lang, 'spaceSwitchFu.shownElsewhere', { name: t(lang, 'exitWidgets.myBrowser') }),
      t(lang, 'exitWidgets.agentSpace', { name: 'planner' }),
    ]);
    await expect(switcher.locator('option[value="you"]')).toBeDisabled();
    await switcher.hover();
    await expect(app.getByRole('tooltip')).toHaveText(t(lang, 'exitWidgets.spaces'));
  });

test('sidepane_switcher_english_unchanged', async ({ app, core }) => {
  const a = agent(core, 'planner');
  const pane = await browserPane(app, core, 'en', a, { taken: true });
  const switcher = pane.getByLabel('Browser space');
  await expect(switcher).toHaveAttribute('data-tip', 'Browser space');
  await expect(switcher.locator('option')).toHaveText(['My browser - shown in another pane', 'planner (agent)']);
  await expect(switcher.locator('option[value="you"]')).toBeDisabled();
});

// Step 3: the pane's other plain UI text. Each string is read in every language against the catalogue; the English strings are
// pinned by agent-pane.spec.ts, splits.spec.ts and agent-pane-badge.spec.ts, which stay unchanged.
for (const lang of LANGUAGES)
  test(`sidepane_extra_strings_translated: ${lang}`, async ({ app, core }) => {
    const a = agent(core, 'a');
    const state = await injectPending(app);
    const pane = await browserPane(app, core, lang, a, { splits: { [a.id]: [{ id: 's1', side: 'right', what: 'terminal' }] } }, 'pty');
    // Region, divider (label and title) and the slim row's tablist; the PTY tab and its view say the terminal is in a split.
    await expect(pane).toHaveAttribute('aria-label', t(lang, 'sidePane.region'));
    const divider = app.locator('[data-pane-divider]');
    await expect(divider).toHaveAttribute('aria-label', t(lang, 'sidePane.resize'));
    await expect(divider).toHaveAttribute('title', t(lang, 'sidePane.resizeTip'));
    await expect(pane.getByRole('tablist')).toHaveAttribute('aria-label', t(lang, 'sidePane.terminals'));
    await expect(pane.getByRole('tab').first()).toContainText(t(lang, 'sidePane.inSplit'));
    await expect(pane.locator('.empty')).toHaveText(t(lang, 'sidePane.termInSplit'));
    // A blocked screen the chat cannot draw.
    state.items[a.id] = [item(a.id, 'dialog', ['screen'])];
    state.push();
    await expect(pane.locator('.need')).toHaveText(t(lang, 'sidePane.needsInput'));
  });

test('sidepane_extra_strings_translated: a shell tab closes with a translated name (ko)', async ({ app, core }) => {
  const a = agent(core, 'a');
  const pane = await browserPane(app, core, 'ko', a);
  await app.keyboard.press('Meta+KeyK'); // the palette's own name is Korean; the command title is not translated yet (REPORT)
  await app.getByRole('dialog', { name: t('ko', 'palette.dialog') }).getByRole('combobox').fill('New shell in the side pane');
  await app.keyboard.press('Enter');
  const tab = pane.getByRole('tab').filter({ hasText: 'shell' });
  await expect(tab).toBeVisible();
  const name = await tab.innerText();
  await expect(pane.getByRole('button', { name: t('ko', 'sidePane.closeShell', { name }) })).toBeVisible();
});

test('sidepane_extra_strings_translated: the selection button reads Korean', async ({ app, core }) => {
  const a = agent(core, 'a');
  const pane = await browserPane(app, core, 'ko', a, {}, 'pty');
  await expect.poll(() => app.locator(`.term[data-session="${a.id}"] .xterm-rows`).innerText()).toContain('fake agent ready');
  await app.evaluate((id) => (window as unknown as { __terminals?: Map<string, { selectAll(): void }> }).__terminals?.get(id)?.selectAll(), a.id);
  const b = (await app.locator(`.term[data-session="${a.id}"] .xterm-rows`).boundingBox())!;
  await app.mouse.move(b.x + 2, b.y + 4);
  await app.mouse.down();
  await app.mouse.move(b.x + 120, b.y + 4, { steps: 5 });
  await app.mouse.up();
  await expect(pane.getByRole('button', { name: t('ko', 'sidePane.insert') })).toBeVisible();
});
