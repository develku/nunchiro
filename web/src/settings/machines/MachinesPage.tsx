import { PLAIN } from '../../plainText';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import type { CoreClient } from '../../api';
import type { Key } from '../../i18n';
import '../accounts/accounts.css';
import './machines.css';
import { Chip } from '../accounts/providers';
import { Icon } from '../../icons/Icon';
import { StrokeIcon } from '../shell/NavIcon';
import { PageActions, PageSummary } from '../shell/PageActions';
import { Why } from '../shell/Row';
import { ErrorDetails, ErrorLine, rawError } from '../../errors';
import { copyText } from '../../terminal/clipboard';
import { askNew } from '../../NewSession';
type T = (key: Key, args?: Record<string, string | number>) => string;
type Channel = { state: string; since_ms: number; remote_version?: string; remote_protocol?: number; local_protocol: number; error?: string; latency_ms?: number };
// Only a live connection has current remote facts; after a drop the version is what was last seen.
const remoteText = (c: Channel | null, t: T, unknown: string) => c?.remote_version ? c.state === 'up' ? t('machines.v25.remoteValue', { version: c.remote_version, protocol: c.remote_protocol ?? unknown }) : t('machines.v25.lastSeen', { version: c.remote_version }) : unknown;
const TONE: Record<string, 'ok' | 'warn' | 'bad'> = { up: 'ok', reconnecting: 'warn', down: 'bad', version_mismatch: 'bad' };
// `saved`: what settings.json holds, without what `ssh -G` adds; the Edit form and Open terminal start from it.
// Ticket 1068: `host` and `user` are what the alias's Host block in ~/.ssh/config names.
type Alias = { name: string; host?: string; user?: string };
const aliasFor = (aliases: Alias[], host: string) => aliases.find((a) => a.host && a.host.toLowerCase() === host.trim().toLowerCase() && a.name !== host.trim());
const aliasText = (t: T, a: Alias) => a.user ? t('machines.useAliasUser', { alias: a.name, user: a.user }) : t('machines.useAlias', { alias: a.name });
type Machine = { machine: string; host: string | null; user: string | null; port: number | null; keys: string[]; fingerprint: string | null; channel: Channel | null; error?: string; saved?: { host: string | null; user: string | null; port: number | null } };
// docs/remote.md: the one install and update command; Nunchiro never runs it on the remote.
const INSTALL = 'cargo install --locked --path crates/nunchiro --root "$HOME/.local"';
// The remote login shell ran, and `nunchiro` was not on its PATH (zsh, bash and sh wordings; 127 is the shell's own code for it).
// Ticket 991 C6: the common ssh failures (ssh's own words) as one plain sentence with what to do; the raw text stays
// under Details. Host key first: its message also says "Permission denied" further down.
const KEY_DENIED = /Permission denied \(publickey/i;
const SSH: [RegExp, Key][] = [
  [/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i, 'machines.ssh.hostKey'],
  [KEY_DENIED, 'machines.ssh.key'],
  [/Could not resolve hostname|nodename nor servname|Name or service not known/i, 'machines.ssh.dns'],
  [/Connection refused/i, 'machines.ssh.refused'],
  [/timed out/i, 'machines.ssh.timeout'],
];
const sshPlain = (t: T, raw: string) => {
  const key = SSH.find(([re]) => re.test(raw))?.[1];
  return key && t(key);
};
function SshError({ t, text }: { t: T; text: string }) {
  const plain = sshPlain(t, text);
  return plain ? <>{plain}<ErrorDetails t={t} details={text} /></> : <>{text}</>;
}
// Ticket 991 C5: the host an alias reaches, as saved here (an Edit changes it, the alias stays the machine's name).
const target = (m: Machine) => m.saved?.host || m.machine;
const notFound = (error?: string) => !!error && /exit status: 127\b|not found: nunchiro|nunchiro: (command )?not found/.test(error);

export function MachinesPage({ core, t, toast, closeSettings }: { core: CoreClient; t: T; toast?: (text: string) => void; closeSettings?: () => void }) {
  // Ticket 980: a session on the machine: the folder is typed here, the agent is picked in the New session list that opens.
  const [starting, setStarting] = useState<string | null>(null);
  const [folder, setFolder] = useState('');
  const [folderBad, setFolderBad] = useState(false);
  const startOn = (alias: string) => {
    const f = folder.trim();
    if (!f.startsWith('/') || f.length < 2) return setFolderBad(true);
    flushSync(() => closeSettings?.());
    askNew(f, undefined, alias);
  };
  const [rows, setRows] = useState<Machine[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // Ticket 336: the rows whose details are showing; each opens and closes on its own.
  const [expanded, setExpanded] = useState<string[]>([]);
  const toggle = (alias: string) => setExpanded((x) => x.includes(alias) ? x.filter((a) => a !== alias) : [...x, alias]);
  // A failed card Test names no error: the card's problem line or Diagnostics already shows it.
  const [tested, setTested] = useState<Record<string, boolean>>({});
  // Look 1117 v10 (C5): a machine edited while connected keeps that connection (its sessions stay) on the old values; its row says so until the connection is a new one.
  const connValues = useRef<Record<string, { since: number | undefined; host: string; user: string; port: string }>>({});
  const [oldValues, setOldValues] = useState<Record<string, number | undefined>>({});
  const addButton = useRef<HTMLButtonElement>(null);
  // Ticket 1068: the card's alias offer opens the form on that alias; its Edit opens the form on the user field.
  const [prefill, setPrefill] = useState('');
  const [focusUser, setFocusUser] = useState(false);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const offerFor = (m: Machine) => aliasFor(aliases, target(m));
  // Suggestions only help: a core without them still lets a host be typed. Read again when a form opens (a machine just added is no longer one).
  useEffect(() => { let live = true; void core.request({ op: 'machine_aliases' }).then((r) => live && setAliases((r as { aliases: Alias[] }).aliases), () => {}); return () => { live = false; }; }, [core, adding, editing]);
  const fail = (e: Error) => setError(rawError(e));
  const load = async (alias: string) => {
    const r = await core.request({ op: 'machine_details', alias }) as { machines: Machine[] };
    setRows((rows) => rows?.some((m) => m.machine === alias) ? rows.map((m) => (m.machine === alias ? r.machines[0] ?? m : m)) : [...(rows ?? []), ...r.machines]);
  };
  // A local shell tab running ssh with the overrides the channel passes (discovery.rs `options`), each its own argument.
  const terminal = async (m: Machine) => {
    setError('');
    const s = m.saved;
    const args = ['ssh', ...(s?.host && s.host !== m.machine ? ['-o', `HostName=${s.host}`] : []), ...(s?.user ? ['-o', `User=${s.user}`] : []), ...(s?.port ? ['-o', `Port=${s.port}`] : []), '--', m.machine];
    try { await core.request({ op: 'start', session: { kind: 'shell', project: '', label: `ssh ${m.machine}`, args, resume: null } }); toast?.(t('machines.terminalOpened', { alias: m.machine })); }
    catch (e) { fail(e as Error); }
  };
  const alive = useRef(true);
  // `quiet`: the timed re-read; it never clears or sets the error line the user may be reading.
  const loadAll = (quiet = false) => {
    if (!quiet) setError('');
    void core.request({ op: 'machine_details' }).then((raw) => {
      if (!alive.current) return;
      const machines = (raw as { machines: Machine[] }).machines;
      setRows(machines);
    }, (e: Error) => alive.current && !quiet && fail(e));
  };
  useEffect(() => {
    alive.current = true;
    loadAll();
    return () => { alive.current = false; };
  }, [core]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ticket 378: a machine's status changes on its own (a link drops, its core starts), so the list is read again every
  // 10 s while the page is open, the window is in front and nothing here is in progress.
  useEffect(() => {
    if (busy) return;
    const id = setInterval(() => document.visibilityState === 'visible' && loadAll(true), 10_000);
    return () => clearInterval(id);
  }, [core, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = async (alias: string, retry: boolean) => {
    setBusy(true); setError('');
    try {
      const r = await core.request({ op: 'machine_status', label: alias, retry }) as { machines: { machine: string; channel?: Channel; error?: string }[] };
      setRows((rows) => rows?.map((m) => m.machine === alias ? { ...m, channel: r.machines[0]?.channel ?? null, error: r.machines[0]?.error } : m) ?? null);
      return r.machines[0];
    } catch (e) { fail(e as Error); }
    finally { setBusy(false); }
  };
  const forget = async () => {
    setBusy(true); setError('');
    try {
      await core.request({ op: 'forget_machine', alias: removing });
      setRows((r) => r?.filter((m) => m.machine !== removing) ?? null);
      setExpanded((x) => x.filter((a) => a !== removing));
      setRemoving(null);
    } catch (e) { fail(e as Error); }
    finally { setBusy(false); }
  };
  return <section className="machines-page" aria-labelledby="h-machines">
    {/* Ticket 250: the page header carries the title and the Add button (final.html); the heading stays for the search. */}
    <h2 id="h-machines" className="sr" tabIndex={-1}>{t('page.machines')}</h2>
    <PageActions><button ref={addButton} className="btn withicon" aria-expanded={adding} onClick={() => { setEditing(null); setPrefill(''); setFocusUser(false); setAdding(!adding); }}><Icon name="plus" size={14} />{t('machines.addTitle')}</button><button className="btn" aria-expanded={sharing} onClick={() => setSharing(!sharing)}>{t('machines.share')}</button></PageActions>
    {sharing && <ShareThisMac core={core} t={t} onClose={() => setSharing(false)} />}
    {error && sshPlain(t, error) ? <div role="alert" data-error="plain"><SshError t={t} text={error} /></div> : <ErrorLine t={t} error={error} className="" foreign retry={rows === null ? loadAll : undefined} />}
    {rows === null && <p role="status">{t('machines.loading')}</p>}
    {rows?.length === 0 && !adding && <p className="empty">{t('machines.empty')} <button type="button" className="btn" onClick={() => setAdding(true)}>{t('empty.addFirstMachine')}</button></p>}
    {/* Ticket 1043: the count line is the page's summary under its title. */}
    <PageSummary parts={[[t('summary.machines'), rows?.length], [t('summary.connected'), !!rows?.length && rows.filter((m) => m.channel?.state === 'up').length], [t('summary.unreachable'), !!rows?.length && rows.filter((m) => m.channel?.state === 'down' || m.channel?.state === 'version_mismatch').length]]} />
    {/* Ticket 336 (owner 11-09, replaces needs 122's card): one line per machine after T3 Code's EnvironmentRow (t3code SavedEnvironmentRows.tsx, MIT License, Copyright (c) 2026 T3 Tools Inc.; idea only). The row is the button; what the card always showed opens under it. */}
    {rows && rows.length > 0 && <div className="scard">{rows.map((m) => {
      const c = m.channel;
      const state = c?.state ?? 'unknown';
      const unknown = t('machines.unknown');
      const time = c?.since_ms ? new Date(c.since_ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : unknown;
      const old = state === 'up' && oldValues[m.machine] === c?.since_ms;
      const words = old ? t('machines.v25.state.upOld') : t(`machines.v25.state.${state}` as Key, { time, remote: c?.remote_protocol ?? unknown, local: c?.local_protocol ?? unknown });
      const shown = open === m.machine;
      const isOpen = expanded.includes(m.machine);
      return <article data-machine={m.machine} key={m.machine} aria-label={m.machine} onKeyDown={(e) => { if (e.key === 'Escape' && isOpen && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.querySelector<HTMLElement>('.machine-row')?.focus(); toggle(m.machine); } }}>
        {/* WebKit leaves a clicked button unfocused, and Esc only reaches this row from inside it. */}
        <button type="button" className="prv-row prv-hd go machine-row" aria-expanded={isOpen} aria-controls={isOpen ? `machine-detail-${m.machine}` : undefined} onClick={(e) => { e.currentTarget.focus(); toggle(m.machine); }}>
          {/* Ticket 378 (owner 11-09): one line, the Accounts row's columns (accounts.css .prv-row.prv-hd). */}
          <StrokeIcon name="server" />
          <span className="prv-nm"><span className="prv-name" title={m.machine}>{m.machine}</span></span>
          <span className="prv-meta machine-line"><span className="machine-mono">{`ssh ${m.machine}`}</span>{target(m) !== m.machine && <span className="machine-mono">{` · ${target(m)}`}</span>}{` · ${t('machines.nunchiro')} ${remoteText(c, t, unknown)}`}</span>
          <span className="prv-chips">{state === 'up' && c?.latency_ms !== undefined && <span className="machine-lat">{t('machines.v25.ms', { ms: c.latency_ms })}</span>}<Chip word={words} tone={old ? 'warn' : TONE[state]} /></span>
          <span />
          <span className="sctl"><Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} /></span>
        </button>
        {isOpen && <div className="machine-detail" id={`machine-detail-${m.machine}`}>
          <div className="machine-head">
            <button className="machine-btn" disabled={busy} aria-busy={busy || undefined} onClick={() => void status(m.machine, true)}>{t(state === 'up' ? 'machines.reconnect' : 'machines.connect')}</button>
            <button className="machine-btn" disabled={busy} aria-busy={busy || undefined} onClick={() => void status(m.machine, false).then((r) => r && setTested((o) => ({ ...o, [m.machine]: r.channel?.state === 'up' })))}>{t('machines.test')}</button>
            <button className="machine-btn" aria-expanded={shown} aria-controls={shown ? `diag-${m.machine}` : undefined} disabled={busy} aria-busy={busy || undefined} onClick={() => { setOpen(shown ? null : m.machine); if (!shown) void status(m.machine, false); }}>{t('machines.v25.diagnostics')}{shown && <span aria-hidden="true"> ▾</span>}</button>
            {state === 'up' && <button className="machine-btn" aria-expanded={starting === m.machine} disabled={busy} onClick={() => { setStarting(starting === m.machine ? null : m.machine); setFolder(''); setFolderBad(false); }}>{t('machines.newSession')}</button>}
            <button className="machine-btn" disabled={busy} aria-busy={busy || undefined} onClick={() => void terminal(m)}>{t('machines.terminal')}</button>
            <button className="machine-btn" disabled={busy} aria-busy={busy || undefined} onClick={() => { setAdding(false); setFocusUser(false); setEditing(m.machine); }}>{t('machines.edit')}</button>
            <button className="machine-btn danger" disabled={busy} aria-busy={busy || undefined} onClick={() => setRemoving(m.machine)}>{t('machines.remove')}</button></div>
          {starting === m.machine && state === 'up' && <form className="machine-new" role="group" aria-label={t('machines.newSession')} onSubmit={(e) => { e.preventDefault(); startOn(m.machine); }}>
            <input {...PLAIN} className="sinp mono" aria-label={t('machines.newFolder', { alias: m.machine })} aria-invalid={folderBad} value={folder} autoFocus autoComplete="off" spellCheck={false} onChange={(e) => (setFolder(e.target.value), setFolderBad(false))} />
            <button type="submit" className="machine-btn">{t('machines.newGo')}</button>
            {folderBad && <span role="alert">{t('machines.newFolderBad', { alias: m.machine })}</span>}
          </form>}
          <dl className="machine-kv">
            <dt>{t('machines.ssh')}</dt><dd className="machine-mono">{`${m.user || unknown}@${m.host || unknown}:${m.port || unknown}`}</dd>
            <dt>{t('machines.keys')}</dt><dd className="machine-mono">{m.keys.length ? m.keys.map((k, i) => <span key={`${i}-${k}`}>{k}{i < m.keys.length - 1 && <br />}</span>) : unknown}</dd>
            {/* Q10 (real SSH look 11-17): "unknown" read as a problem beside a connected machine; no key read, no line. */}
            {m.fingerprint && <><dt>{t('machines.hostKey')}</dt><dd className="machine-mono">{m.fingerprint}</dd></>}
            <dt>{t('machines.nunchiro')}</dt><dd>{c?.remote_version && state !== 'up' ? t('machines.v25.lastSeen', { version: c.remote_version }) : c?.remote_version ? t('machines.version', { version: c.remote_version, protocol: c.remote_protocol ?? unknown, local: c.local_protocol ?? unknown }) : unknown}</dd>
          </dl>
          {(state === 'version_mismatch' || ((c?.error || m.error) && !shown)) && <div className="machine-problem" role="alert"><span>{state === 'version_mismatch' ? t('machines.mismatch', { alias: m.machine, protocol: c?.remote_protocol ?? unknown }) : <SshError t={t} text={(c?.error || m.error)!} />}</span>
            {state !== 'version_mismatch' && !m.saved?.user && KEY_DENIED.test(c?.error || m.error || '') && <>
              {m.user && <span>{` ${t('machines.loggedInAs', { user: m.user })}`}</span>}
              {offerFor(m) && <button type="button" className="machine-btn" onClick={() => { setEditing(null); setPrefill(offerFor(m)!.name); setAdding(true); }}>{aliasText(t, offerFor(m)!)}</button>}
              <button type="button" className="machine-btn" onClick={() => { setAdding(false); setFocusUser(true); setEditing(m.machine); }}>{t('machines.edit')}</button>
            </>}
          </div>}
          {(state === 'version_mismatch' || notFound(c?.error || m.error)) && <FixCommand t={t} text={t(state === 'version_mismatch' ? 'machines.fixUpdate' : 'machines.fixInstall', { alias: m.machine })} />}
          {m.machine in tested && <p role="status" className={`machine-probe ${tested[m.machine] ? 'ok' : 'bad'}`}><span aria-hidden="true">{tested[m.machine] ? '✓ ' : '⚠ '}</span>{t(tested[m.machine] ? 'machines.reachable' : 'machines.notReachable')}</p>}
          {shown && <Diagnostics m={m} t={t} time={time} />}
        </div>}
      </article>;
    })}</div>}
    {(adding || editing) && <AddMachine key={`${editing ?? ''}|${prefill}|${focusUser}`} core={core} t={t} aliases={aliases} prefill={prefill} focusUser={focusUser} edit={rows?.find((m) => m.machine === editing)} onAdded={async (alias, host, d) => {
      if (!editing) { setAdding(false); toast?.(t('machines.added', { alias })); await load(alias); await status(alias, false); return; }
      // The channel reads the saved values when it next connects: a live one is left alone (its sessions stay), any other retries now.
      const channel = rows?.find((m) => m.machine === alias)?.channel;
      const up = channel?.state === 'up';
      // The values the live connection started with: kept at the first edit of that connection. Editing back to them is no longer "old values".
      if (up) {
        const was = rows?.find((m) => m.machine === alias)?.saved;
        if (connValues.current[alias]?.since !== channel.since_ms) connValues.current[alias] = { since: channel.since_ms, host: was?.host ?? alias, user: was?.user ?? '', port: String(was?.port ?? '') };
        const c0 = connValues.current[alias]!;
        const same = host === c0.host && (d.user ?? '') === c0.user && String(d.port ?? '') === c0.port;
        setOldValues((o) => ({ ...o, [alias]: same ? undefined : channel.since_ms }));
      }
      setEditing(null); toast?.(t(up ? 'machines.editSavedLater' : 'machines.editSaved', { alias: host && host !== alias ? `${alias} (${host})` : alias })); await load(alias); if (!up) await status(alias, true);
    }} onError={fail} onCancel={() => { setAdding(false); setEditing(null); addButton.current?.focus(); }} />}
    {removing && <RemoveConfirm alias={removing} t={t} busy={busy} onCancel={() => setRemoving(null)} onConfirm={() => void forget()} />}
  </section>;
}
type Probe = { ok: boolean; text: string };
/** v25f (owner F8, decision A): one Host field that suggests aliases, optional user and port, Test; Add never needs Test. */
/** Edit (`edit`): the same form filled with what was saved; it saves over that alias, and unchanged values send nothing. */
function AddMachine({ core, t, aliases, prefill = '', focusUser = false, edit, onAdded, onError, onCancel }: { core: CoreClient; t: T; aliases: Alias[]; prefill?: string; focusUser?: boolean; edit?: Machine; onAdded: (alias: string, host: string, d: { user?: string; port?: number }) => Promise<void>; onError: (e: Error) => void; onCancel: () => void }) {
  const was = { host: edit ? edit.saved?.host ?? edit.machine : prefill, user: edit?.saved?.user ?? '', port: String(edit?.saved?.port ?? '') };
  const [host, setHost] = useState(was.host);
  const [user, setUser] = useState(was.user);
  const [port, setPort] = useState(was.port);
  const [more, setMore] = useState(!!(was.user || was.port) || focusUser);
  const [listOpen, setListOpen] = useState(false);
  const [pick, setPick] = useState(-1);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  // Ticket 1050: a pasted share link; any edit of host, user or port drops it (its fingerprint names that host only).
  const [pasting, setPasting] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [linked, setLinked] = useState<Linked | null>(null);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [copyId, setCopyId] = useState(false);
  const unlink = () => { setLinked(null); setMismatch(null); setCopyId(false); };
  const paste = (text: string) => {
    setLinkText(text); setProbe(null); unlink();
    const l = parseLink(text);
    if (!l) return;
    setLinked(l); setHost(l.host); setUser(l.user); setPort(String(l.port)); setMore(true);
  };
  const input = useRef<HTMLInputElement>(null);
  const userInput = useRef<HTMLInputElement>(null);
  useEffect(() => (focusUser ? userInput : input).current?.focus(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = aliases.map((a) => a.name).filter((a) => a.toLowerCase().includes(host.trim().toLowerCase())).slice(0, 8);
  const expanded = listOpen && shown.length > 0 && !(shown.length === 1 && shown[0] === host);
  const offer = !edit && !user.trim() ? aliasFor(aliases, host) : undefined;
  const choose = (a: string) => { setHost(a); setListOpen(false); setPick(-1); setProbe(null); unlink(); };
  const details = () => ({ host: host.trim(), user: user.trim() || undefined, port: port.trim() ? Number(port) : undefined });
  const test = async () => {
    setTesting(true); setProbe(null); setMismatch(null); setCopyId(false);
    if (linked) {
      try {
        const r = await core.request({ op: 'machine_trust', alias: linked.label || linked.host, link: linked.text }) as { live: string; trusted: boolean; error?: string | null };
        if (!r.trusted) setMismatch(r.live);
        else if (r.error) { setProbe({ ok: false, text: r.error }); setCopyId(/Permission denied \(publickey/i.test(r.error)); }
        else setProbe({ ok: true, text: t('machines.linkTrusted') });
      } catch (e) { setProbe({ ok: false, text: rawError(e) }); }
      finally { setTesting(false); }
      return;
    }
    try { const r = await core.request({ op: 'machine_probe', ...details() }) as { error?: string | null }; setProbe(r.error ? { ok: false, text: r.error } : { ok: true, text: t('machines.reachable') }); }
    catch (e) { setProbe({ ok: false, text: rawError(e) }); }
    finally { setTesting(false); }
  };
  const add = async () => {
    const d = details();
    if (edit && d.host === was.host && (d.user ?? '') === was.user && String(d.port ?? '') === was.port) return onCancel();
    setBusy(true);
    const alias = edit?.machine ?? (linked?.label || d.host);
    try { await core.request({ op: 'add_machine', alias, ...d, ...(edit ? { replace: true } : {}) }); await onAdded(alias, d.host, d); }
    catch (e) { onError(e as Error); }
    finally { setBusy(false); }
  };
  const onHostKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); setListOpen(true);
      const n = shown.length;
      if (n) setPick((p) => e.key === 'ArrowDown' ? (p + 1) % n : p <= 0 ? n - 1 : p - 1);
    } else if (e.key === 'Enter' && expanded && pick >= 0) { e.preventDefault(); choose(shown[pick]!); }
    else if (e.key === 'Escape' && expanded) { e.stopPropagation(); setListOpen(false); }
  };
  const valid = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]{0,127}$/.test(host.trim()) && /^\d{0,5}$/.test(port.trim());
  // Ticket 543: an empty host only waits for typing (data-idle); a host or port the core would refuse says so on its own line.
  const refused = !valid && (host.trim() !== '' || port.trim() !== '');
  return <form className="machine-add" onKeyDown={(e) => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy) onCancel(); } }} onSubmit={(e) => { e.preventDefault(); if (valid && !busy && !testing) void add(); }}>
    <label htmlFor="machine-alias"><b>{edit ? t('machines.editTitle', { alias: edit.machine }) : t('machines.addTitle')}</b> {t('machines.hostNote')}</label>
    <div className="machine-combo">
      <input {...PLAIN} id="machine-alias" ref={input} role="combobox" aria-label={t('machines.host')} aria-autocomplete="list" aria-expanded={expanded} aria-controls="machine-aliases" aria-activedescendant={expanded && pick >= 0 ? `machine-alias-${pick}` : undefined}
        value={host} onChange={(e) => { setHost(e.target.value); setListOpen(true); setPick(-1); setProbe(null); unlink(); }} onFocus={() => setListOpen(true)} onBlur={() => setListOpen(false)} onKeyDown={onHostKey} autoComplete="off" spellCheck={false} />
      {expanded && <ul id="machine-aliases" role="listbox" aria-label={t('machines.suggestions')}>{shown.map((a, i) => <li key={a} id={`machine-alias-${i}`} role="option" aria-selected={i === pick} onMouseDown={(e) => { e.preventDefault(); choose(a); }}>{a}</li>)}</ul>}
    </div>
    {expanded && <p className="machine-hint">{t('machines.pickHint')}</p>}
    {offer && <p className="machine-hint"><button type="button" className="machine-btn link" onClick={() => choose(offer.name)}>{aliasText(t, offer)}</button></p>}
    <p className="machine-hint">{t('machines.hostHelp')}</p>
    {refused && <p className="machine-hint"><Why id="why-machine-host" reason={t('settingsWhy.machineHost')} /></p>}
    {!edit && <div><button type="button" className="machine-btn link" aria-expanded={pasting} onClick={() => setPasting(!pasting)}>{t('machines.paste')}</button></div>}
    {pasting && <div><input {...PLAIN} className="sinp mono" aria-label={t('machines.link')} placeholder="nunchiro-machine:v1?…" value={linkText} onChange={(e) => paste(e.target.value)} autoComplete="off" spellCheck={false} /></div>}
    {pasting && linkText.trim() !== '' && !parseLink(linkText) && <p role="alert" className="machine-probe bad">{t('machines.linkBad')}</p>}
    {linked && <p className="machine-hint">{t('machines.linkKey')} <span className="machine-mono">{linked.hostkey}</span></p>}
    <div><button type="button" className="machine-btn link" aria-expanded={more} onClick={() => setMore(!more)}><span aria-hidden="true">{more ? '▾' : '▸'} </span>{t('machines.more')}</button></div>
    {more && <div><input {...PLAIN} ref={userInput} className="machine-small" aria-label={t('machines.user')} placeholder={t('machines.user')} value={user} onChange={(e) => { setUser(e.target.value); setProbe(null); unlink(); }} autoComplete="off" spellCheck={false} /><input {...PLAIN} className="machine-small" aria-label={t('machines.port')} placeholder={t('machines.port')} inputMode="numeric" value={port} onChange={(e) => { setPort(e.target.value); setProbe(null); unlink(); }} autoComplete="off" /></div>}
    <div><button type="button" className="btn" disabled={busy || testing || !valid} aria-busy={busy || testing || undefined} aria-describedby={refused ? 'why-machine-host' : undefined} data-idle={(!busy && !testing && !valid && !refused) || undefined} onClick={() => void test()}>{testing ? t('machines.testing') : t('machines.test')}</button><button className="btn p" disabled={busy || testing || !valid} aria-busy={busy || testing || undefined} aria-describedby={refused ? 'why-machine-host' : undefined} data-idle={(!busy && !testing && !valid && !refused) || undefined}>{t(edit ? 'machines.editSave' : 'machines.addOne')}</button> <button type="button" className="btn" disabled={busy} aria-busy={busy || undefined} onClick={onCancel}>{t('machines.cancel')}</button>
      {probe && <span role="status" className={`machine-probe ${probe.ok ? 'ok' : 'bad'}`}><span aria-hidden="true">{probe.ok ? '✓ ' : '⚠ '}</span>{probe.ok ? probe.text : <SshError t={t} text={probe.text} />}</span>}</div>
    {mismatch && linked && <p role="alert" className="machine-probe bad">{t('machines.linkMismatch', { host: linked.host, want: linked.hostkey, live: mismatch })}</p>}
    {copyId && linked && <FixCommand t={t} text={t('machines.copyId')} command={`ssh-copy-id -p ${linked.port} ${linked.user}@${linked.host}`} />}
    <p>{t('machines.addNote')}</p>
  </form>;
}
function RemoveConfirm({ alias, t, busy, onCancel, onConfirm }: { alias: string; t: T; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return <div className="machine-add" role="group" aria-label={t('machines.confirmTitle', { alias })} onKeyDown={(e) => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy) onCancel(); } }}>
    <p>{t('machines.confirm', { alias })}</p>
    <button className="machine-btn danger" disabled={busy} aria-busy={busy || undefined} onClick={onConfirm}>{t('machines.confirmRemove')}</button> <button className="machine-btn" disabled={busy} aria-busy={busy || undefined} ref={cancel} onClick={onCancel}>{t('machines.cancel')}</button>
  </div>;
}
/** The command to run on the remote yourself, with its own Copy. */
function FixCommand({ t, text, command = INSTALL }: { t: T; text: string; command?: string }) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  useEffect(() => { if (!copied) return; const id = setTimeout(() => setCopied(null), 3000); return () => clearTimeout(id); }, [copied]);
  return <div className="machine-fix">
    <p>{text}</p>
    <p><code className="machine-mono">{command}</code> <button className="machine-btn" onClick={() => void copyText(command).then((ok) => setCopied(ok ? 'ok' : 'failed'))}>{copied === 'ok' ? t('machines.v25.copied') : t('machines.fixCopy')}</button>{copied === 'failed' && <span role="status" className="machine-copy-failed"> {t('machines.v25.copyFailed')}</span>}</p>
  </div>;
}
type Hop = 'ok' | 'failed' | 'skipped';
const MARK = { ok: '✓', failed: '✕', skipped: '–' };
function Diagnostics({ m, t, time }: { m: Machine; t: T; time: string }) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  useEffect(() => { if (!copied) return; const id = setTimeout(() => setCopied(null), 3000); return () => clearTimeout(id); }, [copied]);
  const c = m.channel;
  const unknown = t('machines.unknown');
  const state = c?.state ?? 'unknown';
  // From what the channel already knows; a hop it never reached is "not checked".
  const sshHop: Hop = state === 'up' || state === 'version_mismatch' ? 'ok' : state === 'down' || state === 'reconnecting' ? 'failed' : 'skipped';
  // Later hops need a working ssh: after a failure they stay "not checked", whatever an earlier connection saw.
  const reached = sshHop === 'ok';
  const hops: [Key, Hop][] = [
    ['machines.v25.hop.config', m.host ? 'ok' : 'skipped'],
    ['machines.v25.hop.ssh', sshHop],
    ['machines.v25.hop.remote', reached && c?.remote_version ? 'ok' : 'skipped'],
    ['machines.v25.hop.window', !reached ? 'skipped' : state === 'version_mismatch' ? 'failed' : c?.remote_protocol !== undefined ? 'ok' : 'skipped'],
  ];
  const error = c?.error || m.error;
  const up = state === 'up';
  const remote = remoteText(c, t, unknown);
  // Only a live connection has a current latency.
  const latency = up && c?.latency_ms !== undefined ? t('machines.v25.ms', { ms: c.latency_ms }) : unknown;
  const text = [`${m.machine}: ${t(`machines.v25.state.${state}` as Key, { time, remote: c?.remote_protocol ?? unknown, local: c?.local_protocol ?? unknown })}`, `${t('machines.v25.lastError')}: ${error ?? unknown}`, `${t('machines.v25.latency')}: ${latency}`, `${t('machines.v25.remote')}: ${remote}`, `${t('machines.v25.thisMac')}: ${c?.local_protocol ?? unknown}`].join('\n');
  const copy = async () => setCopied((await copyText(text)) ? 'ok' : 'failed');
  return <div className="machine-diag" id={`diag-${m.machine}`} role="group" aria-label={t('machines.v25.diagnostics')}>
    <ul className="machine-hops">{hops.map(([label, hop]) => <li key={label} className={`machine-hop-${hop}`}><span className="machine-mark" aria-hidden="true">{MARK[hop]}</span>{hop === 'ok' ? t(label) : t(`machines.v25.hop.${hop}` as Key, { label: t(label) })}</li>)}</ul>
    <dl className="machine-kv">
      <dt>{t('machines.v25.lastError')}</dt><dd className="machine-mono">{error ?? unknown}</dd>
      <dt>{t('machines.v25.since')}</dt><dd>{time}</dd>
      <dt>{t('machines.v25.latency')}</dt><dd>{latency}</dd>
      <dt>{t('machines.v25.remote')}</dt><dd>{remote}</dd>
      <dt>{t('machines.v25.thisMac')}</dt><dd>{t('machines.v25.protocol', { protocol: c?.local_protocol ?? unknown })}</dd>
    </dl>
    <p><b>{t('machines.v25.try')}</b> {t('machines.v25.tryBody', { alias: m.machine })}</p>
    <p><button className="machine-btn" onClick={() => void copy()}>{copied === 'ok' ? t('machines.v25.copied') : t('machines.v25.copy')}</button>{copied === 'failed' && <span role="status" className="machine-copy-failed"> {t('machines.v25.copyFailed')}</span>}</p>
  </div>;
}

