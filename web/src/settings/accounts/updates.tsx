// Ticket 358, mock #update: the 새 버전 popover (지금 업데이트, 명령 복사) and 모두 업데이트 (n). Every fact here is the core's
// (agent_update.rs `Row`); the window never builds a command and a start sends the tool name alone.
// Adapted from T3 Code apps/web/src/components/settings/ProviderInstanceCard.tsx, apps/web/src/components/ProviderUpdatesAction.tsx
// and apps/web/src/components/ProviderUpdateLaunchNotification.logic.ts (MIT, Copyright (c) 2026 T3 Tools Inc., commit d14ace8),
// with the one-lock-per-installer rule of apps/server/src/provider/providerMaintenanceCommandCoordinator.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CoreClient, ToolUpdate } from '../../api';
import { copyText } from '../../terminal/clipboard';
import { agentOff } from '../agents/newDefaults';
import type { T } from './providers';
import { poll, useUpdates } from './updateRow';
import { ErrorLine } from '../../errors';

const QUEUE_MS = 1_000;
const running = (r: ToolUpdate) => r.run?.phase === 'running';
const startable = (r: ToolUpdate) => r.newer && r.can_update && !!r.command && !running(r);
/** Tools with one lock run one at a time; a tool that updates itself is its own lock. */
const lock = (r: ToolUpdate) => r.installer ?? r.tool;

/** Starts `tool` once its lock is free, asking the core again so a tool that changed meanwhile is not started. */
async function startWhenFree(core: CoreClient, tool: string, key: string) {
  for (;;) {
    const { rows } = await core.agentUpdates();
    if (rows.some((r) => lock(r) === key && running(r))) {
      await new Promise((done) => setTimeout(done, QUEUE_MS));
      continue;
    }
    if (!rows.some((r) => r.tool === tool && startable(r))) return;
    await core.agentUpdateStart(tool);
    return void (await poll(core));
  }
}

/** `inline` (ticket 391): drawn where it stands, in the card head's version line; else portalled into the row's `.prv-meta`. */
export function UpdateMark({ t, core, tool, path, inline }: { t: T; core: CoreClient; tool: string; path?: string | null; inline?: boolean }) {
  const row = useUpdates(core).find((r) => r.tool === tool && r.path === path);
  const [meta, setMeta] = useState<Element | null>(null);
  const anchor = useCallback((el: HTMLElement | null) => setMeta(el?.parentElement?.querySelector(':scope > .prv-meta') ?? null), []);
  const pop = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>('');
  const close = () => {
    if (pop.current) pop.current.open = false;
  };

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (pop.current?.open && !pop.current.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !pop.current?.open) return;
      e.stopPropagation(); // Escape shuts this, not Settings behind it
      close();
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    return () => (document.removeEventListener('pointerdown', away, true), window.removeEventListener('keydown', esc, true));
  }, []);

  const label = row ? t('providerUpdate.new', { version: row.latest ?? '' }) : '';
  const update = (name: string) => {
    setBusy(true);
    setError('');
    core.agentUpdateStart(name).then(
      () => (close(), void poll(core)),
      setError,
    ).finally(() => setBusy(false));
  };
  const mark = !row?.newer || row.run ? null : row.command ? (
    // The row toggles on any click that is not a button, and a portal still bubbles to it.
    <details ref={pop} className="acct-more upd-pop" onClick={(e) => e.stopPropagation()}>
      <summary className="upd">{label}</summary>
      <div className="acct-menu">
        <button type="button" className="acct-link" disabled={busy} onClick={() => update(row.tool)}>
          {t('providerUpdateUi.now')}
        </button>
        <button type="button" className="acct-link" onClick={() => (void copyText(row.command!), close())}>
          {t('providerUpdateUi.copy')}
        </button>
        <ErrorLine t={t} error={error} className="upd-err" />
      </div>
    </details>
  ) : (
    <span className="upd">{label}</span>
  );
  if (inline) return mark;
  return (
    <>
      <span ref={anchor} hidden />
      {mark && meta && createPortal(mark, meta)}
    </>
  );
}

/** `shown`: the tool and binary of each row on the page, so a tool that is only on the PATH is never updated from here. */
export function UpdateAll({ t, core, shown }: { t: T; core: CoreClient; shown: [string, string | null | undefined][] }) {
  const list = useUpdates(core).filter((r) => startable(r) && !agentOff(r.tool) && shown.some(([tool, path]) => tool === r.tool && path === r.path));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>('');
  if (!list.length && !busy && !error) return null;

  const updateAll = async () => {
    setBusy(true);
    setError('');
    const locks = new Map<string, string[]>();
    for (const r of list) locks.set(lock(r), [...(locks.get(lock(r)) ?? []), r.tool]);
    await Promise.all(
      [...locks].map(async ([key, tools]) => {
        // Read again per tool: one queued behind a lock may be turned off while it waits.
        for (const tool of tools) if (!agentOff(tool)) await startWhenFree(core, tool, key).catch(setError);
      }),
    );
    setBusy(false);
  };

  return (
    <>
      <ErrorLine t={t} error={error} className="upd-err" />
      {(list.length > 0 || busy) && (
        <button type="button" className="btn prv-ghost" disabled={busy} aria-busy={busy} onClick={() => void updateAll()}>
          {busy ? t('providerUpdate.updating') : t('providerUpdateUi.all', { n: list.length })}
        </button>
      )}
    </>
  );
}
