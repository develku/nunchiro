// Ticket v1b-12: matching a pending permission to an edit call, and what the card may send. Pure functions, no page.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatEvent, Data } from '../src/chat/feed';
import { buildRows, viewRows } from '../src/chat/model';
import { sideContext, userView, wakeSplit } from '../src/chat/conversation';
import { cardHeldRows } from '../src/chat/held';
import { canonical, cardPlan as planFor, matches, pendingEdit, sessionPath } from '../src/chat/pending';
import { makeT } from './i18n-tables';
import { plan } from '../src/queue/answer';
import type { Decision, Session } from '../src/types';
const cardPlan = (d: Parameters<typeof planFor>[0], s: Parameters<typeof planFor>[1]) => planFor(d, s, makeT('en', 'en'));

let cursor = 0;
const ev = (data: Data): ChatEvent => ({ schema_version: 1, cursor: ++cursor, data });
const use = (tool_id: string, name: string, input: unknown) => ev({ kind: 'tool_use', tool_id, name, input });
const result = (tool_id: string, is_error = false) => ev({ kind: 'tool_result', tool_id, output: 'ok', is_error });
// The core stores a hook item's `tool_input` as its text, serialised with sorted keys.
const item = (input: unknown, extra: Partial<Decision> = {}): Decision => ({
  id: `d${++cursor}`,
  session_id: 's',
  scope: 'main',
  kind: 'permission',
  text: canonical(input),
  choices: [],
  observed_at: 1,
  actionable: true,
  ...extra,
});
// V2-8e r2 (b210f01a; needs 107): the core flags a risky permission (absent = risky) and the card then offers Deny only; a
// risky allow is made in the Decisions widget card, by focus then Enter. The cases below that expect Accept are
// the non-risky items the core marks `risky: false` (an edit inside the session folder), so the helper says so.
const safe = (input: unknown, extra: Partial<Decision> = {}): Decision => item(input, { ...extra, risky: false } as Partial<Decision>);
const session = (state: Session['state'] = 'running'): Session =>
  ({ id: 's', kind: 'claude', project: '/p', cwd: '/p/repo', label: 'a', state, agent_version: null, untested: false, pid: 1, attention: {}, pending: [] }) as unknown as Session;
const EDIT = { file_path: '/p/repo/a.txt', old_string: 'old\nkept', new_string: 'new\nkept\nmore', replace_all: false };

test('a pending Edit, MultiEdit or Write call renders as a diff row from its input, +n −m counted from its lines', () => {
  const rows = buildRows([
    use('e1', 'Edit', EDIT),
    use('m1', 'MultiEdit', { file_path: '/p/repo/b.txt', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: '' }] }),
    use('w1', 'Write', { file_path: '/p/repo/c.txt', content: 'x\ny\n' }),
    use('r1', 'Read', { file_path: '/p/repo/a.txt' }),
  ]);
  expect(rows.map((r) => r.kind)).toEqual(['diff', 'diff', 'diff', 'tool']);
  const [e, m, w] = rows as Extract<(typeof rows)[number], { kind: 'diff' }>[];
  // B9 (ticket 991): a line the edit keeps is context, not removed and added again.
  expect([e.edit.added, e.edit.removed, e.edit.hunks]).toEqual([2, 1, ['-old', '+new', ' kept', '+more']]);
  expect([m.edit.added, m.edit.removed]).toEqual([1, 2]);
  expect([w.edit.path, w.edit.added, w.edit.removed]).toEqual(['/p/repo/c.txt', 2, 0]);
});

