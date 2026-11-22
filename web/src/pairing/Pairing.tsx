// V2.5-15: first visit from a browser. Asks the core for a pairing, shows the 6-digit code the Mac window shows too,
// and waits for the owner's Allow there. Uses only APIs present in an insecure context (fetch, localStorage).
import { PLAIN } from '../plainText';
import { useEffect, useState } from 'react';
import { applyBrowserLanguage, deviceName, storeToken } from './boot';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import { ErrorDetails, explainError, lineError, rawError } from '../errors';
import './pairing.css';

type State = { step: 'ask' } | { step: 'wait'; id: string; code: string } | { step: 'refused' } | { step: 'paired' };

export function Pairing({ again = false }: { again?: boolean }) {
  useState(applyBrowserLanguage); // ticket 528: before useHtmlLangT reads <html lang>
  const t = useHtmlLangT();
  const [name, setName] = useState(deviceName);
  const [state, setState] = useState<State>({ step: 'ask' });
  const [error, setError] = useState('');
  const [raw, setRaw] = useState(''); // ticket 553: an unknown refusal's own words, under the plain line
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    setBusy(true);
    setError('');
    setRaw('');
    try {
      const r = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const v = (await r.json()) as { id?: string; code?: string; error?: string };
      if (r.ok && v.id && v.code) setState({ step: 'wait', id: v.id, code: v.code });
      else if (v.error) {
        setError(lineError(t, v.error));
        const why = explainError(t, v.error);
        if (!why.known) setRaw(why.details);
      } else setError(t('rest.pf.pair.refusedStatus', { status: r.status }));
    } catch (e) {
      setError(t('rest.pf.pair.unreachable')); // ticket 559: a plain line; the browser's own words ("Failed to execute 'json'...") go under Details
      setRaw(rawError(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (state.step !== 'wait') return;
    let live = true;
    const poll = async () => {
      try {
        const v = (await (await fetch(`/pair/${state.id}`, { cache: 'no-store' })).json()) as { state: string; token?: string };
        if (!live) return;
        if (v.state === 'allowed' && v.token) {
          if (!storeToken(v.token)) return setError(t('rest.pf.pair.noStorage'));
          setState({ step: 'paired' });
          location.reload();
          return;
        }
        if (v.state === 'refused') return setState({ step: 'refused' });
      } catch {
        // A dropped poll is retried.
      }
      if (live) timer = setTimeout(poll, 1000);
    };
    let timer = setTimeout(poll, 1000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [state]);

  return (
    <main className="pairing" aria-labelledby="pair-title">
      <h1 id="pair-title">{t('rest.pf.pair.title')}</h1>
      {again && <p role="alert">{t('rest.pf.pair.revoked')}</p>}
      <p className="lede">{t('rest.pf.pair.lede')}</p>
      {state.step === 'ask' && (
        <form onSubmit={(e) => (e.preventDefault(), void ask())}>
          <label>
            {t('rest.pf.pair.device')} <input {...PLAIN} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="pair-btn primary" disabled={busy || !name.trim()}>
            {t('rest.pf.pair.pair')}
          </button>
        </form>
      )}
      {state.step === 'wait' && (
        <section aria-label={t('rest.pf.pair.code')}>
          <p>{t('rest.pf.pair.onMac')}</p>
          <p className="pair-code" data-pair-code>
            {state.code}
          </p>
          <p role="status">{t('rest.pf.pair.waiting')}</p>
        </section>
      )}
      {state.step === 'refused' && (
        <section>
          <p role="alert">{t('rest.pf.pair.refused')}</p>
          <button className="pair-btn" onClick={() => setState({ step: 'ask' })}>
            {t('rest.pf.pair.tryAgain')}
          </button>
        </section>
      )}
      {state.step === 'paired' && <p role="status">{t('rest.pf.pair.paired')}</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <ErrorDetails t={t} details={raw} />
        </div>
      )}
    </main>
  );
}
