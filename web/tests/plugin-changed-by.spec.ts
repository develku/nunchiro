// The chat's "Changed by <plugin>" tag is told by a line's words (a chat line names no send row): it shows only when
// every send row with those words is a changed one from another sender, so the owner's own line and an agent's
// unchanged line with the same words stay untagged.
import { expect, test } from '@playwright/test';
import { changedBy } from '../src/queue/Knock';
import type { SendRow } from '../src/types';

const row = (sender: string, content: string, plugin?: string): SendRow => ({
  id: `${sender}-${content}-${plugin ?? ''}`,
  sender,
  at: 1,
  content,
  status: 'delivered',
  ...(plugin ? { replaced: { plugin, original: 'what was written' } } : {}),
});

test('changed_by_tags_only_a_changed_line', () => {
  expect(changedBy([row('agent-a', 'Words a plugin chose.', 'Guard')], 'Words a plugin chose.')).toBe('Guard');
  // The owner wrote the same words: no tag on either.
  expect(changedBy([row('agent-a', 'Words a plugin chose.', 'Guard'), row('user', 'Words a plugin chose.')], 'Words a plugin chose.')).toBeNull();
  // Another agent wrote them as they are: no tag.
  expect(changedBy([row('agent-a', 'Words a plugin chose.', 'Guard'), row('agent-b', 'Words a plugin chose.')], 'Words a plugin chose.')).toBeNull();
  expect(changedBy([row('agent-b', 'plain')], 'plain')).toBeNull();
  expect(changedBy([], 'anything')).toBeNull();
});
