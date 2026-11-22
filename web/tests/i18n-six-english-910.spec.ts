// Ticket 910: the Korean English-left scan (korean-main-window.spec.ts, settings-shell.spec.ts) for ja, zh-Hans, zh-Hant,
// es, fr and pt, over the main window, the palette list and every Settings page. A CJK window flags any Latin word outside KEEP; an
// es, fr or pt window shares the Latin script, so there a word is English when the English catalogue uses it and that
// language's own translated lines never do. A raw catalogue key (a missing line) is a fault in every language.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { EN, TABLES, pendingWords } from './i18n-tables';

const LANGS = ['ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const;
type L = (typeof LANGS)[number];

// Names that stay as they are in every language, each with its reason. Product, agent and service names; key, unit and
// format names; font, theme and sound names (the Settings samples); the fixtures' own project and session names.
const KEEP = new Set(
  [
    // products, agents, services
    'Nunchiro', 'Claude', 'Codex', 'Aider', 'Gemini', 'Cursor', 'Grok', 'OpenCode', 'Opus', 'Sonnet', 'Haiku', 'Fable', 'Antigravity', 'Muse',
    'OpenRouter', 'GLM', 'Kimi', 'goose', 'Git', 'GitHub', 'GitLab', 'Forgejo', 'Gitea', 'Azure', 'DevOps', 'Bitbucket', 'Tailscale',
    'WireGuard', 'Ghostty', 'iTerm', 'iTerm2', 'Zed', 'Finder', 'macOS', 'Mac', 'cdnjs', 'jsdelivr', 'localhost', 'Anthropic', 'OpenAI', 'Homebrew',
    'GitCafe', 'Google', // a Git host and a search engine named on the Git and in-app browser pages
    'Gmail', // the mail connector's product name (Settings > Assistants)
    // Nunchiro's own bundled skill names (the Skills and hooks page lists them as they are named on disk)
    'artifacts', 'orchestration',
    // loanwords and key/format names written in Latin in CJK (Authored is from the Co-Authored-By trailer)
    'App', 'GPU', 'Meta', 'KaTeX', 'Cookie', 'PTY', 'token', 'Escape', 'Authored',
    // standard abbreviations and protocols
    'GPT', 'ACP', 'SSH', 'CLI', 'MCP', 'CDN', 'OSC', 'HTTP', 'HTTPS', 'URL', 'API', 'UTF', 'MIT', 'PATH', 'EDITOR', 'REPORT', 'TOML', 'JSON',
    'PR', 'PRs', 'UI', 'IDE', 'LLM', 'AI', 'ID', 'OK', 'Pi', 'gh', 'git',
    // variable-name words in Providers > Shell environment (ticket 1008): written as the names they match
    'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'AUTH',
    // format names in the Artifact Libraries rows ("讀寫 CSV", "Markdown 轉 HTML"): the rows arrive after the page's first
    // draw, so the scan met them only in some runs and failed then (wave 15: zh-Hant in one run, ja in another)
    'CSV', 'HTML', 'Markdown',
    // terminal programs named in the OSC 52 help (Settings > Terminal)
    'vim', 'tmux',
    // keys on the keyboard and layouts
    'Esc', 'Tab', 'Enter', 'Return', 'Space', 'Shift', 'Option', 'Control', 'Ctrl', 'Cmd', 'QWERTY', 'Dvorak', 'Colemak', 'Workman',
    // units
    'KB', 'MB', 'GB', 'MiB', 'ms', 'px', 'toml', 'md', 'json',
    // effort level names are the agents' own flags (low/medium/high/xhigh/max)
    'low', 'medium', 'high', 'xhigh', 'xHigh', 'max', 'ultra',
    // font names (the Terminal font list)
    'SF', 'Mono', 'Menlo', 'Monaco', 'Symbols', 'Nerd', 'Font', 'Code', 'Hangul', 'Hack', 'JetBrains', 'Fira', 'Cascadia', 'Iosevka',
    'Source', 'Pro', 'IBM', 'Plex', 'D2Coding', 'Meslo', 'LGS', 'FiraCode', 'CaskaydiaCove', 'SauceCodePro', 'BlexMono', 'JetBrainsMono',
    'D2CodingLigature', 'MesloLGS',
    // theme names
    'Light', 'Dark', 'Catppuccin', 'Latte', 'Solarized', 'Color', 'Schemes',
    // macOS sound names
    'Glass', 'Ping', 'Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Hero', 'Morse', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink',
    // the fixtures' own names (project, session, agent)
    'demo', 'alpha', 'beta', 'claude', 'codex', 'shell', 'main', 'src', 'login', 'http',
  ].map((w) => w.toLowerCase()),
);

const words = (s: string) => (s.replace(/\{[^}]*\}/g, ' ').match(/\p{L}+/gu) ?? []).map((w) => w.toLowerCase());
const EN_WORDS = new Set(Object.values(EN).flatMap(words));
/** Words of a language's own lines: a line still equal to English adds nothing (it is the gap being looked for). */
const own = (lang: L) => new Set(Object.entries(TABLES[lang] ?? {}).filter(([k, v]) => v !== (EN as Record<string, string>)[k]).flatMap(([, v]) => words(v as string)));
const KEYS = new Set(Object.keys(EN));

