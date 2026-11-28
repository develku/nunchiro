// A project's lead proposes a trigger (docs/triggers.md): a card in Decisions says the trigger in one line and the
// project; Not now adds nothing; Add trigger adds it, asking first. A real core and a real lead seat.
import fs from 'node:fs';
import path from 'node:path';
import { type Core, expect, nunchiro, openWindow, test } from './fixtures';
import { mates, openSeat, repo, tokenClaude, tokenOf } from './leader-990';
import { patchSnapshots } from './tree-mock-states';

const triggers = (core: Core) =>
  fs.existsSync(path.join(core.home, 'triggers.json')) ? (JSON.parse(nunchiro(core.env, ['trigger', 'list', '--json'])) as { name: string; mode: string; github?: { repo: string } }[]) : [];

for (const scheme of ['light', 'dark'] as const) {
  test(`trigger_proposal_card (${scheme})`, async ({ app, core }) => {
    tokenClaude(core);
    const project = repo(core, 'nunchiro');
    mates(core, [{ id: 'bot-dalsu', name: 'Dalsu', job: 'Splits goals into tasks.', project, lead: true }]);
    await patchSnapshots(app);
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app, {}, core);
    const lead = await openSeat(app, core, 'Dalsu');
    const token = await tokenOf(core, lead);
    const propose = () =>
      nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, ['trigger', 'propose', 'ci-fix', '--on', 'github', '--repo', 'o/r', '--event', 'checks_failed', '--task', 'Find why the checks failed and fix it.']);
    expect(propose()).toContain('The user is asked on a card: ci-fix · GitHub o/r: checks fail · Claude: Find why the checks failed and fix it.');
    await app.locator('#icon-decisions').click();
    const card = app.locator('.dw [data-trigger-proposal="ci-fix"]');
    await expect(card.locator('.mc-head')).toHaveText('A lead proposes a trigger');
    await expect(card.locator('.rc-words b')).toHaveText('ci-fix · GitHub o/r: checks fail · Claude: Find why the checks failed and fix it.');
    await expect(card.locator('.rc-pill')).toHaveText('nunchiro');
    fs.mkdirSync('../.scratch/shots', { recursive: true });
    await app.screenshot({ path: `../.scratch/shots/trigger-proposal-${scheme}.png` });
    // Not now: nothing is added.
    await card.locator('[data-act="not-now"]').click();
    await expect(card).toHaveCount(0);
    expect(triggers(core)).toEqual([]);
    // Add trigger: it is added, asking first.
    propose();
    await card.locator('[data-act="add-trigger"]').click();
    await expect(card).toHaveCount(0);
    expect(triggers(core)).toMatchObject([{ name: 'ci-fix', mode: 'ask', github: { repo: 'o/r' } }]);
  });
}
