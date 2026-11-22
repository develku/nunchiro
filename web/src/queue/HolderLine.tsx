// V2-1b: after a core restart or update, a session whose holder speaks another protocol keeps its agent running but
// is not attached. A plain status line says what to do: an older holder restarts the session (close, then start
// again, resuming the conversation where there is one); a newer holder needs this Nunchiro updated.
import { useState } from 'react';
import type { CoreClient } from '../api';
import { canRestart, restartStart } from '../PermissionNeeded';
import type { Session } from '../types';
import { ErrorLine } from '../errors';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';

export function HolderLine({ core, session, onReplaced }: { core: CoreClient; session: Session; onReplaced: (old: string, next: Session) => void }) {
  const t = useHtmlLangT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (session.state !== 'running' || !session.holder_status) return null;
  if (session.holder_status === 'update_nunchiro')
    return (
      <p className="perm-needed" role="status">
        <b>{t('rest.shell.holder.update')}</b> · {t('rest.shell.holder.newer')}
      </p>
    );
  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      await core.request({ op: 'close', id: session.id });
      if (canRestart(session)) {
        const reply = (await core.request({ op: 'start', session: restartStart(session) })) as { session?: Session };
        if (reply.session) onReplaced(session.id, reply.session);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="perm-needed" role="status">
      {t('rest.shell.holder.needsRestart')}{' '}
      <button className="btn" disabled={busy} onClick={() => void restart()}>
        {t('shell.chrome.restartSession')}
      </button>
      <ErrorLine t={t} error={error} className="" />
    </div>
  );
}
