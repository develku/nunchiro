// Ticket 252 (needs 197, G20): Settings > Permissions (개인정보 · 권한 group), the macOS permissions Nunchiro uses with
// their status from the app's read-only `permission_status` probe and an Open System Settings button each. Status
// display only (widget check G20): nothing here asks macOS for a grant.
//
// The rows lift Orca's developer permissions pane (one row per permission: name, status, reason, a System Settings
// button; local network has no status macOS reports): orca/src/renderer/src/components/settings/
// DeveloperPermissionsPane.tsx, and the pane URLs from orca/src/main/ipc/developer-permissions.ts `PRIVACY_PANE_URLS`.
// MIT License, Copyright (c) 2026 Lovecast Inc.
import { useCallback, useEffect, useState } from 'react';
import type { Key, T } from '../i18n';
import { SETTINGS_URLS } from '../PermissionNeeded';
import { PageActions, PageSummary } from '../settings/shell/PageActions';
import { Row, Sec } from '../settings/shell/Row';
import { registerSettingsPage } from './registry';

/** `permission_status` (app/src-tauri/src/permissions.rs): full_disk null is unknown. */
export type Status = { full_disk: boolean | null; volumes: 'not_needed' | 'granted' | 'not_granted' | 'unknown' };
export const VOLUMES = { not_needed: null, granted: true, not_granted: false, unknown: null } as const;

export const PANE_URLS = {
  fullDisk: SETTINGS_URLS.fullDisk,
  volumes: SETTINGS_URLS.files,
  network: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork',
  // Ticket 351: the In-app browser page's why line for a blocked camera or microphone (browser-prefs.tsx).
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
} as const;

export const probe = async () => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<Status>('permission_status');
};

const openPane = (url: string) => void import('@tauri-apps/plugin-opener').then((o) => o.openUrl(url)).catch(() => {});

/** undefined: still checking; 'error': the probe failed, so every row is unknown. */
const stateOf = (value: boolean | null | undefined, none: Key): [Key, string] =>
  value === undefined ? ['perms.checking', 'checking'] : value === true ? ['perms.granted', 'ok'] : value === false ? ['perms.notGranted', 'warn'] : [none, none === 'perms.notNeeded' ? 'plain' : 'unknown'];
function chip(t: T, value: boolean | null | undefined, none: Key) {
  const [key, state] = stateOf(value, none);
  return (
    <span className="chip" data-state={state}>
      {t(key)}
    </span>
  );
}

function PermissionsPage({ t }: { t: T }) {
  const [status, setStatus] = useState<Status | 'error' | null>(null);
  const read = useCallback(() => {
    setStatus(null);
    probe().then(setStatus, () => setStatus('error'));
  }, []);
  useEffect(read, [read]);
  const known = status === null || status === 'error' ? undefined : status;
  const loading = (v: boolean | null) => (status === null ? undefined : v);
  const rows: [id: keyof typeof PANE_URLS, Key, Key, boolean | null | undefined, Key][] = [
    ['fullDisk', 'perms.fullDisk', 'perms.fullDiskDesc', loading(known?.full_disk ?? null), 'perms.unknown'],
    ['volumes', 'perms.volumes', 'perms.volumesDesc', loading(known ? VOLUMES[known.volumes] : null), known?.volumes === 'not_needed' ? 'perms.notNeeded' : 'perms.unknown'],
    ['network', 'perms.network', 'perms.networkDesc', null, 'perms.unknown'],
  ];
  return (
    <>
      <PageActions>
        {/* Ticket 543: disabled only while the check runs (aria-busy), so the page check counts it as a wait. */}
        <button type="button" className="btn" disabled={status === null} aria-busy={status === null || undefined} onClick={read}>
          {t('perms.refresh')}
        </button>
      </PageActions>
      {/* Ticket 1043: the two permissions macOS reports; local network has no status to sum up. */}
      <PageSummary parts={rows.slice(0, 2).map(([, name, , v, none]) => [t(name), t(stateOf(v, none)[0])])} />
      <Sec id="h-perms" title={t('perms.section')} lede={t('perms.lede')}>
        {rows.map(([id, name, desc, v, none]) => (
          <Row
            key={id}
            id={`perm-${id}`}
            setting={`perm.${id}`}
            label={
              <>
                {t(name)} {chip(t, v, none)}
              </>
            }
            desc={t(desc)}
            control={
              <button type="button" className="btn" aria-describedby={`perm-${id}`} onClick={() => openPane(PANE_URLS[id])}>
                {t('perms.open')}
              </button>
            }
          />
        ))}
      </Sec>
    </>
  );
}

// In the app only: a plain browser has no app to probe and no System Settings to open.
if ('__TAURI_INTERNALS__' in globalThis) registerSettingsPage({ id: 'permissions', title: 'Permissions', group: 'privacy', order: 1, render: ({ t }) => <PermissionsPage t={t} /> });
