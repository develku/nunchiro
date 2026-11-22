// Real-app 11-10 defect 5 (v32-shell-2): an agent's folder-trust prompt is a dialog the core answers with Esc only (needs 44), so
// its card says plainly that the session's terminal answers it, offers a button that shows and focuses that terminal, and names
// what its one sent key (Esc) does. Never a lone "Deny" under "Needs permission". A real core and fake agents (decision-card-options).
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { fakes, gitRepo, pending, proxy, show } from './decision-rows-seed';
import { icon, sidebar } from './d5b';

// Claude's own folder-trust prompt (its numbered choices and footer), and one the screen shows without readable choices.
const TRUST_FILES = ' Do you trust the files in this folder?\r\n\r\n /work/repo\r\n\r\n ❯ 1. Yes, proceed\r\n   2. No, exit\r\n\r\n Enter to confirm · Esc to exit\r\n';
const TRUST_BARE = ' Do you trust this folder?\r\n';

async function ask(app: Page, core: Core, screen: string) {
  fakes(core);
  const a: { id: string; cwd: string } = core.agent(gitRepo(core, 'repo'), 'wt-a', 'go-a', true);
  const px = await proxy(app);
  await openWindow(app);
  show(a.cwd, 'go-a', screen);
  await expect(app.locator(`.q[data-line="${a.id}"]`)).toBeVisible({ timeout: 8000 });
  await icon(app, 'right', 'Decisions').click();
  const card = sidebar(app, 'right').locator('.dc-item');
  await expect(card).toHaveCount(1);
  // Opening the sidebar refits the terminal and a redraw re-files the prompt under a new id: wait for the item the core holds now.
  await expect
    .poll(async () => {
      const shown = await card.first().getAttribute('data-item');
      return pending(core).some((d) => d.id === shown);
    })
    .toBe(true);
  return { a, px, card };
}

for (const [name, screen, effect] of [
  ['with its choices', TRUST_FILES, 'No, exit'],
  ['without readable choices', TRUST_BARE, 'the agent exits'],
] as const) {
  test(`folder_trust_card ${name}: says the terminal answers it, Open terminal focuses that terminal, and Esc names its effect`, async ({ app, core }) => {
    const { a, px, card } = await ask(app, core, screen);
    await expect(sidebar(app, 'right').locator('.deccard')).not.toContainText('permission');
    await expect(card.locator('.dc-why')).toContainText("Answer this prompt in the terminal of the session");
    await expect(card.locator('.dc-why')).not.toContainText('The agent asks before it runs this.');
    // No lone Deny: the way to answer, then Esc with what it does.
    const buttons = card.locator('.dc-btns button');
    await expect(buttons).toHaveText(['Open terminal', `Esc: ${effect}`]);
    await expect(card.getByRole('button', { name: 'Deny', exact: true })).toHaveCount(0);
    // Open terminal shows this session with its terminal focused: the prompt is answered there.
    await card.getByRole('button', { name: 'Open terminal' }).click();
    await expect(app.locator(`.tab[data-tab="${a.id}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(app.locator(`.term[data-session="${a.id}"] .xterm-helper-textarea`)).toBeFocused();
    expect(px.sent).toHaveLength(0); // opening the terminal answers nothing
  });
}

test('folder_trust_card: the Esc button sends the one answer a dialog takes from the window (deny, as Esc)', async ({ app, core }) => {
  const { px, card } = await ask(app, core, TRUST_FILES);
  await card.getByRole('button', { name: 'Esc: No, exit' }).click();
  await expect.poll(() => px.sent.length).toBe(1);
  expect(px.sent[0].answer).toEqual({ type: 'deny' });
});
