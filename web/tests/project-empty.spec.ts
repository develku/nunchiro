// Ticket 370 item 7: the empty centre and tree tell a new user, in their language, to add a project; a user who has a
// project is told about sessions instead. Korean literals on purpose: a key missing from `ko` falls back to English and fails here.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { en, ko, ja, zhHans, zhHant, es, fr, pt } from '../src/i18n/areas/firstrun';
import { expect, test } from './fixtures';
import { seed } from './tree-seed';

const ADD = '프로젝트를 추가해 시작하세요';
const centre = (app: Page) => app.locator('.pane .empty');
const tree = (app: Page) => app.locator('.tree');

async function openKorean(app: Page) {
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' })));
  await app.goto('/'); // openWindow waits for the English "Connected" line
}
const shot = (app: Page, name: string) => app.screenshot({ path: `../.scratch/shots/project-empty-${name}-${test.info().project.name}.png` });

test('zero_projects_korean: centre and tree say to add a project, and the tree button opens the chooser', async ({ app }) => {
  await openKorean(app);
  await expect(centre(app).getByText(ADD, { exact: true })).toBeVisible();
  await expect(tree(app).locator('.empty')).toContainText(`${ADD}.`);
  await expect(centre(app)).not.toContainText('세션이 없습니다');
  // Walk 8 (ticket 700): the key hint read as broken Korean ("f 모든 곳에 힌트를 표시합니다"): each key is pressed.
  await expect(centre(app)).toContainText('f 키를 누르면 모든 곳에 힌트가 보입니다.');
  await shot(app, 'none');
  await tree(app).locator('.empty').getByRole('button', { name: '프로젝트 추가', exact: true }).click();
  await expect(app.getByRole('dialog', { name: '프로젝트 추가', exact: true })).toBeVisible();
});

test('project_no_open_session_korean: the session line shows, never the add-a-project line', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'alpha');
  await openKorean(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).hover(); // the close button shows on hover
  await app.locator(`.tab[data-tab="${s.id}"] ~ .x`).click();
  await expect(centre(app).locator('p').first()).toHaveText(/^열린 세션이 없습니다\. .*⌘K 키를 누르세요\.$/);
  await expect(app.locator('body')).not.toContainText(ADD);
  await expect(tree(app).locator('.empty')).toHaveCount(0);
  await shot(app, 'project');
});

test('added_project_no_session_korean: a project added from its folder counts, so the line is about sessions', async ({ app, core }) => {
  seed(core, { op: 'add', project: core.project('beta'), added: true });
  await openKorean(app);
  await expect(centre(app).locator('p').first()).toHaveText('아직 세션이 없습니다.');
  await expect(app.locator('body')).not.toContainText(ADD);
  await expect(tree(app).locator('.empty')).toHaveCount(0);
});

test('new_keys_in_all_8_locales: the key sets file and every catalogue carry them, translated', () => {
  const sets: Record<string, string[]> = JSON.parse(readFileSync(new URL('./i18n-key-sets.json', import.meta.url), 'utf8'));
  const keys = ['landing.noProjects', 'landing.noSessionOpen', 'landing.noSessions'] as const;
  expect(Object.keys(sets)).toHaveLength(8);
  for (const list of Object.values(sets)) expect(keys.filter((k) => !list.includes(k))).toEqual([]);
  for (const table of [ko, ja, zhHans, zhHant, es, fr, pt]) for (const k of keys) expect(table[k]).not.toBe(en[k]);
});
