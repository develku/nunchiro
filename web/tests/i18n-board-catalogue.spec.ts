// UI language, V2-14e (needs 93; ticket 120): the board tab's window text comes from the catalogue. Pure checks, no page.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeT } from '../src/i18n';
// The node runner has no import.meta.glob, so the merged catalogue holds no area: read the board area file itself.
import * as area from '../src/i18n/areas/board';
const EN: Record<string, string> = area.en;

// The board strings main carried in the Own files before this slice (key -> text, `{name}` filled from args).
const BEFORE: Record<string, string> = {
  'board.card.folderGone': " · its folder is gone", // added after the extraction (its own ticket); listed so the key set matches
  'board.region': 'Board',
  'board.project': 'Project',
  'board.projectFilter': 'Project filter',
  'board.allProjects': 'All projects',
  'board.fresh': 'new {n}',
  'board.keptLast': '{error} · keeping the last good board',
  'board.addCard': '+ Card',
  'board.col.add': '+ Add',
  'board.columns': 'Columns',
  'board.deletedCard': 'Deleted card {title}',
  'board.card.new': 'New card',
  'board.card.edit': 'Edit card',
  'board.card.title': 'Title',
  'board.card.note': 'Note',
  'board.card.column': 'Column',
  'board.card.session': 'Session',
  'board.card.sessionNone': 'none',
  'board.card.sessionClosedOption': '{id} (closed)',
  'board.card.errTitle': 'title: 1 to 256 bytes',
  'board.card.errNote': 'note: at most 65536 bytes',
  'board.card.delete': 'Delete',
  'board.card.cancel': 'Cancel',
  'board.card.save': 'Save',
  'board.card.aria': '{title}, {word}',
  'board.card.ariaProject': ', {project}',
  'board.card.ariaOpens': ', opens the session',
  'board.card.ariaEdit': ', edit',
  'board.card.metaProject': ' · {project}',
  'board.card.sessionClosed': ' · session closed',
  'board.word.manual': 'manual',
  'board.word.stale': 'stale',
  'board.state.working': 'working',
  'board.state.needs_decision': 'needs decision',
  'board.state.review': 'review',
  'board.state.done': 'done',
  'board.cols.written': 'written to board.toml',
  'board.cols.close': 'Close',
  'board.cols.titleOf': 'Title of column {n}',
  'board.cols.decisionHint': 'Mark the column "needs decision": its cards ask for a decision',
  'board.cols.decision': '▲ decision column',
  'board.cols.statesOf': 'States column {n} takes',
  'board.cols.takes': 'takes:',
  'board.cols.moveLeft': 'Move column {n} left',
  'board.cols.moveRight': 'Move column {n} right',
  'board.cols.delete': 'Delete column {n}',
  'board.cols.keepOne': 'A board keeps at least one column',
  'board.cols.add': '+ Add column',
  'board.cols.errTitle': 'column title: 1 to 256 bytes',
  'board.col.needsYou': 'needs you',
  'board.col.needsYouHint': 'Cards here need your decision',
  'board.col.count': '{n} cards',
  // V2.5-37 (ticket 185, draft B): lanes, task card, history, coordinator, filters.
  'board.task.refNoSession': "{ref} · attach a session to open it",
  'board.task.working': "working",
  'board.task.yourTurn': "your turn",
  'board.task.idle': "idle",
  'board.task.gone': "session gone",
  'board.task.stale': "stale {n} min",
  'board.task.staleHint': "No column change for this long",
  'board.task.waitsOn': "waits on #{id}",
  'board.task.ownerMoved': "moved by you · no receipt needed",
  'board.task.missing': "receipt missing · stopped in {column} (sha, command, result needed)",
  'board.hist.you': "you",
  'board.hist.created': "created in {to}",
  'board.hist.edited': "edited",
  'board.hist.refused': "refused {from} → {to}: {reason}",
  'board.hist.moved': "{from} → {to}",
  'board.hist.undone': "undo {from} → {to}",
  'board.hist.label': "History",
  'board.hist.undoHint': "Put the card back as it was before its last change",
  'board.hist.nothing': "Nothing to undo",
  'board.hist.undo': "Undo last change",
  'board.hist.toggle': "History of {title}",
  'board.col.proof': "proof",
  'board.col.proofHint': "Moving a card here needs a receipt (proof = true)",
  'board.lane.none': "no group",
  'board.lane.kind.group': "group",
  'board.lane.kind.project': "project",
  'board.lane.kind.fallback': "project · no group",
  'board.lane.kind.role': "role",
  'board.lane.progress': "{lane} progress",
  'board.lane.done': "{n}/{m} done",
  'board.lane.key': "Lanes",
  'board.lane.by.group': "group",
  'board.lane.by.project': "project",
  'board.lane.by.role': "role",
  'board.lane.by.none': "none",
  'board.coord.hint': "A session that started child sessions becomes the coordinator automatically",
  'board.coord.label': "Coordinator: {label}",
  'board.coord.children': "· {n} child sessions",
  'board.coord.cli': "CLI ▾",
  'board.coord.writes': "The coordinator writes only through →",
  'board.filter.label': "Filter",
  'board.filter.you': "Your turn only",
  'board.filter.role': "Role filter",
  'board.filter.roleIs': "role: {role}",
  'board.filter.stale': "stale",
  'board.filter.missing': "receipt missing",
  'board.strip.hint': "New cards land in {column} · stale after {n} min",
  'board.detail.pr': "PR",
  'board.detail.branch': "Branch",
  'board.detail.checks': "Checks",
  'board.detail.review': "Review",
  'board.detail.changes': "Changes",
  'board.detail.merged': "Merged",
  'board.detail.updated': "Updated",
  'board.detail.openPr': "Open PR ↗",
  'board.detail.openSession': "Open session",
  'board.detail.noReview': "No review",
  'board.task.auto': "auto · session card",
  'board.filter.add': "+ filter",
  'board.filter.noRoles': "No roles on the board",
  'board.coord.noImport': "· no herdr import",
  'board.hist.unavailable': "Undo was refused or got no answer; reload the window to try again",
  // V2.5-38 (ticket 186, draft B): edit panel, saved views, one-line list.
  'board.edit.open': "Edit board widget",
  'board.edit.title': "Edit board widget",
  'board.edit.done': "Done",
  'board.edit.columns': "Columns (drag to order)",
  'board.edit.doneCol': "Done column",
  'board.edit.proof': "receipt required (proof)",
  'board.edit.fields': "Card fields",
  'board.field.ref': "ref",
  'board.field.role': "role · assignee",
  'board.field.waits': "waits on",
  'board.field.pr': "PR line",
  'board.field.receipt': "receipt",
  'board.field.project': "project",
  'board.edit.lane': "Lane key",
  'board.edit.laneHint': "no group falls back to project lanes",
  'board.edit.filters': "Filters",
  'board.edit.density': "Show as",
  'board.density.cards': "cards",
  'board.density.list': "one-line list",
  'board.edit.staleNudge': "Stale · nudge",
  'board.edit.staleMin': "stale badge threshold (min)",
  'board.edit.nudge': "turn-end agent nudge",
  'board.edit.errMin': "1 to 1440 whole minutes",
  'board.edit.foot': "Saved: board.toml · this widget's view is saved with its zone (can sit in any zone)",
  'board.view.saved': "Saved view: {view}",
  'board.view.noLanes': "no lanes",
  'board.view.lanes': "{key} lanes",
  'board.cols.errSame': "another column is already called {title}",
  'board.cols.drag': "Drag to move column {n}",
  'board.list.label': "Cards",
  'board.list.broken': "broken",
  'board.edit.newCards': "new cards",
  'board.edit.rename': "Rename",
  'board.edit.states': "Claimed states\u2026",
};
const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => `<${k}>`);

