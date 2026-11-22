// V2.5-34 (finding 17): a session that shows its terminal (a shell: the terminal is its whole main view) has no
// composer, the terminal takes the keys; an agent session shows its chat and keeps the composer.
import { expect, openWindow, showComposer, test } from './fixtures';

test('composer_hidden_in_terminal_view: absent for a shell session, present in chat view', async ({ app, core }) => {
  const project = core.project('demo');
  const shell = core.shell(project, 'sh-one');
  const agent = core.agent(project, 'x', 'alpha');
  await openWindow(app);

  await app.locator(`.tab[data-tab="${shell.id}"]`).click();
  await expect(app.locator(`.term[data-session="${shell.id}"]`)).toBeVisible();
  await expect(app.locator('.composer')).toHaveCount(0);

  await app.locator(`.tab[data-tab="${agent.id}"]`).click();
  await expect(app.locator('.chat[data-session="' + agent.id + '"]')).toBeVisible();
  await expect(app.locator('.composer')).toBeVisible();

  await app.locator(`.tab[data-tab="${shell.id}"]`).click();
  await expect(app.locator('.composer')).toHaveCount(0);
});

test('composer_comes_back_on_request: "Focus the composer" shows one for the terminal view of that session only, "Hide or show" takes it away', async ({ app, core }) => {
  const project = core.project('demo');
  const one = core.shell(project, 'sh-one');
  const two = core.shell(project, 'sh-two');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${one.id}"]`).click();
  await expect(app.locator('.composer')).toHaveCount(0);
  await showComposer(app);
  await expect(app.locator('.composer textarea')).toBeFocused();
  await app.locator(`.tab[data-tab="${two.id}"]`).click();
  await expect(app.locator('.composer')).toHaveCount(0);
  await app.locator(`.tab[data-tab="${one.id}"]`).click();
  await expect(app.locator('.composer')).toBeVisible();
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await app.getByRole('dialog').getByRole('combobox').fill('Hide or show the composer');
  await app.keyboard.press('Enter');
  await expect(app.locator('.composer')).toHaveCount(0);
});
