// The Korean-window scan (ticket 492), shared: every English word in a visible text node, placeholder or selected
// option under the window, with the text it came from. Product names, commands and code are kept out.
import type { Page } from '@playwright/test';
import { EN, pendingWords } from '../i18n-tables';

// Ticket 513: `makeT` shows the key when no table has the line, so a missing line looks like `shell.tree.card`. A token of
// two or more dotted words (hyphens allowed after the first) whose first word is a catalogue area is such a key: a fault.
// A host or file name that starts with an area word (`chat.openai.com`, `git.config.lock`) ends in a domain suffix or a
// file extension, and is not one, unless it is a declared key itself (`about.section.app`, `usage.reset.log`).
const NOT_KEY = /\.(?:com|org|net|io|dev|app|ai|co|uk|kr|jp|cn|tw|edu|gov|lock|json|toml|ts|tsx|js|jsx|mjs|md|txt|sh|rs|css|html|yml|yaml|log|png|svg|jpg)$/i;
const KEYS = Object.keys(EN);
const AREAS = [...new Set(KEYS.map((k) => k.split('.')[0]))];

// Product and agent names, key names, units, acronyms and the fixture's own names (project, branch, file) stay as they are.
const KEEP = /^(Nunchiro|Claude|Codex|Aider|Gemini|Cursor|Grok|OpenCode|Opus|Sonnet|Haiku|Fable|GPT|Git|GitHub|PR|Diff|ACP|SSH|CLI|macOS|Mac|Finder|EDITOR|Esc|Tab|Enter|Return|Space|Shift|Option|Control|Ctrl|Cmd|UTF|KB|MB|MCP|CDN|OSC|http|demo|main|src|login|claude|codex|shell|low|medium|high|xhigh|xHigh|max|ultra)$/;

/** Every English word in a visible text node or placeholder under the window, with the text it came from. */
export async function english(page: Page): Promise<string[]> {
  const words = await page.evaluate(({ areas, notKey, keys }) => {
    const out: string[] = [];
    const declared = new Set(keys);
    const unlike = new RegExp(notKey, 'i');
    const add = (text: string, from: string) => {
      for (const w of text.split(/\s+/)) {
        const k = w.replace(/^[^A-Za-z]+|[^\w]+$/g, '');
        // Ticket 521: a version (`0.9.0-rc.2`, whose tail `rc.2` looks like a key) or a `board.v2` name is not a key.
        if (/^[\d-]/.test(w.replace(/^[^\w-]+/, '')) || /\.v\d+$/.test(k)) continue;
        if (declared.has(k) || (/^[A-Za-z]\w*(?:\.[A-Za-z0-9][\w-]*)+$/.test(k) && areas.includes(k.split('.')[0]) && !unlike.test(k))) out.push(`${k} (${from.trim().slice(0, 60)})`);
      }
      // A path, a file name or a variable is code, the same in every language.
      const plain = text.replace(/\S*[/.~$=#_@]\S*/g, ' ');
      for (const w of plain.match(/[A-Za-z][A-Za-z’'-]*[A-Za-z]/g) ?? []) if (w.length > 2) out.push(`${w} (${from.trim().slice(0, 60)})`);
    };
    // Agent output (the chat transcript, the terminal), code (a patch, file paths, keys) and the session's own name are content.
    const SKIP = 'code, kbd, .kbd, .mono, .xterm, .term, .clist, .dcode, .dpath, .sr, script, style, [aria-hidden="true"]';
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement!;
      if (!el.checkVisibility?.() || el.closest(SKIP)) continue;
      add(n.textContent ?? '', n.textContent ?? '');
    }
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[placeholder], textarea[placeholder]')) {
      if (el.checkVisibility?.() && !el.closest(SKIP)) add(el.placeholder, `placeholder: ${el.placeholder}`);
    }
    for (const el of document.querySelectorAll<HTMLSelectElement>('select')) {
      const o = el.selectedOptions[0];
      if (o && el.checkVisibility?.() && !el.closest(SKIP)) add(o.text, `select: ${o.text}`);
    }
    return out;
  }, { areas: AREAS, notKey: NOT_KEY.source, keys: KEYS });
  const pending = pendingWords('ko'); // English-only lines until ticket 1035
  return words.filter((w) => !KEEP.test(w.split(' (')[0]) && !pending.has(w.split(' (')[0].toLowerCase()));
}