test('B9: a pure addition written as -anchor/+new/+anchor counts +3 −0, for a Codex patch and a pending Claude Edit', () => {
  const anchor = 'def format_price(amount):';
  const rows = buildRows([
    ev({ kind: 'edit', tool_id: 'c1', path: 'app.py', added: 4, removed: 1, hunks: ['@@', `-${anchor}`, '+def shipping():', '+    return 5', '+', `+${anchor}`] }),
    use('e9', 'Edit', { file_path: '/p/repo/app.py', old_string: `${anchor}\n`, new_string: `def shipping():\n    return 5\n\n${anchor}\n` }),
  ]);
  const [c, e] = rows as Extract<(typeof rows)[number], { kind: 'diff' }>[];
  // N11 (look 1117): Codex's bare "@@" carries no line numbers: none leads the card, one between hunks is a gap mark.
  expect([c.edit.added, c.edit.removed, c.edit.hunks]).toEqual([3, 0, ['+def shipping():', '+    return 5', '+', ` ${anchor}`]]);
  expect([e.edit.added, e.edit.removed]).toEqual([3, 0]);
  const [two] = buildRows([ev({ kind: 'edit', tool_id: 'c2', path: 'a.py', added: 2, removed: 0, hunks: ['@@', '+a', '@@', '+b'] })]) as Extract<(typeof rows)[number], { kind: 'diff' }>[];
  expect(two.edit.hunks).toEqual(['+a', '⋯', '+b']);
});

test('B11: a slash command reads as typed; a pasted handoff folds into its own part', () => {
  expect(userView('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>')).toEqual({ text: '/model sonnet' });
  expect(userView('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>')).toEqual({ text: '/clear' });
  const handoff = 'Handoff from Claude (2 turns, session abcd1234)\n\n## Requests\n1. fix it';
  expect(userView(`<pasted_content id="b819">\n${handoff}\n</pasted_content id="b819">`)).toEqual({ text: '', handoff });
  // After one Codex look: an open tag with no close and many spaces is read in one pass (a lazy regex went cubic here).
  const open = `<pasted_content>${' '.repeat(200_000)}x`;
  const t0 = Date.now();
  expect(userView(open)).toEqual({ text: open });
  expect(Date.now() - t0).toBeLessThan(200);
  const tags = '<command-name>'.repeat(40_000);
  const t1 = Date.now();
  expect(userView(tags)).toEqual({ text: tags });
  expect(Date.now() - t1).toBeLessThan(200);
  expect(userView('a <pasted_content id="1">\n one \n</pasted_content id="1"> b <pasted_content>two</pasted_content>')).toEqual({ text: 'a one b two' });
  expect(userView(`${sideContext(handoff)}\n\nwhy?`)).toEqual({ text: 'why?', handoff: sideContext(handoff).split('\n').slice(1, -1).join('\n') });
  expect(userView('plain <b>text</b>')).toEqual({ text: 'plain <b>text</b>' });
});

test('990: a seat\'s brief folds and a worker\'s wake line is a note, not the person\'s words', () => {
  const brief = 'You are Lead, a teammate of this user in Nunchiro. This is a standing role: you keep it across conversations.\n\n## Your job\nLead.';
  expect(userView(brief)).toEqual({ text: '', brief });
  expect(userView(`\n\n<pasted_content id="97a3">\n${brief}\n</pasted_content id="97a3">`)).toEqual({ text: '', brief }); // as Claude records a long paste
  // Ticket 1072: wake lines are drawn by buildRows (wakes row); the lines stay what the pattern knows.
  for (const line of ['worker tax done; report says: "STATUS: done"', 'worker review-tax blocked (question)', 'worker a b failed', '1 new messages: run nunchiro agent check']) expect(wakeSplit(line)).toEqual({ n: 1, team: 0, rest: '' }); // 1085: team counts the core's team lines
  // What a person types stays theirs: another sentence.
  expect(wakeSplit('and then?\nworker tax done')).toBeNull();
  expect(userView('You are right, do it.')).toEqual({ text: 'You are right, do it.' });
});

test('v16 A S3: a seat\'s brief held behind the trust card is not shown or given back as the person\'s words', () => {
  const row = (id: string, content: string, status = 'queued') => ({ id, sender: 'user', status, content });
  const brief = row('b', 'You are Lead, a teammate of this user in Nunchiro. This is a standing role.\n## Your job\nLead.');
  const mine = row('m', 'use make test instead');
  expect(cardHeldRows([brief, mine, row('d', 'sent', 'delivered')])).toEqual({ own: [mine], brief: true });
  expect(cardHeldRows([mine])).toEqual({ own: [mine], brief: false });
});

