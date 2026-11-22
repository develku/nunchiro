// Ticket 408 follow-up: with no free spot touching a target (every spot off screen), a label fell back to the target's
// top-left pulled on screen, over the control's first character. The last resort now leaves that character readable.
import { expect, openWindow, test } from './fixtures';

test('last_resort_keeps_first_letter: a control past every screen edge keeps its label beside its first letter', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  // One control larger than the window on every side: every spot on or beside it is off screen, so placement falls back.
  // Its text starts a few pixels in from the window's corner, where the old fallback put the label.
  await app.evaluate(() => {
    // A role=button div: a <button> centres its text, and this one's text must sit at the top.
    const b = document.createElement('div');
    b.setAttribute('role', 'button');
    b.tabIndex = 0;
    b.id = 'huge';
    b.textContent = 'Xylophone';
    Object.assign(b.style, { position: 'fixed', left: '-10px', top: '-10px', width: 'calc(100vw + 20px)', height: 'calc(100vh + 20px)', zIndex: '2147483000', padding: '12px 0 0 16px', margin: '0', border: '0', textAlign: 'left', verticalAlign: 'top', display: 'block', font: '14px system-ui' });
    document.body.append(b);
  });
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyF');
  await expect(app.locator('.hint[data-kind="element"]').first()).toBeVisible();
  const r = await app.evaluate(() => {
    const el = document.getElementById('huge')!;
    const all = (window as unknown as { __hintTargets: { el?: Element; label: string }[] }).__hintTargets;
    const label = all.find((h) => h.el === el)?.label ?? null;
    const hint = [...document.querySelectorAll<HTMLElement>('.hint[data-kind="element"]')].find((h) => h.dataset.hint === label);
    const n = el.firstChild!;
    const range = document.createRange();
    range.setStart(n, 0);
    range.setEnd(n, 1);
    const g = range.getBoundingClientRect();
    const h = hint?.getBoundingClientRect();
    return {
      label,
      count: all.length,
      glyph: { x: g.left, y: g.top, w: g.width, h: g.height },
      hint: h ? { x: h.left, y: h.top, w: h.width, h: h.height } : null,
    };
  });
  // The control is the only target the user can see, and it keeps its label.
  expect(r.count).toBe(1);
  expect(r.label).not.toBeNull();
  expect(r.hint).not.toBeNull();
  const { glyph: g, hint: h } = r as { glyph: typeof r.glyph; hint: NonNullable<typeof r.hint> };
  // The setup reaches the fallback's old spot: the window's top-left corner would cover the first letter.
  expect(g.x).toBeLessThan(h.w);
  expect(g.y).toBeLessThan(h.h);
  // On screen, and clear of the first letter.
  expect(h.x).toBeGreaterThanOrEqual(0);
  expect(h.y).toBeGreaterThanOrEqual(0);
  const meets = h.x < g.x + g.w && g.x < h.x + h.w && h.y < g.y + g.h && g.y < h.y + h.h;
  expect(meets, `label ${r.label} at ${h.x},${h.y} covers the first letter at ${g.x},${g.y}`).toBe(false);
});

test('last_resort_icon_unchanged: an icon button past every screen edge keeps the top-left placement, pulled on screen', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  // The same oversized control with an icon and no text: it has no first character, so the last resort is the old one.
  await app.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'huge-icon';
    b.setAttribute('aria-label', 'Huge icon');
    b.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg>';
    Object.assign(b.style, { position: 'fixed', left: '-10px', top: '-10px', width: 'calc(100vw + 20px)', height: 'calc(100vh + 20px)', zIndex: '2147483000', padding: '0', margin: '0', border: '0' });
    document.body.append(b);
  });
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyF');
  await expect(app.locator('.hint[data-kind="element"]').first()).toBeVisible();
  const r = await app.evaluate(() => {
    const el = document.getElementById('huge-icon')!;
    const all = (window as unknown as { __hintTargets: { el?: Element; label: string }[] }).__hintTargets;
    const label = all.find((h) => h.el === el)?.label ?? null;
    const hint = [...document.querySelectorAll<HTMLElement>('.hint[data-kind="element"]')].find((h) => h.dataset.hint === label);
    const h = hint?.getBoundingClientRect();
    return { label, count: all.length, hint: h ? { x: h.left, y: h.top } : null };
  });
  expect(r.count).toBe(1);
  expect(r.label).not.toBeNull();
  // The target's top-left (-10, -10) pulled on screen: the window's corner.
  expect(r.hint).toEqual({ x: 0, y: 0 });
});
