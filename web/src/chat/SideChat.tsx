import type { T } from '../i18n';
import type { Session } from '../types';
import './side-chat.css';

export const sideChatShown = (s: Session | null): s is Session => !!s && !s.machine && s.state === 'running' && (s.kind === 'claude' || s.kind === 'codex');
export const SIDE_CHAT_KEY = 'nunchiro.side-chat.v1';
export function readSideChats(): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(SIDE_CHAT_KEY) ?? '[]');
    return Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? ids : [];
  } catch {
    return [];
  }
}
export function rememberSideChats(ids: string[]): string[] {
  const next = [...new Set([...readSideChats(), ...ids])];
  try {
    localStorage.setItem(SIDE_CHAT_KEY, JSON.stringify(next));
  } catch {
    // A window with storage disabled still keeps its live pane state.
  }
  return next;
}
// Structured Resume/Restart is refused; raw owner commands are out of scope per needs 47 (same-user authority).
export function SideChat({ id, t }: { id: string; t: T }) {
  return <div className="side-chat-head" data-side-chat={id}>
    <span>{t('chat.side.mode')}</span>
    <p>{t('chat.side.notice')}</p>
  </div>;
}
