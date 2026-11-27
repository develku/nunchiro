// V2-9a project groups: the placement model and the key binding. Pure, no page.
import { expect, test } from '@playwright/test';
import { AREA, DEFAULT_BINDINGS, unassigned } from '../src/keys';
import { barOf, buildTree, byUrgency, cleanable, foldGroup, pickerList, place, rowState, type RowState, type WorktreeFact } from '../src/tree';
import { withResumed, type Decision, type Session, type TreeState } from '../src/types';
import { makeT } from './i18n-tables';
import { stateLine, withMerges } from '../src/tree/decisions';
import { stripSessions, toneOf } from '../src/tree/strip';

const EMPTY: TreeState = { groups: [], pins: [], folded: [] };

let n = 0;
const session = (project: string, over: Omit<Partial<Session>, 'attention'> & { attention?: Partial<Session['attention']> } = {}): Session => ({
  id: `s${++n}`,
  kind: 'claude',
  project,
  cwd: project,
  label: '',
  state: 'running',
  agent_version: null,
  untested: false,
  pid: 1,
  pending: [],
  ...over,
  attention: { working: false, waiting: false, stale: false, failed: false, last_activity: 0, ...over.attention },
});
const decision = (s: Session, at: number): Decision =>
  ({ id: `d${at}`, session_id: s.id, kind: 'permission', text: 'ok?', observed_at: at, choices: [] }) as unknown as Decision;
const groupsOf = (sessions: Session[]) => buildTree(sessions, sessions.map((s) => s.id))[0].groups;
const names = (gs: { name: string }[]) => gs.map((g) => g.name);

test('picker_binding_free: prefix j is unbound before the picker and waiting.next stays on prefix w', () => {
  const others = Object.entries(DEFAULT_BINDINGS).filter(([id]) => id !== 'projects.pick');
  expect(others.filter(([, bs]) => bs.includes('prefix KeyJ'))).toEqual([]);
  expect(DEFAULT_BINDINGS['projects.pick']).toEqual(['prefix KeyJ']);
  expect(DEFAULT_BINDINGS['waiting.next']).toEqual(['prefix KeyW']);
  expect(unassigned(DEFAULT_BINDINGS)).toEqual([]);
  for (const id of ['projects.pick', 'tree.expand-all', 'group.create', 'group.rename', 'group.dissolve', 'group.move', 'group.remove', 'project.pin'])
    expect(AREA[id], id).toBe('Views and docks');
});

test('never_fold: every project stays in first-seen order whatever its state; pins show once', () => {
  const w = session('/p/waiting');
  w.pending = [decision(w, 1)];
  const sessions = [
    w,
    session('/p/working', { attention: { working: true } }),
    session('/p/failed', { state: 'failed' }),
    session('/p/stale', { attention: { stale: true } }),
    session('/p/unread', { state: 'exited' }),
    session('/p/pinned'),
    session('/p/quiet-a'),
    session('/p/quiet-b', { state: 'exited' }),
  ];
  const [other] = place(groupsOf(sessions), { ...EMPTY, pins: ['/p/pinned'] });
  expect(other.name).toBeNull();
  expect(names(other.pinned)).toEqual(['pinned']);
  expect(names(other.open)).toEqual(['waiting', 'working', 'failed', 'stale', 'unread', 'quiet-a', 'quiet-b']);
  const all = [...other.pinned, ...other.open].map((g) => g.project);
  expect(new Set(all).size).toBe(all.length);
  expect(all).toHaveLength(sessions.length);
  // Pinning draws a project once, in the pinned part.
  const [again] = place(groupsOf(sessions), { ...EMPTY, pins: ['/p/working', '/p/quiet-a'] });
  expect(names(again.pinned)).toEqual(['working', 'quiet-a']);
  expect(names(again.open)).not.toContain('working');
  expect(names(again.open)).not.toContain('quiet-a');
});

test('groups sit under the ungrouped part in creation order; a group whose projects have no session is not drawn', () => {
  const sessions = [session('/p/a'), session('/p/b'), session('/p/c'), session('/p/d')];
  const tree: TreeState = {
    groups: [
      { name: 'Web', projects: ['/p/c', '/p/gone'] },
      { name: 'Empty', projects: ['/p/gone'] },
      { name: 'Core', projects: ['/p/b'] },
    ],
    pins: [],
    folded: [],
  };
  const placed = place(groupsOf(sessions), tree);
  expect(placed.map((g) => g.name)).toEqual([null, 'Web', 'Core']);
  expect(names(placed[0].open)).toEqual(['a', 'd']);
  expect(names(placed[1].open)).toEqual(['c']);
});

