// Ticket 391 follow-up: the report's shots of Providers (the Claude card open, then the ACP card open) and of Skills & hooks,
// dark and light, at 1440 and 900 px, into .scratch/shots/391b/. Each shot also checks what it shows. Fake agents only.
import fs from 'node:fs';
import path from 'node:path';
import { openRow } from './accounts-rows';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { stripOnTop, expect, openWindow, REPO, test } from './fixtures';
import { openSettings } from './settings-modal';

test.beforeEach(({ core }) => stripOnTop(core));

const DIR = path.join(REPO, '.scratch/shots/391b');
for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1440, 900]) {
    test(`391b shots: Providers with Claude open, then OpenCode open, and Skills & hooks (${scheme}, ${width} px)`, async ({ app, core }) => {
      test.skip(test.info().project.name !== 'chromium', 'one set of shots');
      fs.writeFileSync(path.join(core.home, 'bin/claude'), `#!/bin/sh\ncase "$1" in --version) echo '2.1.311 (Claude Code)'; exit 0;; esac\n[ "$1 $2" = "auth status" ] && { echo '{"loggedIn": true, "subscriptionType": "max"}'; exit 0; }\nexec /bin/cat\n`, { mode: 0o700 });
      fs.writeFileSync(path.join(core.home, 'bin/codex'), `#!/bin/sh\ncase "$1" in --version) echo 'codex-cli 0.161.0'; exit 0;; esac\n[ "$1 $2" = "login status" ] && kill -9 $$\nexec /bin/cat\n`, { mode: 0o700 });
      fs.writeFileSync(agentsToml(core), tomlEntry('opencode', fakeAcp(core, 'opencode', '1.4.0', ['many:2'])));
      ownerOk(core, { op: 'acp_agent_grant', name: 'opencode', hash: ownerOk(core, { op: 'acp_agent_status', name: 'opencode' }).view.hash });
      ownerOk(core, { op: 'start', session: { kind: 'acp', project: core.project('demo'), args: ['opencode'], model: null, effort: null, resume: null } });
      await app.setViewportSize({ width, height: 900 });
      await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await openWindow(app);
      await openSettings(app);
      fs.mkdirSync(DIR, { recursive: true });
      await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
      // The page checks "Your own" as it opens and drops the head's Check once signed in (accounts-check-on-open); openRow waits for that check.
      await openRow(app, 'Claude');
      await expect(app.locator('#s-accounts [data-row="claude"] .prv-chips')).toHaveText('Signed in');
      await app.screenshot({ path: path.join(DIR, `providers-claude-open-${scheme}-${width}.png`), fullPage: true });
      await openRow(app, 'opencode');
      await expect(app.locator('#s-accounts .acct-agent[data-agent="opencode"] [data-field="models"] .prv-mr')).toHaveCount(4, { timeout: 15_000 });
      await app.locator('#s-accounts .acct-agent[data-agent="opencode"]').scrollIntoViewIfNeeded();
      await app.screenshot({ path: path.join(DIR, `providers-acp-open-${scheme}-${width}.png`), fullPage: true });
      await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks' }).click();
      await expect(app.getByRole('switch', { name: 'Add Nunchiro hooks to new sessions', exact: true })).toBeVisible();
      await app.screenshot({ path: path.join(DIR, `skills-hooks-${scheme}-${width}.png`), fullPage: true });
    });
  }
}
