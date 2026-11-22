// Screenshots of the chat for the comparison with R8-final frame 1 (not assertions). Run with SHOTS=1.
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './fixtures';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

const OUT = path.join(REPO, '.scratch/shots');

test('chat screens', async ({ page, chatCore }, info) => {
  test.skip(info.project.name !== 'chromium' || !process.env.SHOTS, 'run with SHOTS=1');
  fs.mkdirSync(OUT, { recursive: true });
  const s = chatCore.chat('core-serve');
  append(
    s.file,
    rec.userImage('PTY 세션이 끝날 때 프로세스 그룹 정리 순서가 맞는지 확인하고, 틀리면 고쳐줘'),
    rec.thinking('Check the exit path first.'),
    rec.assistant('종료 경로를 확인하겠습니다.'),
    rec.use('r1', 'Read', { file_path: '/p/src/core/session.rs' }),
    rec.result('r1', 'fn a() {}'),
    rec.use('r2', 'Read', { file_path: '/p/src/core/reap.rs' }),
    rec.result('r2', 'fn b() {}'),
    rec.use('r3', 'Read', { file_path: '/p/src/core/pty.rs' }),
    rec.result('r3', 'fn c() {}'),
    rec.assistant('reap 전에 프로세스 그룹을 retire 하지 않아 좀비가 남을 수 있었습니다. 순서를 바꿨습니다.'),
    rec.edit('e1', 'src/core/session.rs', ['-  self.reap(pid)?;', '+  self.retire_group(pgid)?;', '+  self.reap(pid)?;']),
    rec.use('b1', 'Bash', { command: 'cargo test session::' }),
    rec.result('b1', 'running 48 tests\ntest result: ok. 48 passed'),
    rec.assistant('완료. 세션 종료 시 그룹을 먼저 정리한 뒤 reap 합니다.'),
  );
  await openChat(page, s.id);
  await expect(chat(page, s.id).getByText('완료. 세션')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'chat-1-r8.png') });
  await chat(page, s.id).locator('.tool .tl', { hasText: 'Read 3 files' }).click();
  await page.screenshot({ path: path.join(OUT, 'chat-2-expanded.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(OUT, 'chat-3-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 900, height: 700 });
  await page.screenshot({ path: path.join(OUT, 'chat-4-narrow.png') });
});

// Detailed-row coverage explicitly selects Verbose; the window now starts in Normal.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
});
