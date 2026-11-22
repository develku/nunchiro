// Clean-room check (BOARDREWRITE): nothing under web/src/board carries the Apache-2.0 vibe-kanban attribution.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('board_has_no_apache_attribution', () => {
  const dir = path.join(import.meta.dirname, '../src/board');
  for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), 'utf8'), f).not.toMatch(/vibe-kanban|KanbanBoard/);
});
