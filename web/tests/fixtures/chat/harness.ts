// Chat tests drive the real core: a fake `claude` session whose transcript the test writes record by record,
// so every frame the window sees is the core's own projection (README "Chat events").
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { Core, REPO, expect, test as base } from '../../fixtures';

const BIN = path.join(REPO, 'target/debug/nunchiro');
export const TESTED = '2.1.310 (Claude Code)';

// `--version` reads a file so a test can pick an untested version; a line "STOP <text>" typed into the PTY sends
// the Stop hook the real agent would (last_assistant_message), through the session's own hook token; "EXIT" ends it.
const fake = (home: string) => `#!/bin/sh
if [ "$1" = --version ]; then cat '${home}/fake-version'; exit; fi
printf 'fake chat agent\\r\\n'
n=0
while IFS= read -r line; do
  case "$line" in
    EXIT) exit 0 ;;
    STOP\\ *) n=$((n+1)); printf '{"session_id":"x","turn_id":"t%s","last_assistant_message":"%s"}' "$n" "\${line#STOP }" | '${BIN}' hook Stop ;;
  esac
done
`;

export class ChatCore extends Core {
  constructor(id: string) {
    super(id);
    fs.writeFileSync(path.join(this.home, 'bin/claude'), fake(this.home), { mode: 0o700 });
    this.version(TESTED);
  }
  version(v: string) {
    fs.writeFileSync(path.join(this.home, 'fake-version'), `${v}\n`);
  }
  /** A fake Claude session; `transcript` false leaves it with none yet (a fresh session). The project folder is named by the label;
   *  ticket 570: the tab strip shows one project, so chats that share a strip pass the same `project`. */
  chat(label = 'chat', transcript = true, worktree = false, project = label) {
    const args = ['session', 'start', '--kind', 'claude', '--project', this.project(project), '--label', label];
    if (worktree) args.push('--worktree');
    const s = this.cli(...args).session as { id: string; cwd: string; agent_session_id: string };
    const file = this.transcriptPath(s);
    if (transcript) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    }
    return { ...s, file };
  }
}

export const test = base.extend<{ chatCore: ChatCore }>({
  chatCore: async ({ page }, use, info) => {
    const core = new ChatCore(`chat-${info.workerIndex}-${info.testId}`);
    await core.ready();
    await page.addInitScript((boot) => {
      window.__NUNCHIRO__ = boot;
    }, core.boot());
    // V2.5-69 (ticket 289): the Board opens as the watch view; specs written against the columns view keep it (board/views.ts).
    await page.addInitScript(() => localStorage.setItem('nunchiro.test.board-mode', 'columns'));
    await use(core);
    await core.stop();
  },
});
export { expect };

let uuid = 0;
const id = () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`;

/** Claude Code 2.1.310 transcript records (shapes as in crates/nunchiro-core/tests/fixtures/chat/claude-2.1.310). */
export const rec = {
  user: (text: string) => ({ type: 'user', uuid: id(), message: { role: 'user', content: text } }),
  userImage: (text: string) => ({
    type: 'user',
    uuid: id(),
    message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c2FtcGxl' } }] },
  }),
  assistant: (text: string) => ({ type: 'assistant', uuid: id(), message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  note: (text: string) => ({ type: 'assistant', thinkingDisplay: 'updates', uuid: id(), message: { role: 'assistant', content: [{ type: 'thinking', thinking: text, signature: 'x' }] } }),
  thinking: (text: string) => ({ type: 'assistant', uuid: id(), message: { role: 'assistant', content: [{ type: 'thinking', thinking: text, signature: 'x' }] } }),
  use: (tool_id: string, name: string, input: unknown) => ({
    type: 'assistant',
    uuid: id(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: tool_id, name, input }] },
  }),
  result: (tool_id: string, content: string, extra: Record<string, unknown> = {}, is_error = false) => ({
    type: 'user',
    uuid: id(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool_id, content, is_error }] },
    ...extra,
  }),
  /** An Edit call and its result with the structured patch the diff card renders. */
  edit: (tool_id: string, file: string, lines: string[]) => [
    rec.use(tool_id, 'Edit', { file_path: file, old_string: 'a', new_string: 'b' }),
    rec.result(tool_id, 'edited', {
      toolUseResult: {
        filePath: file,
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: lines.filter((l) => !l.startsWith('+')).length,
            newStart: 1,
            newLines: lines.filter((l) => !l.startsWith('-')).length,
            lines,
          },
        ],
      },
    }),
  ],
};

export function append(file: string, ...records: unknown[]) {
  fs.appendFileSync(file, records.flat().map((r) => JSON.stringify(r) + '\n').join(''));
}

/** Opens the window on the core and waits for the live connection and the first chat page. `firstPage`: the wait for
 * that page, for a transcript the core must index first (the debug core reads every record of it from the start). */
export async function openChat(page: Page, session: string, firstPage?: number) {
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.locator(`.tab[data-tab="${session}"]`).click();
  await expect(page.locator(`.chat[data-session="${session}"] .clist`)).toHaveAttribute('aria-busy', 'false', { timeout: firstPage });
}

export const chat = (page: Page, session: string) => page.locator(`.chat[data-session="${session}"]`);
