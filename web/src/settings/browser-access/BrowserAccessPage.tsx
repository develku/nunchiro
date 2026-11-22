// V2.5-15: Settings > Browser access (docs/design/v25-web-access.md section 1 and 3): one toggle, the port, where to
// open it, and the paired devices with Revoke. Off by default; the core binds nothing until it is turned on.
import { PLAIN } from '../../plainText';
import { useEffect, useState } from 'react';
import type { BrowserStatus, CoreClient } from '../../api';
import type { Key } from '../../i18n';
import { Icon } from '../../icons/Icon';
import { openLink } from '../../terminal/links';
import { copyText } from '../../terminal/clipboard';
import { Reset, Row, Sec, StepBox, Switch } from '../shell/Row';
import { PageSummary } from '../shell/PageActions';
import { ErrorLine, rawError } from '../../errors';
const DEFAULT_PORT = 7788; // http/browser.rs `DEFAULT_PORT`
type T = (key: Key, args?: Record<string, string | number>) => string;

// The window's language (App sets <html lang>), not a fixed English format.
const when = (ms: number) => new Date(ms).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function BrowserAccessPage({ core, t }: { core: CoreClient; t: T }) {
  const [s, setS] = useState<BrowserStatus | null>(null);
  const [port, setPort] = useState('');
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<{ url: string; ok: boolean } | null>(null);
  const run = async (op: Parameters<CoreClient['browserAccess']>[0]) => {
    setBusy(true);
    try {
      const next = await core.browserAccess(op);
      setS(next);
      setPort(String(next.port));
      setError('');
    } catch (e) {
      setError(rawError(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => void run({ op: 'status' }), [core]); // eslint-disable-line react-hooks/exhaustive-deps
  // A pairing allowed in the sheet, a Tailscale address that came or went: shown without reopening the page.
  useEffect(() => {
    const t = setInterval(() => void core.browserAccess({ op: 'status' }).then(setS, () => {}), 2000);
    return () => clearInterval(t);
  }, [core]);
  useEffect(() => {
    if (copied === null) return;
    const id = setTimeout(() => setCopied(null), 3000);
    return () => clearTimeout(id);
  }, [copied]);
  // The text copied or opened is exactly the address shown: no token, code, device id or path is ever added.
  const copy = (u: string) => void copyText(u).then((ok) => setCopied({ url: u, ok }));
  const wanted = Number(port);
  const portOk = Number.isInteger(wanted) && wanted >= 1024 && wanted <= 65535;
  // Loopback first is how the core lists them; a Tailscale address is what a phone opens.
  const urls = (s?.addresses ?? []).map((a) => `http://${a}`);
  // Ticket 250 r3: the final draft's two cards (access with its port, paired browsers); every string from the catalogue.
  return (
    <div className="browser-page ssec-group">
      <PageSummary parts={s ? [[t('summary.access'), t(s.enabled ? 'summary.on' : 'summary.off')], [t('summary.paired'), s.devices.length]] : []} />
      <section className="ssec" aria-labelledby="h-browser">
        <h2 id="h-browser" tabIndex={-1}>
          {t('settings.row.browserTitle')}
        </h2>
        <div className="scard">
          {!s ? (
            !error && (
              <p className="lede srow" role="status">
                {t('settings.row.reading')}
              </p>
            )
          ) : (
            <>
              <Row
                icon={<Icon name="browser" />}
                label={t('settings.row.browserAllow')}
                chip={<span className={`chip${s.enabled ? ' ok' : ''}`}>{t(s.enabled ? 'settings.row.browserOn' : 'settings.row.browserOff')}</span>}
                desc={t('settings.row.browserDesc')}
                reset={<Reset t={t} label={t('settings.row.browserAllow')} show={s.enabled} run={() => void run({ op: 'set', enabled: false, port: portOk ? wanted : undefined })} />}
                control={<Switch setting="browserAccess" label={t('settings.row.browserAllow')} checked={s.enabled} disabled={busy} onChange={(on) => void run({ op: 'set', enabled: on, port: portOk ? wanted : undefined })} />}
              />
              {/* Editable while off, so a busy default port can be changed first. */}
              <Row
                sub
                label={t('settings.row.port')}
                desc={t('settings.row.portDesc')}
                reset={<Reset t={t} label={t('settings.row.port')} show={port !== String(DEFAULT_PORT)} run={() => void run({ op: 'set', enabled: s.enabled, port: DEFAULT_PORT })} />}
                control={
                  // Look 1117 v15 Q6-11: a number in the kit's stepper frame; − and + move the port in use by one.
                  <StepBox t={t} label={t('settings.row.port')} down={!busy && s.port > 1024 ? () => void run({ op: 'set', enabled: s.enabled, port: s.port - 1 }) : null} up={!busy && s.port < 65535 ? () => void run({ op: 'set', enabled: s.enabled, port: s.port + 1 }) : null}>
                  <input {...PLAIN}
                    inputMode="numeric"
                    aria-label={t('settings.row.port')}
                    value={port}
                    aria-invalid={!portOk}
                    disabled={busy}
                    aria-busy={busy || undefined}
                    onChange={(e) => (setPort(e.target.value.trim()), setRefused(false))}
                    onBlur={() => {
                      // Ticket 378: a value the core would refuse goes back to the saved port, and the range line stays.
                      if (!portOk) {
                        setPort(String(s.port));
                        setRefused(port !== '');
                      } else if (wanted !== s.port) void run({ op: 'set', enabled: s.enabled, port: wanted });
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                  </StepBox>
                }
              />
              {/* Ticket 354: a port below 1024 sat in the field as if taken; the core refuses it, and now the page says so. */}
              {((port !== '' && !portOk) || refused) && (
                <p className="conflict" role="alert" data-field="port-range">
                  {t('settingsSmall.portRange', { port: s.port })}
                </p>
              )}
              {s.problem && (
                <p className="conflict" role="alert" data-field="problem">
                  {s.problem}
                </p>
              )}
              {s.enabled && !s.tailscale && <p className="srow sds">{t('settings.row.noTailscale')}</p>}
              {/* Ticket 991 Q6-11: each address is a kit row with the kit's buttons (the page drew its own before). */}
              {s.enabled &&
                urls.map((u) => (
                  <Row
                    sub
                    key={u}
                    setting="address"
                    label={<span className="mono">{u}</span>}
                    control={
                      <>
                        {copied?.url === u && <span role="status" className="sunit">{t(copied.ok ? 'settings.row.copied' : 'about.copyFailed')}</span>}
                        <button type="button" className="btn" aria-label={t('settings.row.copyAddr', { url: u })} onClick={() => copy(u)}>
                          {t('settings.row.copy')}
                        </button>
                        <button type="button" className="btn" aria-label={t('settings.row.openAddr', { url: u })} onClick={() => void openLink(u)}>
                          {t('settings.row.open')}
                        </button>
                      </>
                    }
                  />
                ))}
              {s.enabled && <p className="srow sds">{t('settings.row.plainHttp')}</p>}
            </>
          )}
        </div>
      </section>
      {s && (
        <Sec
          id="h-paired"
          title={t('settings.row.paired')}
          action={
            s.devices.length > 1 && (
              <button type="button" className="btn danger" disabled={busy} aria-busy={busy || undefined} onClick={() => void run({ op: 'revoke', device: null })}>
                {t('settings.row.revokeAll')}
              </button>
            )
          }
        >
          {s.devices.length === 0 ? (
            <p className="empty">{t(!s.enabled ? 'settings.row.noPairedOff' : urls.length > 0 ? 'settings.row.noPaired' : 'settings.row.noPairedNoAddress')}</p>
          ) : (
            s.devices.map((d) => (
              <Row
                key={d.id}
                setting="device"
                label={d.name}
                desc={`${t('settings.row.lastUsed', { when: when(d.last_used_ms) })} · ${t('settings.row.pairedFrom', { peer: d.peer })}`}
                control={
                  <button type="button" className="btn danger" disabled={busy} aria-busy={busy || undefined} aria-label={t('settingsSmall.revokeOne', { name: d.name })} onClick={() => void run({ op: 'revoke', device: d.id })}>
                    {t('settings.row.revoke')}
                  </button>
                }
              />
            ))
          )}
        </Sec>
      )}
      <ErrorLine t={t} error={error} className="" retry={s ? undefined : () => void run({ op: 'status' })} />
    </div>
  );
}
