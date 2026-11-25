// Ticket 1113: the lead's close proposal reaches the owner as a Decisions card.
import { expect, test, nunchiro, openWindow } from './fixtures';
import { mates, openSeat, repo, owner, tokenClaude, tokenOf } from './leader-990';

test('a foreign session stays open until Close; Not now dismisses without closing', async ({ app, core }) => {
  tokenClaude(core);
  // Hidden formatting characters cannot disguise the project in a close confirmation.
  const project = repo(core, 'close-\u202eproject');
  mates(core, [{ id: 'lead-close', name: 'Lead', project, lead: true }]);
  const target = core.shell(project, 'Account session').id;
  await openWindow(app, {}, core);
  const lead = await openSeat(app, core, 'Lead');
  const token = await tokenOf(core, lead);
  const reason = 'This account is ready to log out.';
  const propose = () => nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, ['session', 'close', target, '--why', reason]);
  const running = () => owner(core, { op: 'snapshot' }).Ok.sessions.find((s: { id: string }) => s.id === target)?.state;
  propose();
  await app.locator('#icon-decisions').click();
  const card = app.locator('.dw [data-session-close-card]');
  await expect(card).toBeVisible();
  await expect(card.locator('.mc-head')).toHaveText('Close Account session · close-project');
  await expect(card.locator('.sched-ctask')).toHaveText(reason);
  await expect(card.locator('.sched-by')).toHaveText('asked by Lead');
  await expect(card.locator('.dc-btns button')).toHaveText(['Close', 'Not now']);
  expect(running()).toBe('running');
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toHaveCount(0);
  expect(running()).toBe('running');
  propose();
  await expect(card).toBeVisible();
  // The owner card retains who asked even if the lead ends before the owner answers.
  expect(owner(core, { op: 'close', id: lead }).Err).toBeUndefined();
  await expect(card.locator('.sched-by')).toHaveText('asked by Lead');
  await card.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(running).not.toBe('running');
});