test('a group takes its most urgent child state and the sum of its counts; its items are oldest first', () => {
  const a = session('/p/a', { attention: { working: true } });
  const b = session('/p/b');
  b.pending = [decision(b, 9)];
  const c = session('/p/c');
  c.pending = [decision(c, 3)];
  const tree: TreeState = { groups: [{ name: 'G', projects: ['/p/a', '/p/b', '/p/c'] }], pins: [], folded: [] };
  const [g] = place(groupsOf([a, b, c]), tree);
  expect(g.urgency).toBe('waiting');
  expect(g.counts).toEqual({ working: 1, waiting: 2, attention: 0 });
  expect(g.items.map((d) => d.observed_at)).toEqual([3, 9]);
});

test('fold keys follow the core: group:<name>', () => {
  expect(foldGroup('Web')).toBe('group:Web');
});

test('status_picker_orders: waiting, failed, unread result, working, then last activity; each row carries its group', () => {
  const w = session('/p/waiting', { attention: { last_activity: 1 } });
  w.pending = [decision(w, 1)];
  const sessions = [
    session('/p/old', { attention: { last_activity: 10 } }),
    session('/p/working', { attention: { working: true, last_activity: 5 } }),
    session('/p/unread', { state: 'exited', attention: { last_activity: 2 } }),
    session('/p/failed', { state: 'failed', attention: { last_activity: 3 } }),
    session('/p/new', { attention: { last_activity: 20 } }),
    w,
  ];
  const tree: TreeState = { groups: [{ name: 'Web', projects: ['/p/failed', '/p/new'] }], pins: [], folded: [] };
  const list = pickerList(groupsOf(sessions), tree, new Set(['/p/unread']));
  expect(list.map((r) => r.group.name)).toEqual(['waiting', 'failed', 'unread', 'working', 'new', 'old']);
  expect(list.map((r) => r.groupName)).toEqual([null, 'Web', null, null, 'Web', null]);
});

// TREEROWS: row state, urgency order, bar segments and the clean-up selector. Pure; the clock is fixed.
const NOW = 10_000_000;
const wt = (sessions: Session[]) => ({ path: '/p/wt', name: 'wt', sessions });
const asked = (s: Session, kind: Decision['kind'], at: number, text = 'git push\nmore') => ({ ...decision(s, at), kind, text }) as Decision;

