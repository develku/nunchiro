// After a restart each session that was running is offered for explicit resume into the same agent session
// id (`claude --resume <id>`, `codex resume <id>`; the core builds the command). Nothing resumes by itself.
// rc2b-fb (needs 190 (2)): × or Esc in the bar hides it for the sessions it showed, kept in this window's storage,
// until a session not among them can resume.
import { useState } from 'react';
import { Icon } from '../../icons/Icon';
import type { CoreClient } from '../../api';
import type { Key } from '../../i18n';
import { sessionName } from '../../Sidebar';
import { ErrorLine } from '../../errors';
import type { Session } from '../../types';

type T = (key: Key, args?: Record<string, string | number>) => string;
export const resumable = (s: Session) => !s.side_chat && s.state === 'resumable' && !!s.agent_session_id;

const DISMISSED = 'nunchiro.resumeDismissed.v1';
const loadDismissed = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export function ResumeOffer({ t, core, sessions }: { t: T; core: CoreClient; sessions: Session[] }) {
  const [error, setError] = useState<unknown>('');
  const [starting, setStarting] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(loadDismissed);
  const list = sessions.filter(resumable);
  if (!list.some((s) => !dismissed.includes(s.id))) return null;
  const dismiss = () => {
    // Only the sessions shown now: ids the core forgot drop out of the store.
    const ids = list.map((s) => s.id);
    setDismissed(ids);
    try {
      localStorage.setItem(DISMISSED, JSON.stringify(ids));
    } catch {
      // Storage blocked: dismissed for this window only.
    }
  };
  const resume = async (s: Session) => {
    setError('');
    setStarting((a) => [...a, s.id]);
    try {
      await core.request({ op: 'start', session: { kind: s.kind, project: s.project, label: s.label, resume: s.agent_session_id } });
    } catch (e) {
      setError(e);
    } finally {
      setStarting((a) => a.filter((id) => id !== s.id));
    }
  };
  return (
    <section className="resume" aria-label={t('settings.lifetime.resumeRegion')} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), dismiss())}>
      <b>{t('settings.lifetime.resumeTitle')}</b>
      {list.map((s) => (
        <span key={s.id} className="resume-item" data-session={s.id}>
          {sessionName(s)}{' '}
          <button className="btn" disabled={starting.includes(s.id)} aria-label={t('settings.lifetime.resumeOne', { name: sessionName(s) })} onClick={() => void resume(s)}>
            {t('settings.lifetime.resume')}
          </button>
        </span>
      ))}
      <ErrorLine t={t} error={error} />
      <button type="button" className="btn" aria-label={t('settings.lifetime.resumeDismiss')} title={t('settings.lifetime.resumeDismiss')} onClick={dismiss}>
        <Icon name="x" size={12} />
      </button>
    </section>
  );
}
