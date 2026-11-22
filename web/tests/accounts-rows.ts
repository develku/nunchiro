// Ticket 355: Settings > Accounts shows one row open at a time; an account's rarer actions are behind its ⋯.
import type { Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Core } from './fixtures';

/** Accounts probe 11-10 round 2: wraps the fake `claude` and `codex` in the test's bin so each status run records, in
 *  `status-runs.log` under the core home, the folder it was pointed at, its exit code and the first 200 bytes of what it
 *  printed. Test code only: the product logs nothing new. `whenFails` puts that record in a failing assertion's message. */
export function recordStatusRuns(core: Core) {
  const log = path.join(core.home, 'status-runs.log');
  for (const name of ['claude', 'codex']) {
    const bin = path.join(core.home, 'bin', name);
    fs.renameSync(bin, `${bin}.real`);
    fs.writeFileSync(
      bin,
      `#!/bin/sh
case "$1 $2" in
  "auth status"|"login status")
    t=$(mktemp -d /tmp/nsr.XXXXXX)
    '${bin}.real' "$@" > "$t/o" 2> "$t/e"; c=$?
    { printf '%s %s code=%s out=' '${name}' "\${CLAUDE_CONFIG_DIR:-\${CODEX_HOME:-own}}" "$c"; head -c 200 "$t/o" | tr '\n' ' '; printf ' err='; head -c 200 "$t/e" | tr '\n' ' '; echo; } >> '${log}'
    cat "$t/o"; cat "$t/e" >&2; rm -rf "$t"; exit "$c";;
esac
exec '${bin}.real' "$@"
`,
      { mode: 0o700 },
    );
  }
  return async (check: () => Promise<void>) => {
    try {
      await check();
    } catch (e) {
      const runs = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(no status run recorded)';
      throw new Error(`${e instanceof Error ? e.message : e}\nstatus runs:\n${runs}`);
    }
  };
}

/** Opens this agent's row (Claude, Codex or an ACP entry's name) unless it is open already. */
export async function openRow(app: Page, agent: string) {
  const chevron = app.locator(`#s-accounts [data-row="${agent.toLowerCase()}"] .prv-chv`);
  await chevron.waitFor();
  // Accounts probe 11-10: the page checks "Your own" as it opens; its answer can drop the head's Check, which moves the
  // head under a click. Wait for it first.
  await expect(app.locator(`#s-accounts [data-row="${agent.toLowerCase()}"] .prv-chips`)).not.toHaveText('Checking…', { timeout: 25_000 });
  // Round 3: the version line's "New version" mark lands when the core's background version read ends, and moves the head
  // the same way; a click that missed is clicked again until the row is open.
  await expect(async () => {
    if ((await chevron.getAttribute('aria-expanded')) !== 'true') await chevron.click();
    await expect(chevron).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Opens an account card's ⋯ menu unless it is open already. */
export async function more(card: Locator) {
  const menu = card.locator('details.acct-more');
  if (!(await menu.evaluate((d: HTMLDetailsElement) => d.open))) await menu.locator('summary').click();
}

/** Remove… on the named account, through its agent's row and ⋯. */
export async function clickRemove(app: Page, agent: string, label: string) {
  await openRow(app, agent);
  const card = app.locator(`#s-accounts .acct-card[data-agent-name="${agent}"]`).filter({ hasText: label }).first();
  await more(card);
  await card.getByRole('button', { name: `Remove ${agent} account ${label}` }).click();
}

/** Ticket 450: the add form (the Name field and its two ways to sign in) opens from the agent card's "Add account" button. */
export async function openAdd(app: Page, agent: string) {
  await app.locator(`#s-accounts .acct-agent[data-agent="${agent.toLowerCase()}"]`).getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(app.getByRole('group', { name: `Add ${agent[0].toUpperCase()}${agent.slice(1).toLowerCase()} account` })).toBeVisible();
}
