// Ticket 262 (needs 197 G19 part a) and ticket 181 V2.5-34l: Settings > About, the last page of the Advanced group. It shows
// which build runs (app and core version, macOS, the short sha fixed at build time by vite.config.ts `buildSha`), copies
// that as one support line, lists THIRD_PARTY_NOTICES.md (imported at build time) with a search, and installs the
// `nunchiro` command (app/src-tauri/src/cli_install.rs). The page itself makes no outbound call.
// Built from final.html's builders through the row kit (`header`, `sec`, `row`, `btn`). The version row with Copy follows
// T3 Code's About row (apps/web/src/components/settings/SettingsPanels.tsx `AboutVersionTitle` row, idea only; MIT,
// Copyright (c) 2026 T3 Tools Inc.); the install states follow Orca (see cli_install.rs).
import { PLAIN } from '../plainText';
import { useEffect, useMemo, useState } from 'react';
import notices from '../../../THIRD_PARTY_NOTICES.md?raw';
import type { PageContext } from './registry';
import { registerSettingsPage } from './registry';
import { Row, Sec, tilde, Why } from '../settings/shell/Row';
import { PageSummary } from '../settings/shell/PageActions';
import { ErrorDetails, plainError, rawError } from '../errors';
import { copyText } from '../terminal/clipboard';
import { inApp } from '../settings/lifetime/tauri';
import { reveal } from '../files/open';
import { checkNow, rcUpdates } from '../chrome/rcUpdate';

type T = PageContext['t'];
type Info = { app: string; core: string | null; macos: string | null; resources?: string | null };
type Cli = { state: 'not_installed' | 'installed' | 'stale' | 'old_copy' | 'conflict'; link: string; target: string | null; current: string | null; path_hint: string | null };

/** The app shell's About commands; none outside the app. */
async function call<R>(cmd: 'about_info' | 'cli_status' | 'cli_install'): Promise<R | null> {
  if (!inApp()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<R>(cmd);
}

const or = (v: string | null | undefined) => v || 'unknown';
/** "Nunchiro <app> · <sha>": the line the page shows. */
export const versionLine = (i: Info | null) => `Nunchiro ${or(i?.app)} · ${__NUNCHIRO_BUILD__}`;
/** The support line Copy writes; English on purpose, so a report reads the same in every language. */
export const supportLine = (i: Info | null) => `${versionLine(i)} (core ${or(i?.core)}, macOS ${or(i?.macos)})`;

// Read once when the window loads, so Copy writes at once: WebKit drops a clipboard write made after an awaited app call,
// once the click's user gesture is gone (the palette's timer still carries it).
let known: Info | null = null;
const loaded: Promise<Info | null> = call<Info>('about_info').then(
  (i) => (known = i),
  () => null,
);

/** Copies the support line (the page's Copy and the palette's "Copy build info"); false when the clipboard refused. */
export const copyBuildInfo = (): Promise<boolean> => copyText(supportLine(known));

/** The app menu's "About Nunchiro" (main.rs ABOUT_SCRIPT) sends this; useAppSettings opens the page. */
export const ABOUT_EVENT = 'nunchiro:about';

function useInfo() {
  const [info, setInfo] = useState<Info | null | undefined>(known ?? undefined);
  useEffect(() => void loaded.then(setInfo), []);
  return info;
}

function Version({ t }: { t: T }) {
  const info = useInfo(); // undefined while the app answers
  const [note, setNote] = useState<'' | 'copied' | 'failed'>('');
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(''), 3000);
    return () => clearTimeout(id);
  }, [note]);
  const unknown = info === undefined ? '…' : t('about.unknown');
  return (
    <>
      <PageSummary parts={[[t('summary.version'), `${info?.app || unknown} · ${__NUNCHIRO_BUILD__}`]]} />
      <Row
        setting="buildInfo"
        label={
          <>
            {t('about.version')}
            <span className="mono sver">{`${info?.app || unknown} · ${__NUNCHIRO_BUILD__}`}</span>
          </>
        }
        desc={t('about.versionOf', { core: info?.core || unknown, macos: info?.macos || unknown })}
        control={
          <>
            {note && <span role="status">{t(note === 'copied' ? 'about.copied' : 'about.copyFailed')}</span>}
            <button className="btn" data-setting="buildInfo" aria-label={t('about.copyLabel')} onClick={() => void copyBuildInfo().then((ok) => setNote(ok ? 'copied' : 'failed'))}>
              {t('about.copy')}
            </button>
          </>
        }
      />
    </>
  );
}

