// Ticket 358, mock #acplogin: sign an approved ACP agent in by the methods it reports, copy the link, cancel, and sign out where
// the agent advertises that. What it reports comes from the core's confined check, and that list holds no env_var method, so
// nothing here can offer one. Placement of copy, cancel and sign-out is T3 Code's ProviderAuthenticationSection, the control
// is the mock's segments. A sign-in outlives its row being collapsed, so the state lives here per agent and the row's chip reads it.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AcpAuthMethod, AcpCheck, AcpRow, AcpSignIn, CoreClient } from '../../api';
import type { Key } from '../../i18n';
import { copyText } from '../../terminal/clipboard';
import { ErrorDetails, plainError, rawError } from '../../errors';
import { Chip, Ln, type T } from './providers';

const POLL_MS = 500;
const TAB_POLL_MS = 2000;
const COPIED_MS = 1500;
const CHECK_TRIES = 10;
const CHECK_WAIT_MS = 700;

/** `stale`: the last read of the agent's state failed, so `check` is what was known before it. */
type Live = { check?: AcpCheck; run?: AcpSignIn; stale?: boolean };
const live = new Map<string, Live>();
const listeners = new Set<() => void>();
const update = (name: string, change: Live) => {
  live.set(name, { ...live.get(name), ...change });
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const useLive = (name: string): Live => useSyncExternalStore(subscribe, () => live.get(name)) ?? {};
const inProgress = (run?: AcpSignIn) => run?.phase === 'starting' || run?.phase === 'waiting';
const BUSY = 'a check is running';
const following = new Set<string>();

/** The core runs one check at a time, so a check that loses that race waits for its turn. */
async function readCheck(core: CoreClient, row: AcpRow, afterSignIn = false) {
  const entry = { name: row.name, command: row.command, args: row.args, env: row.env };
  // Only where a state was expected: a first check with no answer on the login is an ordinary result for many agents.
  const unread = () => update(row.name, { stale: afterSignIn || !!live.get(row.name)?.check });
  for (let tries = 0; tries < CHECK_TRIES; tries++) {
    try {
      const check = await core.acpCheck(entry);
      if (check.sign_in) attach(core, row, check.sign_in);
      // No answer on the login (a timeout, an agent that failed): what was known stays, and the row says it could not read.
      if (check.signed_in === null) return unread();
      return update(row.name, { check, stale: false });
    } catch (e) {
      if (!rawError(e).includes(BUSY)) return unread();
      await new Promise((done) => setTimeout(done, CHECK_WAIT_MS));
    }
  }
  unread();
}

/** A sign-in this window has not followed yet: one it started, or one found after a reload. */
function attach(core: CoreClient, row: AcpRow, run: AcpSignIn) {
  if (following.has(run.attempt)) return;
  following.add(run.attempt);
  update(row.name, { run, stale: false });
  follow(core, row, run.attempt);
}

function follow(core: CoreClient, row: AcpRow, attempt: string) {
  const tick = async () => {
    try {
      const run = await core.acpSignInState(attempt);
      update(row.name, { run });
      if (inProgress(run)) return void setTimeout(() => void tick(), POLL_MS);
      // The agent opened a session, so that is known even if the read below fails.
      const known = live.get(row.name)?.check;
      if (run.phase === 'signed_in' && known) update(row.name, { check: { ...known, signed_in: true } });
    } catch {
      update(row.name, { run: undefined }); // the core lost it (a restart): the row reads its state again below
    }
    following.delete(attempt);
    await readCheck(core, row, true);
  };
  void tick();
}

/** A terminal method's login tab: when it ends, the row reads what it did. */
function followTab(core: CoreClient, row: AcpRow, id: string) {
  const tick = async () => {
    try {
      const { sessions } = (await core.request({ op: 'snapshot' })) as { sessions: { id: string; state: string }[] };
      if (sessions.find((s) => s.id === id)?.state === 'running') return void setTimeout(() => void tick(), TAB_POLL_MS);
    } catch {
      return; // a lost core: the row reads its state the next time it opens
    }
    await readCheck(core, row, true);
  };
  void tick();
}

/** The row's status while the agent's sign-in is known: it takes the place of 승인됨 (`.upd-st` hides the chip after it). */
export function AcpLoginChip({ t, name, bad }: { t: T; name: string; bad: boolean }) {
  const { check, run } = useLive(name);
  if (bad) return null;
  if (inProgress(run)) return <span className="upd-st"><span className="pchip upd-run">{t('acpLogin.signing')}</span></span>;
  if (check?.signed_in === true) return <span className="upd-st"><Chip word={t('acpLogin.signed')} tone="ok" /></span>;
  if (check?.signed_in === false && check.auth_methods?.length) return <span className="upd-st"><Chip word={t('providers.needsLogin')} tone="warn" /></span>;
  return null;
}

/** Accounts probe 11-10: the line under Sign-in says what the button beside it does in each of its three states: Sign in
 *  (by the chosen method), Cancel while a sign-in runs, and nothing to do once signed in (or what Sign out runs). */
function what(signedIn: boolean, active: boolean, canLogout: boolean, kind: AcpAuthMethod['kind'] | undefined): Key {
  if (active) return 'acpLogin.whatCancel';
  if (signedIn) return canLogout ? 'acpLogin.whatInOut' : 'acpLogin.whatIn';
  return kind === 'terminal' ? 'acpLogin.whatTerminal' : 'acpLogin.whatAgent';
}

export function AcpLogin({ t, core, row }: { t: T; core: CoreClient; row: AcpRow }) {
  const { check, run, stale } = useLive(row.name);
  const [pick, setPick] = useState('');
  const [copied, setCopied] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [details, setDetails] = useState(''); // ticket 476: the raw reason, under Details
  const usable = row.acp && row.state === 'approved' && !row.refused && !!row.found_path;

  useEffect(() => {
    if (usable) void readCheck(core, row);
    // A new hash is a new command; the rest of `row` changes with every listing.
  }, [core, row.name, row.hash, usable]);

  if (!usable) return null;
  const methods = check?.auth_methods ?? [];
  const active = inProgress(run);
  const signedIn = check?.signed_in === true && !active;
  const signedOut = check?.signed_in === false && !active;
  const showRow = active || (signedIn && (methods.length > 0 || !!check?.can_logout)) || (signedOut && methods.length > 0);

  // Two segments are the two kinds; several of one kind take the names the agent reported.
  const label = (m: AcpAuthMethod) => (methods.filter((x) => x.kind === m.kind).length > 1 ? m.name : t(m.kind === 'agent' ? 'acpLogin.agent' : 'acpLogin.terminal'));
  const chosen = methods.find((m) => m.id === (active ? run?.method : pick)) ?? methods[0];
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setDetails('');
    setNote('');
    try {
      await work();
    } catch (e) {
      if (rawError(e).includes(BUSY)) setError(t('acpLogin.checkFailed'));
      else (setError(plainError(t, e)), setDetails(rawError(e)));
    } finally {
      setBusy(false);
    }
  };
  const signIn = () =>
    act(async () => {
      let project: string | undefined;
      if (chosen.kind === 'terminal') {
        const sessions = ((await core.request({ op: 'snapshot' })) as { sessions: { project: string; attention: { last_activity: number } }[] }).sessions;
        project = [...sessions].sort((a, b) => b.attention.last_activity - a.attention.last_activity)[0]?.project;
        if (!project) return setError(t('agents.sheet.startFirst'));
      }
      const started = await core.acpSignIn(row.name, chosen.id, project);
      if ('session' in started) {
        setNote(t('agents.sheet.loginOpened', { tab: started.session.label }));
        return followTab(core, row, started.session.id);
      }
      attach(core, row, started.state);
    });
  const copy = (link: string) => {
    void copyText(link).then((ok) => (setCopied(ok), setTimeout(() => setCopied(null), COPIED_MS)));
  };
  const failed = run?.phase === 'failed' ? t(run.reason === 'timed_out' ? 'acpLogin.timedOut' : run.reason === 'bad_link' ? 'acpLogin.badLink' : 'acpLogin.failed') : '';
  const line = error || failed || (stale && !active ? t('acpLogin.checkFailed') : '');
  if (!showRow && !line) return null;

  return (
    <>
      {showRow && <Ln k={t('acpLogin.signIn')} sp>
        <span data-field="acp-login">
          {signedIn ? (
            <small>{methods.length === 1 ? label(methods[0]) : t('acpLogin.signed')}</small>
          ) : methods.length > 1 ? (
            <span className="sseg" role="radiogroup" aria-label={t('acpLogin.method')}>
              {methods.map((m) => (
                <label key={m.id}>
                  <input type="radio" name={`acp-login-${row.name}`} checked={m.id === chosen.id} disabled={active} onChange={() => setPick(m.id)} />
                  {label(m)}
                </label>
              ))}
            </span>
          ) : (
            <small>{methods[0] ? label(methods[0]) : t('acpLogin.signing')}</small>
          )}
        </span>
        <span className="prv-end">
          {signedIn ? (
            check?.can_logout && (
              <button type="button" className="btn" disabled={busy} onClick={() => void act(async () => (await core.acpSignOut(row.name), await readCheck(core, row)))}>
                {t('accountCards.signOut')}
              </button>
            )
          ) : active ? (
            <>
              {run?.link && (
                <button type="button" className="btn" onClick={() => copy(run.link!)}>
                  {t(copied === null ? 'settings.accounts.copyLink' : copied ? 'providersFailed.copied' : 'about.copyFailed')}
                </button>
              )}
              <button type="button" className="btn" disabled={busy} onClick={() => void act(() => core.acpSignInCancel(run!.attempt))}>
                {t('providers.cancel')}
              </button>
            </>
          ) : (
            <button type="button" className="btn p" disabled={busy} onClick={() => void signIn()}>
              {t('acpLogin.signIn')}
            </button>
          )}
        </span>
      </Ln>}
      {showRow && (
        <p className="prv-note" data-field="acp-login-what">
          {t(what(signedIn, active, !!check?.can_logout, chosen?.kind), { name: row.label })}
        </p>
      )}
      {active && (
        <div className="prv-note" role="status" data-field="acp-note">
          {t('acpLogin.waiting')}
        </div>
      )}
      {note && !signedIn && (
        <p role="status" className="prv-note">
          {note}
        </p>
      )}
      {line && (
        <div role="alert" className="prv-note bad">
          {line}
          {error && <ErrorDetails t={t} details={details} />}
        </div>
      )}
    </>
  );
}
