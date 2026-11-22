// Ticket 370 item 3: "+ Project" > Clone against the real core, with a stand-in `git` first on the core's PATH (no network).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { seed } from './tree-seed';

const URL = 'https://example.invalid/acme/web-console.git';

/** Answers `git clone` with `body` ($target is the folder); every other git call is the real one. */
function standIn(core: Core, body: string) {
  const script = `#!/bin/sh\ncase " $* " in *" clone "*) ;; *) exec /usr/bin/git "$@" ;; esac\nfor target; do :; done\n${body}\n`;
  fs.writeFileSync(path.join(core.home, 'bin/git'), script, { mode: 0o700 });
}
const dialog = (app: Page) => app.getByRole('dialog', { name: 'Clone a repository' });

async function openClone(app: Page, parent: string, url = URL) {
  await openWindow(app);
  await app.getByRole('button', { name: '+ Project' }).click();
  await app.getByRole('dialog', { name: 'Add project' }).getByRole('button', { name: /^Clone/ }).click();
  const d = dialog(app);
  await d.getByLabel('Git URL').fill(url);
  await d.getByLabel('Parent folder').fill(parent);
  return d;
}

test('project_clone_success_reaches_the_tree_and_new_session: progress shows, then the project is in the tree and New session opens on it', async ({ app, core }) => {
  standIn(core, `printf 'Receiving objects:  42%% (4/9)\\r' >&2\nsleep 1\necho hello > "$target/README"`);
  const parent = core.project('parent');
  const d = await openClone(app, parent);
  await d.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(d.getByRole('progressbar', { name: 'Clone progress' })).toHaveAttribute('aria-valuenow', '42');
  await expect(d).toContainText('Receiving objects');

  const made = path.join(parent, 'web-console');
  const pop = app.getByRole('dialog', { name: 'New tab' });
  await expect(pop.locator('.nt-in')).toHaveAttribute('title', made, { timeout: 10_000 });
  expect(fs.readFileSync(path.join(made, 'README'), 'utf8')).toBe('hello\n');
  // Added before the popover opened, so dismissing it keeps the project.
  await app.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(app.locator(`.row.head[data-project-path="${made}"]`)).toBeVisible();
});

test('project_clone_cancel_returns_to_the_form: Cancel ends the job, leaves no folder and keeps what was typed', async ({ app, core }) => {
  standIn(core, `echo partial > "$target/p"\nprintf 'Receiving objects:  10%% (1/9)\\r' >&2\nexec sleep 600`);
  const parent = core.project('parent');
  const d = await openClone(app, parent);
  await d.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(d.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10');
  expect(fs.existsSync(path.join(parent, 'web-console/p'))).toBe(true);

  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(d.getByRole('progressbar')).toHaveCount(0);
  await expect(d.getByRole('button', { name: 'Clone', exact: true })).toBeEnabled();
  await expect(d.getByLabel('Git URL')).toHaveValue(URL);
  expect(fs.existsSync(path.join(parent, 'web-console'))).toBe(false);
});

test('project_clone_closing_the_dialog_is_cancel: Escape during a clone ends it and removes its folder', async ({ app, core }) => {
  standIn(core, `echo partial > "$target/p"\nprintf 'Receiving objects:  10%% (1/9)\\r' >&2\nexec sleep 600`);
  const parent = core.project('parent');
  const d = await openClone(app, parent);
  await d.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(d.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10');
  await app.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
  await expect.poll(() => fs.existsSync(path.join(parent, 'web-console')), { timeout: 10_000 }).toBe(false);
});

test('project_clone_failure_offers_retry_and_a_retry_can_succeed: a translated reason, never git output alone', async ({ app, core }) => {
  standIn(core, `echo partial > "$target/p"\necho "fatal: could not read Username: terminal prompts disabled" >&2\nexit 128`);
  const parent = core.project('parent');
  const d = await openClone(app, parent);
  await d.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(d.getByRole('alert')).toHaveText('Could not clone. Authentication failed. Check in a terminal that you can access this repository.');
  await expect(d).toContainText('The folder this clone created was removed.');
  await expect(d).not.toContainText('terminal prompts disabled');
  expect(fs.existsSync(path.join(parent, 'web-console'))).toBe(false);

  standIn(core, `echo ok > "$target/README"`);
  await d.getByRole('button', { name: 'Retry' }).click();
  await expect(app.getByRole('dialog', { name: 'New tab' }).locator('.nt-in')).toHaveAttribute('title', path.join(parent, 'web-console'), { timeout: 10_000 });
});

test('project_clone_failed_tree_add_says_so_and_can_be_repeated: New session waits until the project is in the tree', async ({ app, core }) => {
  standIn(core, `echo hello > "$target/README"`);
  let refuse = true;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (refuse && r?.request?.op === 'tree_edit') {
        refuse = false;
        return ws.send(JSON.stringify({ id: r.id, response: { Err: 'tree file is locked' } }));
      }
      server.send(msg);
    });
    server.onMessage((msg) => ws.send(msg));
  });
  const parent = core.project('parent');
  const d = await openClone(app, parent);
  await d.getByRole('button', { name: 'Clone', exact: true }).click();
  const made = path.join(parent, 'web-console');
  await expect(d.getByRole('alert')).toHaveText(`Cloned to ${made}, but it could not be added to the tree.`, { timeout: 10_000 });
  await expect(d).toContainText('tree file is locked');
  const pop = app.getByRole('dialog', { name: 'New tab' });
  await expect(pop).toHaveCount(0);
  expect(fs.existsSync(path.join(made, 'README'))).toBe(true);

  await d.getByRole('button', { name: 'Add to the tree again' }).click();
  await expect(pop.locator('.nt-in')).toHaveAttribute('title', made, { timeout: 10_000 });
  await expect(app.locator(`.row.head[data-project-path="${made}"]`)).toBeVisible();
});

test('project_clone_refused_url_and_existing_folder_have_no_retry: Clone stays disabled and nothing is touched', async ({ app, core }) => {
  const ran = path.join(core.home, 'git-ran');
  standIn(core, `touch "${ran}"`);
  const parent = core.project('parent');
  fs.mkdirSync(path.join(parent, 'web-console'));
  fs.writeFileSync(path.join(parent, 'web-console/mine'), 'keep');
  const d = await openClone(app, parent, 'ext::sh -c x');
  await expect(d.getByRole('alert')).toHaveText('This URL cannot be used. Use https://, ssh:// or the scp form (user@host:path).');
  await expect(d.getByRole('button', { name: 'Clone', exact: true })).toBeDisabled();
  await expect(d.getByRole('button', { name: 'Retry' })).toHaveCount(0);

  await d.getByLabel('Git URL').fill(URL);
  await d.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(d.getByRole('alert')).toContainText('web-console already exists');
  await expect(d.getByRole('button', { name: 'Clone', exact: true })).toBeDisabled();
  await expect(d.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  expect(fs.readFileSync(path.join(parent, 'web-console/mine'), 'utf8')).toBe('keep');
  expect(fs.existsSync(ran)).toBe(false);
});

test('project_clone_parent_follows_the_tree: the folder most projects sit in is offered, not ~/Projects', async ({ app, core }) => {
  const [a, b] = [core.project('one'), core.project('two')];
  seed(core, { op: 'add', project: a, added: true }, { op: 'add', project: b, added: true });
  await openWindow(app);
  await app.getByRole('button', { name: '+ Project' }).click();
  await app.getByRole('dialog', { name: 'Add project' }).getByRole('button', { name: /^Clone/ }).click();
  await expect(dialog(app).getByLabel('Parent folder')).toHaveValue(path.dirname(a));
});
