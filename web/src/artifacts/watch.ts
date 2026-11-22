// "changed" (ticket v1b-06): a file is read on view, then asked again on window focus and every 2 s while shown.
// New content marks it changed; it re-renders only when the user asks (04 resets the network grant on a new hash).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactSource } from '../sandbox/ArtifactFrame';
import { host, imageUrl, outsideRoot, problemOf, readFile, type Problem, type Target } from './host';

export const POLL_MS = 2000;

export type Loaded<T> = { key: string; value: T };
export type Watched<T> = { status: 'loading' } | { status: Problem } | { status: 'ready'; shown: T; changed: boolean; show: () => void };

/** HTML and SVG: the frame's id and hash, from `artifact_open`. */
export async function loadFrame(t: Target): Promise<Loaded<ArtifactSource>> {
  const a = await host().open(t.root, t.path);
  return { key: a.hash, value: a };
}

export type Content = { text: string } | { image: string };
/** Markdown and images: the file's content, from `file_read`. */
export async function loadContent(t: Target): Promise<Loaded<Content>> {
  const r = await readFile(t.root, t.path);
  if (t.type === 'image') {
    if (!r.data) throw new Error('not an image');
    const image = imageUrl(t.path, r.data);
    return { key: image, value: { image } };
  }
  if (r.text === null) throw new Error('not text');
  return { key: r.text, value: { text: r.text } };
}

export function useWatched<T>(t: Target, load: (t: Target) => Promise<Loaded<T>>, enabled = true): Watched<T> {
  const [state, setState] = useState<{ status: 'loading' } | { status: Problem } | { status: 'ready'; shown: Loaded<T>; latest: Loaded<T> }>({ status: 'loading' });
  const shownRef = useRef<Loaded<T> | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    shownRef.current = null;
    setState({ status: 'loading' });
    if (outsideRoot(t.path)) return void setState({ status: 'outside' });
    if (!enabled) return;
    let live = true;
    let busy = false;
    const ask = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const got = await loadRef.current(t);
        if (!live) return;
        shownRef.current ??= got;
        const shown = shownRef.current;
        setState((s) => (s.status === 'ready' && s.latest.key === got.key ? s : { status: 'ready', shown, latest: got }));
      } catch {
        if (!live) return;
        const why = await problemOf(t);
        if (live) setState((s) => (s.status === why ? s : { status: why }));
      } finally {
        busy = false;
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), POLL_MS);
    window.addEventListener('focus', ask);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', ask);
    };
    // A target is its root and path; type and title never change what is read.
  }, [t.root, t.path, enabled]);

  const show = useCallback(() => {
    setState((s) => {
      if (s.status !== 'ready') return s;
      shownRef.current = s.latest;
      return { ...s, shown: s.latest };
    });
  }, []);
  if (state.status !== 'ready') return state;
  return { status: 'ready', shown: state.shown.value, changed: state.shown.key !== state.latest.key, show };
}
