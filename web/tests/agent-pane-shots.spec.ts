// AGENTVIEW REPORT page: the approved mockup (frame-ko-e.html) and this app at the same 1440x900, light and dark, for every
// pane state. Run with SHOTS=1 (chromium only); writes .scratch/agentview/ and side-by-side.html.
import fs from 'node:fs';
import path from 'node:path';
import { icon } from './d5b';
import { REPO } from './fixtures';
import { append, chat, openChat, rec, test } from './fixtures/chat/harness';
import { injectPending, item, newShell, showPreview } from './agent-pane';

const MOCKUP = path.join(REPO, '.scratch/v2-drafts/ko/frame-ko-e.html');
const OUT = path.join(REPO, '.scratch/agentview');
const STATES = ['closed', 'pty', 'shell', 'browser', 'preview', 'tui', 'max'] as const;
const MOCK: Record<(typeof STATES)[number], [string, string]> = { closed: ['closed', 'pty'], pty: ['term', 'pty'], shell: ['term', 's1'], browser: ['browser', 'br'], preview: ['term', 'pv'], tui: ['tui', 'pty'], max: ['max', 'pty'] };

test('agentview shots', async ({ page, chatCore, browser }, info) => {
  test.skip(info.project.name !== 'chromium' || !process.env.SHOTS, 'run with SHOTS=1');
  test.skip(!fs.existsSync(MOCKUP), `mockup frame absent: ${MOCKUP}`);
  test.setTimeout(240_000);
  fs.mkdirSync(OUT, { recursive: true });
  const s = chatCore.chat('ux-fix-2');
  const md = '# tree-after\n\nThe tree after the change.';
  fs.writeFileSync(path.join(s.cwd, 'tree-after.md'), md);
  append(s.file, rec.user('트리 줄을 정리해줘'), rec.assistant('정리했습니다. 결과 문서를 만들었습니다.'), [
    rec.use('w1', 'Write', { file_path: path.join(s.cwd, 'tree-after.md'), content: md }),
    rec.result('w1', 'created', { toolUseResult: { type: 'create', filePath: path.join(s.cwd, 'tree-after.md'), content: md, structuredPatch: [] } }),
  ]);
  const state = await injectPending(page);
  const mock = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await mock.goto(`file://${MOCKUP}`);
  await openChat(page, s.id);
  const shot = async (name: (typeof STATES)[number], scheme: string) => {
    await page.screenshot({ path: path.join(OUT, `app-${name}-${scheme}.png`) });
    const [st, tab] = MOCK[name];
    await mock.evaluate(([a, b, c]) => {
      document.documentElement.dataset.theme = c;
      (0, eval)(`st=${JSON.stringify(a)};ptab=${JSON.stringify(b)};stage()`);
    }, [st, tab, scheme]);
    await mock.screenshot({ path: path.join(OUT, `mock-${name}-${scheme}.png`) });
  };
  const termI = icon(page, 'right', 'Terminal');
  const pane = page.locator('[data-side-pane]');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot('closed', scheme);
    await termI.click();
    await page.locator(`.term[data-session="${s.id}"] .xterm-screen`).waitFor();
    await shot('pty', scheme);
    await newShell(page);
    await page.locator('[data-side-pane] .term .xterm-screen').nth(1).waitFor();
    await shot('shell', scheme);
    await icon(page, 'right', 'Browser').click();
    await shot('browser', scheme);
    await showPreview(page);
    await chat(page, s.id).locator('.acard[data-path="tree-after.md"]').getByRole('button', { name: 'Open' }).click();
    await page.locator('.preview .pv-body h1').waitFor();
    await shot('preview', scheme);
    await termI.click(); // the pane is on Preview: the Terminal icon brings the PTY back
    state.items[s.id] = [item(s.id, 'dialog', ['screen'])];
    state.push();
    await page.locator('[data-side-pane].tui').waitFor();
    await shot('tui', scheme);
    state.items[s.id] = [];
    state.push();
    await pane.getByRole('button', { name: /Maximi[sz]e/ }).click();
    await shot('max', scheme);
    await pane.getByRole('button', { name: /Restore/ }).click();
    // Back to the start for the next scheme: close the shell, close the pane.
    await pane.getByRole('button', { name: /^Close shell/ }).click();
    await termI.click();
  }
  await mock.close();
  const cell = (n: string, sc: string) => `<td><img src="mock-${n}-${sc}.png" alt="mockup ${n} ${sc}"></td><td><img src="app-${n}-${sc}.png" alt="app ${n} ${sc}"></td>`;
  fs.writeFileSync(
    path.join(OUT, 'side-by-side.html'),
    `<!doctype html><meta charset="utf-8"><title>AGENTVIEW side by side</title><style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse}td,th{border:1px solid #888;padding:4px;vertical-align:top}img{width:700px;display:block}</style>` +
      `<h1>AGENTVIEW: frame-ko-e mockup | app, 1440x900</h1><table><tr><th>state</th><th>mockup</th><th>app</th></tr>` +
      STATES.flatMap((n) => ['light', 'dark'].map((sc) => `<tr><th>${n}<br>${sc}</th>${cell(n, sc)}</tr>`)).join('') +
      `</table>`,
  );
});
