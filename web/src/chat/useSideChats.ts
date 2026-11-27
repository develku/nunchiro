// Chat: the pending handoff and side chats (split out of App.tsx, needs 183).
import { errorNote, heldNote, notePlain, startOp, type Note } from '../errors';
import { agentName } from './conversation';
import { useEffect, useRef, useState } from 'react';
import { CoreClient } from '../api';
import { sideChatShown, readSideChats, rememberSideChats, SIDE_CHAT_KEY } from './SideChat';
import { add as addSplit, bindSideSplit, SIDE_START, remove as removeSplit, splitsOf } from '../split/store';
import type { Session } from '../types';
import type { Pending as Handoff, Preview } from './HandoffChip';
import type { T } from '../i18n';

type Deps = { core: CoreClient; sessions: Session[]; t: T; setPaneNote: (note: Note) => void };

/** v2-3b: the pending handoff and the window's side chats (kept in storage), and opening a side chat from a session. */
export function useSideChats({ core, sessions, t, setPaneNote }: Deps) {
  // v2-3b: the one pending handoff (picker, palette or chain link); nothing is sent until the composer's Enter.
  const [handoff, setHandoff] = useState<(Handoff & { fork?: { id: string; through?: string } }) | null>(null);
  const [sideChats, setSideChats] = useState<string[]>(readSideChats);
  useEffect(() => {
    const changed = (e: StorageEvent) => {
      if (e.key === SIDE_CHAT_KEY || e.key === null) setSideChats(readSideChats());
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    const marked = sessions.filter((s) => s.side_chat).map((s) => s.id);
    if (marked.some((id) => !sideChats.includes(id))) setSideChats((ids) => rememberSideChats([...ids, ...marked]));
  }, [sessions, sideChats]);
  const sideOpening = useRef(false);
  /** `anyway`: a low-memory hold's Start anyway, the same side chat past the hold. */
  const openSideChat = async (source: Session, anyway = false) => {
    if (!sideChatShown(source) || sideOpening.current) return;
    sideOpening.current = true;
    let slot: string | null = null;
    try {
      const preview = (await core.request({ op: 'handoff_preview', id: source.id, last_five: true })) as Preview;
      slot = addSplit(source.id, 'right', SIDE_START);
      const args = [...(source.kind === 'claude' ? ['--permission-mode', 'plan'] : ['--sandbox', 'read-only']), '--nunchiro-side-chat', source.id, slot];
      const reply = (await core.request(startOp({ op: 'start', session: { kind: source.kind, project: source.cwd, args, label: 'Side chat', resume: null, ...(source.account ? { account: source.account } : {}) } }, anyway))) as { session: Session };
      const id = reply.session.id;
      if (!bindSideSplit(source.id, slot, id)) {
        await core.request({ op: 'close', id });
        return;
      }
      setSideChats((ids) => rememberSideChats([...ids, id]));
      setHandoff({ from: source.id, fromKind: source.kind, to: source.kind, preview, text: preview.text, error: null, fork: { id } });
    } catch (e) {
      if (slot && splitsOf(source.id).some((s) => s.id === slot && s.what === SIDE_START)) removeSplit(source.id, slot);
      setPaneNote(heldNote(t, e, agentName(source.kind, source.acp_agent), () => void openSideChat(source, true)) ?? errorNote(t('chat.side.error', { error: notePlain(t, e) }), e));
    } finally {
      sideOpening.current = false;
    }
  };
  return { handoff, setHandoff, sideChats, setSideChats, openSideChat };
}
