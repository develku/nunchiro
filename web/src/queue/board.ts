// v1b-18: needs-decision board cards as queue items of kind `board` (spec B4, Acceptance 12). They come from the
// snapshot's `board_decisions`, not from a session; their only answers are Resolved and, with a URL, Open.
import { useMemo, useRef } from 'react';
import type { CoreClient } from '../api';
import type { BoardDecision, Decision, Session } from '../types';

/** One id per raise: a later `updated_at` is a new item, so the strip and tree treat it as new. */
export const boardId = (b: BoardDecision) => `${b.identity}@${b.updated_at}`;

/** Queue items for the strip and tree. `observed_at` is when this window first saw the raise (the card's
 * `updated_at` is the integration's own clock), so arrival order matches session items. */
export function useBoardItems(list: BoardDecision[], sessions: Session[]): Decision[] {
  const first = useRef(new Map<string, number>());
  return useMemo(() => {
    const projects = new Set(sessions.map((s) => s.project));
    const ids = new Set(list.map(boardId));
    for (const id of first.current.keys()) if (!ids.has(id)) first.current.delete(id);
    return list.map((b) => {
      const id = boardId(b);
      if (!first.current.has(id)) first.current.set(id, Date.now());
      return {
        id,
        session_id: '',
        // The tree slot: a project with sessions here; otherwise the item shows in the strip only.
        scope: b.project && projects.has(b.project) ? b.project : '',
        kind: 'board' as const,
        text: b.question,
        choices: [],
        observed_at: first.current.get(id)!,
        actionable: true,
        board: b,
      };
    });
  }, [list, sessions]);
}

export const resolveBoard = (core: CoreClient, b: BoardDecision) => core.request({ op: 'board_resolve', identity: b.identity, updated_at: b.updated_at });

/** Who asks: the integration source's name, or "board" for a manual card. */
export const boardWho = (b: BoardDecision) => b.source_name ?? 'board';