test('B19: a finished turn shows one changed-files card (per-file +/-), not also the "N changed files" row', () => {
  const rows = buildRows([
    ev({ kind: 'message', role: 'user', text: 'fix' }),
    use('e1', 'Edit', EDIT),
    result('e1'),
    ev({ kind: 'edit', tool_id: 'e1', path: '/p/repo/a.txt', added: 1, removed: 1, hunks: ['-old', '+new'] }),
    ev({ kind: 'turn', turn_id: 't', state: 'completed', files: ['a.txt'] } as Data),
  ]);
  expect(rows.some((r) => r.kind === 'turnfiles')).toBe(true); // Verbose keeps every row as built
  const shown = viewRows(rows, 'normal');
  expect(shown.filter((r) => r.kind === 'turnfiles')).toHaveLength(0);
  expect(shown.filter((r) => r.kind === 'changes')).toMatchObject([{ added: 1, removed: 1, turn: ['a.txt'] }]);
});

test('N21: a Codex patch made inside its exec script gets the same changes card', () => {
  const rows = buildRows([
    ev({ kind: 'message', role: 'user', text: 'fix' }),
    use('x1', 'exec', 'text(await tools.apply_patch("*** Begin Patch"));'),
    ev({ kind: 'edit', tool_id: 'x1', path: '/p/repo/app.py', added: 3, removed: 0, hunks: ['+a', '+b', '+c'] }),
    ev({ kind: 'tool_result', tool_id: 'x1', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: '{}' }], is_error: false }),
    ev({ kind: 'turn', turn_id: 't', state: 'completed', files: ['app.py'] } as Data),
  ]);
  expect(viewRows(rows, 'normal').filter((r) => r.kind === 'changes')).toMatchObject([{ added: 3, removed: 0 }]);
});

test('S2-7: a question\'s "Type something." is no plain choice (its digit only opens a text field); the others are', () => {
  const d = item({ questions: [{ question: 'Name?' }] }, { kind: 'question', choices: ['alpha', 'beta', 'Type something.', 'Chat about this'].map((label, i) => ({ label, keys: [String(i + 1)], changes_settings: false })) });
  const labels = plan(d, session(), makeT('en', 'en')).acts.map((a) => a.label);
  expect(labels).toEqual(['1 alpha', '2 beta', '4 Chat about this', 'Cancel']);
});

test('a call with a result is no pending card: an error stays a tool row, as in 03', () => {
  const rows = buildRows([use('e1', 'Edit', EDIT), result('e1', true)]);
  expect(rows.map((r) => r.kind)).toEqual(['tool']);
  expect(pendingEdit({ kind: 'tool_use', tool_id: 'x', name: 'Edit', input: { old_string: 'a' } })).toBeNull();
});

test('matching: same tool input in any key order; not a finished call, a screen-text item or another kind', () => {
  const rows = buildRows([use('e1', 'Edit', EDIT), use('e0', 'Edit', { ...EDIT, new_string: 'z' }), result('e0')]);
  // Keys in the agent's order on one side, sorted on the other.
  const d = item({ replace_all: false, new_string: EDIT.new_string, file_path: EDIT.file_path, old_string: EDIT.old_string });
  expect([...matches(rows, [d]).entries()]).toEqual([['e1', d]]);
  expect(matches(rows, [item({ ...EDIT, new_string: 'z' })]).size).toBe(0);
  expect(matches(rows, [{ ...d, text: 'Edit file\nDo you want to proceed?\n1. Yes' }]).size).toBe(0);
  expect(matches(rows, [{ ...d, kind: 'question' }]).size).toBe(0);
  expect(matches(rows, [{ ...d, text: canonical({ ...EDIT, file_path: '/p/repo/b.txt' }) }]).size).toBe(0);
});