test('row_state_mapping: decision kinds, session states, facts and the #pr rule', () => {
  const en = makeT('en', 'en');
  const ko = makeT('ko', 'ko');
  const of = (s: Session, fact?: WorktreeFact) => rowState(wt([s]), [s], fact, NOW, undefined, en);
  for (const [kind, want] of [['permission', 'hand'], ['dialog', 'hand'], ['question', 'ask'], ['board', 'ask'], ['owner', 'ask']] as const) {
    const s = session('/p');
    s.pending = [asked(s, kind, NOW - 180_000)];
    expect(of(s), kind).toMatchObject({ kind: want, tone: 'you' });
  }
  const s = session('/p');
  s.pending = [asked(s, 'permission', NOW - 180_000)];
  expect(of(s).tip).toEqual(['Needs permission · git push', 'Claude · asked 3 min ago']);
  // B20 (ticket 991): a screen prompt names what it asks, never its first screen line.
  s.pending = [{ ...asked(s, 'permission', NOW - 180_000), text: 'Edit file\napp.py\n 11 + # A negative rate\nDo you want to make this edit to app.py?\n> 1. Yes\n  3. No' }];
  expect(of(s).tip[0]).toBe('Needs permission · Edit app.py');
  s.pending = [{ ...asked(s, 'dialog', NOW - 180_000), text: '/private/var/folders/x\n> 1. Yes, I trust this folder\n  2. No, exit' }];
  expect(of(s).tip[0]).toBe('Prompt in the terminal');
  // An agent's own terminal dialog is a prompt to answer there, not a permission (its decision card says the same).
  s.pending = [asked(s, 'dialog', NOW - 180_000)];
  expect(of(s).tip).toEqual(['Prompt in the terminal · git push', 'Claude · asked 3 min ago']);
  expect(rowState(wt([s]), [s], undefined, NOW, undefined, ko).tip).toEqual(['터미널의 프롬프트 · git push', 'Claude · 3분 전에 질문함']);
  // Ticket 701: a Korean window's tips come from the catalogue, never English literals.
  s.pending = [asked(s, 'permission', NOW - 30_000)];
  expect(rowState(wt([s]), [s], undefined, NOW, undefined, ko).tip).toEqual(['권한 필요 · git push', 'Claude · 1분 미만 전에 질문함']);
  expect(rowState(wt([s]), [session('/p')], undefined, NOW, undefined, ko).tip).toEqual(['쉬는 중 · Claude']); // one Korean word for idle (look 1117 v3)
  expect(rowState(wt([s]), [session('/p', { state: 'exited' })], undefined, NOW, undefined, ko).tip).toEqual(['완료 · Claude']);
  // Ticket 740: the Shell and ACP agent names in the tips are the catalogue's too.
  expect(rowState(wt([s]), [session('/p', { kind: 'shell' })], undefined, NOW, undefined, ko).tip).toEqual(['쉬는 중 · 셸']);
  expect(rowState(wt([s]), [session('/p', { kind: 'acp' })], undefined, NOW, undefined, ko).tip).toEqual(['쉬는 중 · ACP 에이전트']);
  expect(of(session('/p', { state: 'failed' }))).toMatchObject({ kind: 'fail', tone: 'bad', tip: ['Agent failed', expect.stringMatching(/^Claude · /)] });
  expect(of(session('/p', { attention: { working: true } }))).toMatchObject({ kind: 'work', tone: 'run' });
  // v19-Q9-cx: a terminal that refused the last write is broken, never the idle circle; the tip says what to do.
  expect(of(session('/p', { attention: { input_blocked: true } }))).toEqual({ kind: 'fail', tone: 'bad', tip: ['not reading input · Claude', 'The program is not reading what you type. Close the session or wait.'] });
  // Look 1117 v12 B N11-S2-3: a turn blocked in `agent ask --wait` waits for its answer: no work on its row.
  expect(of(session('/p', { attention: { working: true, asking: true } }))).toEqual({ kind: 'idle', tone: 'idle', tip: ['waiting for an answer · Claude'] });
  // Look 1117 v13 B N13-S3-6: the head's strip shows it as its row does (grey), never as a working bar.
  expect(toneOf(session('/p', { attention: { working: true, asking: true } }))).toBe('g');
  // Look 1117 v10 A-N6: two sessions in one worktree are one row, so one bar (the urgent one's); main-folder sessions keep one each.
  const pair = [session('/p'), session('/p', { attention: { working: true } })];
  expect(stripSessions({ main: [session('/p'), session('/p')], worktrees: [wt(pair)] }).map(toneOf)).toEqual(['g', 'g', 'b']);
  // Q7 item 12: a working row's time is its turn start (the row draws `at` as its age).
  expect(of(session('/p', { attention: { working: true, working_since: NOW - 9_000 } })).at).toBe(NOW - 9_000);
  expect(of(session('/p', { attention: { stale: true, last_activity: NOW - 600_000 } }))).toMatchObject({ kind: 'stale', tip: ['stale · no output for 10 min'] });
  expect(of(session('/p'))).toMatchObject({ kind: 'idle', tone: 'idle', tip: ['idle · Claude'] });
  expect(of(session('/p', { state: 'exited' })).tip).toEqual(['done · Claude']);
  // q67 look (new 6, 9): the row's state word is the status bar's own (`mw.status.*`), in its case and form. It read
  // "Idle · Shell" beside "idle · Shell", and in Spanish "Inactivo · Shell" beside the tab's and status bar's "inactiva".
  const es = makeT('es', 'es');
  for (const [over, key] of [[{}, 'mw.status.idle'], [{ state: 'exited' }, 'mw.status.done'], [{ state: 'resumable' }, 'mw.status.resumable'], [{ attention: { working: true } }, 'mw.status.working']] as const)
    for (const say of [en, ko, es]) expect(rowState(wt([s]), [session('/p', { kind: 'shell', ...over })], undefined, NOW, undefined, say).tip[0].split(' · ')[0]).toBe(say(key));
  expect(rowState(wt([s]), [session('/p', { kind: 'shell' })], undefined, NOW, undefined, es).tip).toEqual(['inactiva · Shell']);
  // Verify look (ticket 991 A7): a shell restarted in the row joins the finished one; the live one names the row.
  const restarted = [session('/p', { kind: 'shell', state: 'closed' }), session('/p', { kind: 'shell' })];
  // `ago`: since when it has rested, for the row's "idle · 2h" (design book), the live session's last activity.
  expect(rowState(wt(restarted), restarted, undefined, NOW, undefined, en)).toEqual({ kind: 'idle', tone: 'idle', tip: ['idle · Shell'], ago: 0 });
  // Facts.
  const idle = session('/p');
  expect(of(idle, { gone: true })).toMatchObject({ kind: 'gone', tip: ['Folder gone', 'Deleted outside the app'] });
  expect(of(idle, { pr: { number: 48, state: 'merged', age: 2 * 86_400_000 } })).toMatchObject({ kind: 'merge', tone: 'done', tip: ['Merged · PR #48 · 2d', 'Branch kept'] });
  expect(of(idle, { pr: { number: 54, state: 'checks_fail', failed: '2 of 12 failed · 1h' } })).toMatchObject({ kind: 'fail', tip: ['Checks failing · PR #54', '2 of 12 failed · 1h'] });
  expect(of(idle, { pr: { number: 53, state: 'open' } })).toMatchObject({ kind: 'pr', tone: 'ok', tip: ['PR #53 open'] });
  expect(rowState(wt([]), [], { newBranch: true }, NOW, undefined, en)).toMatchObject({ kind: 'new', tip: ['New · no session yet'] });
  // A working session beats a merged PR and a gone folder; a waiting one too. #53 only on a working row with a PR.
  const w = session('/p', { attention: { working: true } });
  expect(of(w, { pr: { number: 53, state: 'merged' } })).toMatchObject({ kind: 'work', pr: undefined });
  expect(of(w, { gone: true }).kind).toBe('work');
  expect(of(w, { pr: { number: 53, state: 'open' } })).toMatchObject({ kind: 'work', pr: 53, tip: ['working · Claude', 'PR #53 open · checks running'] });
  expect(of(w).pr).toBeUndefined();
  const q = session('/p');
  q.pending = [asked(q, 'question', 1)];
  expect(of(q, { pr: { number: 1, state: 'merged' } }).kind).toBe('ask');
});

