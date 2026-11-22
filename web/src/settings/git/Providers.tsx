// v25f (F7): the Connected services card (final.html F.providers). The core asks each CLI (git_providers.rs); sign-in,
// sign-out and add-host are the CLI's own commands in a visible terminal tab, and Nunchiro reads no token. Row anatomy
// after T3 Code SourceControlSettings.tsx (logo, version, auth line, install hint; idea only, no code taken).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CoreClient } from '../../api';
import type { T } from '../../i18n';
import { Icon } from '../../icons/Icon';
import { openExternal } from '../../sandbox/link';
import { openSession } from '../../tree';
import type { Session } from '../../types';
import { Sec } from '../shell/Row';
import { ErrorLine, rawError } from '../../errors';
import { ExternalIcon, Logo, type LogoId } from './logos';
import './providers.css';

type Probe = { id: LogoId; installed: boolean; version: string | null; state: 'signed_in' | 'signed_out' | 'missing'; account: string | null; hosts: string[] };
type Spec = { id: LogoId; name: string; cli?: string; login?: string; install?: string };

// final.html's row order. Login words are shown only; the core runs its own constants for the id. GitCafe's link is its CLI's package (T3 Code's install hint).
const ROWS: Spec[] = [
  { id: 'git', name: 'git', cli: 'git', install: 'https://git-scm.com/downloads' },
  { id: 'github', name: 'GitHub', cli: 'gh', login: 'gh auth login', install: 'https://cli.github.com/' },
  { id: 'gitlab', name: 'GitLab', cli: 'glab', login: 'glab auth login', install: 'https://gitlab.com/gitlab-org/cli#installation' },
  { id: 'forgejo', name: 'Forgejo / Gitea', cli: 'tea', login: 'tea login add', install: 'https://gitea.com/gitea/tea#installation' },
  { id: 'azure', name: 'Azure DevOps', cli: 'az', login: 'az login', install: 'https://learn.microsoft.com/azure/devops/cli/' },
  { id: 'gitcafe', name: 'GitCafe', cli: 'cafe', install: 'https://www.npmjs.com/package/@gitcafe/cli' },
  { id: 'bitbucket', name: 'Bitbucket' },
];

// As Accounts: a timer and window focus, no push from the core.
const REFRESH_MS = 60_000;
const message = (e: unknown) => rawError(e);

/** The probe's rows, kept by GitPage because the page header's Rescan and the card share them. */
export function useProviders(core: CoreClient) {
  const [rows, setRows] = useState<Probe[] | null>(null);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const busy = useRef(false);
  const scan = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setScanning(true);
    try {
      setRows(((await core.request({ op: 'git_providers' })) as { providers: Probe[] }).providers);
      setError('');
    } catch (e) {
      setError(message(e));
    } finally {
      busy.current = false;
      setScanning(false);
    }
  }, [core]);
  useEffect(() => {
    void scan();
    const tick = () => document.visibilityState === 'visible' && void scan();
    const timer = setInterval(tick, REFRESH_MS);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [scan]);
  return { rows, error, setError, scanning, scan };
}

/** Sign in or out runs the CLI's own command in a visible terminal tab; also Live PR status's fix (ticket 475). */
export const providerTab = (core: CoreClient, verb: { login: LogoId } | { logout: LogoId }, fail: (e: string) => void) =>
  core.request({ op: 'git_providers', ...verb }).then(
    (r) => openSession((r as { session: Session }).session.id),
    (e: unknown) => fail(message(e)),
  );

/** The install page of a provider's CLI, for a fix elsewhere on the page. */
export const installUrl = (id: LogoId) => ROWS.find((r) => r.id === id)?.install;

export type Verb = { login: LogoId } | { logout: LogoId };
type View = { dot: 'ok' | 'warn' | 'idle'; chip?: [string, '' | 'ok' | 'warn']; line: ReactNode; action?: 'login' | 'install' | 'signed' };

/** Tool, extension and command names are code in every language, so each placeholder renders as code, not as a word of
 * the sentence (ticket 478). Up to three names: each one is swapped for a control character, then split back out. */
const coded = (t: T, key: Parameters<T>[0], names: Record<string, string>) => {
  const keys = Object.keys(names);
  return t(key, Object.fromEntries(keys.map((k, i) => [k, String.fromCharCode(1 + i)])))
    .split(/([\u0001-\u0003])/)
    .map((part, i) => {
      const k = part.length === 1 ? keys[part.charCodeAt(0) - 1] : undefined;
      return k ? <code key={i} className="mono">{names[k]}</code> : part;
    });
};

