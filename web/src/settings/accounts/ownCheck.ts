// Accounts probe 11-10: one "Your own" sign-in check per agent for the whole window, read by Providers and Onboarding, so
// the two pages never state one fact differently. Opening either page checks every found agent whose state is not known
// yet or is older than FRESH_MS; nothing re-checks while a page stays open, and "Check" or "Check again" forces one.
import { useSyncExternalStore } from 'react';
import type { Account, AccountAgent, CoreClient } from '../../api';
import { openSession } from '../../tree';
import type { Session } from '../../types';

/** The page's freshness rule: the "Checked just now" line's minute (`ageText`), the core's `OWN_CHECK_EVERY` too. */
export const FRESH_MS = 60_000;

export interface OwnCheck {
  /** The last answer; null before one came back, or when the request itself failed. */
  account: Account | null;
  /** A check came back (an `unknown` after it is "Couldn't check", before it "Not checked"). */
  done: boolean;
  /** When it came back (ms). */
  at: number;
  /** A check is running: the state reads "Checking…". */
  running: boolean;
  /** The last answer came from the owner's Check, not from a page opening. */
  forced: boolean;
}
export type OwnChecks = Partial<Record<AccountAgent, OwnCheck>>;

/** Ticket 423 round 2: a "still checking" reply (`checking`: the core's check still waits for a probe slot when the 15 s
 *  join bound ends) is asked again after RE_ASK_MS, at most RE_ASKS times, and only while Providers or Onboarding is open
 *  (a page reads the checks); then it reads "Couldn't check". When every ask joins a check already running, a press
 *  spends at most 15 s + 5 x (5 s + 15 s) = 115 s in join waits and re-ask delays, not counting transport and
 *  scheduling delays. Ticket 431: an ask that starts the check waits at most 15 s for its probe slot ("still checking"
 *  past it), and only an ask that got its slot runs the check (at most 15 s more, then answers), so a press is at most
 *  115 s + 15 s = 130 s on the same terms. */
export const RE_ASKS = 5;
export const RE_ASK_MS = 5_000;

let checks: OwnChecks = {};
const running = new Map<AccountAgent, Promise<Account | null>>();
const listeners = new Set<() => void>();
const set = (agent: AccountAgent, next: OwnCheck) => {
  checks = { ...checks, [agent]: next };
  for (const l of listeners) l();
};

/** Checks `agent`'s "Your own" unless a check is running (its answer is shared) or, without `force`, one came back
 *  within FRESH_MS. Rejects when the request failed; the state then reads "Couldn't check". */
export function checkOwn(core: CoreClient, agent: AccountAgent, force = false): Promise<Account | null> {
  const now = running.get(agent);
  if (now) return now;
  const last = checks[agent];
  if (!force && last?.done && last.account && Date.now() - last.at < FRESH_MS) return Promise.resolve(last.account);
  set(agent, { account: last?.account ?? null, done: last?.done ?? false, at: last?.at ?? 0, running: true, forced: last?.forced ?? false });
  const asked = ask(core, agent, force).then(
    (account) => {
      running.delete(agent);
      // The page closed while the check was still queued: no answer, so the state is as before this check.
      if (!account) {
        set(agent, { ...(last ?? { account: null, done: false, at: 0, forced: false }), running: false });
        return last?.account ?? null;
      }
      set(agent, { account, done: true, at: Date.now(), running: false, forced: force });
      return account;
    },
    (e: unknown) => {
      running.delete(agent);
      set(agent, { account: null, done: true, at: Date.now(), running: false, forced: force });
      throw e;
    },
  );
  running.set(agent, asked);
  return asked;
}

/** One check: the reply, asked again while the core says it is still checking (RE_ASKS); null when the page closed first.
 *  A re-ask is not forced, so it joins the check still running or reads the one that just ended. */
async function ask(core: CoreClient, agent: AccountAgent, force: boolean): Promise<Account | null> {
  let { account } = await core.checkAccount(agent, force);
  for (let n = 0; account.checking && n < RE_ASKS; n++) {
    await new Promise((done) => setTimeout(done, RE_ASK_MS));
    if (listeners.size === 0) return null;
    ({ account } = await core.checkAccount(agent));
  }
  return account;
}

/** What a page opening does: every found agent not known yet, or known for longer than FRESH_MS, is checked once. */
export function checkOnOpen(core: CoreClient, agents: AccountAgent[]) {
  for (const agent of agents) void checkOwn(core, agent).catch(() => {});
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
/** The window's checks; a page re-renders when one starts or comes back. */
export const useOwnChecks = () => useSyncExternalStore(subscribe, () => checks);

/** `list` with each "Your own" row as this window's last answer for it, once that came back (the list's own row is the core's
 *  last check, `unknown` while one runs); the row keeps the list's default marks. */
export function withOwnChecks(list: Account[], now: OwnChecks = checks): Account[] {
  const next = list.map((a) => {
    const got = a.default && now[a.agent]?.done && !now[a.agent]?.running ? now[a.agent]?.account : null;
    return got && (got.signed_in !== a.signed_in || got.plan !== a.plan) ? { ...got, label: a.label, session_default: a.session_default, fell_back: a.fell_back } : a;
  });
  return next.some((a, i) => a !== list[i]) ? next : list;
}

/** Resolves once session `id` no longer runs (read from the core every half second). */
export async function sessionEnded(core: CoreClient, id: string) {
  for (;;) {
    await new Promise((done) => setTimeout(done, 500));
    const { sessions } = (await core.request({ op: 'snapshot' })) as { sessions: Session[] };
    if (sessions.find((s) => s.id === id)?.state !== 'running') return;
  }
}

/** "Your own" signs in only in a terminal (account_signin.rs): its own login in a visible tab, closed once it ended.
 *  Providers' and Onboarding's Sign in (ticket 991) both run this; the caller checks the sign-in again after it. */
export async function ownLogin(core: CoreClient, account: Account) {
  const { session } = (await core.request({ op: 'account_remove', agent: account.agent, id: account.id, step: 'login', leftovers: false })) as { session: Session };
  openSession(session.id);
  await sessionEnded(core, session.id);
  await core.request({ op: 'close', id: session.id });
}
