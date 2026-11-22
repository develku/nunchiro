// The one confirmation before "Quit and stop all agents" (spec Core and window), and the one-time notice
// that closing the window leaves agents running. Native <dialog>: focus is trapped and Esc cancels.
import { useEffect, useRef } from 'react';
import type { Key } from '../../i18n';
import { sessionName } from '../../Sidebar';
import { agentName } from '../../chat/conversation';
import { kindTitle } from '../../chat/DecisionCard';
import { ErrorDetails } from '../../errors';
import type { Session } from '../../types';

type T = (key: Key, args?: Record<string, string | number>) => string;

function Modal({ label, onCancel, children }: { label: string; onCancel: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" aria-label={label} onCancel={(e) => (e.preventDefault(), onCancel())}>
      {children}
    </dialog>
  );
}

export function QuitDialog({ t, sessions, onCancel, onConfirm, busy, error, details }: { sessions: Session[]; onCancel: () => void; onConfirm: () => void; busy: boolean; error: string; details?: string; t: T }) {
  const running = sessions.filter((s) => s.state === 'running');
  const pending = sessions.flatMap((s) => s.pending.map((d) => ({ d, s })));
  return (
    <Modal label={t('settings.lifetime.quit')} onCancel={onCancel}>
      <h2>{t('settings.lifetime.quitAsk')}</h2>
      <p>{t(running.length === 1 ? 'settings.lifetime.quitEnds.one' : 'settings.lifetime.quitEnds.other', { n: running.length })}</p>
      <h3>{t('settings.lifetime.running', { n: running.length })}</h3>
      <ul>
        {running.map((s) => (
          <li key={s.id}>
            {sessionName(s)} <span className="dim">· {agentName(s.kind, s.acp_agent)}</span>
          </li>
        ))}
        {running.length === 0 && <li className="dim">{t('settings.lifetime.none')}</li>}
      </ul>
      <h3>{t('settings.lifetime.pending', { n: pending.length })}</h3>
      <p className="dim">{t('settings.lifetime.dropped')}</p>
      <ul>
        {pending.map(({ d, s }) => (
          <li key={d.id}>
            {sessionName(s)} <span className="dim">· {kindTitle(d, t)}</span>
          </li>
        ))}
        {pending.length === 0 && <li className="dim">{t('settings.lifetime.none')}</li>}
      </ul>
      {error && (
        <div className="conflict" role="alert">
          {error}
          <ErrorDetails t={t} details={details} />
        </div>
      )}
      <div className="actions">
        <button className="btn" autoFocus onClick={onCancel} disabled={busy} aria-busy={busy || undefined}>
          {t('settings.lifetime.cancel')}
        </button>{' '}
        <button className="btn p" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
          {busy ? t('settings.lifetime.stopping') : t('settings.lifetime.quit')}
        </button>
      </div>
    </Modal>
  );
}

export function CloseNotice({ t, fullQuit, onClose, onCancel }: { t: T; fullQuit: string; onClose: () => void; onCancel: () => void }) {
  return (
    <Modal label={t('settings.lifetime.closing')} onCancel={onCancel}>
      <h2>{t('settings.lifetime.keepRunning')}</h2>
      <p>
        {t('settings.lifetime.closeNote', { fullQuit })}{' '}
        <code>{'nunchiro serve stop'}</code>{t('settings.lifetime.once')}
      </p>
      <div className="actions">
        <button className="btn" onClick={onCancel}>
          {t('settings.lifetime.keepWindow')}
        </button>{' '}
        <button className="btn p" autoFocus onClick={onClose}>
          {t('settings.lifetime.closeWindow')}
        </button>
      </div>
    </Modal>
  );
}