/** Text under `root`: visible text nodes, placeholders and selected options. */
async function texts(page: Page, root: string): Promise<string[]> {
  return page.evaluate((root) => {
    const out: string[] = [];
    // Agent output, terminal content, code and the Settings samples (theme cards, the font sample, the hints drawing) are content.
    const SKIP = 'code, kbd, .kbd, .mono, .machine-mono, .xterm, .term, .clist, .dcode, .dpath, .sr, script, style, .tcards, .fsample, .hk-board, .hk-what, [aria-hidden="true"]';
    const base = document.querySelector(root) ?? document.body;
    const walk = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement!;
      if (!el.checkVisibility?.() || el.closest(SKIP)) continue;
      if ((n.textContent ?? '').trim()) out.push(n.textContent!);
    }
    for (const el of base.querySelectorAll<HTMLInputElement>('input[placeholder], textarea[placeholder]')) if (el.checkVisibility?.() && !el.closest(SKIP)) out.push(el.placeholder);
    for (const el of base.querySelectorAll<HTMLSelectElement>('select')) if (el.checkVisibility?.() && !el.closest(SKIP) && el.selectedOptions[0]) out.push(el.selectedOptions[0].text);
    return out;
  }, root);
}

/** The English words (and raw keys) in one view, as `word (text)`. */
function english(lang: L, lines: string[], pending = pendingWords(lang) /* English-only lines until ticket 1035; the self-test passes none */): string[] {
  const mine = own(lang);
  const latin = ['es', 'fr', 'pt'].includes(lang);
  const out: string[] = [];
  for (const text of lines) {
    const from = text.trim().slice(0, 60);
    for (const tok of text.split(/\s+/)) {
      const k = tok.replace(/^[^A-Za-z]+|[^\w]+$/g, '');
      if (KEYS.has(k)) out.push(`${k} (${from})`);
    }
    // A path, a file name or a variable is code, the same in every language.
    const plain = text.replace(/\S*[/.~$=#_@]\S*/g, ' ');
    for (const w of plain.match(/\p{L}+/gu) ?? []) {
      const lw = w.toLowerCase();
      if (!/^[A-Za-z]{3,}$/.test(w) || KEEP.has(lw) || pending.has(lw) || (latin && mine.has(lw))) continue;
      if (latin && !EN_WORDS.has(lw)) continue;
      out.push(`${w} (${from})`);
    }
  }
  return out;
}

for (const lang of LANGS) {
  test(`six_languages_no_english_910_${lang}: main window, palette and every Settings page`, async ({ app, core }) => {
    const t = (k: string) => (TABLES[lang] as Record<string, string>)[k] ?? (EN as Record<string, string>)[k];
    const project = core.project('demo');
    const agent = core.agent(project, 'beta', 'x');
    await app.addInitScript((language) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language })), lang);
    await app.goto('/');
    await expect(app.locator('html')).toHaveAttribute('lang', lang);
    await expect(app.getByRole('status').filter({ hasText: new RegExp(`^${t('chrome.connected')}$`) })).toBeVisible();
    await app.locator(`.tab[data-tab="${agent.id}"]`).click();
    const bad: string[] = [];
    const scan = async (where: string, root = 'body') => bad.push(...english(lang, await texts(app, root)).map((w) => `${where}: ${w}`));

    await scan('window');

    // The palette list.
    await app.keyboard.press('Meta+KeyK');
    await expect(app.getByRole('dialog').getByRole('combobox')).toBeVisible();
    await scan('palette', '[role="dialog"]');
    await app.keyboard.press('Escape');

    // Every Settings page, built-in and registered.
    await app.getByRole('navigation').getByRole('button', { name: t('shell.widget.settings'), exact: true }).first().click();
    const nav = app.locator('.settings > nav');
    await expect(nav).toBeVisible();
    const ids = await nav.locator('button[data-page]').evaluateAll((b) => b.map((x) => x.getAttribute('data-page')!));
    expect(ids.length).toBeGreaterThanOrEqual(14);
    for (const id of ids) {
      await nav.locator(`button[data-page="${id}"]`).click();
      if (id === 'providers') await expect(app.locator('.settings .sbody .prv-row').first()).toBeVisible();
      if (id === 'usage') await expect(app.locator('#s-usage .lim').first()).toBeVisible();
      if (id === 'git') await expect(app.locator('.settings .sbody .prov[data-provider="git"] .chip')).toBeVisible();
      await expect(app.locator('.settings .sbody [aria-busy="true"]')).toHaveCount(0);
      await scan(`settings ${id}`, '.settings');
    }
    // One line per word and text: the Settings nav is scanned with each page.
    const unique = [...new Map(bad.map((b) => [b.slice(b.indexOf(': ') + 2), b])).values()];
    console.log(`910 ${lang}: ${unique.length} English words`);
    expect(unique).toEqual([]);
  });
}

