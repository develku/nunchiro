// Ticket 601: nothing guards a new core refusal from falling to "That did not work. Details below." This check reads every
// refusal reason written in the core source (tests/core-reasons.ts) and requires each one to be either
//   1. mapped: a row in `KNOWN` (src/errors.tsx, and the grouped rows in src/errors-groups.ts) gives it a line, or
//   2. in the ledger tests/errors-core-reasons.json, keyed by the core's wording (`{}` = a value), with a category and a
//      one-line reason a reader can check: no request the window or the browser sends can return it.
// A new reason that is neither fails here, naming the file and line. A ledger entry or a group entry that is gone from the
// source, or a ledger entry that is now mapped, fails too, so both only shrink. Ledger categories: agent = only an agent
// session token, a hook, a room call, an ACP agent or a sandboxed script gets it; cli = only a `nunchiro` command-line
// flag gets it; guard = a dispatch, shape or role guard the window's own complete requests never trip; internal = the
// holder, core startup, an id or a code word, not text for a user.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { makeT, mergeAreas, type Lang } from '../src/i18n';
import * as gaps from '../src/i18n/areas/errors-gaps';
import * as core578 from '../src/i18n/areas/errors-core';
import * as errors from '../src/i18n/areas/errors';
import { CommandError, parse, tokenize } from '../src/layout/command';
import { GROUPS } from '../src/errors-groups';
import * as groups from '../src/i18n/areas/errors-groups';
import { coreReasons } from './core-reasons';

const LEDGER: Record<string, string> = JSON.parse(fs.readFileSync(new URL('./errors-core-reasons.json', import.meta.url), 'utf8'));
const CATEGORIES = ['agent', 'cli', 'guard', 'internal'];
const ALL_LANGS: Lang[] = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'];
const TABLES = mergeAreas({ en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} }, { gaps, groups, core578, errors });
const words = (lang: Lang) => makeT<string>(lang, lang, TABLES as never);
/** owner 11-21 (ticket 1035): a new line is English only until the one pass before the release, as i18n-translations.spec.ts allows. */
const pending = (lang: Lang, key: string) => !(key in ((TABLES as unknown as Record<string, Record<string, string>>)[lang] ?? {}));

test('errors_core_reasons_all_mapped: every refusal reason in the core source is mapped or on the reviewed ledger', async () => {
  const { KNOWN } = await import('../src/errors');
  const reasons = coreReasons();
  expect(reasons.length, 'the scan found few reasons: has the core source moved?').toBeGreaterThan(1200);
  const mapped = (text: string) => KNOWN.some(([re]) => re.test(text));
  const unlisted = [...new Map(reasons.filter((r) => !mapped(r.text) && !(r.template in LEDGER)).map((r) => [r.template, r])).values()].map((r) => `${r.file}:${r.line}: ${r.template}`);
  expect(unlisted, 'map each in KNOWN (src/errors.tsx, src/errors-groups.ts) with an English line (the other 7 languages: ticket 1035), or add it to tests/errors-core-reasons.json as "category: why no window request returns it"').toEqual([]);
  const byTemplate = new Map(reasons.map((r) => [r.template, r]));
  const stale = Object.keys(LEDGER).filter((tpl) => !byTemplate.has(tpl) || mapped(byTemplate.get(tpl)!.text));
  expect(stale, 'remove from tests/errors-core-reasons.json: gone from the core source, or now mapped').toEqual([]);
  const deadGroup = Object.entries(GROUPS).flatMap(([key, list]) => list.filter((tpl) => !byTemplate.has(tpl)).map((tpl) => `${key}: ${tpl}`));
  expect(deadGroup, 'remove from src/errors-groups.ts: gone from the core source').toEqual([]);
  const bad = Object.entries(LEDGER).filter(([, v]) => !CATEGORIES.includes(v.split(': ')[0]) || v.split(': ').slice(1).join(': ').length < 20);
  expect(bad, 'each ledger entry is "category: reason" with a category from the header').toEqual([]);
});

test('errors_core_reasons_gap_lines_8_languages: each reason that maps to a 601 line (err.g.*, err.h.*) reads as that line in all 8 languages (English where a language waits for ticket 1035), never generic or raw', async () => {
  const { KNOWN, explainError } = await import('../src/errors');
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const r of coreReasons()) {
    const hit = KNOWN.find(([re]) => re.test(r.text));
    if (!hit || !/^err\.[gh]\./.test(hit[1])) continue;
    seen.add(hit[1]);
    for (const lang of ALL_LANGS) {
      const t = words(lang);
      const got = explainError(t as never, r.text);
      const want = t(hit[1]);
      if (!got.known || got.what !== want) bad.push(`${lang}: ${r.text} -> ${got.what}`);
      else if (lang !== 'en' && !pending(lang, hit[1]) && want === words('en')(hit[1])) bad.push(`${lang}: English text: ${hit[1]}`);
      else if (got.details !== r.text) bad.push(`${lang}: details lost: ${r.text}`);
    }
  }
  expect(bad).toEqual([]);
  const gapKeys = [...new Set(KNOWN.filter(([, key]) => /^err\.[gh]\./.test(key)).map(([, key]) => key))].sort();
  expect([...seen].sort(), 'a KNOWN row for a 601 line with no reason in the core source').toEqual(gapKeys);
});

test('errors_gaps_layout_and_file_words: the four layout command refusals and the file fallback say what to do in 8 languages', () => {
  const cases: [string, string, string[]][] = [
    ['split right terminal --nope x', 'own.cmd.flag', ['split', '--nope']],
    ['split right chat', 'own.cmd.widget', ['chat', 'terminal']],
    ['frobnicate', 'own.cmd.unknown', ['frobnicate', 'split']],
    ['', 'own.cmd.empty', ['split']],
  ];
  const en = words('en');
  for (const [line, key, mustHave] of cases) {
    let err: unknown;
    try {
      parse(tokenize(line));
    } catch (e) {
      err = e;
    }
    expect(err, line).toBeInstanceOf(CommandError);
    const e = err as CommandError;
    expect(e.key, line).toBe(key);
    for (const lang of ALL_LANGS) {
      const said = words(lang)(e.key, e.args);
      for (const w of mustHave) expect(said, `${lang} ${key}`).toContain(w);
      expect(said, `${lang} ${key}: an unfilled slot`).not.toMatch(/\{\w+\}/);
      if (lang !== 'en') expect(said, `${lang} ${key}: English text`).not.toBe(en(e.key, e.args));
    }
  }
  for (const lang of ALL_LANGS) {
    const said = words(lang)('own.file.unknown');
    expect(said, lang).toBeTruthy();
    if (lang !== 'en') expect(said, lang).not.toBe(en('own.file.unknown'));
  }
});
