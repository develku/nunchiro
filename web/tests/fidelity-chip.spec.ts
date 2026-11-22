// ticket 95 (fid-63 review SHOULD): the new-session target chip is checked on the rendered page, not by reading App.tsx.
// Expected values are the tokens the chip's rules name (`--fs-11`, `--text`, `--line`), resolved by the browser.
import { expect, openWindow, showComposer, test } from './fixtures';
import { repo } from './visual/compare';

test('new_session_chip_computed_style: the composer target chip draws the token font size, colours and a project icon', async ({ app, core }) => {
  const p = repo(core, 'nunchiro'); // a repository: "main" names its main checkout (a plain folder shows none: no_main_for_a_plain_folder)
  core.shell(p, 'chip-check');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell shows its terminal; its composer is asked for
  const chip = app.locator('.chips .chip').first();
  await expect(chip).toContainText('nunchiro / main'); // needs 130: the mockup's "<project> / <worktree or branch>"
  await expect(chip.locator('svg[data-icon="project"]')).toHaveCount(1);
  const [got, want] = await app.evaluate(() => {
    const el = document.querySelector('.chips .chip') as HTMLElement;
    const probe = document.createElement('div');
    probe.style.cssText = 'color: var(--muted); font-size: var(--fs-11); border-color: transparent'; // ticket 1041: plain muted text, no outline (polish-1121 .where)
    document.body.append(probe);
    const c = getComputedStyle(el);
    const t = getComputedStyle(probe);
    const out = [[c.fontSize, c.color, c.borderTopColor], [t.fontSize, t.color, t.borderTopColor]];
    probe.remove();
    return out;
  });
  expect(got).toEqual(want);
  // shortcut: no `--r-12` token exists (tokens.css is another lane's), so the R8 `.chip` pill radius is the mockup's 12px literal; use the token when one lands.
  await expect(chip).toHaveCSS('border-top-left-radius', '12px');
});