test('rows_in_urgency_order: your turn oldest first, then broken; working, stale, PR open and idle rows keep first-seen order (991 A12)', () => {
  const mk = (label: string, s: Session, fact?: WorktreeFact) => ({ label, state: rowState(wt([s]), [s], fact, NOW) });
  const late = session('/p');
  late.pending = [asked(late, 'permission', 900)];
  const early = session('/p');
  early.pending = [asked(early, 'question', 100)];
  const rows = [
    mk('idle', session('/p')),
    mk('work', session('/p', { attention: { working: true } })),
    mk('late', late),
    mk('pr', session('/p'), { pr: { number: 2, state: 'open' } }),
    mk('fail', session('/p', { state: 'failed' })),
    mk('stale', session('/p', { attention: { stale: true } })),
    mk('early', early),
    mk('idle2', session('/p')),
  ];
  expect(byUrgency(rows).map((r) => r.label)).toEqual(['early', 'late', 'fail', 'idle', 'work', 'pr', 'stale', 'idle2']);
});

test('bar_segments: urgency order, at most 8 then +N, merged and gone rows leave', () => {
  const tones = { hand: 'you', idle: 'idle', work: 'run', merge: 'done', gone: 'idle' } as const;
  const kinds = (n: number, kind: keyof typeof tones = 'work'): RowState[] => Array.from({ length: n }, () => ({ kind, tone: tones[kind], tip: [''] }));
  expect(barOf([...kinds(2, 'idle'), ...kinds(1, 'hand')]).tones).toEqual(['you', 'idle', 'idle']);
  const eleven = barOf(kinds(11));
  expect(eleven.tones).toHaveLength(8);
  expect(eleven.more).toBe(3);
  expect(barOf([...kinds(1, 'merge'), ...kinds(1, 'gone')])).toEqual({ tones: [], more: 0 });
});

