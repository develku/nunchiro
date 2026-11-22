// Ticket 373 round 2: the Diff git button's ladder as a table, from facts to label, prompt and disabled reason. Pure, no page.
import { expect, test } from '@playwright/test';
import { gitAction, ladder, type Ask, type GitFacts } from '../src/diff/gitAction';
import type { Key } from '../src/i18n';
import type { Session } from '../src/types';

const facts = (f: Partial<GitFacts> = {}): GitFacts => ({ branch: 'fix-login', dirty: false, upstream: false, ahead: 0, behind: 0, ahead_of_default: 0, is_default: false, has_remote: true, upstream_unknown: false, gh: true, ...f });
const L = (k: string) => `gitActions.label.${k}` as Key;
const W = (k: string) => `gitActions.why.${k}` as Key;
type Row = [string, Partial<GitFacts>, boolean, Key, Ask | null, Key | undefined];

const LADDER: Row[] = [
  ['changes, no PR', { dirty: true }, false, L('commitPushPr'), 'commit_push_pr', undefined],
  ['changes, PR open', { dirty: true }, true, L('commitPush'), 'commit_push', undefined],
  ['changes, no gh', { dirty: true, gh: false }, false, L('commitPush'), 'commit_push', W('noGh')],
  ['changes, no remote', { dirty: true, has_remote: false }, false, L('commit'), 'commit', undefined],
  ['no upstream, local commit', { ahead_of_default: 1 }, false, L('pushPr'), 'push_pr', undefined],
  ['no upstream, local commit, PR open', { ahead_of_default: 1 }, true, L('push'), 'push', undefined],
  ['no upstream, local commit, no gh', { ahead_of_default: 1, gh: false }, false, L('push'), 'push', W('noGh')],
  ['no upstream, nothing ahead', {}, false, L('push'), null, W('noCommits')],
  ['no upstream, nothing ahead, PR open', {}, true, L('commit'), null, W('upToDate')],
  ['no remote, clean', { has_remote: false }, false, L('push'), null, W('noRemote')],
  ['diverged', { upstream: true, ahead: 1, behind: 1 }, false, L('sync'), null, W('diverged')],
  ['behind', { upstream: true, behind: 2 }, false, L('pull'), 'pull', undefined],
  ['ahead of upstream', { upstream: true, ahead: 1 }, false, L('pushPr'), 'push_pr', undefined],
  ['ahead of upstream, PR open', { upstream: true, ahead: 1 }, true, L('push'), 'push', undefined],
  ['pushed, ahead of default', { upstream: true, ahead_of_default: 2 }, false, L('createPr'), 'create_pr', undefined],
  ['pushed, ahead of default, no gh', { upstream: true, ahead_of_default: 2, gh: false }, false, L('createPr'), null, W('noGh')],
  ['pushed, up to date', { upstream: true }, false, L('commit'), null, W('upToDate')],
  ['pushed, PR open', { upstream: true, ahead_of_default: 2 }, true, L('commit'), null, W('upToDate')],
  ['detached', { branch: null, dirty: true }, false, L('commit'), null, W('detached')],
  // Ticket 393: an upstream that is set but unreadable refuses push and PR only; a commit of changes is still offered.
  ['upstream unknown, changes', { upstream_unknown: true, dirty: true }, false, L('commit'), 'commit', W('unknown')],
  ['upstream unknown, ahead', { upstream_unknown: true, upstream: true, ahead: 1 }, false, L('push'), null, W('unknown')],
  ['upstream unknown, local commit', { upstream_unknown: true, ahead_of_default: 1 }, false, L('push'), null, W('unknown')],
];

test('git_actions_ladder: each rung label, prompt and reason from the facts', () => {
  for (const [name, f, openPr, label, ask, why] of LADDER) expect(ladder(facts(f), openPr), name).toEqual({ label, ask, ...(why ? { why } : {}) });
});

const session = (s: Partial<Session> = {}, working = false) =>
  ({ id: 's', kind: 'claude', state: 'running', pending: [], attention: { working, waiting: false, stale: false, failed: false, last_activity: 0 }, ...s }) as Session;
const permission = { kind: 'permission' } as Session['pending'][number];

test('git_actions_session: each disabled reason sends nothing', () => {
  const dirty = facts({ dirty: true });
  const rows: [string, Session, GitFacts | null, Key, Key][] = [
    ['shell', session({ kind: 'shell' }), dirty, L('commit'), W('shell')],
    ['exited', session({ state: 'exited' }), dirty, L('commit'), W('notRunning')],
    ['agent ended', session({ agent_ended: true }), dirty, L('commit'), W('notRunning')],
    ['blocked', session({ pending: [permission] }), dirty, L('commit'), W('blocked')],
    ['git unreadable', session(), null, L('commit'), W('unknown')],
    ['default branch', session(), facts({ dirty: true, is_default: true, branch: 'main' }), L('commitPushPr'), W('defaultBranch')],
    ['default branch, ahead', session(), facts({ is_default: true, branch: 'main', upstream: true, ahead: 1 }), L('pushPr'), W('defaultBranch')],
    ['working', session({}, true), dirty, L('commitPushPr'), W('working')],
  ];
  for (const [name, s, g, label, why] of rows) expect(gitAction(s, g, false), name).toEqual({ label, ask: null, why });
  expect(gitAction(session(), dirty, false)).toEqual({ label: L('commitPushPr'), ask: 'commit_push_pr' });
});
