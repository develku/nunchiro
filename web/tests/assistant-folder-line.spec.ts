// The Assistant's folder grant: a folder the owner named shows as one quiet line under the composer, and its Remove sends
// `folder_remove` for exactly that folder. The core's grant rules are tested in crates/nunchiro-core/tests/folders.rs; here
// the snapshot is patched with a folder (the window socket proxied, as attention-patch.ts does) and the request watched.
import { expect, openChat, test } from './fixtures/chat/harness';

const FOLDER = '/Users/someone/Documents/Orders';

test('folder_line_remove: a given folder shows its quiet line, and Remove asks the core to end that grant', async ({ page, chatCore }) => {
  const a = chatCore.chat('a', true, false, 'p');
  const sent: { op: string; [k: string]: unknown }[] = [];
  let removed = false;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m).request : null;
      if (r?.op === 'folder_remove') {
        sent.push(r);
        removed = true;
      }
      server.send(m);
    });
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const s of msg.sessions ?? []) if (s.id === a.id && !removed) s.folders = [FOLDER];
      ws.send(JSON.stringify(msg));
    });
  });
  await openChat(page, a.id);
  const line = page.locator(`.folder-given[data-folder="${FOLDER}"]`);
  await expect(line).toHaveText(`${FOLDER} · read and write for this conversation Remove`);
  await line.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => sent).toEqual([{ op: 'folder_remove', id: a.id, folder: FOLDER }]);
});