test('english_text_unchanged: every board key holds the text the source had, with no stray board key', () => {
  const have = Object.keys(EN).filter((k) => k.startsWith('board.'));
  expect(have.sort()).toEqual(Object.keys(BEFORE).sort());
  const t = makeT<string>('en', 'en-US', { en: EN } as never);
  for (const [k, text] of Object.entries(BEFORE)) expect(t(k as never, Object.fromEntries([...text.matchAll(/\{(\w+)\}/g)].map((m) => [m[1], `<${m[1]}>`]))), k).toBe(fill(text));
  for (const [k, text] of Object.entries(BEFORE)) expect((EN as Record<string, string>)[k], k).toBe(text);
});

test('fallback_per_string: a ko table with one board key shows it; any other board key shows English', () => {
  const tables = { en: { 'board.addCard': '+ Card', 'board.columns': 'Columns' }, ko: { 'board.addCard': '+ 카드' } };
  const t = makeT('ko', 'en-US', tables);
  expect(t('board.addCard')).toBe('+ 카드');
  expect(t('board.columns')).toBe('Columns');
});

test('no_catalogue_collision: board keys carry the prefix and no key of the catalogue is declared twice', () => {
  // Since ticket 167 the board keys live in their area file (index.ts only merges areas).
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/i18n/areas/board.ts'), 'utf8');
  const declared = [...src.split('export const en = {')[1].split('\n};')[0].matchAll(/^\s*"([\w.-]+)":/gm)].map((m) => m[1]);
  expect(declared.filter((k, i) => declared.indexOf(k) !== i), 'duplicated keys').toEqual([]);
  expect(declared.length).toBe(Object.keys(EN).length);
  expect(src).toContain('the board keys written before area files existed');
  expect(declared.length).toBe(Object.keys(BEFORE).length);
  expect(declared.every((l) => l.startsWith('board.')), 'block keys').toBe(true);
  // No board key is declared again by another area file (index.ts merges them all; a second owner would collide).
  const dir = path.resolve(import.meta.dirname, '../src/i18n/areas');
  const elsewhere = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'board.ts').flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^\s*"([\w.-]+)":/gm)].map((m) => m[1]));
  expect(declared.filter((k) => elsewhere.includes(k)), 'keys owned twice').toEqual([]);
});

