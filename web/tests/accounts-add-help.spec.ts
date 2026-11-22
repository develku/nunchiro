// Ticket 391 follow-up G (real-app check 11-10): the new-account help names the page by its name now (Skills & hooks, not
// Agent extensions), and each agent's card says its own folder: Codex never shows Claude's ~/.claude text.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { openAdd, openRow } from './accounts-rows';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const help = (app: Page, agent: string) => app.locator(`#s-accounts .acct-agent[data-agent="${agent}"] .acct-add input.prv-inp`);

test('accounts: the new-account help names Skills & hooks, and each card names its own agent folder', async ({ app, core }) => {
  for (const [name, version] of [['claude', '2.1.311 (Claude Code)'], ['codex', 'codex-cli 0.161.0']])
    fs.writeFileSync(path.join(core.home, 'bin', name), `#!/bin/sh\ncase "$1" in --version) echo '${version}'; exit 0;; esac\nexit 1\n`, { mode: 0o700 });
  await openWindow(app);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
  await openAdd(app, 'claude');
  await expect(help(app, 'claude')).toHaveAttribute('title', 'A new account starts empty. Skills, hooks, plugins and CLAUDE.md from ~/.claude are not loaded. Add what you need in Skills & hooks.');
  await openRow(app, 'Codex');
  await openAdd(app, 'codex');
  await expect(help(app, 'codex')).toHaveAttribute('title', 'A new account starts empty. The config, AGENTS.md and skills from ~/.codex are not loaded. Add what you need in Skills & hooks.');
});
