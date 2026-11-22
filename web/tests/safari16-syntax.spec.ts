// Q9 zh-hans-J19-1: the build targets safari16 (vite.config.ts), and regex lookbehind is a SyntaxError before
// Safari 16.4 (macOS 13.0-13.2): one in a chunk stops the whole chunk from parsing.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('web_src_has_no_regex_lookbehind', () => {
  const src = path.join(import.meta.dirname, '../src');
  for (const f of fs.readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f)))
    expect(fs.readFileSync(path.join(src, f), 'utf8'), f).not.toMatch(/\(\?<[=!]/);
});
