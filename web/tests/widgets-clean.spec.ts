// Ticket 203 follow-up, settings5 item 1 (needs 171; V2.5-49 shared hidden-character rule): a widget's own text (act
// status, status note, output) carries no bidi or zero-width character, so the owner reads the string the code compares.
// Plain unit specs: no window, no core.
import fs from 'node:fs';
import path from 'node:path';
import { clean, HIDDEN, statusLine } from '../src/widgets/output';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** The core's rule: `board/rights.rs` `hidden`, parsed from its source (the one definition). */
function coreHidden(): (cp: number) => boolean {
  const src = read('crates/nunchiro-core/src/board/rights.rs');
  const body = src.slice(src.indexOf('pub fn hidden'));
  const line = body.slice(0, body.indexOf('\n}'));
  const ranges = [...line.matchAll(/'\\u\{([0-9A-Fa-f]+)\}'(?:\.\.='\\u\{([0-9A-Fa-f]+)\}')?/g)].map((m) => [parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)] as const);
  expect(ranges.length, 'rights.rs hidden() lists its code points').toBeGreaterThan(3);
  return (cp) => ranges.some(([a, b]) => cp >= a && cp <= b);
}

/** bridge.ts `HIDDEN`: the web copy the bridge's start check uses, as a `u` character-class body. */
function bridgeHidden(): (cp: number) => boolean {
  const lit = /const HIDDEN = ('[^\n]*');/.exec(read('web/src/webwidgets/bridge.ts'))?.[1];
  expect(lit, 'bridge.ts holds the HIDDEN literal').toBeTruthy();
  const re = new RegExp(`[${new Function(`return ${lit}`)() as string}]`, 'u');
  return (cp) => re.test(String.fromCodePoint(cp));
}

const isControl = (cp: number) => cp <= 0x08 || (cp >= 0x0b && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
/** Every scalar value clean() removes from "a?b" beyond the controls it always removed. */
function strippedByClean(): Set<number> {
  const out = new Set<number>();
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if ((cp >= 0xd800 && cp <= 0xdfff) || isControl(cp)) continue;
    if (clean(`a${String.fromCodePoint(cp)}b`) !== `a${String.fromCodePoint(cp)}b`) out.add(cp);
  }
  return out;
}

test('clean_strips_hidden_chars: every code point of the shared rule is removed from a status title and note', () => {
  // Both ranges the brief names, spelled out (an independent list, not the rule's own).
  const named = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];
  for (const cp of named) {
    const ch = String.fromCodePoint(cp);
    expect(clean(`Al${ch}low`), `U+${cp.toString(16)}`).toBe('Allow');
    expect(statusLine(`sent to “x${ch}y”`).text).toBe('sent to “xy”');
    expect(statusLine(`sent to “x${ch}y”`).title).toBe('sent to “xy”');
  }
  // A spoofed "Allow" with an override inside is the plain word, not a reversed one.
  expect(clean('\u202eAllow\u202c')).toBe('Allow');
});

test('clean_strips_hidden_chars: ordinary text is unchanged', () => {
  for (const s of ['Allow', '한국어 메모: 승인 대기 중', 'queued 👍 ok', 'tab\tand\nnewline', 'é ñ 中文 — “quotes” … ·']) {
    expect(clean(s)).toBe(s);
    expect(statusLine(s).text).toBe(s);
  }
});

test('clean_strips_hidden_chars: the set equals the V2.5-49 shared rule (rights.rs) and the bridge copy', () => {
  const core = coreHidden();
  const bridge = bridgeHidden();
  const ours = strippedByClean();
  const expected = new Set<number>();
  for (let cp = 0; cp <= 0x10ffff; cp++) if (!(cp >= 0xd800 && cp <= 0xdfff) && !isControl(cp) && core(cp)) expected.add(cp);
  expect([...ours].filter((c) => !expected.has(c)).map((c) => c.toString(16)), 'removed but not in the core rule').toEqual([]);
  expect([...expected].filter((c) => !ours.has(c)).map((c) => c.toString(16)), 'in the core rule but not removed').toEqual([]);
  // The bridge copy matches the same set, and the exported character-class body is the bridge's own literal.
  const viaBridge = new Set<number>();
  for (const cp of expected) if (bridge(cp)) viaBridge.add(cp);
  expect(viaBridge.size).toBe(expected.size);
  expect(new RegExp(`[${HIDDEN}]`, 'u').test('\u202e')).toBe(true);
});

test('act_title_bounded: a 5000-character status shows at most 200 characters plus an ellipsis; title keeps 2000', () => {
  const long = `${'x'.repeat(3000)}\u202e${'y'.repeat(2000)}`;
  const { text, title } = statusLine(long);
  expect([...text]).toHaveLength(201);
  expect(text.endsWith('…')).toBe(true);
  expect(text.slice(0, -1)).toBe('x'.repeat(200));
  expect([...title]).toHaveLength(2000);
  expect(title).toBe('x'.repeat(2000));
  // Cleaned first: the hidden character does not count toward the bound or survive in either.
  expect(text + title).not.toContain('\u202e');
  // Exactly 200 is not cut; astral characters are counted as one, never split.
  expect(statusLine('z'.repeat(200)).text).toBe('z'.repeat(200));
  expect([...statusLine('😀'.repeat(300)).text]).toHaveLength(201);
  expect(statusLine('😀'.repeat(300)).text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
});