test('matching: two identical pending calls or two identical items match nothing; one item with two cards marks only its own', () => {
  const two = buildRows([use('e1', 'Edit', EDIT), use('e2', 'Edit', EDIT)]);
  expect(matches(two, [item(EDIT)]).size).toBe(0);
  const one = buildRows([use('e1', 'Edit', EDIT)]);
  expect(matches(one, [item(EDIT), item(EDIT)]).size).toBe(0);
  const w = { file_path: '/p/repo/b.txt', content: 'b' };
  const mixed = buildRows([use('e1', 'Edit', EDIT), use('w1', 'Write', w)]);
  const d = item(w);
  expect([...matches(mixed, [d]).entries()]).toEqual([['w1', d]]);
});

test('matching: a Codex apply_patch call that raises a permission item gets the same card', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.rs\n@@\n-old\n+new\n*** End Patch\n';
  const rows = buildRows([use('c1', 'apply_patch', { input: patch }), ev({ kind: 'edit', tool_id: 'c1', path: 'src/a.rs', added: 1, removed: 1, hunks: ['@@', '-old', '+new'] })]);
  expect(rows.map((r) => r.kind)).toEqual(['diff']);
  const d = item({ input: patch });
  expect([...matches(rows, [d]).entries()]).toEqual([['c1', d]]);
  expect(matches(buildRows([use('c2', 'apply_patch', { input: patch }), result('c2')]), [d]).size).toBe(0);
});

test('card plan: Accept is allow once, Reject is deny; never an "always"; restored or not running sends nothing', () => {
  const s = session();
  const plain = cardPlan(safe(EDIT), s);
  expect([plain.accept?.answer, plain.reject?.answer, plain.note]).toEqual([{ type: 'allow_once' }, { type: 'deny' }, undefined]);
  const screen = cardPlan(safe(EDIT, { choices: [{ label: 'Yes', keys: ['1', 'enter'], changes_settings: false }, { label: 'No', keys: ['2', 'enter'], changes_settings: false }] }), s);
  expect(screen.accept?.answer).toEqual({ type: 'allow_once' });
  // The only allow changes settings: Reject only.
  const persistent = cardPlan(safe(EDIT, { choices: [{ label: "Yes, and don't ask again", keys: ['1', 'enter'], changes_settings: true }, { label: 'No', keys: ['2', 'enter'], changes_settings: false }] }), s);
  expect([persistent.accept, persistent.reject?.answer]).toEqual([undefined, { type: 'deny' }]);
  expect(cardPlan(safe(EDIT, { actionable: false }), s)).toEqual({ note: 'restored after a restart · answer in the terminal' });
  // V2-1b: a restored item awaiting fresh proof after a core restart.
  expect(cardPlan(safe(EDIT, { actionable: false, reconciled: true }), s)).toEqual({ note: 'checking · restored after a restart' });
  // v1b-32: a view-only card beside another pending request (not reconciled) sends nothing either.
  expect(cardPlan(safe(EDIT, { actionable: false, reconciled: false }), s)).toEqual({ note: 'answer in the terminal: another request is still pending' });
  // V2-8e r2: a risky item (the core's flag absent or true) gets Deny only, whatever its choices: the allow is the Decisions card's.
  for (const risky of [undefined, true]) {
    const r = cardPlan(item(EDIT, risky === undefined ? {} : ({ risky } as Partial<Decision>)), s);
    expect([r.accept, r.reject?.answer, r.note], `risky ${risky}`).toEqual([undefined, { type: 'deny' }, undefined]);
  }
  expect(cardPlan(safe(EDIT), session('exited'))).toEqual({ note: 'session exited · not answerable' });
});

