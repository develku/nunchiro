// V2-4b: the problem card for an ACP agent that could not start or answer: each case shows its one fix, "Details" where
// the cause has some, and no fix at all for a refused Claude entry. A running ACP session never gets a card from what the
// agent prints, and a changed or unapproved entry is no card (the Agents sheet is the answer, see agents-page.spec).
import fs from 'node:fs';
import type { Session } from '../src/types';
import { agentsToml, fakeAcp, ownerOk, owner, tomlEntry } from './acp-fakes';
import { stripOnTop, expect, openWindow, test, type Core } from './fixtures';

test.beforeEach(({ core }) => stripOnTop(core));

const snapshot = (core: Core) => core.cli('snapshot', '--json').sessions as Session[];
function approve(core: Core, name: string) {
  const view = ownerOk(core, { op: 'acp_agent_status', name }).view;
  ownerOk(core, { op: 'acp_agent_grant', name, hash: view.hash });
}
const startAcp = (core: Core, name: string) => owner(core, { op: 'start', session: { kind: 'acp', project: core.project('demo'), args: [name], model: null, effort: null, resume: null } });
const band = (app: import('@playwright/test').Page) => app.locator('.problem-band');
async function show(app: import('@playwright/test').Page, core: Core, agent: string) {
  await expect.poll(() => snapshot(core).find((s) => s.acp_agent === agent)?.problem?.case, { timeout: 20_000 }).toBeTruthy();
  const id = snapshot(core).find((s) => s.acp_agent === agent)!.id;
  await openWindow(app);
  await app.locator(`button.row.wt2[data-menu-session="${id}"]`).click();
  return id;
}

test('not installed: a known agent offers its install page, a custom entry has no fix button', async ({ app, core }) => {
  fs.writeFileSync(agentsToml(core), tomlEntry('gemini', '/nonexistent/gemini', ['--experimental-acp']) + '\n' + tomlEntry('mine', '/nonexistent/mine'));
  approve(core, 'gemini');
  approve(core, 'mine');
  expect(startAcp(core, 'gemini').Ok?.session.state).toBe('failed');
  expect(startAcp(core, 'mine').Ok?.session.state).toBe('failed');
  await show(app, core, 'gemini');
  await expect(band(app)).toHaveAttribute('data-problem', 'not_installed');
  await expect(band(app)).toContainText('Gemini CLI is not installed.');
  await app.evaluate(() => ((window as any).open = (u: string) => (((window as any).__opened = u), null)));
  await band(app).getByRole('button', { name: 'Install page ↗' }).click();
  expect(await app.evaluate(() => (window as any).__opened)).toBe('https://github.com/google-gemini/gemini-cli');
  const mine = snapshot(core).find((s) => s.acp_agent === 'mine')!;
  await app.locator(`button.row.wt2[data-menu-session="${mine.id}"]`).click();
  await expect(band(app)).toContainText('mine is not installed.');
  await expect(band(app).getByRole('button')).toHaveCount(0);
});

test('signed out: Sign in opens the agent\'s own login in a visible tab', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'signout', 'signout 1.0', ['auth']);
  fs.writeFileSync(agentsToml(core), tomlEntry('signout', cmd));
  approve(core, 'signout');
  startAcp(core, 'signout');
  await show(app, core, 'signout');
  await expect(band(app)).toHaveAttribute('data-problem', 'logged_out');
  await expect(band(app)).toContainText('signout is not signed in.');
  await band(app).getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => snapshot(core).find((s) => s.label === 'Login: signout')?.kind).toBe('shell');
  await expect(app.locator('.tab').filter({ hasText: 'Login: signout' })).toBeVisible();
});

test('no ACP answer: Fix command opens the Agents sheet of that entry, with Details', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'mute', 'mute 1.0', ['v2']);
  fs.writeFileSync(agentsToml(core), tomlEntry('mute', cmd));
  approve(core, 'mute');
  startAcp(core, 'mute');
  await show(app, core, 'mute');
  await expect(band(app)).toHaveAttribute('data-problem', 'acp_no_answer');
  await expect(band(app)).toContainText('mute did not answer ACP: check its command.');
  await band(app).getByText('Details').click();
  await expect(band(app).locator('pre')).toContainText('ACP version');
  await band(app).getByRole('button', { name: 'Fix command' }).click();
  await expect(app.getByRole('heading', { level: 2, name: /Providers/ })).toBeVisible();
  await expect(app.getByRole('group', { name: 'mute' }).getByRole('textbox', { name: 'Command' })).toHaveValue(cmd);
});

test('a Claude entry without an API key: the reason in one line and no fix', async ({ app, core }) => {
  fs.writeFileSync(agentsToml(core), tomlEntry('cl', '/opt/claude-acp'));
  expect(startAcp(core, 'cl').Err).toContain('ANTHROPIC_API_KEY');
  await show(app, core, 'cl');
  await expect(band(app)).toHaveAttribute('data-problem', 'acp_refused');
  await expect(band(app)).toContainText('a Claude ACP agent needs ANTHROPIC_API_KEY');
  await expect(band(app).getByRole('button')).toHaveCount(0);
  await expect(band(app).locator('details')).toHaveCount(0);
});

test('a running ACP session never gets a card from what its agent prints', async ({ app, core }) => {
  const cmd = fakeAcp(core, 'talker', 'talker 1.0');
  fs.writeFileSync(agentsToml(core), tomlEntry('talker', cmd));
  approve(core, 'talker');
  const id = startAcp(core, 'talker').Ok!.session.id as string;
  await expect.poll(() => (snapshot(core).find((s) => s.id === id) as Session & { model?: string } | undefined)?.model).toBeTruthy();
  ownerOk(core, { op: 'agent_prompt', id, text: 'say:auth_required: Authentication required. No such file. not found. Please log in.' });
  await openWindow(app);
  await app.locator(`button.row.wt2[data-menu-session="${id}"]`).click();
  await app.waitForTimeout(800);
  expect(snapshot(core).find((s) => s.id === id)).toMatchObject({ state: 'running' });
  await expect(band(app)).toHaveCount(0);
});
