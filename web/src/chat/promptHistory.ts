// Ticket 371 item 14: Up and Down bring back this session's earlier prompts in the composer. ChatView publishes the user
// rows here, the composer reads them at the keypress. Prompts are only what the transcript already holds.
// `stepPromptHistory`, `findActive` and the repeat rule in `promptEntries` are adapted from T3 Code
// `apps/web/src/components/chat/composerPromptHistory.ts` (local source copy, no commit recorded).
// MIT License, Copyright (c) 2026 T3 Tools Inc.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { savedPaths } from '../images/Thumbnail';
import type { Row } from './model';
import { isCommandRecord } from './commandRecord';

export interface PromptEntry {
  readonly id: string;
  readonly prompt: string;
}

export interface PromptPosition {
  readonly entryId: string;
  readonly recalled: string;
}

type UserRow = { key: number; text: string };

/** One list per session, the least recently published dropped first (ChatView keeps 8 transcripts). */
const PUBLISHED_MAX = 16;
const published = new Map<string, UserRow[]>();

export function publishPrompts(session: string, rows: readonly Row[]) {
  published.delete(session);
  published.set(
    session,
    rows.flatMap((r) => (r.kind === 'user' ? [{ key: r.key, text: r.text }] : [])),
  );
  if (published.size > PUBLISHED_MAX) published.delete(published.keys().next().value!);
}

/** A sent prompt as it can be typed again: the lines that only named a saved image are gone, their chips cannot come back.
 *  A slash command's record is never given back (`isCommandRecord`). */
export function recallable(text: string) {
  if (isCommandRecord(text)) return '';
  const saved = new Set(savedPaths(text).map((s) => s.path));
  return text
    .split('\n')
    .filter((l) => !saved.has(l.trim()))
    .join('\n')
    .trim();
}

export function promptEntries(session: string): PromptEntry[] {
  const entries: PromptEntry[] = [];
  for (const row of published.get(session) ?? []) {
    const prompt = recallable(row.text);
    if (!prompt) continue;
    const id = String(row.key);
    if (entries.at(-1)?.prompt === prompt) entries[entries.length - 1] = { id, prompt };
    else entries.push({ id, prompt });
  }
  return entries;
}

function findActive(entries: readonly PromptEntry[], position: PromptPosition) {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  return entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

/** The next prompt for the box, or null when the key is not recall's: a box holding other text never changes. */
export function stepPromptHistory(input: { direction: 'backward' | 'forward'; entries: readonly PromptEntry[]; position: PromptPosition | null; currentPrompt: string }): { position: PromptPosition | null; prompt: string } | null {
  const { entries, position, currentPrompt } = input;
  const activeIndex = position && position.recalled === currentPrompt ? findActive(entries, position) : -1;

  if (input.direction === 'backward') {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (!entry) return null;
    return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
  }

  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (!entry) return { position: null, prompt: '' };
  return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}
