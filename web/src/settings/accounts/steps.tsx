// A listed agent's add tile opens four steps in place of the bare form (mockup docs/design/agent-kinds-m7/index.html,
// section 3): Install, Approve, Sign in, Test, under the list's cost line. Install types the vendor's command into a
// visible terminal tab and never runs it; Approve is the form's own promise in one click (the confined check, then add,
// then the grant of exactly the hash of what was shown); Sign in and Test happen on the agent's row once it is approved.
import { useEffect, useState, type ReactNode } from 'react';
import type { AcpCost, AcpEntry, AcpRow, AgentView, CoreClient } from '../../api';
import type { Key } from '../../i18n';
import { ErrorDetails, plainError, rawError } from '../../errors';
import { openExternal } from '../../sandbox/link';
import { copyText } from '../../terminal/clipboard';
import { joinWords } from '../agents/words';
import { Chip, Ln, type T } from './providers';

/** A cost line older than this is shown in the warning tone. */
const STALE_DAYS = 90;
export const costWord = (cost: AcpCost): Key => `providersSteps.word.${cost}` as Key;
const numbers = (v: string | null | undefined) => v?.match(/\d+(\.\d+)+/)?.[0] ?? '';
const same = (a: AcpEntry, b: AcpEntry) => a.name === b.name && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args) && JSON.stringify(a.env) === JSON.stringify(b.env);

const Step = ({ k, done, children }: { k: string; done?: boolean; children: ReactNode }) => (
  <Ln
    k={
      <>
        {done && (
          <svg className="tl-check" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8.5l3.2 3.2L13 4.8" />
          </svg>
        )}
        {k}
      </>
    }
    sp
  >
    {children}
  </Ln>
);

export function AcpSteps({ t, core, row, onApproved, onChange, onRecheck }: { t: T; core: CoreClient; row: AcpRow; onApproved: (view: AgentView) => void; onChange: () => void; onRecheck: () => void }) {
  const setup = row.setup!;
  const [opened, setOpened] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const installed = !!row.found_path;
  const command = setup.install?.length ? joinWords(setup.install) : (setup.install_script ?? '');
  // The window coming back to the front is when an install in the terminal tab may have finished (as onboarding checks).
  useEffect(() => {
    if (installed) return;
    const back = () => onRecheck();
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [installed, onRecheck]);

  const openTab = async () => {
    setError(null);
    try {
      // An empty project starts the shell in the home folder; the text goes in with no Return, so nothing runs.
      const { session } = (await core.request({ op: 'start', session: { kind: 'shell', project: '', label: `Install ${row.label}`, resume: null } })) as { session: { id: string } };
      await core.sendText(session.id, command);
      setOpened(true);
    } catch (e) {
      setError(e);
    }
  };
  const entry: AcpEntry = { name: row.name, command: row.found_path ?? row.command, args: row.args, env: row.env };
  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const check = await core.acpCheck(entry);
      if (check.acp_v1_ms === null) throw new Error(check.error ?? t('providers.failed'));
      const view = await core.acpAdd(entry);
      if (!same(view.entry, entry)) throw new Error(t('agents.sheet.changed'));
      if (view.refused) throw new Error(view.refused);
      onApproved(await core.acpGrant(view.name, view.hash));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const age = setup.checked ? (Date.now() - Date.parse(setup.checked)) / 86_400_000 : 0;
  return (
    <div className="prv-exp f" role="group" aria-label={row.label} data-field="acp-steps">
      <Ln k={t('providersSteps.cost')} sp>
        {setup.cost === 'unknown' ? (
          <span>{t('providersSteps.notChecked')}</span>
        ) : (
          <span className="prv-try">
            <span>{setup.cost_line}</span>
            <small>
              {setup.checked && (age > STALE_DAYS ? <Chip word={t('providersSteps.checked', { date: setup.checked })} tone="warn" /> : t('providersSteps.checked', { date: setup.checked }))}
              {setup.pricing_url && (
                <>
                  {' · '}
                  <a href={setup.pricing_url} onClick={(e) => (e.preventDefault(), void openExternal(setup.pricing_url!))}>
                    {t('providersSteps.plans', { service: setup.account ?? row.label })} ↗
                  </a>
                </>
              )}
            </small>
          </span>
        )}
      </Ln>
      <Step k={t('providersSteps.install')} done={installed}>
        {installed ? (
          <span className="mono">{`${row.found_path}${numbers(row.version) ? ` · ${numbers(row.version)}` : ''}`}</span>
        ) : (
          <>
            <span className="prv-try">
              {command && <code className="mono">{command}</code>}
              <small>
                {command && t('providersSteps.installNote')}
                {row.install_url && (
                  <>
                    {' · '}
                    <a href={row.install_url} onClick={(e) => (e.preventDefault(), void openExternal(row.install_url!))}>
                      {t('providersSteps.guide')} ↗
                    </a>
                  </>
                )}
              </small>
            </span>
            {command && <span className="prv-end">
              <button type="button" className="btn" onClick={() => void copyText(command).then((ok) => (setCopied(ok), setTimeout(() => setCopied(false), 1500)))}>
                {t(copied ? 'providersSteps.copied' : 'providersSteps.copy')}
              </button>
              <button type="button" className="btn p" onClick={() => void openTab()}>
                {t('providersSteps.openTab')}
              </button>
            </span>}
          </>
        )}
      </Step>
      {opened && !installed && (
        <p role="status" className="prv-note">
          {t('providersSteps.notFound')}
        </p>
      )}
      <Step k={t('providersSteps.approve')}>
        {installed ? (
          <>
            <span className="prv-try">
              <code className="mono">{joinWords([entry.command, ...entry.args])}</code>
              <small>{row.env.length ? row.env.join(', ') : t('providersSteps.noVars')}</small>
            </span>
            <span className="prv-end">
              <button type="button" className="btn" onClick={onChange}>
                {t('providersSteps.change')}
              </button>
              <button type="button" className="btn p" aria-busy={busy} disabled={busy} onClick={() => void approve()}>
                {t('providersSteps.approveButton')}
              </button>
            </span>
          </>
        ) : (
          <span>{t('providersSteps.approveFirst')}</span>
        )}
      </Step>
      <Step k={t('providersSteps.signIn')}>
        <span>{setup.account ? t('providersSteps.signInWith', { service: setup.account }) : t('providersSteps.signInAny')}</span>
      </Step>
      <Step k={t('providersSteps.test')}>
        <span>{t('providersSteps.testWhat')}</span>
      </Step>
      {!!error && (
        <div role="alert" className="prv-note bad">
          {plainError(t, error)}
          <ErrorDetails t={t} details={rawError(error)} />
        </div>
      )}
    </div>
  );
}