/** The palette's "Check for updates": works only in a build that updates itself, like the palette item; a newer build shows
 *  in the status bar. Look v35 c S3-2: any other build (cargo, a debug run, an RC or official app whose update source is
 *  missing: rc_update.rs `start`) shows the row with the button off and the reason, rather than no row. */
function Updates({ t }: { t: T }) {
  const [none, setNone] = useState(false);
  const [error, setError] = useState('');
  const on = rcUpdates();
  return (
    <Row
      setting="updates"
      label={t('about.updates')}
      desc={error ? <>{t('rc.update.checkFailed', { error: plainError(t, error) })}<ErrorDetails t={t} details={error} /></> : none ? t('rc.update.none') : t('about.updates.desc')}
      why={!on && <Why id="why-updates" reason={t('about.updates.off')} />}
      control={
        <button className="btn" disabled={!on} aria-describedby={on ? undefined : 'why-updates'} onClick={() => void checkNow().then((v) => (setNone(!v), setError('')), setError)}>
          {t('about.updates.check')}
        </button>
      }
    />
  );
}

function CliInstall({ t }: { t: T }) {
  const [s, setS] = useState<Cli | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => void call<Cli>('cli_status').then(setS, (e) => setError(rawError(e))), []);
  const install = () => {
    setBusy(true);
    void call<Cli>('cli_install')
      .then((r) => (setS(r), setError('')), (e) => setError(rawError(e)))
      .finally(() => setBusy(false));
  };
  // Ticket 471: the home folder reads as ~, as everywhere else in the app.
  const link = tilde(s?.link ?? '~/.local/bin/nunchiro');
  // Outside the app, or an app that is not Nunchiro.app (the RC, a dev build): nothing to install from.
  const outside = !inApp() || (s !== null && !s.target);
  // Ticket 475: the two states Install cannot work in are a why line the button points at; neither has a fix the
  // window can run (another build, or a file only the person should move), so each says what to do.
  const why = outside ? t('about.cli.outside') : s?.state === 'conflict' ? t('about.cli.conflict', { link }) : null;
  const note = error ? (
    <div role="alert">
      {t('about.cli.failed', { error: plainError(t, error) })}
      <ErrorDetails t={t} details={error} />
    </div>
  ) : why ? (
    <p role={outside ? 'status' : 'alert'}>
      <Why id="why-cli" reason={why} />
    </p>
  ) : s?.state === 'stale' ? (
    // Look v34 S3-2: the state notes are hint lines in the card's muted description type (.sds), not body text.
    <p className="sds" role="status">{t('about.cli.stale', { link, current: tilde(s.current ?? '') })}</p>
  ) : s?.state === 'old_copy' ? (
    <p className="sds" role="status">{t('about.cli.oldcopy', { link })}</p>
  ) : s?.state === 'installed' ? (
    <p className="sds" role="status">{t('about.cli.installed', { link, target: tilde(s.current ?? s.target ?? '') })}</p>
  ) : null;
  const [before, after] = t('about.cli.desc', { cmd: '\0' }).split('\0'); // `nunchiro` as code, wherever the language puts it
  return (
    <Row
      setting="cliInstall"
      top={!!note || !!(s?.path_hint && !outside)}
      label={t('about.cli.row')}
      desc={
        <>
          {before}
          <code>nunchiro</code>
          {after}
        </>
      }
      extra={
        <>
          {note}
          {s?.path_hint && !outside && (
            <p className="sds">
              {t('about.cli.path')} <code>{s.path_hint}</code>
            </p>
          )}
        </>
      }
      control={
        <button className="btn" disabled={busy || outside || !s || s.state === 'conflict' || s.state === 'installed'} aria-busy={busy || (!s && !outside) || undefined} aria-describedby={why ? 'why-cli' : undefined} data-idle={s?.state === 'installed' || undefined} onClick={install}>
          {t(s?.state === 'stale' ? 'about.cli.update' : 'about.cli.install')}
        </button>
      }
    />
  );
}

