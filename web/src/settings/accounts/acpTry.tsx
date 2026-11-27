// The test message of an approved ACP agent's row (mockup docs/design/agent-kinds-m7/index.html, section 3): one fixed
// sentence on the owner's click only, the answer and its receipt, and the row's chip that says when it last answered.
// The core runs it confined as the setup check (crates/nunchiro-core/src/acp/turn.rs) and keeps the last result.
import { useState } from 'react';
import type { AcpTurn, CoreClient } from '../../api';
import { ErrorDetails, plainError, rawError } from '../../errors';
import { Chip, Ln, type T } from './providers';

const DAY = 86_400_000;
const FAIL = {
  no_answer: 'providersTry.fail.no_answer',
  not_signed_in: 'providersTry.fail.not_signed_in',
  error: 'providersTry.fail.error',
  empty: 'providersTry.fail.empty',
  no_end: 'providersTry.fail.no_end',
} as const;
const numbers = (v: string | null | undefined) => v?.match(/\d+(\.\d+)+/)?.[0] ?? '';
const dayStart = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** Not tried, Answered today / n days ago, Not tried on {version} (the agent changed since), Test failed. */
export function TryChip({ t, turn, version }: { t: T; turn?: AcpTurn; version?: string | null }) {
  if (!turn) return <Chip word={t('providersTry.chip.none')} />;
  if (turn.failure) return <Chip word={t('providersTry.chip.failed')} tone="bad" />;
  const now = numbers(version);
  if (now && numbers(turn.version) && now !== numbers(turn.version)) return <Chip word={t('providersTry.chip.version', { version: now })} tone="warn" />;
  const days = Math.round((dayStart(Date.now()) - dayStart(turn.at * 1000)) / DAY);
  return <Chip word={days < 1 ? t('providersTry.chip.today') : t(days === 1 ? 'providersTry.chip.days.one' : 'providersTry.chip.days.other', { n: days })} tone="ok" />;
}

function when(t: T, at: number) {
  const d = new Date(at * 1000);
  const lang = document.documentElement.lang || undefined;
  const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  return dayStart(d.getTime()) === dayStart(Date.now()) ? t('providersTry.today', { time }) : `${d.toLocaleDateString(lang)} ${time}`;
}

export function AcpTry({ t, core, name, label, turn, onDone }: { t: T; core: CoreClient; name: string; label: string; turn?: AcpTurn; onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async () => {
    setRunning(true);
    setError(null);
    try {
      await core.acpTry(name);
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
      onDone();
    }
  };
  const agent = { agent: label };
  const failure = turn?.failure;
  const failed = !failure ? '' : failure === 'other' ? (turn?.error ?? '') : t(FAIL[failure], { ...agent, text: turn?.error ?? '' });
  return (
    <div data-field="acp-try">
      <Ln k={t('providersTry.title')} sp>
        <span className="prv-try">
          {running ? (
            <span role="status">{t('providersTry.waiting', agent)}</span>
          ) : turn && !turn.failure ? (
            <>
              <span>{t('providersTry.answered', { text: turn.text, seconds: (turn.ms / 1000).toFixed(1) })}</span>
              <small>{t('providersTry.receipt', { ...agent, version: numbers(turn.version), when: when(t, turn.at) })}</small>
            </>
          ) : (
            <>
              <span>{t('providersTry.sends')}</span>
              <small>{t('providersTry.costs', agent)}</small>
            </>
          )}
        </span>
        <span className="prv-end">
          {running ? (
            <button type="button" className="btn" onClick={() => void core.acpTryCancel(name).catch(() => {})}>
              {t('providersTry.cancel')}
            </button>
          ) : (
            <button type="button" className={turn ? 'btn' : 'btn p'} onClick={() => void send()}>
              {t(turn ? 'providersTry.again' : 'providersTry.send')}
            </button>
          )}
        </span>
      </Ln>
      {!running && failed && (
        <div role="alert" className="prv-note bad">
          {failed}
          {turn?.failure === 'no_answer' && <> {t('providersTry.fail.no_answer.next')}</>}
        </div>
      )}
      {!running && !!error && (
        <div role="alert" className="prv-note bad">
          {plainError(t, error)}
          <ErrorDetails t={t} details={rawError(error)} />
        </div>
      )}
    </div>
  );
}
