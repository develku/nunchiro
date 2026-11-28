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

/** Every request the window sends, in order. */
function record(page: import('@playwright/test').Page) {
  const sent: { op: string; [k: string]: unknown }[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      const r = typeof f.payload === 'string' ? JSON.parse(f.payload).request : null;
      if (r) sent.push(r);
    }),
  );
  return { sent, ops: (op: string) => sent.filter((r) => r.op === op) };
}

/** A paste as the system makes it: `beforeinput` and `paste` with the text, then the text in the box and its `input`. */
async function paste(box: import('@playwright/test').Locator, text: string) {
  await box.evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: t, bubbles: true, cancelable: true }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    const box = el as HTMLTextAreaElement;
    box.setRangeText(t, box.selectionStart, box.selectionEnd, 'end');
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', data: t, bubbles: true }));
  }, text);
}

test('folder_offer_typed_words: Enter offers a box of typed keys only, before the message goes; a paste, an edited paste or a recalled prompt offers nothing', async ({ page, chatCore }) => {
  const a = chatCore.chat('a', true, false, 'p');
  const w = record(page);
  await openChat(page, a.id);
  const box = page.locator('#composer');
  const typed = 'file the PDFs in /Users/someone/Documents/Orders please';
  await box.click();
  await box.pressSequentially(typed);
  await box.press('Enter');
  await expect.poll(() => w.ops('send_text').length).toBe(1);
  expect(w.ops('folder_offer')).toEqual([{ op: 'folder_offer', id: a.id, text: typed }]);
  expect(w.sent.findIndex((r) => r.op === 'folder_offer')).toBeLessThan(w.sent.findIndex((r) => r.op === 'send_text'));
  // A pasted path, even with typed words around it: no offer for the message.
  await box.pressSequentially('file the PDFs in ');
  await paste(box, '/Users/someone/Documents/Pasted');
  await box.pressSequentially(' now');
  await expect(box).toHaveValue('file the PDFs in /Users/someone/Documents/Pasted now');
  await box.press('Enter');
  await expect.poll(() => w.ops('send_text').length).toBe(2);
  expect(w.ops('folder_offer')).toHaveLength(1);
  // Text Nunchiro put in the box (here a recalled earlier prompt), then typed on: no offer either.
  await box.evaluate((el) => {
    const box = el as HTMLTextAreaElement;
    box.value = 'an earlier prompt from /Users/someone/Elsewhere';
  });
  await box.pressSequentially(' again');
  await box.press('Enter');
  await expect.poll(() => w.ops('send_text').length).toBe(3);
  expect(w.ops('folder_offer')).toHaveLength(1);
  // After that send the box is clean again: typed words offer.
  await box.pressSequentially('and /Users/someone/Documents/Orders');
  await box.press('Enter');
  await expect.poll(() => w.ops('folder_offer').length).toBe(2);
});
