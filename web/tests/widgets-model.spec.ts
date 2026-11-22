// User widget kinds in the layout model and output rules (ticket v1b-19). Pure functions, no page.
import { expect, test } from '@playwright/test';
import { apply, defaultLayout, leaves, MIN, TITLE, type Layout } from '../src/layout/model';
import { format, parse, tokenize } from '../src/layout/command';
import { clean, table } from '../src/widgets/output';

const run = (l: Layout, line: string) => apply(l, parse(tokenize(line), undefined, l));

test('widget:<name> is a layout kind: placed, pinned, titled, sized; zone ids stay letters, digits and -', () => {
  let l = run(defaultLayout(), 'split right widget:my_tool --zone terminal --pin 리뷰-03');
  const z = leaves(l.root).find((x) => x.widgets[0].startsWith('widget:'))!;
  expect(z.widgets).toEqual(['widget:my_tool@리뷰-03']);
  expect(z.id).toBe('widget-my-tool');
  expect(z.id).toMatch(/^[A-Za-z0-9-]+$/);
  expect((TITLE as Record<string, string>)['widget:my_tool']).toBe('my_tool');
  expect((MIN as Record<string, unknown>)['widget:my_tool']).toEqual({ w: 200, h: 80 });
  expect(format({ op: 'split', dir: 'right', widget: 'widget:my_tool@s1', zone: 'terminal' })).toBe('split right widget:my_tool --pin s1 --zone terminal');
  l = run(l, 'remove widget:my_tool');
  expect(leaves(l.root).some((x) => x.widgets.some((w) => w.startsWith('widget:')))).toBe(false);
  for (const bad of ['widget:', 'widget:Bad', 'widget:-x', 'widgets:x']) expect(() => run(defaultLayout(), `stack ${bad}`)).toThrow(/unknown widget/);
});

test('output: escapes stripped, Hangul and emoji kept; table columns are the key union in first-seen order', () => {
  expect(clean('\x1b[1;31m빨강\x1b[0m 🎉\x1b]0;title\x07 ok\x07\n')).toBe('빨강 🎉 ok\n');
  const t = table([{ b: 1, a: 'x' }, { c: null, a: { y: 2 } }, 'scalar', [1, 2]]);
  expect(t.columns).toEqual(['b', 'a', 'c', 'value']);
  expect(t.rows).toEqual([
    ['1', 'x', '', ''],
    ['', '{"y":2}', '', ''],
    ['', '', '', 'scalar'],
    ['', '', '', '[1,2]'],
  ]);
  const big = table(Array.from({ length: 501 }, (_, i) => ({ i })));
  expect([big.rows.length, big.total, big.dropped]).toEqual([500, 501, 0]);
});

test('output: a 60,000-key object keeps 64 columns, reports the rest, and stays fast', () => {
  const wide = Object.fromEntries(Array.from({ length: 60_000 }, (_, i) => [`k${i}`, i]));
  const t0 = performance.now();
  const t = table([wide, { k1: 'again', extra: true }]);
  expect(performance.now() - t0).toBeLessThan(500);
  expect(t.columns.length).toBe(64);
  expect(t.columns.slice(0, 3)).toEqual(['k0', 'k1', 'k2']);
  expect(t.dropped).toBe(60_001 - 64);
  expect(t.rows[1].slice(0, 2)).toEqual(['', 'again']);
});
