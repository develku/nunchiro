// Ticket 900 (first-use walk 11): D1, a refused typed folder stayed the chooser's folder ("in here", every start failed
// again); D2, Onboarding read the core's busy refusal of `first_run` as "No agent found" with Claude installed.
import { expect, openWindow, test } from './fixtures';

test('walk11_refused_folder_is_not_kept: after "not there" the chooser asks for a folder again', async ({ app }) => {
  await openWindow(app);
  await app.locator('.pane .empty').getByRole('button', { name: 'Add project' }).click();
  await app.getByRole('dialog', { name: 'Add project' }).getByText('Browse folder', { exact: true }).click();
  const input = app.getByPlaceholder(/Search tabs, files/);
  await input.fill('/no/such/folder/here');
  await input.press('Enter');
  await expect(app.getByText(/^Not added to the tree: /)).toBeVisible();
  await expect(app.getByText('No folder yet. Choose one to start an agent.')).toBeVisible();
  await expect(app.getByText('in here', { exact: true })).toHaveCount(0);
});

test.describe('fresh window', () => {
  test.use({ firstRun: true });

  test('walk11_busy_first_run_is_not_no_agent: a refused look is retried, Claude shows', async ({ app }) => {
    let refused = 0;
    await app.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        const msg = typeof m === 'string' ? JSON.parse(m) : null;
        // The core's MAX_JOBS refusal, word for word (http/mod.rs), for the first two looks.
        if (msg?.request?.op === 'first_run' && refused < 2) {
          refused++;
          return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'too many requests in flight; try again' } }));
        }
        server.send(m);
      });
      server.onMessage((m) => ws.send(m));
    });
    await openWindow(app);
    const settings = app.getByRole('dialog', { name: 'Settings' });
    await settings.locator('.ob-step').filter({ hasText: 'Connect your agents' }).click();
    await expect(settings.locator('.acct-agent[data-agent="claude"]')).toBeVisible();
    await expect(settings).not.toContainText('No agent found');
    expect(refused).toBe(2);
  });
});