test('cleanable_counts_merged_and_gone: the clean-up selector lists only worktrees whose fact says merged or gone', () => {
  const a = session('/p/r', { cwd: '/p/r/a' });
  const b = session('/p/r', { cwd: '/p/r/b' });
  const c = session('/p/r', { cwd: '/p/r/c', attention: { working: true } });
  const [g] = groupsOf([a, b, c]);
  const facts = new Map<string, WorktreeFact>([
    ['/p/r/a', { pr: { number: 1, state: 'merged' } }],
    ['/p/r/b', { gone: true }],
    ['/p/r/c', { gone: true }], // a working session keeps its row
  ]);
  expect(cleanable(g, facts, NOW).map((x) => x.w.name)).toEqual(['a', 'b']);
  expect(cleanable(g, new Map(), NOW)).toEqual([]);
});

// Ticket 178 threat 5: an account's own Login and Logout tabs never make its config folder a tree project; a project
// whose path only looks alike stays.
test('account_folder_never_a_tree_project: Login and Logout tabs in an account folder form no project; look-alike paths stay', () => {
  const folder = '/Users/me/.nunchiro/accounts/claude/0f3c2a1e-9b7d-4c1a-8e2f-123456789abc';
  const login = session(folder, { kind: 'shell', label: 'Login: work', account_tab: true });
  const logout = session(`${folder.replace('claude', 'codex')}`, { kind: 'shell', label: 'Logout: team', state: 'exited', account_tab: true });
  const real = session('/Users/me/code/app');
  const alike = session('/Users/me/code/accounts/claude/not-an-id');
  const groups = groupsOf([login, logout, real, alike]);
  expect(names(groups)).toEqual(['app', 'not-an-id']);
  expect(groups.flatMap((g) => g.main.map((s) => s.id))).toEqual([real.id, alike.id]);
  expect(buildTree([login, logout], [login.id, logout.id])).toEqual([]);
});

// Ticket 178 round 2: only the Login/Logout shell shape is left out. An agent started in an account folder (an agent
// with tools among the credentials) stays in the tree, its pending ask counted, and so does a shell there by another
// name or an agent labelled like a login tab.
test('agent_session_in_account_folder_stays_visible: an agent in an account folder keeps its row and its waiting ask', () => {
  const folder = '/Users/me/.nunchiro/accounts/claude/0f3c2a1e-9b7d-4c1a-8e2f-123456789abc';
  const agent = session(folder, { kind: 'claude', label: 'Login: work', attention: { waiting: true } });
  agent.pending = [decision(agent, 5)];
  const shell = session(folder, { kind: 'shell', label: 'my shell' });
  const deeper = session(folder, { kind: 'shell', label: 'Login: work', cwd: `${folder}/x` });
  const login = session(folder, { kind: 'shell', label: 'Login: work', account_tab: true });
  const [g] = groupsOf([agent, shell, deeper, login]);
  expect(g.project).toBe(folder);
  expect([...g.main, ...g.worktrees.flatMap((w) => w.sessions)].map((s) => s.id).sort()).toEqual([agent.id, deeper.id, shell.id].sort());
  expect(g.items.map((d) => d.id)).toEqual(['d5']);
  expect(g.counts.waiting).toBe(1);
  expect(g.urgency).toBe('waiting');
});

// Ticket 322 (security review): an agent can start a shell in the agent config folder with a login label; without the
// core flag it stays in the tree where the owner sees it.
test('account_tab_needs_the_core_flag: a shell that only looks like a login tab stays in the tree', () => {
  const spoof = session('/Users/me/.claude', { kind: 'shell', label: 'Login: Default' });
  const real = session('/Users/me/.claude', { kind: 'shell', label: 'Login: Default', account_tab: true });
  expect(groupsOf([spoof, real]).flatMap((g) => g.main.map((s) => s.id))).toEqual([spoof.id]);
});

