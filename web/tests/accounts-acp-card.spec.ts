// Ticket 391 follow-up D (real-app check 11-10): inside an open card. An ACP agent's models read one line each (an
// ellipsis when long), Connection & sign-in says in a sentence what Sign in does, and no divider line sits on the first
// line of a block (the ACP sign-in line, and Path in the Claude card). Real core, fake agents only.
import type { Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { openRow } from './accounts-rows';
import { REPO, expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

const SIGNIN_PY = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/acp/signin_agent.py');
const grant = (core: Core, cmd: string) => {
  fs.writeFileSync(agentsToml(core), tomlEntry('acme', cmd));
  ownerOk(core, { op: 'acp_agent_grant', name: 'acme', hash: ownerOk(core, { op: 'acp_agent_status', name: 'acme' }).view.hash });
};
async function card(app: Page, name: string) {
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, name);
  return app.locator(`#s-accounts .acct-agent[data-agent="${name.toLowerCase()}"]`);
}
/** The divider lines drawn on the first shown line of a block: none is right. */
const firstLineDividers = (c: Locator) =>
  c.locator('.prv-bb').evaluateAll((blocks) =>
    blocks.flatMap((b) => {
      const first = [...b.querySelectorAll('.prv-ln')].find((l) => l.getBoundingClientRect().height > 0);
      if (!first) return [];
      const shownBefore = [...b.querySelectorAll('*')].some((e) => e.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING && !e.contains(first) && e.getBoundingClientRect().height > 0 && !first.contains(e));
      return !shownBefore && parseFloat(getComputedStyle(first).borderTopWidth) > 0 ? [first.textContent ?? ''] : [];
    }),
  );

test('acp card: long model names and ids stay on one line each at 900 px', async ({ app, core }) => {
  grant(core, fakeAcp(core, 'acme', 'acme 0.9.1', ['many:3']));
  ownerOk(core, { op: 'start', session: { kind: 'acp', project: core.project('demo'), args: ['acme'], model: null, effort: null, resume: null } });
  await app.setViewportSize({ width: 900, height: 900 });
  await openWindow(app);
  const acme = await card(app, 'acme');
  const rows = acme.locator('[data-field="models"] .prv-mr');
  await expect(rows).toHaveCount(5, { timeout: 15_000 });
  const tall = await rows.evaluateAll((els) => els.filter((r) => [...r.querySelectorAll('span')].some((s) => s.getClientRects().length > 1 || s.getBoundingClientRect().height > 24)).map((r) => r.textContent));
  expect(tall).toEqual([]);
  // A name cut short keeps its whole text in the tooltip.
  await expect(rows.last().locator('span').first()).toHaveAttribute('title', 'Long model 2');
});

test('acp card: Connection & sign-in says what Sign in does, with no divider on its first line', async ({ app, core }) => {
  const cmd = path.join(core.home, 'bin/acme');
  fs.writeFileSync(cmd, `#!/bin/sh\n[ "$1" = --version ] && { echo 'acme 0.9.1'; exit 0; }\nexec /usr/bin/python3 ${SIGNIN_PY} ${path.join(core.home, 'acme.state')} methods:terminal "$@"\n`, { mode: 0o700 });
  grant(core, cmd);
  await openWindow(app);
  const acme = await card(app, 'acme');
  const login = acme.locator('.prv-blk').filter({ hasText: 'Connection & sign-in' });
  await expect(login.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 });
  await expect(login.locator('[data-field="acp-login-what"]')).toHaveText("Sign in opens acme's own login in a terminal tab.");
  expect(await firstLineDividers(acme)).toEqual([]);
});

test('claude card: Path, the first line of Advanced, has no divider above it', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), `#!/bin/sh\ncase "$1" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac\nexit 1\n`, { mode: 0o700 });
  await openWindow(app);
  const claude = await card(app, 'Claude');
  await expect(claude.locator('.prv-blk').filter({ hasText: 'Advanced' }).locator('.prv-ln').first()).toContainText('Path');
  expect(await firstLineDividers(claude)).toEqual([]);
});
