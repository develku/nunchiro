// needs 168 (plan strip): the pure reading of a session's newest plan. Claude `TodoWrite` and Codex `update_plan` give
// the same shape; the replace / clear / malformed rule mirrors crates/nunchiro-core/src/chat/handoff.rs (the newest list
// replaces the older one, an empty list clears it, a malformed call keeps the old one).
import { expect, test } from '@playwright/test';
import { current, planOf, tally } from '../src/chat/plan';
import type { ChatEvent } from '../src/chat/feed';

let cursor = 0;
const use = (name: string, input: unknown): ChatEvent => ({ schema_version: 1, cursor: ++cursor, data: { kind: 'tool_use', tool_id: `t${cursor}`, name, input } });
const todo = (...items: [string, string, string?][]) => use('TodoWrite', { todos: items.map(([content, status, activeForm]) => ({ content, status, ...(activeForm ? { activeForm } : {}) })) });
const codex = (...items: [string, string][]) => use('update_plan', { plan: items.map(([step, status]) => ({ step, status })) });
const message = (): ChatEvent => ({ schema_version: 1, cursor: ++cursor, data: { kind: 'message', role: 'assistant', text: 'ok' } });

test('plan_model_claude_codex: TodoWrite and update_plan read into one Plan shape; current() is the in-progress item, else the first pending, else null', () => {
  const c = planOf([todo(['Read the spec', 'completed'], ['Write the model', 'in_progress', 'Writing the model'], ['Test it', 'pending'])])!;
  expect(c.items).toEqual([
    { text: 'Read the spec', status: 'completed' },
    { text: 'Write the model', status: 'in_progress', active: 'Writing the model' },
    { text: 'Test it', status: 'pending' },
  ]);
  const x = planOf([codex(['Read the spec', 'completed'], ['Write the model', 'in_progress'], ['Test it', 'pending'])])!;
  expect(x.items.map(({ text, status }) => ({ text, status }))).toEqual(c.items.map(({ text, status }) => ({ text, status })));
  // Claude shows the present-tense form of the step in progress; Codex has none and shows the step.
  expect(current(c)).toBe('Writing the model');
  expect(current(x)).toBe('Write the model');
  // No step in progress: the first pending one. Everything done: null.
  expect(current(planOf([todo(['a', 'completed'], ['b', 'pending'], ['c', 'pending'])])!)).toBe('b');
  expect(current(planOf([todo(['a', 'completed'], ['b', 'completed'])])!)).toBeNull();
  // An unknown status is pending; an item with no text is dropped.
  const odd = planOf([use('TodoWrite', { todos: [{ content: 'a', status: 'blocked' }, { status: 'completed' }, 'x', null, { content: 'b' }] })])!;
  expect(odd.items).toEqual([{ text: 'a', status: 'pending' }, { text: 'b', status: 'pending' }]);
  expect(tally(planOf([todo(['a', 'completed'], ['b', 'in_progress'], ['c', 'pending'])])!)).toEqual({ done: 1, total: 3 });
});

test('plan_replace_clear_malformed: the newest call replaces the older, an empty list clears, a non-array list is ignored', () => {
  const first = todo(['old 1', 'completed'], ['old 2', 'pending']);
  const second = todo(['new 1', 'pending']);
  // Two plans in one feed: only the newest shows.
  expect(planOf([first, message(), second, message()])!.items.map((i) => i.text)).toEqual(['new 1']);
  // The newest call is empty: no plan, not the older one.
  expect(planOf([first, todo()])).toBeNull();
  expect(planOf([first, codex()])).toBeNull();
  // A malformed newest call keeps the previous plan (the handoff.rs rule).
  expect(planOf([first, use('TodoWrite', { todos: 'nope' })])!.items.map((i) => i.text)).toEqual(['old 1', 'old 2']);
  expect(planOf([first, use('update_plan', {}), use('TodoWrite', null)])!.items.map((i) => i.text)).toEqual(['old 1', 'old 2']);
  // A malformed call with nothing before it is no plan; so is a feed with no plan call or other tools only.
  expect(planOf([use('TodoWrite', { todos: {} })])).toBeNull();
  expect(planOf([message(), use('Read', { file_path: 'a.ts' })])).toBeNull();
  expect(planOf([])).toBeNull();
  // A Codex plan after a Claude one (a hand-off) replaces it the same way.
  expect(planOf([first, codex(['c 1', 'in_progress'])])!.items.map((i) => i.text)).toEqual(['c 1']);
});
