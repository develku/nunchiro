// Ticket 358, mock #failed2 and #tile: the actions under a failed row of Settings > Accounts, and a tile's links. Mounted one
// line per place from AccountsPage. An ACP row's diagnostics text comes whole from the core (acp/mod.rs `diagnostics`); links
// come only from the fixed tables (known.toml, UNCONFIRMED, DOCS), never from an agent or a settings file.
import { useState, type ReactNode } from 'react';
import type { AcpRow, CoreClient, TerminalAgent } from '../../api';
import { reveal } from '../../files/open';
import { Icon } from '../../icons/Icon';
import { openExternal } from '../../sandbox/link';
import { copyText } from '../../terminal/clipboard';
import { RefreshIcon } from '../git/logos';
import { inApp } from '../lifetime/tauri';
import { StrokeIcon } from '../shell/NavIcon';
import { ErrorLine } from '../../errors';
import { UNCONFIRMED, type T } from './providers';

const COPIED_MS = 1500;
/** The check where a link leaves for the browser: anything but https draws no button at all. */
const https = (url?: string | null) => (url?.startsWith('https://') ? url : undefined);

/** Claude's or Codex's text, in the core's format and from the same kind of allowlist. These rows have no variables. */
export const loginDiagnostics = (agent: string, found?: TerminalAgent) =>
  [`name: ${agent}`, 'state: signed out', 'failure: login ended', `version: ${found?.version?.match(/\d+(\.\d+)+/)?.[0] ?? 'unknown'}`, `path: ${found?.path ?? 'none'}`, ''].join('\n');

/** 진단 복사, 로그 열기, 문서 열기 (only with a confirmed page) and 다시 확인, under a failed row. */
export function FailedActions({ t, core, diagnostics, docs, onRecheck }: { t: T; core: CoreClient; diagnostics: string; docs?: string | null; onRecheck: () => Promise<unknown> }) {
  const page = https(docs);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState('');
  const [error, setError] = useState<unknown>('');
  const copy = () => {
    void copyText(diagnostics).then((ok) => (setCopied(ok), setTimeout(() => setCopied(null), COPIED_MS)));
  };
  // The logs folder sits beside the agents.toml the core names (logs.rs `dir`). Finder opens it with core.log selected;
  // outside the app, or when that file is not there yet, the path is shown to copy.
  const openLogs = async () => {
    setError('');
    try {
      const { file } = await core.acpAgents();
      const dir = `${file.slice(0, file.lastIndexOf('/'))}/logs`;
      if (inApp()) await reveal(dir, 'core.log').catch(() => setLogs(dir));
      else setLogs(dir);
    } catch (e) {
      setError(e);
    }
  };
  const recheck = async () => {
    setBusy(true);
    setError('');
    try {
      await onRecheck();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="prv-exp prv-failed">
      <div className="acts2">
        <button type="button" className="btn prv-ghost" onClick={copy}>
          {t(copied === null ? 'providersFailed.copyDiagnostics' : copied ? 'providersFailed.copied' : 'about.copyFailed')}
        </button>
        <span className="sr" role="status">
          {copied === null ? '' : t(copied ? 'providersFailed.copied' : 'about.copyFailed')}
        </span>
        <button type="button" className="btn prv-ghost" onClick={() => void openLogs()}>
          {t('providersFailed.openLogs')}
        </button>
        {page && (
          <button type="button" className="btn prv-ghost withicon" onClick={() => void openExternal(page)}>
            <StrokeIcon name="ext" size={14} />
            {t('providersFailed.openDocs')}
          </button>
        )}
        <button type="button" className="btn withicon" disabled={busy} aria-busy={busy} onClick={() => void recheck()}>
          <RefreshIcon />
          {t('providersFailed.recheck')}
        </button>
      </div>
      {logs && (
        <p className="prv-note" data-field="logs-path">
          {t('providersFailed.logsFolder', { path: logs })}
        </p>
      )}
      <ErrorLine t={t} error={error} className="prv-note bad" />
    </div>
  );
}

/** A tile and, when the table has a page for it, its info mark: a sibling of the tile, which may be a button. */
export function TileSlot({ t, id, row, children }: { t: T; id: string; row?: AcpRow; children: ReactNode }) {
  const known = UNCONFIRMED.find((u) => u.name === id);
  const links: [string, string | null | undefined][] = [
    [t('providersFailed.docs'), https(row?.docs_url ?? known?.docs)],
    [t('providersFailed.source'), https(row?.source_url ?? known?.source)],
  ];
  if (!links.some(([, url]) => url)) return <>{children}</>;
  return (
    <div className="prv-slot">
      {children}
      <details className="acct-more prv-info">
        <summary aria-label={t('providersFailed.tileLinks', { label: row?.label ?? known?.label ?? id })}>
          <Icon name="info" size={13} />
        </summary>
        <div className="acct-menu">
          {links.map(
            ([word, url]) =>
              url && (
                <button key={word} type="button" className="acct-link" onClick={() => void openExternal(url)}>
                  {word}
                  <StrokeIcon name="ext" size={12} />
                </button>
              ),
          )}
        </div>
      </details>
    </div>
  );
}
