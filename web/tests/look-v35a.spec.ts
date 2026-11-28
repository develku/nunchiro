// Look v35 a (S3-1 to S3-5, ticket 1041 A+B+C, docs/design/polish-1121): no outlined boxes on the Add project wizard,
// the Stop confirm, the status-bar Undo and the "+" popover's key hints; the rail icon menu; a split's focus ring on Tab only.
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, REPO, test } from './fixtures';

// Shots for the lane report, light and dark; SHOT_TAG=before on the old code.
const shot = async (app: Page, name: string) => {
  if (test.info().project.name !== 'chromium') return;
  await app.screenshot({ path: path.join(REPO, '.scratch/shots', `v35a-${process.env.SHOT_TAG ?? 'after'}-${name}-${test.info().titlePath.at(-2)}.png`) });
};
/** The control's border and fill, and the quiet tint the polish gives a secondary control (tokens.css --control-quiet-bg). */
const look = (l: Locator) =>
  l.evaluate((e) => {
    const probe = document.body.appendChild(document.createElement('i'));
    probe.style.background = 'var(--control-quiet-bg)';
    const quiet = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const cs = getComputedStyle(e);
    // No outline: no border width, or a clear one. Since #69 the controls have `border: 0`, so the colour is currentColor.
    const outline = parseFloat(cs.borderTopWidth) > 0 ? cs.borderTopColor : 'rgba(0, 0, 0, 0)';
    return { border: outline, fill: cs.backgroundColor, quiet };
  });
const NONE = 'rgba(0, 0, 0, 0)';
const quiet = async (l: Locator) => {
  const k = await look(l);
  expect(k.border).toBe(NONE);
  expect(k.fill).toBe(k.quiet);
};

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test('add_project_and_stop_confirm_are_quiet: option rows, Cancel and the Stop confirm Cancel carry no outline', async ({ app, core }) => {
      await openWindow(app);
      await app.locator('.pane .empty').getByRole('button', { name: 'Add project', exact: true }).click();
      const dlg = app.getByRole('dialog', { name: 'Add project', exact: true });
      await expect(dlg).toBeVisible();
      await app.mouse.move(0, 0);
      await shot(app, 'addproject');
      for (const name of [/^Browse folder/, /^Create new/, /^Clone/, /^Cancel$/]) await quiet(dlg.getByRole('button', { name }));
      await expect(dlg.getByRole('button', { name: /^Browse folder/ })).toContainText('Enter'); // the key hint stays
      await dlg.getByRole('button', { name: 'Cancel' }).click();

      const agent = core.agent(core.project('demo'), 'agent', 'never').id;
      await expect(app.locator(`.tab[data-tab="${agent}"]`)).toBeVisible();
      await app.locator(`.tab[data-tab="${agent}"]`).click({ button: 'right' });
      await app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: 'Stop this session' }).click();
      const ask = app.getByRole('alertdialog', { name: 'Stop agent?' });
      await expect(ask).toBeVisible();
      await shot(app, 'stopconfirm');
      await quiet(ask.getByRole('button', { name: 'Cancel' }));
      const stop = await look(ask.getByRole('button', { name: 'Stop' }));
      expect(stop.fill).not.toBe(stop.quiet); // the one main action keeps the ink fill
      await ask.getByRole('button', { name: 'Cancel' }).click();
    });

    test('undo_line_is_quiet: the status bar Undo is a tint button and its key hint plain text', async ({ app, core }) => {
      const p = core.project('demo');
      const [, b] = ['one', 'two'].map((l) => core.shell(p, l).id);
      await openWindow(app);
      const tab = app.locator(`.tab[data-tab="${b}"]`);
      await tab.click();
      await tab.locator('..').getByRole('button', { name: /^Close tab/ }).click();
      const line = app.locator('footer.status .undoline');
      await expect(line).toContainText('tab closed');
      await app.mouse.move(700, 400);
      await shot(app, 'undo');
      const undo = line.getByRole('button', { name: /^Undo/ });
      await quiet(undo);
      const key = undo.locator('.kbd');
      await expect(key).toHaveText('⌘Z'); // the key hint stays
      expect(await key.evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe('0px');
    });

    test('plus_popover_key_hints_are_plain: the "+" popover keys are muted text with no keycap box, as the palette draws them', async ({ app, core }) => {
      core.shell(core.project('demo'), 'one');
      await openWindow(app);
      await app.getByRole('button', { name: 'New session', exact: true }).click();
      const pop = app.locator('.newtab');
      const keys = pop.locator('.nt-row .kbd');
      await expect(keys.first()).toBeVisible();
      await shot(app, 'plus');
      expect(await keys.count()).toBeGreaterThan(0); // every key hint stays
      for (const k of await keys.all()) {
        const cs = await k.evaluate((e) => {
          const c = getComputedStyle(e);
          const m = document.body.appendChild(document.createElement('i'));
          m.style.color = 'var(--muted)';
          const muted = getComputedStyle(m).color;
          m.remove();
          return { width: c.borderTopWidth, bottom: c.borderBottomWidth, fill: c.backgroundColor, color: c.color, muted };
        });
        expect(cs).toMatchObject({ width: '0px', bottom: '0px', fill: NONE, color: cs.muted });
      }
    });

    test('split_focus_mark_is_a_head_tint: the split holding focus, by keys or click, tints its head; no ring or edges', async ({ app, core }) => {
      const a = core.agent(core.project('agents'), 'a', 'never-created');
      await openWindow(app, {}, core);
      await app.locator(`.tab[data-tab="${a.id}"]`).click();
      await app.locator('.cbox textarea').focus();
      await app.keyboard.press('Meta+KeyD');
      const chooser = app.getByRole('listbox', { name: 'Open in this split' });
      await expect(chooser.getByRole('option').first()).toBeFocused();
      await shot(app, 'split-cmdd');
      const split = app.locator('[data-split-id]');
      const mark = () =>
        split.evaluate((e) => ({
          head: getComputedStyle(e.querySelector('.sph')!).backgroundImage,
          ring: getComputedStyle(e).boxShadow,
          after: getComputedStyle(e, '::after').boxShadow,
        }));
      const on = { ring: 'none', after: 'none', head: expect.stringContaining('gradient') };
      await expect.poll(mark).toMatchObject(on);
      await app.keyboard.press('ArrowDown'); // a key walk inside it: the same mark, it never blinks
      await expect(chooser.getByRole('option').nth(1)).toBeFocused();
      await expect.poll(mark).toMatchObject(on);
      await shot(app, 'split-key');
      await split.locator('.sph b').click(); // the pointer focuses the split itself: the same mark
      await expect(split).toBeFocused();
      await expect.poll(mark).toMatchObject(on);
      await shot(app, 'split-click');
      await app.locator('.cbox textarea').focus(); // focus leaves the split: no mark
      await expect.poll(mark).toMatchObject({ ring: 'none', after: 'none', head: 'none' });
    });
  });
}
