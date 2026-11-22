// Ticket 358 (358.html #rename, #rename/dup): an account's name, edited in place of its row. Owner 11-16: the agent's own
// account too (the core keeps that name in its settings, never in the agent's config). The core makes the same checks (accounts.rs `rename`); this only keeps Save off for what it would refuse.
import { PLAIN } from '../../plainText';
import { useState, type KeyboardEvent } from 'react';
import { accountName, type Account, type CoreClient } from '../../api';
import { ACCOUNTS_CHANGED } from '../../tree';
import type { T } from './providers';
import { validName } from './sections';
import { ErrorDetails, plainError, rawError } from '../../errors';

export async function renameAccount(core: CoreClient, a: Account, label: string) {
  await core.request({ op: 'account_rename', agent: a.agent, id: a.id, label });
  window.dispatchEvent(new Event(ACCOUNTS_CHANGED)); // a cached account list reads again
}

export function RenameRow({ t, account, taken, onSave, onClose }: { t: T; account: Account; taken: string[]; onSave: (a: Account, label: string) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(accountName(t, account));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>('');
  const label = value.trim();
  const duplicate = taken.includes(label);
  const ok = validName(label) && !duplicate && !sending;
  const save = async () => {
    if (!ok) return;
    setSending(true);
    setError('');
    try {
      await onSave(account, label);
      onClose();
    } catch (e) {
      setError(e);
      setSending(false);
    }
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // Enter commits a Hangul syllable
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // Settings must not close under it
      onClose();
    }
  };
  const line = error ? plainError(t, error) : (duplicate ? t('providersManage.duplicate') : t('providersManage.renameNote'));
  return (
    <div className="acct-rename" role="group" aria-label={t('providersManage.renameGroup', { label: accountName(t, account) })} data-account={account.id}>
      <div className="acct-rename-row">
        <input {...PLAIN} className="prv-inp" aria-label={t('settings.accounts.name')} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={keys} onFocus={(e) => e.currentTarget.select()} autoFocus autoComplete="off" spellCheck={false} />
        <span className="acct-acts">
          <button className="btn p" disabled={!ok} aria-busy={sending} onClick={() => void save()}>
            {t('providersManage.save')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('settings.accounts.cancel')}
          </button>
        </span>
      </div>
      <div className={`prv-note${error || duplicate ? ' bad' : ''}`} role={error ? 'alert' : undefined}>
        {line}
        {error ? <ErrorDetails t={t} details={rawError(error)} /> : null}
      </div>
    </div>
  );
}
