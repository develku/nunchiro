// CHROME (CLAUDEFEEL): the transcript view, one per window: Verbose (every step, today's rendering), Normal (each turn's
// tool calls fold into one summary line) and Thinking (Normal plus the agent's thinking). The chat.cycleView command (Ctrl+O by default, bound in keys.ts)
// and the chat's control cycle them. Normal starts folded, as approved in needs 121 and the fid-chat round-2 ruling.
import { useSyncExternalStore } from 'react';
import type { Key } from '../i18n';

export type View = 'normal' | 'thinking' | 'verbose';
const ORDER: View[] = ['normal', 'thinking', 'verbose'];
const KEY = 'nunchiro.chatView.v2'; // v1 was a removed view store (chat.spec ignores it)
const DEFAULT: View = 'normal';
export const VIEW_LABEL: Record<View, Key> = { normal: 'chat.view.normal', thinking: 'chat.view.thinking', verbose: 'chat.view.verbose' };

const read = (): View => {
  try {
    const v = localStorage.getItem(KEY);
    return ORDER.includes(v as View) ? (v as View) : DEFAULT;
  } catch {
    return DEFAULT;
  }
};
let current = read();
const subs = new Set<() => void>();

export function cycleView() {
  current = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  try {
    localStorage.setItem(KEY, current);
  } catch {
    // Private window or blocked storage: the view lasts until reload.
  }
  subs.forEach((f) => f());
}

export const useView = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => current,
  );
