// The fixture's pin rewrite follows the app's: a pin is rewritten only inside a `<script ... src="URL">` tag.
import { test, expect } from '@playwright/test';
import { rewritePinned, sha384Of } from './fixtures/web-widgets/host';

const U = 'https://cdn.jsdelivr.net/npm/lib@1.0.0/lib.js';
const BYTES = 'r("ran")';
const ORIGIN = 'http://127.0.0.1:1';
const pins = [{ url: U, bytes: BYTES }];
const to = `${ORIGIN}/lib/${sha384Of(BYTES)}`;

test('rewrite_pinned_rewrites_script_src_tag', () => {
  expect(rewritePinned(`<script src="${U}"></script>`, pins, ORIGIN)).toBe(`<script src="${to}"></script>`);
  expect(rewritePinned(`<script type="module" src="${U}"></script>`, pins, ORIGIN)).toBe(`<script type="module" src="${to}"></script>`);
});

test('rewrite_pinned_leaves_other_text_alone', () => {
  for (const html of [`<img src="${U}">`, `<p>src="${U}"</p>`, '<script src="https://other/x.js"></script>']) {
    expect(rewritePinned(html, pins, ORIGIN)).toBe(html);
  }
});
