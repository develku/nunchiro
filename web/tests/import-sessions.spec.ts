// V2.5-12 (ticket 153): first run offers to import the claude and codex conversations already on this Mac. Read only:
// the fixture agent homes are unchanged byte for byte; imported conversations are searchable from the same step.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WebSocketRoute } from '@playwright/test';
import { makeT } from './i18n-tables';
import { expect, openWindow, test, type Core } from './fixtures';

const line = (text: string) => JSON.stringify({ type: 'user', cwd: '/work/app', message: { role: 'user', content: text } }) + '\n';
function transcripts(core: Core) {
  const dir = path.join(core.home, 'claude-home/projects/-work-app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c1.jsonl'), line('migrate the zebra table') + line('and then rename it'));
  fs.writeFileSync(path.join(dir, 'c2.jsonl'), line('write the release notes'));
}
/** Hash of every file under the agent homes (name, bytes, mtime). */
function digest(core: Core) {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(p).update(fs.readFileSync(p)).update(String(fs.statSync(p).mtimeMs));
    }
  };
  for (const r of ['claude-home', 'codex-home']) if (fs.existsSync(path.join(core.home, r))) walk(path.join(core.home, r));
  return h.digest('hex');
}

// Ticket 305: the import block lives on Settings > Onboarding, which a first run opens.
test.use({ firstRun: true });

test('import: reachable in one click, imported conversations are searchable, agent homes unchanged', async ({ app, core }) => {
  transcripts(core);
  const before = digest(core);
  await openWindow(app);
  const step = app.locator('[data-step="import"]');
  // Click 1 (the only one needed to see the list): the visible, labelled control.
  await step.getByRole('button', { name: 'Look for conversations' }).click();
  await expect(step.getByRole('checkbox')).toHaveCount(2);
  await expect(step).toContainText('migrate the zebra table');
  await step.getByRole('checkbox', { name: /zebra/ }).check();
  await step.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(step.getByRole('status')).toHaveText('Imported 1 conversation.');
  // Ticket 378 (설정 나머지): the line sits beside the Import button, not under the list.
  const mid = async (l: typeof step) => { const b = (await l.boundingBox())!; return b.y + b.height / 2; };
  expect(Math.abs((await mid(step.getByRole('status'))) - (await mid(step.getByRole('button', { name: /^Import \d+ selected$/ }))))).toBeLessThan(8);
  await expect(step.getByRole('checkbox', { name: /zebra/ })).toBeDisabled();

  const box = step.getByRole('textbox', { name: 'Search imported conversations' });
  await box.fill('ZEBRA');
  await box.press('Enter');
  await expect(step.locator('[data-hit]')).toHaveCount(1);
  await expect(step.locator('[data-hit]')).toContainText('migrate the zebra table');
  // The conversation that was listed but not imported is not searched.
  await box.fill('release notes');
  await box.press('Enter');
  await expect(step.getByText('No match in the imported conversations.')).toBeVisible();

  expect(digest(core)).toBe(before);
  expect(fs.existsSync(path.join(core.home, 'import.json'))).toBe(true);
  await app.screenshot({ path: `../.scratch/shots/import-${test.info().project.name}.png` });
});

test('import: nothing is listed or written before the button', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  const step = app.locator('[data-step="import"]');
  await expect(step.getByRole('checkbox')).toHaveCount(0);
  expect(fs.existsSync(path.join(core.home, 'import.json'))).toBe(false);
});

// Ticket 555 (scorecard F5): the first-run import step reads cleanly.
test('import_555_names: a project head shows the project name, the full path is secondary text with a tooltip', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  const step = app.locator('[data-step="import"]');
  await step.getByRole('button', { name: 'Look for conversations' }).click();
  const head = step.locator('[data-project="/work/app"]');
  await expect(head.locator('b')).toHaveText('app');
  await expect(head.locator('.fr-path')).toHaveText('/work/app');
  await expect(head.locator('.fr-path')).toHaveAttribute('title', '/work/app');
});

test('import_555_plurals: "Imported N conversation(s)" is right for 0, 1, 2 in all 8 languages', () => {
  for (const lang of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const) {
    const t = makeT(lang, 'en');
    // The catalogue holds `.one` and `.other` for the same key (the house dialect, see plural() in tree/state.ts).
    const say = (n: number) => t(`import.done.${n === 1 ? 'one' : 'other'}`, { n });
    for (const n of [0, 1, 2]) expect(say(n), `${lang} ${n}`).toContain(String(n));
    expect(say(1), lang).not.toBe(say(2));
    if (lang === 'en') {
      expect(say(0)).toBe('Imported 0 conversations.');
      expect(say(1)).toBe('Imported 1 conversation.');
      expect(say(2)).toBe('Imported 2 conversations.');
    }
    if (lang === 'es') expect(say(1)).toBe('Se importó 1 conversación.');
  }
});

test('import_555_busy: a line says it is importing and the button is off until the import ends', async ({ app, core }) => {
  transcripts(core);
  // Keep the core's answer to `import_add` until released.
  const held: (() => void)[] = [];
  const ids = new Set<number>();
  await app.routeWebSocket(/\/ws$/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (typeof m === 'string') {
        const f = JSON.parse(m);
        if (f.request?.op === 'import_add') ids.add(f.id);
      }
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m === 'string' && ids.has(JSON.parse(m).id)) held.push(() => ws.send(m));
      else ws.send(m);
    });
  });
  await openWindow(app);
  const step = app.locator('[data-step="import"]');
  await step.getByRole('button', { name: 'Look for conversations' }).click();
  await step.getByRole('checkbox', { name: /zebra/ }).check();
  await step.getByRole('button', { name: 'Import 1 selected' }).click();
  await expect(step.getByRole('status')).toHaveText('Importing…');
  await expect(step.getByRole('button', { name: 'Import 1 selected' })).toBeDisabled();
  await expect.poll(() => held.length).toBe(1);
  held.splice(0).forEach((send) => send());
  await expect(step.getByRole('status')).toHaveText('Imported 1 conversation.');
  await expect(step.getByText('Importing…')).toHaveCount(0);
});

test('import_555_running: the session that is running now is not offered for import', async ({ app, core }) => {
  transcripts(core);
  const s = core.agent(core.project('run'), 'Add a hello line', 'x');
  const file = core.transcriptPath(s);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: s.cwd, message: { role: 'user', content: 'Add a hello line to README' } }) + '\n');
  await openWindow(app);
  // A running session means no automatic first-run page: open Settings > Onboarding by hand.
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Onboarding', exact: true }).click();
  const step = app.locator('[data-step="import"]');
  await step.getByRole('button', { name: 'Look for conversations' }).click();
  await expect(step.getByRole('checkbox')).toHaveCount(2);
  await expect(step).toContainText('migrate the zebra table');
  await expect(step).not.toContainText('hello line');
});

test('import_555_error: a failed import says what happened in plain words, not the core text', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  const step = app.locator('[data-step="import"]');
  await step.getByRole('button', { name: 'Look for conversations' }).click();
  await step.getByRole('checkbox', { name: /zebra/ }).check();
  fs.rmSync(path.join(core.home, 'claude-home/projects/-work-app/c1.jsonl'));
  await step.getByRole('button', { name: 'Import 1 selected' }).click();
  const note = step.getByRole('status');
  await expect(note).toContainText('Import failed:');
  await expect(note).not.toContainText(/c1\.jsonl|\/claude-home|os error|No such file/i);
});