// Ticket 1050: the share link (docs/remote.md). The core parses it again on Test; this copy only fills the form.
type Linked = { host: string; user: string; port: number; hostkey: string; label?: string; text: string };
const LINK_FIELDS = ['host', 'user', 'port', 'hostkey', 'label'];
function parseLink(raw: string): Linked | null {
  const text = raw.trim();
  if (text.length > 1024 || !text.startsWith('nunchiro-machine:v1?')) return null;
  const f: Record<string, string> = {};
  for (const pair of text.slice('nunchiro-machine:v1?'.length).split('&')) {
    const at = pair.indexOf('=');
    const key = pair.slice(0, at);
    if (at < 0 || !LINK_FIELDS.includes(key) || key in f) return null;
    f[key] = pair.slice(at + 1);
  }
  const { host = '', user = '', port = '', hostkey = '', label } = f;
  const ok = /^(?!-)[A-Za-z0-9.-]{1,253}$/.test(host) && /^(?!-)[A-Za-z0-9._-]{1,64}$/.test(user) && /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535
    && /^SHA256:[A-Za-z0-9+/]{43}$/.test(hostkey) && (label === undefined || /^(?!-)[A-Za-z0-9_.-]{1,128}$/.test(label));
  return ok ? { host, user, port: Number(port), hostkey, label, text } : null;
}
/** Ticket 1050: this Mac's link for Add machine on another Mac. It holds no secret; Remote Login off says how to turn it on. */
function ShareThisMac({ core, t, onClose }: { core: CoreClient; t: T; onClose: () => void }) {
  const [got, setGot] = useState<{ remote_login: boolean; shares: { host: string; link: string }[] } | null>(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState(0);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  useEffect(() => { let live = true; void core.request({ op: 'machine_share' }).then((r) => live && setGot(r as never), (e: Error) => live && setError(rawError(e))); return () => { live = false; }; }, [core]);
  useEffect(() => { if (!copied) return; const id = setTimeout(() => setCopied(null), 3000); return () => clearTimeout(id); }, [copied]);
  const link = got?.shares[pick]?.link;
  return <div className="machine-add" role="group" aria-label={t('machines.share')} onKeyDown={(e) => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); onClose(); } }}>
    <b>{t('machines.share')}</b>
    {!got && !error && <p role="status">{t('machines.loading')}</p>}
    <ErrorLine t={t} error={error} className="" foreign />
    {got && !got.remote_login && <p role="alert">{t('machines.shareOff')}</p>}
    {got?.remote_login && !link && <p role="alert">{t('machines.shareNone')}</p>}
    {got && got.shares.length > 1 && <p><select className="sinp" aria-label={t('machines.shareHost')} value={pick} onChange={(e) => setPick(Number(e.target.value))}>{got.shares.map((s, i) => <option key={s.host} value={i}>{s.host}</option>)}</select></p>}
    {link && <p><code className="machine-mono">{link}</code> <button className="machine-btn" onClick={() => void copyText(link).then((ok) => setCopied(ok ? 'ok' : 'failed'))}>{copied === 'ok' ? t('machines.v25.copied') : t('machines.v25.copy')}</button>{copied === 'failed' && <span role="status" className="machine-copy-failed"> {t('machines.v25.copyFailed')}</span>}</p>}
    {link && <p>{t('machines.shareNote')}</p>}
    <button className="machine-btn" onClick={onClose}>{t('machines.shareClose')}</button>
  </div>;
}
