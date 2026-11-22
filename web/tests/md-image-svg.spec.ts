// Ticket V2-10b: an SVG `![alt](path)` that passes V2-10a's root and size rules renders only inside v1b's artifact
// sandbox frame (06's FrameCard, 04's frame), never as an `<img>` or inline `<svg>` in the window. Real core, fake
// agent; the frame host is 06's browser stand-in (bytes only through the core's `file_read`, the same CSP files).
import fs from 'node:fs';
import path from 'node:path';
import { installHost } from './fixtures/artifacts/cards/host';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';
import { frames, helpers } from './fixtures/images/helpers';
import { artifactServer, canary } from './sandbox-server';

/** Script, an onload handler and an external reference; each one would leave a mark in the window if it ran there. */
const hostile = (port: number, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="60" onload="window.__svgOnload=1;try{top.__svgOnload=1}catch(e){}">` +
  `<script>window.__svgScript=1;try{top.__svgScript=1;parent.document.title='pwned'}catch(e){}try{fetch('http://127.0.0.1:${port}/f')}catch(e){}</script>` +
  `<image href="http://127.0.0.1:${port}/img.png" width="10" height="10"/><image xlink:href="http://127.0.0.1:${port}/x.png" width="10" height="10"/>` +
  `<text x="4" y="30">${label}</text></svg>`;

test('md-image-svg-sandboxed: session-relative and absolute SVGs render in the sandbox frame; nothing runs or loads in the window', async ({ page, chatCore }) => {
  const art = await artifactServer({});
  const net = await canary();
  try {
    await page.addInitScript(helpers);
    await installHost(page, art);
    const leaked: string[] = [];
    page.on('request', (r) => r.url().includes(`:${net.port}/`) && leaked.push(r.url()));
    const blocked: string[] = [];
    page.on('requestfailed', (r) => r.url().includes(`:${net.port}/`) && blocked.push(r.failure()?.errorText ?? ''));
    const s = chatCore.chat();
    fs.mkdirSync(path.join(s.cwd, 'pics'));
    fs.writeFileSync(path.join(s.cwd, 'diagram.svg'), hostile(net.port, 'relative'));
    fs.writeFileSync(path.join(s.cwd, 'pics/abs.svg'), hostile(net.port, 'absolute'));
    const outside = path.join(chatCore.home, 'outside.svg');
    fs.writeFileSync(outside, hostile(net.port, 'outside'));
    // Over the core's 2 MB `file_read` cap.
    fs.writeFileSync(path.join(s.cwd, 'big.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(2 * 1024 * 1024)}--></svg>`);
    append(
      s.file,
      rec.assistant(`relative ![x](diagram.svg)\n\nabsolute ![y](${path.join(s.cwd, 'pics/abs.svg')})\n\n![o](${outside})\n\n![m](gone.svg)\n\n![b](big.svg)`),
      rec.assistant('done'),
    );
    await openChat(page, s.id);
    const view = chat(page, s.id);
    await expect(view.getByText('done')).toBeVisible();
    for (const [rel, label] of [
      ['diagram.svg', 'relative'],
      ['pics/abs.svg', 'absolute'],
    ]) {
      const card = view.locator(`.md .acard.frame[data-path="${rel}"]`);
      await card.scrollIntoViewIfNeeded();
      await expect(card).toHaveAttribute('data-state', 'ready');
      await expect(card.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
      // Rendered inside the frame, and its script ran there (an opaque origin, not the window).
      const svg = card.frameLocator('iframe').locator('svg');
      await expect(svg.locator('text')).toHaveText(label);
      await expect.poll(() => svg.evaluate(() => (window as unknown as { __svgScript?: number }).__svgScript)).toBe(1);
      expect((await card.boundingBox())!.height).toBe(346);
    }
    // Missing, outside the readable folders or over 2 MB: a muted chip, as in V2-10a.
    const chip = (p: string) => view.locator('.mdimg.off', { hasText: p });
    for (const p of [outside, 'gone.svg', 'big.svg']) await expect(chip(p)).toBeVisible();
    await expect(view.locator('.acard')).toHaveCount(2);
    // Nothing of the SVG is in the window: no inline <svg> or <img> of it, no script or handler ran, no request left.
    await expect(view.locator('.md svg, .md img')).toHaveCount(0);
    await page.waitForTimeout(500);
    const marks = await page.evaluate(() => {
      const w = window as unknown as { __svgScript?: number; __svgOnload?: number };
      return [w.__svgScript, w.__svgOnload, document.title === 'pwned'];
    });
    expect(marks).toEqual([undefined, undefined, false]);
    expect(net.count()).toBe(0);
    // Chromium reports the frame's attempts, each stopped by the frame's CSP before the network (the canary saw none).
    expect(blocked).toEqual(leaked.map(() => 'csp'));
    // The file outside every root is never asked of the core.
    const reads = (await frames(page)).filter((f) => f.op === 'file_read').map((f) => f.path);
    expect(reads).not.toContain(outside);
    await page.screenshot({ path: '../.scratch/shots/v2-10b-inline-svg.png' });
    // One click on Open shows it in Preview.
    await view.locator('.md .acard.frame[data-path="diagram.svg"]').getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('.preview')).toHaveAttribute('data-path', 'diagram.svg');
    // A shown frame whose file goes away keeps its box (a problem card, not a chip), so text below it does not move.
    fs.rmSync(path.join(s.cwd, 'pics/abs.svg'));
    const gone = view.locator('.md .acard.frame[data-path="pics/abs.svg"]');
    await expect(gone).toHaveAttribute('data-state', 'missing', { timeout: 10_000 });
    expect((await gone.boundingBox())!.height).toBe(346);
  } finally {
    await art.close();
    await net.close();
  }
});

