// Tree: the New Session and Stop dialogs' state (split out of App.tsx, needs 183).
import { docT, errorNote, notePlain, type Note, rawError } from '../errors';
import { useEffect, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import type { AgentKind, Session } from '../types';
import { NEW_EVENT, needsAsk, STOP_EVENT } from '../NewSession';

type Deps = { core: CoreClient; byId: Map<string, Session>; setPaneNote: (note: Note) => void };

/** v1a-59: the New Session dialog (palette, a project's "+", the empty state) and the one Stop question. */
export function useSessionStart({ core, byId, setPaneNote }: Deps) {
  // v1a-59: the start dialog (opened by the palette, a project's "+" or the empty state) and the one Stop question.
  const [starting, setStarting] = useState<{ project?: string; agent?: AgentKind; machine?: string; go?: boolean; worktree?: { path: string; name: string } } | null>(null);
  const [stopping, setStopping] = useState<{ id: string; error: string } | null>(null);
  const stopSession = (id: string, asked = false) =>
    core.request({ op: 'close', id }).then(
      () => setStopping(null),
      (e) => {
        const text = rawError(e);
        if (asked) setStopping({ id, error: text });
        else setPaneNote(errorNote(docT()('err.note.notStopped', { error: notePlain(docT(), e) }), e));
      },
    );
  const stop = (id: string) => {
    const s = byId.get(id);
    if (s?.state !== 'running') return;
    if (needsAsk(s)) setStopping({ id, error: '' });
    else void stopSession(id);
  };
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    // Asked again while open (a click on the tab strip's "+", the new-session key): it closes, as Orca's "+" menu does.
    const onNew = (e: Event) => {
      const asked = (e as CustomEvent<{ project?: string; agent?: AgentKind; machine?: string; go?: boolean; worktree?: { path: string; name: string } }>).detail;
      setStarting((open) => (open ? null : { project: asked?.project, agent: asked?.agent, machine: asked?.machine, go: asked?.go, worktree: asked?.worktree }));
    };
    const onStop = (e: Event) => stopRef.current((e as CustomEvent<{ id: string }>).detail.id);
    window.addEventListener(NEW_EVENT, onNew);
    window.addEventListener(STOP_EVENT, onStop);
    return () => (window.removeEventListener(NEW_EVENT, onNew), window.removeEventListener(STOP_EVENT, onStop));
  }, []);
  return { starting, setStarting, stopping, setStopping, stopSession, stop };
}