test('B20 (ticket 991): the decision line under a session is a state phrase, never a cut of the screen', () => {
  const en = makeT('en', 'en');
  const d = (kind: Decision['kind'], text: string) => ({ id: 'd', session_id: 's', scope: 'main', kind, text, choices: [], observed_at: 1, actionable: true }) as Decision;
  expect(stateLine(d('permission', 'Caution\nEdit file\napp.py\nDo you want to make this edit to app.py?\n❯ 1. Yes\n  3. No'), en)).toBe('Edit app.py');
  expect(stateLine(d('permission', 'Bash command\n\n  python -m pytest\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No'), en)).toBe('Run python -m pytest');
  // B20 (w8): a hook's permission (its tool input, JSON) reads the same, never a cut of the path.
  expect(stateLine(d('permission', JSON.stringify({ file_path: '/private/var/folders/x/app.py', old_string: 'a', new_string: 'b' })), en)).toBe('Edit app.py');
  expect(stateLine(d('permission', JSON.stringify({ command: 'python -m pytest', description: 'Run tests' })), en)).toBe('Run python -m pytest'); // B20 (w8): the same phrase as a screen permission
  expect(stateLine(d('dialog', 'these files. Your trust decision will be saved.\n❯ 1. Yes, I trust\n  2. No, exit'), en)).toBe('Needs an answer in the terminal');
  expect(stateLine(d('question', JSON.stringify({ questions: [{ question: 'Which currency?' }] })), en)).toBe('Which currency?');
  // Look 1117 v9 B N-S3-8: Codex's "$ <command>", wrapped by a narrow terminal, reads whole (not its last line).
  const cx = 'Would you like to run the following command?\n\nReason: Allow the exact command?\n\n$ echo hi >\n/Volumes/data/projects/demo-app/.scratc\nh/look-1117/v9/b/cxout.txt\n\n› 1. Yes, proceed (y)\n  3. No (esc)';
  expect(stateLine(d('permission', cx), en)).toBe('Run echo hi >\n/Volumes/data/projects/demo-app/.scratc\nh/look-1117/v9/b/cxout.txt');
  // Codex w25-e: the wrap is never guessed, so two arguments never merge into one path.
  const rm = 'Would you like to run the following command?\n\n$ rm -rf /tmp/a \n/tmp/b\n\n› 1. Yes, proceed (y)\n  3. No (esc)';
  expect(stateLine(d('permission', rm), en)).toBe('Run rm -rf /tmp/a\n/tmp/b');
});

// N10 (look 1117): ended side chats stayed as "Side chat, Done" in the tree's "N done" and on the Board.
test('ended_side_chats_leave_the_tree (N10)', () => {
  const main = session('/p', { id: 'main', state: 'running' });
  const live = session('/p', { id: 'side-live', state: 'running', side_chat: true } as Partial<Session>);
  const ended = session('/p', { id: 'side-ended', state: 'closed', side_chat: true } as Partial<Session>);
  const ids = buildTree([main, live, ended], []).flatMap((m) => m.groups.flatMap((g) => g.main.map((s) => s.id)));
  expect(ids.sort()).toEqual(['main', 'side-live']);
});

// Look 1117 v4 (B S3-5): after a core restart a resumable row read "Finished · Claude", which does not say Resume works.
test('resumable_row_says_resumable', () => {
  const en = makeT('en', 'en');
  const s = session('/p', { id: 'r', kind: 'claude', state: 'resumable' } as Partial<Session>);
  const st = rowState({ path: 'main:r', name: 'r', sessions: [s] }, [s], undefined, Date.now(), undefined, en);
  expect(st.tip[0]).toMatch(/^resumable · /);
});

test('a resumed lead answers to its old id, so its merge card names it (look 1117 v13 B N13-S3-3)', () => {
  const lead = session('/p', { resumed_from: ['old-lead'] });
  const other = session('/p');
  expect(withResumed(new Map([lead, other].map((s) => [s.id, s])), [lead, other]).get('old-lead')).toBe(lead);
});

test('a merge line taken from its task\'s board card keeps the lead as its asker (look v15 B, v13-B-N13-S3-3)', () => {
  const merge = { id: 'o1', session_id: 'lead-now', kind: 'owner', text: '', observed_at: 1, choices: [], owner: { type: 'merge', task: 't5', title: 'Add c.txt', place: '/p', revision: 'abc' } } as unknown as Decision;
  const card = { id: 'b1', session_id: '', scope: '/p', kind: 'board', text: 'Add c.txt', observed_at: 2, choices: [], board: { title: 'Add c.txt' } } as unknown as Decision;
  const [line] = withMerges([card], [merge], makeT('en', 'en'));
  expect([line.id, line.session_id, line.owner?.type]).toEqual(['b1', 'lead-now', 'merge']);
  expect(withMerges([], [merge], makeT('en', 'en'))[0].session_id).toBe('lead-now');
});
