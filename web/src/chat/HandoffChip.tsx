// V2-3b: the pending handoff above the composer (round 2, 02): a divider "Switching to Codex · handoff" and a collapsed
// chip with the preview's counts, View/Edit and ✕. Nothing here sends; the composer's Enter (or Enter in the editor)
// does, and Esc or ✕ drops it.
import { PLAIN } from '../plainText';
import { ErrorDetails } from '../errors';
import { useState } from 'react';
import type { T } from '../i18n';
import type { AgentKind } from '../types';
import { agentName } from './conversation';
import './handoff.css';

export type Preview = { text: string; prompts: number; files: number; bytes: number };
export type Pending = { from: string; fromKind: AgentKind; to: AgentKind; /** V2-4b: the ACP entry a hand-off to `acp` names. */ acp?: string; preview: Preview | null; text: string; error: string | null; /** Ticket 476: the raw reason, under Details. */ details?: string };

export function HandoffChip({ pending, onEdit, onCancel, onSend, t, sideChat = false }: { sideChat?: boolean; t: T; pending: Pending; onEdit: (text: string) => void; onCancel: () => void; onSend: (from: HTMLElement) => void }) {
  const [open, setOpen] = useState(false);
  const p = pending.preview;
  const kb = p ? (p.bytes / 1024).toFixed(1) : '…';
  return (
    <div className={sideChat ? "hoff hoff-side" : "hoff"}>
      {!sideChat && <div className="hoff-div" role="separator">
        {t('chat.handoff.divider', { agent: agentName(pending.to, pending.acp) })}
      </div>}
      <div className="hoff-row" role="group" aria-label={t('chat.handoff.group')}>
        <span className={sideChat ? "chip side-chat-chip" : "chip hoff-chip"} data-handoff-chip>
          {sideChat ? t('chat.side.handoff') : p ? t('chat.handoff.from', { agent: agentName(pending.fromKind), prompts: p.prompts, files: p.files, kb }) : t('chat.handoff.reading', { agent: agentName(pending.fromKind) })}
        </span>
        {sideChat && <span className="side-chat-send-note">{t('chat.side.send')}</span>}
        <button type="button" className="hoff-btn" aria-expanded={open} disabled={!p} onClick={() => setOpen((o) => !o)}>
          {t('chat.handoff.view')}
        </button>
        <button type="button" className="hoff-btn" aria-label={t('chat.handoff.cancel')} title={t('chat.handoff.cancelTitle')} onClick={onCancel}>
          ✕
        </button>
        {pending.error && (
          <span className="hoff-err" role="alert">
            {pending.error}
            <ErrorDetails t={t} details={pending.details} />
          </span>
        )}
      </div>
      {open && p && (
        <textarea {...PLAIN}
          className="hoff-edit"
          aria-label={t('chat.handoff.text')}
          value={pending.text}
          onChange={(e) => onEdit(e.target.value)}
          onKeyDown={(e) => {
            // A Hangul syllable's Enter or Esc belongs to the IME, never to the handoff.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend(e.currentTarget);
            }
          }}
        />
      )}
    </div>
  );
}
