// Triggers under the Schedules list (docs/triggers.md): the owner adds a GitHub trigger and a webhook trigger in the
// window, against a real core. The core keeps them (`trigger list`); a webhook's secret is shown once and never listed;
// the switch pauses one; Remove asks first.
import fs from 'node:fs';
import { expect, openWindow, test } from './fixtures';
import { owner } from './leader-990';
import { openWidget } from './schedules-seed';

type Listed = { name: string; on: string; mode: string; paused?: boolean; secret?: string; github?: { repo: string; event: string; label?: string; any_author?: boolean }; run: { task?: string } };
const triggers = (core: Parameters<typeof owner>[0]) => owner(core, { op: 'trigger', action: { do: 'list' } }).Ok.triggers as Listed[];

for (const scheme of ['light', 'dark'] as const) {
  test(`triggers_added_in_the_window (${scheme})`, async ({ app, core }) => {
    const demo = core.project('demo');
    core.shell(demo, 'main');
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app);
    const widget = await openWidget(app);
    await widget.locator('[data-move="tab"]').click();
    const view = app.locator('.schedv[data-where="tab"]');
    const section = view.locator('[data-triggers]');
    await expect(section.getByText('No triggers yet.')).toBeVisible();

    // A GitHub trigger: checks fail on a pull request of o/r.
    await section.getByRole('button', { name: 'Add trigger' }).click();
    let form = section.getByRole('form', { name: 'New trigger' });
    await form.getByRole('combobox', { name: 'When' }).selectOption({ label: 'GitHub: checks fail on my pull request' });
    await form.getByRole('textbox', { name: 'Repository' }).fill('o/r');
    // Only the owner's own pull requests unless the owner says anyone's (a stranger's could start a run).
    await expect(form.getByRole('checkbox', { name: "Anyone's, not only mine" })).not.toBeChecked();
    await form.getByRole('textbox', { name: 'Name' }).fill('fix checks');
    await form.getByRole('textbox', { name: 'What' }).fill('Find why the checks failed and fix it.');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    const fix = section.locator('[data-trigger="fix-checks"]');
    await expect(fix).toContainText('GitHub · o/r · demo');
    await expect(fix).toContainText('not fired yet');
    await expect(fix.locator('.chip')).toHaveText('Ask me first');
    expect(triggers(core)).toMatchObject([{ name: 'fix-checks', on: 'github', mode: 'ask', github: { repo: 'o/r', event: 'checks_failed' }, run: { task: 'Find why the checks failed and fix it.' } }]);
    expect(triggers(core)[0].github?.any_author).toBeUndefined();

    // A webhook trigger that starts by itself: the address shows, and the secret is shown once after Add.
    await section.getByRole('button', { name: 'Add trigger' }).click();
    form = section.getByRole('form', { name: 'New trigger' });
    await form.getByRole('combobox', { name: 'When' }).selectOption({ label: 'A webhook is called' });
    await form.getByRole('textbox', { name: 'Name' }).fill('ci');
    await expect(form.locator('.trig-code')).toHaveText('http://127.0.0.1:47800/hooks/ci');
    await form.getByRole('textbox', { name: 'What' }).fill('The nightly build failed. Look at the log below.');
    await form.getByRole('combobox', { name: 'Before it starts' }).selectOption('auto');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    const secret = (await section.locator('[data-trigger-secret] code').textContent()) ?? '';
    expect(secret).toMatch(/^[0-9a-f]{32}$/);
    await expect(section.locator('[data-trigger="ci"] .chip')).toHaveText('Starts by itself');
    const ci = triggers(core).find((x) => x.name === 'ci')!;
    expect(ci).toMatchObject({ on: 'webhook', mode: 'auto', secret: 'set' }); // never the secret itself
    fs.mkdirSync('../.scratch/shots', { recursive: true });
    await app.screenshot({ path: `../.scratch/shots/triggers-window-${scheme}.png` });
    await section.getByRole('button', { name: 'Done' }).click();
    await expect(section.locator('[data-trigger-secret]')).toHaveCount(0);

    // The switch pauses it in the core; Remove asks first.
    await section.getByRole('switch', { name: 'Trigger fix-checks' }).click();
    await expect.poll(() => triggers(core).find((x) => x.name === 'fix-checks')?.paused).toBe(true);
    await section.getByRole('button', { name: 'Remove trigger ci' }).click();
    await section.getByRole('group', { name: 'Remove this trigger?' }).getByRole('button', { name: 'Remove' }).click();
    await expect(section.locator('[data-trigger="ci"]')).toHaveCount(0);
    expect(triggers(core).map((x) => x.name)).toEqual(['fix-checks']);
    // The narrow widget in the right sidebar: the run's line goes under the name.
    await view.locator('[data-move="side"]').click();
    await expect(app.locator('.sbar .schedv [data-trigger="fix-checks"]')).toBeVisible();
    await app.screenshot({ path: `../.scratch/shots/triggers-window-side-${scheme}.png` });
  });
}
