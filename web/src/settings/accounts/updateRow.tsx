// Ticket 358, mock #update: a tool's update progress, 취소 and 다시 시도 (the 새 버전 mark is updates.tsx). Mounted beside a
// row's version cell; `tool` and `path` pick the row, so a row running some other binary than the table's shows nothing.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CoreClient, ToolUpdate } from '../../api';
import { Chip, type T } from './providers';
import { plainError, tipError } from '../../errors';

const ACTIVE_MS = 1_000;
const IDLE_MS = 5_000; // the core answers from memory; an update started elsewhere shows within this

// One poll for every row on the page, while any row is mounted.
let rows: ToolUpdate[] = [];
let polling: CoreClient | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let latest = 0;
const listeners = new Set<() => void>();

export async function poll(core: CoreClient) {
  clearTimeout(timer);
  const mine = ++latest;
  let active = true;
  try {
    const r = await core.agentUpdates();
    if (mine !== latest) return;
    rows = r.rows;
    active = !r.checked || rows.some((x) => x.run?.phase === 'running');
    listeners.forEach((l) => l());
  } catch {
    if (mine !== latest) return; // a lost core: the next tick tries again
  }
  timer = setTimeout(() => void poll(core), active ? ACTIVE_MS : IDLE_MS);
}

function subscribe(core: CoreClient, listener: () => void) {
  listeners.add(listener);
  if (polling !== core) {
    polling = core;
    void poll(core);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    polling = null;
    latest++;
    clearTimeout(timer);
    rows = [];
  };
}

export function useUpdates(core: CoreClient) {
  const listen = useCallback((l: () => void) => subscribe(core, l), [core]);
  return useSyncExternalStore(listen, () => rows);
}

export function UpdateRow({ t, core, tool, path, onChanged }: { t: T; core: CoreClient; tool: string; path?: string | null; onChanged: () => Promise<unknown> }) {
  const row = useUpdates(core).find((r) => r.tool === tool && r.path === path);
  const run = row?.run;
  const running = run?.phase === 'running';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>('');

  // An update that ended changed what the row's own version cell should read.
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !running) void onChanged().catch(() => {});
    was.current = running;
  }, [running, onChanged]);

  if (!row) return null;
  const act = (op: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    op().then(
      () => void poll(core),
      (e) => setError(e),
    ).finally(() => setBusy(false));
  };
  const version = row.latest ?? '';
  const words = running
    ? run.text || (version ? t('providerUpdate.installing', { version }) : t('providerUpdate.installingAny'))
    : run?.phase === 'unchanged'
      ? t('providerUpdate.unchanged')
      : version
        ? t('providerUpdate.failed', { version })
        : t('providerUpdate.failedAny');
  const reason = run?.reason === 'timed_out' ? t('providerUpdate.timedOut') : run?.reason === 'start_failed' ? t('providerUpdate.startFailed') : '';
  const line = running ? words : [words, reason, run?.text].filter(Boolean).join(' · ');
  return (
    <>
      {run && (
        <>
          {/* Ticket 480: a failure reads plainly; its raw reason is the tooltip. */}
          <span className="upd-meta" title={error ? tipError(t, error) : running ? run.text || undefined : undefined}>
            <span className={running ? 'upd-line' : 'upd-line wrap'}>{error ? plainError(t, error) : line}</span>
            {running && (
              <span className="bar" role="progressbar" aria-label={t('providerUpdate.progress')}>
                <i className="ind" />
              </span>
            )}
          </span>
          <span className="upd-act">
            {running ? (
              <button type="button" className="btn" disabled={busy} onClick={() => act(() => core.agentUpdateCancel(row.tool))}>
                {t('providerUpdate.cancel')}
              </button>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={() => act(() => core.agentUpdateStart(row.tool))}>
                {t('providerUpdate.retry')}
              </button>
            )}
          </span>
          <span className="upd-st">{running ? <span className="pchip upd-run">{t('providerUpdate.updating')}</span> : run.phase === 'unchanged' ? <Chip word={t('providerUpdate.unchangedChip')} /> : <Chip word={t('providerUpdate.failedChip')} tone="bad" />}</span>
        </>
      )}
    </>
  );
}
