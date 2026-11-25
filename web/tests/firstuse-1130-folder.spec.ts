// Ticket 1130 B-L5 C7 (owner 11-25 Q3, mockup docs/design/first-use-b-1130): the Folder row's default. Node side, no browser.
import { expect, test } from '@playwright/test';
import { folderRows } from '../src/settings/onboarding/state';

const HOME = '/n/team/home';
const claude = { path: '/code/my-app', agent: 'claude', at: 2 };

test('folder_rows_no_history: no Claude or Codex history starts on Assistants; a picked folder comes first, Assistants stays', () => {
  expect(folderRows([], HOME)).toEqual([{ path: HOME, agent: '', at: 0 }]);
  expect(folderRows([], HOME)[0].path).toBe(HOME);
  const picked = { path: '/code/picked', agent: '', at: 0 };
  expect(folderRows([picked], HOME).map((r) => r.path)).toEqual(['/code/picked', HOME]);
});

test('folder_rows_with_history: the history list is unchanged and has no Assistants row', () => {
  const list = [claude, { path: '/code/api', agent: 'codex', at: 1 }];
  expect(folderRows(list, HOME)).toBe(list);
  expect(folderRows([{ path: '/code/picked', agent: '', at: 0 }, ...list], HOME).map((r) => r.path)).toEqual(['/code/picked', '/code/my-app', '/code/api']);
});

test('folder_rows_unknown: nothing before the listing answers, and no Assistants row without its folder', () => {
  expect(folderRows(null, HOME)).toEqual([]);
  expect(folderRows([], '')).toEqual([]);
});
