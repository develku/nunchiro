// Ticket 810 (first-use walk 10, Korean window): English left on screens a new user reads, and a header that named the
// receiving session as the sender of the Room's wake-up. D1 (picker reasons) is in picker.spec.ts, D6 (split words) in
// palette-everyday.spec.ts.
import { expect, test } from './fixtures';

test.use({ locale: 'ko-KR' });

test('walk10_korean_window_names: split shell, About version, tab dot and tree groups read Korean', async ({ app, core }) => {
  const project = core.project('demo');
  const agent = core.agent(project, 'beta', 'x');
  await app.goto('/'); // not openWindow: its Connected check is English
  const tab = app.locator(`.tab[data-tab="${agent.id}"]`);
  await tab.click();
  // D4: screen-reader names of the tab's status dot and the tree's machine and project groups.
  await expect(tab.locator('.tdot')).toHaveAttribute('aria-label', /^[^a-z]+$/);
  await expect(app.getByRole('group', { name: '이 Mac' })).toBeVisible();
  await expect(app.locator('.grp[data-project][role="group"]').first()).toHaveAttribute('aria-label', /^demo: [^a-z]+$/);
  // D2: a shell opened by a split is the catalogue's untitled terminal, not "split shell 1".
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog').getByRole('combobox').fill('오른쪽으로 나누기');
  await app.keyboard.press('Enter');
  await app.getByText('이 폴더에서 새 셸').click();
  await expect(app.locator('.tree')).toContainText('새 터미널');
  await expect(app.locator('body')).not.toContainText('split shell');
  // D3: About's version line has no English "unknown" (the web build has no app version).
  await app.getByRole('button', { name: '설정', exact: true }).click();
  await app.getByRole('dialog').getByText('정보', { exact: true }).first().click();
  await expect(app.locator('.sver')).not.toContainText('unknown');
  await expect(app.locator('.sver')).toContainText('알 수 없음');
});

test('walk10_room_wakeup_reads_as_the_room: the receiving session header does not name itself as sender', async ({ app, core }) => {
  const project = core.project('demo');
  const agent = core.agent(project, 'beta', 'x');
  await app.goto('/');
  await app.locator(`.tab[data-tab="${agent.id}"]`).click();
  await app.getByText('대화방', { exact: true }).last().click();
  await app.getByPlaceholder('beta에게 메시지') /* the Room box names who hears it since 8cf1b2f1d */.fill('계획을 세워 주세요');
  await app.keyboard.press('Enter');
  // The Room logs its wake-up on the lead with the lead's own id as sender (ticket 810 D5).
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; send_log?: { sender: string }[] }[]).find((s) => s.id === agent.id)?.send_log?.some((r) => r.sender === agent.id), { timeout: 15_000 }).toBe(true);
  await app.locator(`.tab[data-tab="${agent.id}"]`).click();
  await expect(app.locator('.shead .sentby')).toContainText('대화방');
  await expect(app.locator('.shead .sentby')).not.toContainText('beta');
});
