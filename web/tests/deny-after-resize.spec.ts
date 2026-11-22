// Ticket 611 (first-use walks 5 and 7): a Claude prompt shown before the window opened its tab. The tab's fit resizes the
// PTY, the core blanks its screen and waits for the agent's redraw (a real Claude 2.1.325 redraws within 2 s). The fake did
// not redraw, so Deny -> Just deny failed with "decision is no longer on screen" while the window still showed the prompt.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';

test('deny_after_the_tab_resized_the_prompt: the core still reads the prompt and Just deny goes through', async ({ app, core }) => {
  const a = core.agent(core.project('demo'), 'a', 'go');
  fs.writeFileSync(path.join(a.cwd, 'go'), ''); // the prompt is on screen before any window
  await expect.poll(() => core.screen(a.id), { timeout: 8000 }).toContain('Do you want to proceed?');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click(); // the tab's terminal fits: a resize
  const line = app.locator(`.tree .q[data-line="${a.id}"]`);
  await expect(line).toBeVisible({ timeout: 8000 });
  await app.waitForTimeout(2000); // past the core's 1500 ms resize grace (queue::RESIZE_GRACE_MS): an unredrawn screen stays blank from here
  expect(core.screen(a.id)).toContain('Do you want to proceed?');
  await line.locator('[data-act="deny"]').click();
  await app.getByRole('button', { name: 'Just deny' }).click();
  await expect(app.locator('.tree .qerr')).toHaveCount(0);
  core.run(['session', 'send-keys', a.id, '2', 'enter']); // lane w102: send-text waits out a start question
  await expect.poll(() => core.read(a.id), { timeout: 5000 }).toContain('answered \x1b2'); // the deny's Esc reached the agent
});
