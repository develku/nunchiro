// The window's composer under a chat with a Preview and a Diff split beside it (three panes): its card stays in the chat
// column and stays usable there, at 1440x900 and at 1280x800. It squeezed to 20 px, its placeholder one letter a line,
// when pane/composerRoom.ts took the Preview (right of the chat, left of the composer's middle) for a left host.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test as plain } from '@playwright/test';
import { MIN_CARD, room } from '../src/pane/composerRoom';
import { installHost } from './fixtures/artifacts/cards/host';
import { append, openChat, rec, test, expect } from './fixtures/chat/harness';
import { artifactServer } from './sandbox-server';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);


/** The card's width and how many lines its placeholder wraps to in the textarea (greedy word wrap, the textarea's font). */
const measure = (app: Page) =>
  app.locator('.composer:not([data-pinned]) textarea').evaluate((t: HTMLTextAreaElement) => {
    const cs = getComputedStyle(t);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const width = t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let lines = 1;
    let line = '';
    for (const word of t.placeholder.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width && line) [lines, line] = [lines + 1, word];
      else line = next;
    }
    return { card: Math.round(t.closest('.cbox')!.getBoundingClientRect().width), lines };
  });

for (const [w, h] of [[1440, 900], [1280, 800]] as const) {
  test(`composer_three_panes_${w}: beside a Preview and a Diff split the card keeps ${MIN_CARD} px and a placeholder on 2 lines at most`, async ({ page: app, chatCore }) => {
    await app.setViewportSize({ width: w, height: h });
    const art = await artifactServer({});
    try {
      await installHost(app, art, []);
      const s = chatCore.chat('nunchiro');
      git(s.cwd, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(s.cwd, 'a.ts'), 'a\n');
      git(s.cwd, 'add', '.');
      git(s.cwd, 'commit', '-qm', 'base');
      fs.writeFileSync(path.join(s.cwd, 'a.ts'), 'b\n');
      fs.mkdirSync(path.join(s.cwd, 'site'));
      const html = '<!doctype html><title>Sales chart</title><h1>Sales</h1>';
      const file = path.join(s.cwd, 'site/index.html');
      fs.writeFileSync(file, html);
      append(s.file, rec.user('make the chart'), rec.use('w1', 'Write', { file_path: file, content: html }),
        rec.result('w1', 'ok', { toolUseResult: { type: 'create', filePath: file, content: html, structuredPatch: [] } }), rec.assistant('Done.'));
      await openChat(app, s.id);
      await app.locator('.acard[data-path="site/index.html"]').getByRole('button', { name: 'Open' }).click();
      await expect(app.locator('.preview .pv-frame')).toBeVisible();
      await app.keyboard.press('Escape');
      await app.keyboard.press('Meta+KeyD');
      await app.getByRole('listbox', { name: 'Open in this split' }).getByRole('option', { name: /^Diff/ }).click();
      await expect(app.locator('[data-split-id]')).toContainText('a.ts');
      await expect.poll(async () => (await measure(app)).card).toBeGreaterThanOrEqual(MIN_CARD);
      expect((await measure(app)).lines).toBeLessThanOrEqual(2);
      // The card stays in the chat column while it has the room: it starts where the chat does.
      const chat = await app.locator(`.chat[data-session="${s.id}"]`).boundingBox();
      const card = await app.locator('.composer:not([data-pinned]) .cbox').boundingBox();
      expect(card!.x).toBeGreaterThanOrEqual(chat!.x);
      await app.screenshot({ path: test.info().outputPath(`three-panes-${w}.png`) });
    } finally {
      await art.close();
    }
  });
}

plain('composer_room_two_hosts_right: two panes right of the chat leave the card the gap left of both', () => {
  // The chat 301-657, a Preview 664-944 and a Diff split 954-1389 beside it, the composer row 301-1389 under all three.
  expect(room({ left: 301, right: 1389 }, [{ left: 664, right: 944 }, { left: 954, right: 1389 }])).toEqual({ left: 0, right: 725 });
  // A narrow window: the card keeps its floor; the room on the right gives way first.
  expect(room({ left: 0, right: 600 }, [{ left: 200, right: 600 }])).toEqual({ left: 0, right: 600 - 40 - MIN_CARD });
});