test('View path: relative to the session folder; outside it, null', () => {
  expect(sessionPath('/p/repo/src/a.rs', '/p/repo')).toBe('src/a.rs');
  expect(sessionPath('/p/repo/src/a.rs', '/p/repo/')).toBe('src/a.rs');
  expect(sessionPath('src/a.rs', '/p/repo')).toBe('src/a.rs');
  expect(sessionPath('./src/a.rs', '/p/repo')).toBe('src/a.rs');
  expect(sessionPath('/p/repo-other/a.rs', '/p/repo')).toBeNull();
  expect(sessionPath('/p/repo/../x', '/p/repo')).toBeNull();
  expect(sessionPath('../x', '/p/repo')).toBeNull();
  expect(sessionPath('/p/repo', '/p/repo')).toBeNull();
  expect(sessionPath('/p/repo/a.rs', '')).toBeNull();
});

test('card plan: Accept follows the core allow-once rule on the shared label cases', () => {
  // The same file pins queue::Choice::allows_once (crates/nunchiro-core/tests/queue_persistence.rs).
  const file = path.resolve(import.meta.dirname, '../../crates/nunchiro-core/tests/fixtures/allow-once-labels.json');
  const cases = JSON.parse(fs.readFileSync(file, 'utf8')) as { label: string; changes_settings: boolean; allows_once: boolean }[];
  for (const c of cases) {
    // One allow choice plus a plain No: Accept is drawn exactly when the core would allow once.
    const choices = [{ label: c.label, keys: ['1', 'enter'], changes_settings: c.changes_settings }, { label: 'Never', keys: ['9', 'enter'], changes_settings: false }];
    expect(cardPlan(safe(EDIT, { choices }), session()).accept !== undefined, c.label).toBe(c.allows_once);
    // The same choices on a risky item never draw Accept (needs 107: that allow is made in the Decisions card).
    expect(cardPlan(item(EDIT, { choices }), session()).accept, `${c.label} (risky)`).toBeUndefined();
  }
});

// After one Codex look: a very long run of added lines (an agent's patch of 150,000 lines) is copied in a loop; a
// spread call passed the argument limit and crashed the chat's rendering.
test('tighten_takes_a_patch_of_150000_lines', async () => {
  const { tighten } = await import('../src/chat/pending');
  const hunks = Array.from({ length: 150_000 }, (_, i) => `+line ${i}`);
  const out = tighten({ hunks } as never);
  expect(out.hunks.length).toBe(150_000);
});

// Home N-E (look 1117 v4f): a new file written with one line read "1 file changed +0 -0" (Claude's Write result carries an
// empty patch) while the header's git count read "+1 -0". The card counts the written content's lines, as git does.
test('write_of_a_new_file_counts_its_lines (N-E)', () => {
  const rows = buildRows([
    use('w9', 'Write', { file_path: '/p/repo/TALLY.txt', content: 'tally\n' }),
    ev({ kind: 'edit', tool_id: 'w9', path: '/p/repo/TALLY.txt', added: 0, removed: 0, hunks: [] } as Data),
    result('w9'),
  ]);
  const d = rows.find((r) => r.kind === 'diff') as Extract<(typeof rows)[number], { kind: 'diff' }>;
  expect([d.edit.added, d.edit.removed]).toEqual([1, 0]);
});

test('Q9 fr-J19-1: a patch of two files shows two diff cards; the call (its buttons, its step) is counted once', () => {
  const rows = buildRows([
    use('p2', 'apply_patch', '*** Begin Patch'),
    ev({ kind: 'edit', tool_id: 'p2', path: 'a.txt', added: 1, removed: 0, hunks: ['+a'] }),
    ev({ kind: 'edit', tool_id: 'p2', path: 'b.txt', added: 1, removed: 0, hunks: ['+b'] }),
  ]);
  const diffs = rows as Extract<(typeof rows)[number], { kind: 'diff' }>[];
  expect(diffs.map((r) => [r.kind, r.edit.path, r.tool?.use.tool_id, !!r.more])).toEqual([
    ['diff', 'a.txt', 'p2', false],
    ['diff', 'b.txt', 'p2', true],
  ]);
  expect(new Set(rows.map((r) => r.key)).size).toBe(2);
});