test('six_languages_scan_flags_english_910: a line left in English and a raw key are found in every language', () => {
  for (const lang of LANGS) {
    expect(english(lang, [EN['settings.keys.kind_left' as keyof typeof EN]], new Set()), lang).not.toEqual([]);
    expect(english(lang, ['settings.keys.kind_left'], new Set()), lang).not.toEqual([]);
    expect(english(lang, ['Nunchiro · Claude · GitHub'], new Set()), lang).toEqual([]);
    // Review r1 SHOULD 1: a word that some CJK line writes in Latin is still English on a CJK screen.
    if (!['es', 'fr', 'pt'].includes(lang)) expect(english(lang, ['Check for update'], new Set()), lang).toHaveLength(3);
  }
});

// The screen scan counts any word of a language's own lines as that language's, so a half-English line ("{n} stale")
// passes it in es, fr and pt. These English-only words are no es, fr or pt word: a line that keeps one from its English
// line is English left. (Commands such as `git remote add` are code and are not in the list.)
const ENGLISH_ONLY = new Set(['the', 'and', 'for', 'with', 'your', 'you', 'this', 'that', 'from', 'are', 'own', 'stale', 'receipt', 'waits']);
const latinWords = (s: string) => (s.replace(/\{[^}]*\}/g, ' ').replace(/\S*[/.~$=#_@`]\S*/g, ' ').match(/[A-Za-z]+/g) ?? []).map((w) => w.toLowerCase());

test('six_languages_catalogue_keeps_no_english_words_910: no line keeps an English-only word of its English line', () => {
  const left: string[] = [];
  for (const lang of LANGS)
    for (const [k, v] of Object.entries(TABLES[lang] ?? {})) {
      const en = new Set(latinWords((EN as Record<string, string>)[k] ?? ''));
      if (latinWords(v as string).some((w) => ENGLISH_ONLY.has(w) && en.has(w))) left.push(`${lang} ${k}: ${v}`);
    }
  expect(left).toEqual([]);
});

// Ticket 873: the board words ticket 870 fixed in Korean, in the six other tables. Names kept as written: CLI, PR, herdr,
// and sha; the unit min; `board.toml`, `proof` and `true` are what the user types in board.toml (shown in parentheses).
test('board_six_tables_have_no_english_873: the receipt, proof, ref, waits-on, project, lane-hint and stale lines are translated', async () => {
  const board = await import('../src/i18n/areas/board');
  const KEPT = new Set(['CLI', 'PR', 'herdr', 'sha', 'board', 'toml', 'proof', 'true', 'min']); // min: the minute unit in es, fr and pt too
  const KEYS873 = ['board.task.ownerMoved', 'board.task.missing', 'board.col.proof', 'board.col.proofHint', 'board.filter.missing', 'board.edit.proof',
    'board.field.ref', 'board.field.waits', 'board.field.receipt', 'board.field.project', 'board.edit.laneHint', 'board.edit.staleMin'] as const;
  const en = board.en as Record<string, string>;
  const BOARD_EN = new Set([...ENGLISH_ONLY, 'ref', 'project', 'group', 'needed', 'required', 'missing', 'threshold', 'lanes']);
  const left: string[] = [];
  for (const lang of LANGS) {
    const table = (board as unknown as Record<string, Record<string, string>>)[lang.replace('-', '')];
    for (const k of KEYS873) {
      const v = table[k];
      // A CJK line has no Latin word but the kept names; an es, fr or pt line has none of the English board words (a shared
      // cognate such as French "badge" is fine).
      const shared = latinWords(v).filter((w) => !KEPT.has(w) && (!['es', 'fr', 'pt'].includes(lang) || BOARD_EN.has(w)));
      if (v === en[k] || shared.length) left.push(`${lang} ${k}: ${v}`);
    }
  }
  expect(left).toEqual([]);
});
