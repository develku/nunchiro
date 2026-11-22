// Acceptance 13: arrivals during Hangul composition with the pointer over the sidebar move nothing, keep
// focus and the composition, and still show in the tree slots, AGENTS dots and tab dots.
import fs from 'node:fs';
import path from 'node:path';
import { boxes, expect, openWindow, test, unmoved, legacyLayout, showComposer } from './fixtures';
import { openQuiet } from './tree-seed';

test.beforeEach(({ core }) => legacyLayout(core, { strip: 'beside' })); // D5b: the default window has no tree or AGENTS zone; this spec is about zones, so it starts from their old shape
// needs 107 (ticket 180): no strip above the composer; it sits in its own zone right of the terminal, which an arrival never
// resizes, so "only the strip's own box changes" still holds.

for (const strip of ['on', 'off'] as const)
  test(`three arrivals mid-composition move nothing (strip ${strip})`, async ({ app, core, browserName }) => {
    const p = core.project('nunchiro');
    const writer = core.shell(p, 'writer');
    const agents = ['a', 'b', 'c'].map((t) => core.agent(p, `agent-${t}`, `go-${t}`).id);
    if (strip === 'off')
      await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ strip: 'off' })));
    openQuiet(core); // V2-9a: quiet projects start folded
    await openWindow(app);
    await app.locator(`.tab[data-tab="${writer.id}"]`).click();
    await showComposer(app); // V2.5-34: a shell's composer is asked for
    const box = app.locator('.cbox textarea');
    await box.focus();
    const cdp = browserName === 'chromium' ? await app.context().newCDPSession(app) : null;
    await app.keyboard.insertText('답장 ');
    if (cdp) await cdp.send('Input.imeSetComposition', { text: '눈', selectionStart: 1, selectionEnd: 1 });
    const head = app.locator('.grp[data-project="nunchiro"] .head .n');
    await head.hover();
    const at = (await head.boundingBox())!;
    const point = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
    // Mark the element under the pointer; after the arrivals the same element must still be there.
    await app.evaluate(({ x, y }) => ((document.elementFromPoint(x, y) as HTMLElement).dataset.probe = 'under-pointer'), point);
    const before = await boxes(app);
    for (const t of ['go-a', 'go-b', 'go-c']) fs.writeFileSync(path.join(p, t), '');
    for (const id of agents) {
      await expect(app.locator(`[data-agent="${id}"] .st`)).toHaveAttribute('data-s', 'waiting', { timeout: 5000 });
      await expect(app.locator(`.tab[data-tab="${id}"] .tdot`)).toHaveAttribute('data-s', 'waiting');
    }
    await expect(app.locator('.grp[data-project="nunchiro"] .head .chip')).toHaveText('new 3');
    await expect(app.locator('.grp[data-project="nunchiro"]')).toHaveAttribute('data-urgency', 'waiting');
    // V1A-60b (needs 77): with the strip on, only the strip's own box changes as it appears above the composer.
    await expect(app.locator('#waiting-strip .qcard')).toHaveCount(strip === 'on' ? 1 : 0);
    expect(unmoved(before, await boxes(app))).toEqual(strip === 'on' ? ['strip'] : []);
    expect(await app.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement).dataset.probe, point)).toBe('under-pointer');
    expect(await app.evaluate(() => document.activeElement?.id)).toBe('composer');
    if (cdp) {
      // The composition is still open: committing it lands where it was typed.
      await cdp.send('Input.insertText', { text: '눈' });
      await expect(box).toHaveValue('답장 눈');
    } else await expect(box).toHaveValue('답장 ');
    await expect(app.locator('#waiting-strip')).toHaveAttribute('data-mode', strip);
    // Leaving the sidebar shows the items in the reserved slots.
    await app.mouse.move(900, 300);
    await expect(app.locator('.grp[data-project="nunchiro"] .q')).toHaveCount(2);
    await expect(app.locator('.grp[data-project="nunchiro"] .more')).toHaveText('+1');
    expect(core.read(writer.id)).not.toContain('답장');
  });