// Text a person can see in the extracted files. Tokens that are data, not words, stay: the status-dot token and the
// default title of a column the person adds (stored in board.toml, so data), and the card source value `manual`.
const TOKENS = new Set(['stale', 'Column', 'true', 'false', 'manual']);
const OWN = ['Board.tsx', 'CardEditor.tsx', 'CardView.tsx', 'ColumnEditor.tsx', 'Columns.tsx', 'drag.tsx', 'CardParts.tsx', 'Strip.tsx', 'tasks.ts', 'EditPanel.tsx', 'ListView.tsx', 'views.ts']; // V2.5-37: CardParts, Strip, tasks; V2.5-38: the last three

/** The balanced `{...}` or `(...)` expression that starts at `at` (the opening bracket). */
function balanced(code: string, at: number): string {
  const [open, close] = code[at] === '{' ? ['{', '}'] : ['(', ')'];
  let depth = 0;
  for (let i = at; i < code.length; i++) {
    if (code[i] === open) depth++;
    else if (code[i] === close && --depth === 0) return code.slice(at + 1, i);
  }
  return code.slice(at + 1);
}
/** English words left in the literals of an expression, after catalogue calls `t('…')` are removed. */
function literals(expr: string): string[] {
  const bare = expr.replace(/\bt\(\s*(?:'[^']*'|`[^`]*`)/g, '');
  const out: string[] = [];
  for (const m of bare.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`((?:[^`$]|\$\{[^}]*\})*)`/g)) {
    const text = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, '').trim();
    if (/[A-Za-z]{2}/.test(text) && !TOKENS.has(text)) out.push(text);
  }
  return out;
}
function leftEnglish(text: string): { jsx: string[]; attrs: string[]; calls: string[] } {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
  const jsx = [...code.matchAll(/(?<![=\-])>\s*([A-Za-z+▲][^<>{}]*?)\s*<(?=[\/A-Za-z])/g)].map((m) => m[1]);
  const attrs: string[] = [];
  for (const m of code.matchAll(/\b(?:placeholder|aria-label|title|alt)=("[^"]+"|\{)/g)) {
    if (m[1] === '{') attrs.push(...literals(balanced(code, m.index! + m[0].length - 1)));
    else attrs.push(m[1]);
  }
  const calls: string[] = [];
  for (const m of code.matchAll(/\b(?:setError|setMessage)\(|\blabel:\s*(?=[`'"])|(?:&&|\?|(?<=\s):)\s*(?=['"`])/g)) {
    const from = m.index! + m[0].length;
    const expr = m[0].endsWith('(') ? balanced(code, from - 1) : code.slice(from).match(/^(?:'[^'\n]*'|"[^"\n]*"|`[^`\n]*`)/)![0];
    calls.push(...literals(expr));
  }
  // A JSX child written as an expression, `{'text'}` or `{cond && 'text'}`, is found by the && / ? / : rule above.
  return { jsx, attrs, calls };
}
const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../src/board', f), 'utf8');

test('no_hardcoded_in_extracted_files: the board tab files hold no English literal outside the catalogue', () => {
  for (const f of OWN) expect(leftEnglish(read(f)), f).toEqual({ jsx: [], attrs: [], calls: [] });
});

test('no_hardcoded_in_extracted_files mutation: a literal put back is caught', () => {
  const text = read('Columns.tsx');
  expect(leftEnglish(text.replace('</header>', '<i>Hello</i></header>')).jsx).toEqual(['Hello']);
  expect(leftEnglish(text.replace('<section ', '<section title="Oops" ')).attrs).toEqual(['"Oops"']);
  expect(leftEnglish(text.replace('<header', '<header aria-label={`${1} cards`}')).attrs).toEqual(['cards']);
  expect(leftEnglish("setError('boom');").calls).toEqual(['boom']);
  expect(leftEnglish('{x && \' · gone\'}').calls).toEqual(['· gone']);
});