test('md-image-svg-no-jump: a scrolled-up chat does not move when SVG frames load', async ({ page, chatCore }) => {
  const art = await artifactServer({});
  try {
    await installHost(page, art);
    // Every core request waits for `__release()`, so the reserved boxes can be measured before anything arrives.
    await page.addInitScript(() => {
      const w = window as unknown as { __held: (() => void)[] | null; __release: () => void };
      w.__held = [];
      w.__release = () => {
        const h = w.__held!;
        w.__held = null;
        h.forEach((f) => f());
      };
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && data.includes('"op":"file_read"') && w.__held) return void w.__held.push(() => send.call(this, data));
        return send.call(this, data);
      };
    });
    const s = chatCore.chat();
    fs.writeFileSync(path.join(s.cwd, 'd.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="400"><rect width="40" height="400"/></svg>');
    append(s.file, Array.from({ length: 200 }, (_, i) => rec.assistant(i % 8 ? `메시지 ${i}` : `메시지 ${i} ![d](d.svg)`)));
    await openChat(page, s.id);
    const view = chat(page, s.id);
    await expect(view.getByText('메시지 199', { exact: true })).toBeVisible();
    const scroller = view.locator('.cscroll');
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // The box is reserved before anything is read: the same height loading as loaded, so no row below it moves.
    const heights = () => view.locator('.md .acard.frame').evaluateAll((all) => all.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(await view.locator('.md .acard.frame[data-state="loading"]').count()).toBeGreaterThan(0);
    expect(new Set(await heights())).toEqual(new Set([346]));
    const row = await scroller.evaluate((el) => {
      const r = [...el.querySelectorAll<HTMLElement>('.crow')].find((e) => e.getBoundingClientRect().top >= el.getBoundingClientRect().top + 20)!;
      return { key: r.dataset.key!, y: Math.round(r.getBoundingClientRect().y) };
    });
    await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
    await expect.poll(() => view.locator('.md .acard.frame[data-state="ready"]').count()).toBeGreaterThan(0);
    await expect(view.locator('.md .acard.frame[data-state="loading"]')).toHaveCount(0);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(new Set(await heights())).toEqual(new Set([346]));
    const y = await view.locator(`.crow[data-key="${row.key}"]`).evaluate((e) => Math.round(e.getBoundingClientRect().y));
    expect(Math.abs(y - row.y)).toBeLessThanOrEqual(1);
  } finally {
    await art.close();
  }
});
