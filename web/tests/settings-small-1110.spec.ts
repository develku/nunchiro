// Settings small 11-10: small Settings defects from the 11-10 web suite triage and real-app checks. The About version
// line keeps a gap after its label; the Keyboard page's key slots give a 24 px target; the theme search draws the
// standard focus ring.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const page = async (app: Page, name: string) => {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name, exact: true }).click();
  await expect(app.locator('.settings header.phd h1')).toHaveText(name);
};

test('about_version_gap: the version value sits one gap (--sp-8) after the "Version" label, not against it', async ({ app }) => {
  await openWindow(app);
  await page(app, 'About');
  const row = app.locator('.srow[data-row="buildInfo"]');
  await expect(row.locator('.sver')).toBeVisible();
  const m = await row.evaluate((r) => {
    const value = r.querySelector('.sver')!;
    // The label's own text: the text node just before the value, measured by a Range (it has no box of its own).
    const text = value.previousSibling!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-8'));
    return { label: text.textContent, gap, measured: value.getBoundingClientRect().left - range.getBoundingClientRect().right };
  });
  expect(m.label).toBe('Version');
  expect(m.gap).toBe(8);
  expect(m.measured).toBeCloseTo(m.gap, 0);
});

test('keys_slot_target: every key slot on Settings > Keyboard is at least 24x24, the prefix row included', async ({ app }) => {
  await openWindow(app);
  await page(app, 'Keyboard');
  const slots = app.locator('.kslot');
  await expect(slots.first()).toBeVisible();
  const small = await slots.evaluateAll((all) =>
    all
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.width && r.height && (r.width < 24 || r.height < 24))
      .map(({ e, r }) => `${e.closest('.kpfx') ? 'prefix' : 'list'} "${e.textContent}" ${r.width}x${r.height}`),
  );
  expect(small).toEqual([]);
  await expect(app.locator('.kpfx .kslot').first()).toBeVisible();
});

test('theme_search_ring: the theme search box draws the standard 2px focus ring outside, in the focus-ring colour', async ({ app }) => {
  await openWindow(app);
  await page(app, 'Appearance');
  const box = app.getByRole('searchbox', { name: 'Search themes' });
  await box.focus();
  const s = await box.evaluate((e) => {
    const c = getComputedStyle(e);
    // The token resolved to a colour the way the browser writes one, inside Settings (ticket 1041 lane 8: there the ring
    // is the neutral --ring-focus).
    const probe = document.createElement('i');
    probe.style.color = 'var(--focus-ring)';
    e.closest('.settings')!.append(probe);
    const ring = getComputedStyle(probe).color;
    probe.remove();
    return { style: c.outlineStyle, width: c.outlineWidth, offset: parseFloat(c.outlineOffset), color: c.outlineColor, ring };
  });
  expect(s.style).toBe('solid');
  expect(s.width).toBe('2px');
  expect(s.offset).toBeGreaterThanOrEqual(0);
  expect(s.color).toBe(s.ring);
});