/** THIRD_PARTY_NOTICES.md's table rows as "file — source — licence": markdown links and backticks dropped, the source and
 *  licence columns found by their headers (Source or Upstream; Licence or License). */
export function noticeRows(md: string): string[] {
  const cells = (l: string) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, ''));
  const rule = (l = '') => /^\|[-| :]+\|$/.test(l);
  const lines = md.split('\n');
  const rows: string[] = [];
  let cols: { source: number; licence: number } | null = null;
  for (const [i, l] of lines.entries()) {
    if (!l.startsWith('|')) cols = null;
    else if (rule(l)) continue;
    else if (rule(lines[i + 1])) {
      const h = cells(l).map((c) => c.toLowerCase());
      cols = { source: h.findIndex((c) => c === 'source' || c === 'upstream'), licence: h.findIndex((c) => /^licen[cs]e$/.test(c)) };
    } else if (cols) {
      const c = cells(l);
      rows.push([c[0], c[cols.source], c[cols.licence]].join(' — '));
    }
  }
  return rows;
}
const ROWS = noticeRows(notices);

/** The Legal card. View licences opens the notices list and its search in place below the card. The search lives inside
 *  that block, so a search typed right after closing cannot race the toggle (round 2's fix for the old details block). */
function Legal({ t }: { t: T }) {
  const info = useInfo();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => (q ? ROWS.filter((r) => r.toLowerCase().includes(q)) : ROWS), [q]);
  return (
    <>
      <Sec id="h-about-legal" title={t('about.section.legal')}>
        <Row
          setting="licences"
          label={t('about.licences.row')}
          desc={t('about.licences.desc', { n: String(ROWS.length) })}
          control={
            <button className="btn" aria-expanded={open} aria-controls="about-licences" onClick={() => setOpen(!open)}>
              {t('about.licences.view')}
            </button>
          }
        />
        {info?.resources && (
          <Row
            setting="licenceFiles"
            label={t('about.licences.files')}
            desc={t('about.licences.filesDesc')}
            control={
              // Finder opens the bundle's Resources with the Rust list selected; the npm list and the notices sit beside it.
              <button className="btn" onClick={() => void reveal(info.resources!, 'THIRD_PARTY_LICENSES_RUST.md')}>
                {t('about.licences.reveal')}
              </button>
            }
          />
        )}
      </Sec>
      {open && (
        <div id="about-licences" data-licences style={{ display: 'grid', gap: 'var(--sp-8)', margin: 'calc(var(--sp-12) - var(--set-gap)) 0 var(--set-gap)' }}>
          <input {...PLAIN} className="search" type="search" placeholder={t('about.licences.search')} aria-label={t('about.licences.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          {q && rows.length === 0 && <p role="status">{t('about.licences.none', { query: query.trim() })}</p>}
          <ul
            tabIndex={0}
            aria-label={t('about.licences.row')}
            className="about-lic"
          >
            {rows.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

registerSettingsPage({
  id: 'about',
  title: 'About', // the nav reads `settings.page.about` (settings-about.ts) where the catalogue has it
  group: 'advanced',
  order: 90,
  fields: [{ key: 'buildInfo', at: '[data-setting="buildInfo"]' }],
  render: ({ t }) => (
    <>
      <Sec id="h-about-app" title={t('about.section.app')}>
        <Version t={t} />
        <Updates t={t} />
        <CliInstall t={t} />
      </Sec>
      <Legal t={t} />
    </>
  ),
});
