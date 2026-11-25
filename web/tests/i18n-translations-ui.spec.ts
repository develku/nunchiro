import fs from 'node:fs';
import path from 'node:path';
import { stripOnTop, expect, openWindow, REPO, test } from './fixtures';
import { append, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { makeT } from '../src/i18n';

// Needs 93 (Language in Settings) and needs 157 (3) (it lives on General, the first page, as a click-to-pick row): Settings is
// click 1, picking Korean in the Language row is click 2. The old steps clicked radios on a page the nine-page IA dropped.
test('korean_visible: Settings > General > Language changes a visible label in two clicks', async ({ app, core }) => {
  stripOnTop(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('combobox', { name: /Language/ }).selectOption('ko');
  await expect(app.getByRole('combobox', { name: /언어/ })).toHaveValue('ko');
  await expect(app.getByRole('navigation', { name: '설정 페이지' }).getByRole('button', { name: '화면과 테마', exact: true })).toBeVisible();
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
});

for (const language of ['ko', 'ja', 'es'] as const) {
  chatTest(`translation_shots: ${language} Settings, tree and composer`, async ({ page, chatCore }) => {
    chatTest.skip(process.env.V2_14T_SHOTS !== '1', 'Opt in with V2_14T_SHOTS=1');
    const out = path.join(REPO, '.scratch/v2-14t');
    fs.mkdirSync(out, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    const session = chatCore.chat('translation-demo');
    append(session.file, rec.user('Review the language settings.'), rec.assistant('The agent transcript stays in its original language.'));
    await openChat(page, session.id);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Language', exact: true }).click();
    const names = { ko: '한국어', ja: '日本語', es: 'Español' };
    await page.getByRole('radio', { name: names[language] }).check();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await page.screenshot({ path: path.join(out, `${language}-settings-${chatTest.info().project.name}.png`) });
    await page.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs; Esc closes it first
    await page.locator(`.tab[data-tab="${session.id}"]`).click();
    const tree = page.locator('.sbar[data-widget="tree"]');
    if (!(await tree.isVisible())) await page.getByRole('button', { name: makeT(language, 'en')('tree.root'), exact: true }).click();
    await expect(tree).toBeVisible();
    await page.screenshot({ path: path.join(out, `${language}-tree-${chatTest.info().project.name}.png`) });
    await expect(page.locator('.cbox')).toBeVisible();
    await page.locator('.cbox textarea').fill('A draft message — never sent');
    await page.screenshot({ path: path.join(out, `${language}-composer-${chatTest.info().project.name}.png`) });
    // A translated label can overflow (clip) or wrap onto a second line: a .ph row whose controls sit at two tops.
    const overflow = await page.locator('.settings, .sbar[data-widget="tree"], .cbox').evaluateAll((roots) => roots.flatMap((root) => {
      const clipped = [...root.querySelectorAll('button, label, h2')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && el.scrollWidth > el.clientWidth + 1;
        })
        .map((el) => `clip: ${el.textContent?.trim()}`);
      const wrapped = [...root.querySelectorAll('.ph, .cbox .row')]
        .filter((row) => new Set([...row.querySelectorAll('button, label')].map((el) => Math.round(el.getBoundingClientRect().top))).size > 1)
        .map((row) => `wrap: ${row.textContent?.trim()}`);
      return [...clipped, ...wrapped];
    }));
    expect(overflow, `${language} labels fit`).toEqual([]);
    console.log(`${language} overflowing controls: ${JSON.stringify(overflow)}`);
  });
}