function view(s: Spec, p: Probe | undefined, t: T): View {
  if (s.id === 'bitbucket') return { dot: 'idle', chip: [t('git.stUnsupported'), ''], line: t('git.lineBitbucket') };
  if (!p) return { dot: 'idle', line: t('git.checking') };
  const version = <span className="mono">{p.version ? `${s.cli} ${p.version}` : s.cli}</span>;
  if (p.state === 'missing') {
    const cli = s.cli!;
    const line = s.id === 'azure' ? coded(t, 'git.lineAzure', { cli, ext: 'azure-devops' }) : s.id === 'gitcafe' ? coded(t, 'git.lineCafe', { cli }) : s.login ? coded(t, 'git.lineMissing', { cli, cmd: s.login }) : coded(t, 'git.lineBare', { cli });
    return { dot: 'idle', chip: [s.id === 'gitcafe' ? t('git.stCli') : t('git.stMissing'), ''], line, action: s.install ? 'install' : undefined };
  }
  if (s.id === 'git') return { dot: 'ok', chip: [t('git.stReady'), 'ok'], line: t('git.lineGit', { path: p.account ?? '' }) };
  // The core has no way to ask cafe, so nothing here claims either way.
  if (s.id === 'gitcafe') return { dot: 'idle', chip: [t('git.stInstalled'), ''], line: <>{version} · {coded(t, 'git.lineCafeIn', { cli: s.cli! })}</> };
  if (p.state === 'signed_out') return { dot: 'warn', chip: [t('git.stOut'), 'warn'], line: <>{version} · {t('git.lineOut')}</>, action: 'login' };
  const [host] = p.hosts;
  const who = p.account && host ? t('git.lineIn', { host, account: p.account }) : p.account ? t('git.lineAs', { account: p.account }) : t('git.lineHost', { host });
  return { dot: 'ok', chip: [t('git.stConnected'), 'ok'], line: <>{version} · {who}{p.hosts.length > 1 ? ` · ${t('git.lineHosts', { n: p.hosts.length })}` : ''}</>, action: 'signed' };
}

// Eighth look (C): one stray Space on a focused "Sign in" opened a login shell and closed Settings. The press asks first, in
// the row, with the focus on Cancel; only "Open terminal" starts the CLI's command. `ask` is the page's, so Live PR
// status's "Sign in" asks in GitHub's row too.
export function Providers({ core, t, rows, error, setError, retry, ask, setAsk }: { core: CoreClient; t: T; rows: Probe[] | null; error: string; setError: (e: string) => void; retry: () => void; ask: Verb | null; setAsk: (v: Verb | null) => void }) {
  const tab = (verb: Verb) => setAsk(verb);
  const idOf = (v: Verb) => ('login' in v ? v.login : v.logout);
  return (
    <Sec id="h-providers" title={t('git.providers')} lede={t('git.providersLede')}>
      {ROWS.map((s) => {
        const p = rows?.find((r) => r.id === s.id);
        const v = view(s, p, t);
        return (
          <div className="srow prov" key={s.id} data-provider={s.id}>
            <div className="slab">
              <span className="icn">
                <Logo id={s.id} />
                <i className={`sd ${v.dot}`} />
              </span>
              <div>
                <div className="snm">
                  {s.name}
                  {s.id === 'git' && p?.version && <span className="vv">{p.version}</span>}
                  {v.chip && <span className={`chip ${v.chip[1]}`}>{v.chip[0]}</span>}
                </div>
                <div className="sds">{v.line}</div>
              </div>
            </div>
            {ask && idOf(ask) === s.id ? (
              // Keyed: a new element, so Cancel takes the focus.
              <div key="ask" className="sctl" role="group" aria-label={t('login' in ask ? 'look8.git.askIn' : 'look8.git.askOut', { cli: s.cli ?? s.name })}>
                <span className="sds">{t('login' in ask ? 'look8.git.askIn' : 'look8.git.askOut', { cli: s.cli ?? s.name })}</span>
                <button type="button" className="btn withicon" onClick={() => (setAsk(null), void providerTab(core, ask, setError))}>
                  <Icon name="terminal" />
                  {t('decisions.openTerminal')}
                </button>
                <button type="button" className="btn flat" autoFocus onClick={() => setAsk(null)}>
                  {t('dialog.cancel')}
                </button>
              </div>
            ) : (
            <div className="sctl">
              {v.action === 'login' && (
                <button type="button" className="btn withicon" onClick={() => void tab({ login: s.id })}>
                  <Icon name="terminal" />
                  {t('git.signIn')}
                </button>
              )}
              {v.action === 'signed' && (
                <>
                  {s.id !== 'azure' && (
                    <button type="button" className="btn withicon" onClick={() => void tab({ login: s.id })}>
                      <Icon name="plus" size={14} />
                      {t('git.addHost')}
                    </button>
                  )}
                  <button type="button" className="btn flat" onClick={() => void tab({ logout: s.id })}>
                    {t('git.signOut')}
                  </button>
                </>
              )}
              {v.action === 'install' && (
                <button type="button" className="btn withicon flat" onClick={() => void openExternal(s.install!)}>
                  <ExternalIcon />
                  {t('git.install')}
                </button>
              )}
            </div>
            )}
          </div>
        );
      })}
      <ErrorLine t={t} error={error} className="err" retry={rows === null ? retry : undefined} />
    </Sec>
  );
}
