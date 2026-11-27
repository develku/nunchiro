// Settings · Accounts (V2-2a, screen 01 A; tickets 321 and 322, usage.html): one card list per agent. "Your own" is the agent's own config, always first and
// never removable; each added account has its own config folder, signed in through the agent's own login in a
// visible terminal tab. Today and 7 days are tokens counted from the agents' local transcripts (V2-2c); Sessions stays
// "—" until sessions carry their account (V2-2b). Remove (V2-2d) confirms what goes, runs the agent's own logout in a
// visible tab, then moves the folder to the trash for 7 days; the core refuses it while a session uses the account.
// Ticket 178: an account's own Login or Logout tab is listed on its row (never as a tree project), and when it is the
// only thing in the way, the refusal names it with "Close and remove".
// Ticket 178 finding 20: "Sign in" runs the agent's own login headless and opens its link in the browser (like Orca);
// the panel offers Copy link and, for Claude, Paste code. The terminal login stays as "Sign in in a terminal instead".
import { PLAIN } from '../../plainText';
import { ErrorLine, rawError } from '../../errors';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
// Ticket 355, mockup C: one page: Connected rows with fixed columns that open in place, one at a time, then the add tiles.
// Claude's and Codex's accounts live in their open row; the sign-in flows above are unchanged.
// Ticket 391 (final.html scene a): this is Settings > Providers, the old Agents and Accounts pages in one. Each provider is a
// one-line card head (head.tsx); an open Claude or Codex card has 연결·로그인, 계정, 모델, 새 세션 기본값 and 고급, an ACP card
// 연결·로그인, 모델 and 고급. The default agent (defaults.tsx) and agents.toml moved here from the Agents page.
import { accountName, type Account, type AccountAgent, type AccountUsage, type AcpRow, type AcpTurn, type CommandView, type CoreClient, type SignInState, type TerminalAgent } from '../../api';
import { AcpTry, TryChip } from './acpTry';
import { AcpLogin, AcpLoginChip } from './acpSignIn';
import type { Key } from '../../i18n';
import { ageText } from '../../chat/PrChip';
import { openExternal } from '../../sandbox/link';
import { copyText } from '../../terminal/clipboard';
import { ACCOUNTS_CHANGED, isAccountTab } from '../../tree';
import type { Session } from '../../types';
import type { WithLog } from '../../picker/Picker';
import { RefreshIcon } from '../git/logos';
import { INSTALL } from '../onboarding/state';
import { Icon } from '../../icons/Icon';
import { AGENT_TILES, Chip, KEY_TILES, Mark, MissingVars, ProviderForm, UNCONFIRMED, missingOf } from './providers';
import { DOCS } from '../onboarding/state';
import { FailedActions, TileSlot, loginDiagnostics } from './failed';
import { AccountsSection, CommandSection, DefaultAccountRow, ModelSection, PermissionRow, UseSwitch, blockers, quoted, runningOn, shownSigned, usageAsk } from './sections';
import { AcpModelSection } from './sections';
import { renameAccount } from './rename';
import { AGENTS_OFF } from '../agents/newDefaults';
import { useFeatureSetting } from '../useFeatureSetting';
import { AgentCommandRow } from './command';
import { UpdateRow } from './updateRow';
import { UpdateAll, UpdateMark } from './updates';
import { joinWords } from '../agents/words';
import { checkOnOpen, checkOwn, ownLogin, sessionEnded, useOwnChecks, withOwnChecks } from './ownCheck';
import { Block, ProviderHead } from './head';
import { DefaultAgentRow, ModelDefaults } from './defaults';
import { CodexResetSettings } from '../../usage/CodexResets';
import { PageActions, PageSummary } from '../shell/PageActions';
import { StrokeIcon } from '../shell/NavIcon';
import { Row } from '../shell/Row';
import { reveal } from '../../files/open';
import { inApp } from '../lifetime/tauri';
import '../agents/agents.css';
import './accounts.css';

const AGENTS: [AccountAgent, string][] = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
];
type T = (key: Key, args?: Record<string, string | number>) => string;
// shortcut: refreshes on a timer and on window focus, not on the login tab's exit; a push from the core would end
// the polling once sessions carry their account (V2-2b).
const REFRESH_MS = 60_000;

const OWN = 'own'; // accounts.rs `OWN`
/** 1234 reads `1.2k`, 3400000 `3.4M`: three significant figures at most, never a percentage. */
export function tokens(n: number) {
  const short = (v: number, unit: string) => `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}${unit}`;
  if (n < 1000) return String(n);
  return n < 999_500 ? short(n / 1e3, 'k') : n < 1e9 ? short(n / 1e6, 'M') : short(n / 1e9, 'B');
}
/** The confirm's loss line, with the count the core gave (V2-6: named, not undoable). */
export const lossLine = (t: T, n: number) => t(n === 1 ? 'settings.accounts.loss.one' : 'settings.accounts.loss.other', { n });
/** V2-2d: an account remove in progress: the confirm, the logout tab running, or logout's leftovers to confirm.
 * Ticket 178: `blocked` is a refusal whose only blockers are the account's own `tabs`. */
type Removal = { account: Account; sessions: number; phase: 'confirm' | 'logout' | 'leftovers' | 'blocked'; code?: number | null; tabs?: Session[] };
type RemoveStep = 'check' | 'logout' | 'move' | 'login';
const message = (e: unknown) => rawError(e);
/** Ticket 178 finding 20: a browser sign-in in progress; `state` is the core's, `error` a refused start. */
type SignIn = { agent: AccountAgent; label: string; id?: string; attempt?: string; state?: SignInState; error?: string };
/** Ticket 378: the attempt in progress (no link, state or code), kept while Settings shows another page; cleared on every end. */
const heldSignIn: { s: SignIn | null } = { s: null };
const FAIL: Record<NonNullable<SignInState['reason']>, Key> = {
  code_rejected: 'settings.accounts.fail.codeRejected',
  exited: 'settings.accounts.fail.exited',
  no_link: 'settings.accounts.fail.noLink',
  bad_link: 'settings.accounts.fail.badLink',
  timed_out: 'settings.accounts.fail.timedOut',
  not_signed_in: 'settings.accounts.fail.notSignedIn',
  start_failed: 'settings.accounts.fail.startFailed',
  unknown: 'settings.accounts.fail.unknown',
  not_saved: 'settings.accounts.fail.notSaved',
};
const SIGNIN_POLL_MS = 500;
/** This account's own Login or Logout tab: the tree's `isAccountTab` shape, in this folder, by this account's name. */
export const ownTab = (s: Session, a: Account) => isAccountTab(s) && s.project === a.folder && (s.label === `Login: ${a.label}` || s.label === `Logout: ${a.label}`);
// A refused read is retried this soon: the window runs at most 4 off-loop requests at once (http MAX_JOBS), so a read
// that lands while the sign-in probes or other pages hold them is refused, and the columns stayed "—" until the next minute.
const RETRY_MS = 2_000;
const RETRIES = 5;
/** The row another surface (a problem card's "Fix command", first run) asked to open; the page takes it when it opens. */
export const accountsAsk = { row: '' };
export { usageAsk };
// ponytail: module-level because the login tab sits behind this overlay, so the page is usually closed when the tab ends;
// lost on a window reload, when a push from the core about the login tab's outcome would replace it.
/** `agent:id` of accounts whose terminal login tab ended without a sign-in. */
const loginEnded = new Set<string>();
const accountKey = (a: Account) => `${a.agent}:${a.id}`;
/** `--version` prints its own wording; the column shows the number. */
const versionOf = (v: string | null | undefined) => v?.match(/\d+(\.\d+)+/)?.[0] ?? '';
const CHECK_MARK = (
  <svg className="tl-check" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 8.5l3.2 3.2L13 4.8" />
  </svg>
);
const EXT_MARK = (
  <svg className="tl-ext" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M9.5 2.5h4v4M13.5 2.5L8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
  </svg>
);

/** Which card a search hit or palette jump opens, by field key (FIELDS): the control is inside that card. */
const CARD_OF: Record<string, string> = { 'usage.codex_resets': 'codex', 'usage.codex_reset_agent': 'codex', newDefaultModel: 'claude', newDefaultPermissions: 'claude' };
const jumped: { last: object | null } = { last: null };
const dirOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/';

export function AccountsPage({ t, core, onViewUsage, open: asked, focus, projects, onHooks, live }: {
  t: T;
  core: CoreClient;
  /** The window's live sessions (PageContext.sessions): what proves a sign-in, read at once and not at the page's next poll. */
  live?: Session[];
  onViewUsage: (agent: AccountAgent, id: string) => void;
  /** An agent's card to open (the AGENTS event, `openAgents(name)`); `n` repeats it. */
  open?: { name: string; n: number } | null;
  /** A search hit or palette jump on this page: a field inside a closed card opens that card. */
  focus?: { key: string; n: number } | null;
  /** Ticket 518: the window's project list; a stored override for any other path is a leftover and gets no tag. */
  projects?: string[];
  /** The "인수 있음: 훅 꺼짐" chip: opens the hook switch wherever FIELDS holds it. */
  onHooks: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState('');
  const [terminal, setTerminal] = useState<TerminalAgent[] | null>(null);
  const [rows, setRows] = useState<AcpRow[]>([]);
  const [turns, setTurns] = useState<Record<string, AcpTurn>>({});
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [now, setNow] = useState(Date.now);
  // One row open at a time: 'claude', 'codex' or an ACP entry's name.
  const [openRow, setOpenRow] = useState('');
  const [changing, setChanging] = useState('');
  const [removing, setRemoving] = useState('');
  // The tile whose form is showing: a known row, a name from UNCONFIRMED, or 'custom' for 직접 입력.
  const [form, setForm] = useState<{ row: AcpRow | null; start?: { name: string; label: string }; id: string } | null>(null);
  const [, setEnded] = useState(0); // redraws when `loginEnded` changes
  const [agentsOff] = useFeatureSetting(AGENTS_OFF); // ticket 358
  /** The card another surface asked for: an unapproved ACP entry opens its form under 추가; an approved one goes straight to its command form. */
  const take = (acp: AcpRow[], name: string) => {
    read.current = true;
    const row = acp.find((x) => x.name === name);
    if (row?.state == null && row?.acp) setForm({ row, id: row.name });
    else if (name) {
      setOpenRow(name);
      if (row?.state === 'approved') setChanging(name); // "Fix command": straight to its form
    }
  };
  const toggle = (id: string) => {
    setChanging('');
    setRemoving('');
    setOpenRow((o) => (o === id ? '' : id));
  };
  const [file, setFile] = useState('');
  const [pathNote, setPathNote] = useState('');
  const [commands, setCommands] = useState<Partial<Record<AccountAgent, CommandView>>>({});
  const readAgents = useCallback(async () => {
    const r = await core.acpAgents();
    setFile(r.file);
    setTerminal(r.terminal);
    setRows(r.acp);
    setTurns(r.turns ?? {});
    setCheckedAt(new Date().toISOString());
    setNow(Date.now());
    return r;
  }, [core]);
  // After the account list: the window runs at most 4 off-loop requests, and the listing runs every agent's --version, so
  // starting both at once starves the sign-in probes (an account then reads "unknown").
  const accountsRead = accounts !== null || error !== '';
  useEffect(() => {
    if (!accountsRead) return;
    // Round 2 (security review): a listing that lands after the page was left starts no probe.
    let cancelled = false;
    readAgents().then(
      (r) => {
        // Accounts probe 11-10: opening the page checks each found agent's "Your own" not known yet or older than a minute.
        if (!cancelled) checkOnOpen(core, r.terminal.filter((a) => a.found).map((a) => a.agent));
        setOpening(false);
        const asked = accountsAsk.row;
        accountsAsk.row = '';
        take(r.acp, asked);
      },
      (e) => (setOpening(false), setError(message(e))),
    );
    const age = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      clearInterval(age);
    };
  }, [accountsRead, readAgents]);
  // Ticket 391: a later ask (the AGENTS event while the page is open) opens its card the same way; before the first read it waits there.
  const read = useRef(false);
  useEffect(() => {
    if (!asked?.name) return;
    if (read.current) take(rows, asked.name);
    else accountsAsk.row = asked.name;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new ask only
  }, [asked]);
  useEffect(() => {
    // Each jump once: Settings keeps its last one while the owner moves between pages.
    if (!focus || focus === jumped.last) return;
    jumped.last = focus;
    const card = CARD_OF[focus.key];
    if (card) (setChanging(''), setRemoving(''), setOpenRow(card));
  }, [focus]);
  // The heads show whether Claude's or Codex's command has arguments (the "인수 있음: 훅 꺼짐" chip).
  useEffect(() => {
    for (const agent of ['claude', 'codex'] as const) core.commandStatus(agent).then((view) => setCommands((c) => ({ ...c, [agent]: view })), () => {});
  }, [core]);
  const [usage, setUsage] = useState<AccountUsage[] | null>(null);
  const [polled, setSessions] = useState<Session[]>([]);
  const sessions = live ?? polled;
  // Ticket 358: a just-started ACP agent reports its models (the session's `model`) after the page read the list; read it
  // again then, or the 모델 section stayed missing until the page was opened again (a WebKit flake of accounts-acp-models).
  const acpReported = sessions.filter((s) => s.kind === 'acp' && (s as WithLog).model).map((s) => s.id).join();
  const reportedRead = useRef(acpReported);
  useEffect(() => {
    if (!accountsRead || acpReported === reportedRead.current) return;
    reportedRead.current = acpReported;
    readAgents().catch(() => {});
  }, [accountsRead, acpReported, readAgents]);
  const busy = useRef(false);
  const snapshot = useCallback(async () => {
    const { sessions } = (await core.request({ op: 'snapshot' })) as { sessions: Session[] };
    setSessions(sessions);
    return sessions;
  }, [core]);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      void snapshot().catch(() => {});
      setAccounts(withOwnChecks((await core.accounts()).accounts));
      setError('');
    } catch (e) {
      setError(rawError(e));
    } finally {
      busy.current = false;
    }
  }, [core, snapshot]);
  // The totals read transcript files, so they have their own request: a slow count never holds the sign-in list.
  const counting = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined);
  const count = useCallback(async (tries = RETRIES) => {
    if (counting.current) return;
    counting.current = true;
    clearTimeout(retry.current);
    try {
      setUsage((await core.accountUsage()).rows);
    } catch {
      // The cells keep their last numbers; the account list above reports a lost core.
      if (tries > 0) retry.current = setTimeout(() => void count(tries - 1), RETRY_MS);
    } finally {
      counting.current = false;
    }
  }, [core]);
  useEffect(() => () => clearTimeout(retry.current), []);
  useEffect(() => {
    void refresh();
    void count();
    const tick = () => document.visibilityState === 'visible' && (void refresh(), void count());
    const timer = setInterval(tick, REFRESH_MS);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [refresh, count]);
  // V2-2a r2: the status command writes into the owner's live config, so "Your own" is probed on the page's opening only
  // when its last check is older than a minute (ownCheck.ts), and on the owner's Check; the core throttles to the same minute.
  const checks = useOwnChecks();
  // Until the opening check starts (it waits for the agents' listing), a state no check answered yet reads "Checking…" too.
  const [opening, setOpening] = useState(true);
  const checking = (agent: AccountAgent) => !!checks[agent]?.running || (opening && !checks[agent]?.done);
  const checked = (agent: AccountAgent) => !!checks[agent]?.done;
  // Every answer the window gets, whichever page asked, is drawn on the "Your own" row here. Merged as it renders (ticket
  // 423 round 2): an effect after the render showed the answer's done state on the old row for a frame ("Couldn't check").
  const drawn = accounts && withOwnChecks(accounts, checks);
  // 506 r3: the check's own error, per agent, for its failed-check note (the page's `error` is any action's).
  const [checkError, setCheckError] = useState<Partial<Record<AccountAgent, string>>>({});
  const check = async (agent: AccountAgent) => {
    setError('');
    setCheckError((m) => ({ ...m, [agent]: '' }));
    try {
      return (await checkOwn(core, agent, true)) ?? undefined;
    } catch (e) {
      const why = rawError(e);
      setError(why);
      setCheckError((m) => ({ ...m, [agent]: why }));
    }
  };
  // Ticket 422 and the logout poll below: work that lands after the page was left stops there.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The header's recheck: the owner's press; it checks "Your own" again even within the minute.
  const recheck = async () => {
    setRechecking(true);
    setError('');
    try {
      const r = await readAgents();
      // Ticket 422: a listing that lands after the page was left starts no check (as the opening check's cancelled flag).
      if (!mounted.current) return;
      await Promise.all(r.terminal.filter((a) => a.found).map((a) => check(a.agent)));
      void refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setRechecking(false);
    }
  };
  const add = async (agent: AccountAgent, name: string) => {
    setError('');
    try {
      const { account, session } = await core.addAccount(agent, name);
      setOpened(t('settings.accounts.loginOpened', { label: account.label, tab: session.label }));
      setAccounts((list) => list && [...list, account]);
      void refresh();
      void watchLogin(session.id, account);
      return true;
    } catch (e) {
      setError(rawError(e));
      return false;
    }
  };
  // Ticket 355: a terminal login that ends unsigned says so on its row. Keeps running after the page closes.
  const watchLogin = async (tab: string, account: Account) => {
    await tabEnded(tab).catch(() => {});
    const now = (await core.accounts().catch(() => null))?.accounts.find((a) => a.agent === account.agent && a.id === account.id);
    if (now?.signed_in === 'yes' || !now) loginEnded.delete(accountKey(account));
    else loginEnded.add(accountKey(account));
    setEnded((n) => n + 1);
    void refresh();
  };

  // Ticket 178 finding 20: one sign-in at a time on this page; a newer start (Retry) ends the older poll.
  // Ticket 378: a live attempt outlives the page (`heldSignIn`); coming back shows the panel again and polls on.
  const [signin, setSigninState] = useState<SignIn | null>(() => heldSignIn.s);
  const setSignin = (s: SignIn | null) => {
    heldSignIn.s = s?.attempt && !s.error && s.state?.phase !== 'failed' ? { agent: s.agent, label: s.label, id: s.id, attempt: s.attempt } : null;
    setSigninState(s);
  };
  const polling = useRef('');
  const poll = async (s: SignIn & { attempt: string }) => {
    const { agent, label, id, attempt } = s;
    polling.current = attempt;
    setSignin(s);
    try {
      while (polling.current === attempt && mounted.current) {
        const { state } = await core.signInState(attempt);
        if (polling.current !== attempt || !mounted.current) return;
        if (state.phase === 'signed_in' || state.phase === 'cancelled') {
          setSignin(null);
          setOpened(state.phase === 'cancelled' ? t('settings.accounts.signInCancelled') : t('settings.accounts.signedInDone', { label: state.account?.label ?? label }));
          void refresh();
          return;
        }
        setSignin({ agent, label, id, attempt, state });
        if (state.phase === 'failed') return void refresh();
        await new Promise((done) => setTimeout(done, SIGNIN_POLL_MS));
      }
    } catch (e) {
      setSignin({ agent, label, id, error: message(e) });
    }
  };
  useEffect(() => {
    const held = heldSignIn.s;
    if (held?.attempt) void poll({ ...held, attempt: held.attempt });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // `id` is the signed-out account the sign-in is for: the core then reuses its folder and creates no account.
  const signIn = async (agent: AccountAgent, label: string, id?: string) => {
    setError('');
    setOpened('');
    if (id) loginEnded.delete(`${agent}:${id}`);
    setSignin({ agent, label, id });
    polling.current = '';
    try {
      const { attempt } = await core.signIn(agent, label, id);
      await poll({ agent, label, id, attempt });
    } catch (e) {
      setSignin({ agent, label, id, error: message(e) });
    }
  };
  const cancelSignIn = (s: SignIn) => {
    if (!s.attempt || s.state?.phase === 'failed') {
      polling.current = '';
      return setSignin(null);
    }
    core.signInCancel(s.attempt).catch((e) => setSignin({ ...s, error: message(e) }));
  };

  const [removal, setRemoval] = useState<Removal | null>(null);
  const step = (a: Account, step: RemoveStep, leftovers = false) => core.request({ op: 'account_remove', agent: a.agent, id: a.id, step, leftovers });
  const askRemove = async (account: Account) => {
    setError('');
    setOpened('');
    try {
      const { sessions } = (await step(account, 'check')) as { sessions: number };
      setRemoval({ account, sessions, phase: 'confirm' });
    } catch (e) {
      setRemoval(null);
      // Offered only when every blocker is the account's own Login or Logout tab: an agent session is never closed here.
      const blocking = blockers(await snapshot().catch(() => []), account);
      if (blocking.length && blocking.every((s) => ownTab(s, account))) setRemoval({ account, sessions: 0, phase: 'blocked', tabs: blocking });
      else setError(message(e));
    } finally {
      void count();
    }
  };
  const move = async (r: Removal, leftovers: boolean) => {
    const out = (await step(r.account, 'move', leftovers)) as { type: string; code?: number | null };
    if (out.type === 'account_leftovers') return setRemoval({ ...r, phase: 'leftovers', code: out.code ?? null });
    setRemoval(null);
    setOpened(t('settings.accounts.removed', { label: r.account.label }));
    setAccounts((list) => list && list.filter((a) => !(a.agent === r.account.agent && a.id === r.account.id)));
    void refresh();
    void count();
  };
  // shortcut: polls the snapshot every 500 ms until the logout tab exits; the session push the window already gets
  // would end the polling if this page subscribed to it. Leaving the page stops the poll (the account stays).
  const logout = async (r: Removal) => {
    setError('');
    try {
      const { session } = (await step(r.account, 'logout')) as { session: Session };
      setRemoval({ ...r, phase: 'logout' });
      setOpened(t('settings.accounts.logoutOpened', { label: r.account.label, tab: session.label }));
      void snapshot().catch(() => {}); // the row lists the logout tab
      for (;;) {
        await new Promise((done) => setTimeout(done, 500));
        if (!mounted.current) return;
        const { sessions } = (await core.request({ op: 'snapshot' })) as { sessions: Session[] };
        if (sessions.find((s) => s.id === session.id)?.state !== 'running') break;
      }
      await move(r, false);
    } catch (e) {
      setRemoval(null);
      setError(message(e));
    }
  };
  // Ticket 178: closes the account's own tabs through the plain Close, then runs the remove again from its first step,
  // which refuses (naming it) any session that started on the account meanwhile.
  const closeAndRemove = async (r: Removal) => {
    setError('');
    try {
      for (const s of r.tabs ?? []) await core.request({ op: 'close', id: s.id });
      const { sessions } = (await step(r.account, 'check')) as { sessions: number };
      if (sessions) setRemoval({ account: r.account, sessions, phase: 'confirm' });
      else await logout({ account: r.account, sessions, phase: 'confirm' });
    } catch (e) {
      setRemoval(null);
      setError(message(e));
    }
  };
  const confirmLeftovers = async (r: Removal) => {
    setError('');
    try {
      await move(r, true);
    } catch (e) {
      setRemoval(null);
      setError(message(e));
    }
  };

  // Ticket 322: the owner's pick for new sessions, in the core's `features`; every new-session path reads it through
  // the account list (NewSession `lastAccount`).
  const pickDefault = async (agent: AccountAgent, id: string) => {
    setError('');
    try {
      await core.request({ op: 'quit_settings', patch: { features: { [`accounts.default.${agent}`]: id } } });
      setAccounts((list) => list && list.map((a) => (a.agent === agent ? { ...a, session_default: a.id === id } : a)));
      window.dispatchEvent(new Event(ACCOUNTS_CHANGED));
    } catch (e) {
      setError(message(e));
    }
  };

  // Ticket 322: sign out without removing, through the agent's own logout. Runs on after the page closes: an exited
  // logout tab left listed would keep agents off the folder, and no row offers a way to close it.
  const [signOut, setSignOut] = useState<{ account: Account; running: boolean } | null>(null);
  const tabEnded = (id: string) => sessionEnded(core, id);
  const runSignOut = async (account: Account) => {
    setError('');
    setSignOut({ account, running: true });
    try {
      const { session } = (await step(account, 'logout')) as { session: Session };
      await tabEnded(session.id);
      await core.request({ op: 'close', id: session.id });
      setOpened(t('accountCards.signedOutDone', { label: accountName(t, account) }));
      if (account.default) await check(account.agent);
      else void refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setSignOut(null);
    }
  };
  // "Your own" signs in only in a terminal (account_signin.rs): its own login in a visible tab, no folder override.
  const ownSignIn = async (account: Account) => {
    setError('');
    try {
      await ownLogin(core, account);
      const after = await check(account.agent);
      if (after?.signed_in === 'yes') loginEnded.delete(accountKey(account));
      else loginEnded.add(accountKey(account));
      setEnded((n) => n + 1);
    } catch (e) {
      setError(message(e));
    }
  };
  const removeEntry = async (r: AcpRow) => {
    setError('');
    try {
      // An empty command removes the name (acp/mod.rs `setup`).
      await core.request({ op: 'acp_agent_add', entry: { name: r.name, command: '', args: [], env: [] } });
      setOpenRow('');
      setRemoving('');
      await readAgents();
    } catch (e) {
      setError(message(e));
    }
  };
  const approved = (label: string) => {
    setForm(null);
    setChanging('');
    setOpened(t('agents.page.approvedNote', { label }));
    void readAgents().catch((e) => setError(message(e)));
  };

  const agentRow = ([agent, name]: [AccountAgent, string]) => {
    const mine = (drawn ?? []).filter((a) => a.agent === agent);
    const found = terminal?.find((x) => x.agent === agent);
    const open = openRow === agent;
    const states = mine.map((a) => shownSigned(sessions, a));
    const ended = mine.find((a) => loginEnded.has(accountKey(a)) && shownSigned(sessions, a) !== 'yes');
    const own = mine.find((a) => a.default);
    const running = mine.reduce((n, a) => n + runningOn(sessions, a), 0);
    const missing = found && !found.found;
    const chip = missing ? (
      <Chip word={t('agents.page.stMissing')} /> // ticket 378: grey, as the mockups; amber stays for signed out and needs approval
    ) : ended ? (
      <Chip word={t('providers.accountFailed', { label: accountName(t, ended) })} tone="bad" />
    ) : states.includes('yes') ? (
      <Chip word={t('settings.accounts.signedIn')} tone="ok" />
    ) : states.length && states.every((s) => s === 'no') ? (
      <Chip word={t('settings.accounts.signedOut')} tone="warn" />
    ) : (
      // Ticket 391 follow-up A: no answer is never "Signed out". Checking while "Your own" is checked, Not checked before.
      <Chip word={t(own?.signed_in === 'unknown' && checking(agent) ? 'agents.page.checking' : own?.signed_in === 'unknown' && !checked(agent) ? 'providers.unchecked' : 'providers.couldNotCheck')} />
    );
    const unknown = !missing && !ended && own?.signed_in === 'unknown' && !states.includes('yes');
    // Ticket 494: a check came back and still knows nothing: say so, why when the request said, and the way on.
    const last = checks[agent];
    const failedCheck = unknown && checked(agent) && !!own && !!last && !agentsOff.includes(agent); // an agent turned off shows nothing more
    const failedWhy = failedCheck && !last.account && checkError[agent] ? t('providers.checkFail.error', { error: checkError[agent] }) : t('providers.checkFail.noAnswer', { name });
    const checkedTime = last ? new Date(last.at).toLocaleTimeString(document.documentElement.lang || undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
    const locked = !!removal || !!signin || !!signOut;
    // With no pick stored, new sessions use "Your own" (NewSession `lastAccount`).
    const picked = mine.find((a) => a.session_default)?.id ?? OWN;
    const pick = mine.find((a) => a.id === picked);
    // Ticket 414 (final.html scene a): "n accounts · n sessions", the session count also at none.
    const counts =
      mine.length > 0
        ? [t(mine.length === 1 ? 'providers.count.accounts.one' : 'providers.count.accounts.other', { n: mine.length }), t(running === 1 ? 'providers.count.sessions.one' : 'providers.count.sessions.other', { n: running })].join(' · ')
        : '';
    const args = (commands[agent]?.approved?.args.length ?? 0) > 0;
    // Q9 ko-J9-1: an open confirm keeps every button `locked`, so it stays on screen when the card folds.
    const sheets = (
      <>
        {removal?.account.agent === agent && <RemoveSheet t={t} removal={removal} onLogout={() => void (removal.phase === 'blocked' ? closeAndRemove(removal) : logout(removal))} onLeftovers={() => void confirmLeftovers(removal)} onCancel={() => setRemoval(null)} />}
        {signOut?.account.agent === agent && <SignOutSheet t={t} account={signOut.account} running={signOut.running} sessions={runningOn(sessions, signOut.account)} onConfirm={() => void runSignOut(signOut.account)} onCancel={() => setSignOut(null)} />}
      </>
    );
    // 연결·로그인: drawn in the open card's first block, or under the head while the card is closed.
    const login = (
      <>
        {failedCheck && !checking(agent) && (
          <div className="prv-exp">
            <div className="prv-fx prv-checkfail" role="note">
              <span className="prv-tx">
                {failedWhy} {t('providers.checkFail.next', { name })}
              </span>
              <small>{t('providers.checkFail.at', { time: checkedTime })}</small>
            </div>
          </div>
        )}
        <div className="prv-upd">
          <UpdateRow t={t} core={core} tool={agent} path={found?.path} onChanged={readAgents} />
        </div>
        {ended && (
          <div className="prv-exp">
            <div className="prv-fx">
              <span className="prv-tx">{t('providers.loginEnded')}</span>
              <button type="button" className="btn p" disabled={locked} onClick={() => void (ended.default ? ownSignIn(ended) : signIn(agent, ended.label, ended.id))}>
                {t(ended.default ? 'providers.loginAgain' : 'providers.signInAgain')}
              </button>
            </div>
          </div>
        )}
        {ended && <FailedActions t={t} core={core} diagnostics={loginDiagnostics(agent, found)} docs={DOCS[agent]} onRecheck={async () => void (ended.default ? await check(agent) : await refresh())} />}
        {signin?.agent === agent && (
          <div className="prv-exp">
            <SignInPanel
              t={t}
              name={name}
              signin={signin}
              onCode={(code) => core.signInCode(signin.attempt!, code).then(() => {}, (e) => setSignin({ ...signin, error: message(e) }))}
              onCancel={() => cancelSignIn(signin)}
              onRetry={() => void signIn(agent, signin.label, signin.id)}
              // The terminal login adds an account by name: for an existing account it would make a second one.
              onTerminal={signin.id ? undefined : () => {
                setSignin(null);
                void add(agent, signin.label);
              }}
            />
          </div>
        )}
      </>
    );
    return (
      <div key={agent} className="acct-agent" data-agent={agent}>
        <ProviderHead
          id={agent}
          label={name}
          mark={<Mark name={agent} />}
          name={name}
          sub={
            <>
              <span className="prv-ver">{versionOf(found?.version)}</span>
              <UpdateMark t={t} core={core} tool={agent} path={found?.path} inline />
            </>
          }
          mid={
            <>
              {pick && <span className="prv-acc">{accountName(t, pick)}</span>}
              {pick?.signed_in === 'yes' && pick.plan && <span>{pick.plan[0].toUpperCase() + pick.plan.slice(1)}</span>}
              {counts && <span>{counts}</span>}
              {args && (
                <button type="button" className="pchip warn prv-args" title={t('providersPage.argsChipAria', { name })} onClick={onHooks}>
                  {t('providersPage.argsChip')}
                </button>
              )}
              <span className="prv-act">
                {missing && (
                  <button type="button" className="btn" onClick={() => void openExternal(INSTALL[agent])}>
                    {t('providers.install')}
                  </button>
                )}
                {unknown && (
                  <button className="btn" aria-label={t('settings.accounts.checkOwn', { name, label: own ? accountName(t, own) : t('usage.own') })} disabled={checking(agent)} aria-busy={checking(agent)} onClick={() => void check(agent)}>
                    {t(checking(agent) ? 'agents.page.checking' : 'providers.check')}
                  </button>
                )}
                {/* Ticket 494: the signed-out row's own Sign in (a terminal login), beside Check once a check failed. */}
                {failedCheck && own && (
                  <button className="btn" aria-label={t('providersManage.signInAria', { name: `${name} · ${accountName(t, own)}` })} disabled={locked} onClick={() => void ownSignIn(own)}>
                    {t('settings.accounts.signIn')}
                  </button>
                )}
              </span>
            </>
          }
          chips={
            agentsOff.includes(agent) ? (
              <span className="prv-off">
                <Chip word={t('providersManage.off')} />
              </span>
            ) : (
              chip
            )
          }
          toggle={<UseSwitch t={t} agent={agent} name={name} onOff={() => open && toggle(agent)} />}
          open={open}
          onToggle={() => toggle(agent)}
        />
        {!open && (
          <div className="prv-closed">
            {login}
            {sheets}
          </div>
        )}
        {open && accounts && (
          <div className="prv-exp prv-body">
            <Block title={t('providersPage.login')}>
              {login}
              <span className="prv-calm">{t('providersPage.calm')}</span>
            </Block>
            <Block title={t('providers.accounts')} note={t('providersPage.n', { n: mine.length })}>
              {sheets}
              <AccountsSection
                t={t}
                agent={agent}
                name={name}
                accounts={mine}
                sessions={sessions}
                usage={usage}
                picked={picked}
                checked={checked(agent)}
                checking={checking(agent)}
                rowChecks={unknown}
                signingIn={!!signin}
                locked={locked}
                on={{
                  check: () => void check(agent),
                  reread: () => void refresh(),
                  signIn: (a) => void (a.default ? ownSignIn(a) : signIn(agent, a.label, a.id)),
                  signOut: (a) => setSignOut({ account: a, running: false }),
                  rename: (a, label) => renameAccount(core, a, label).then(() => (setAccounts((list) => list && list.map((x) => (x.agent === a.agent && x.id === a.id ? { ...x, label } : x))), void snapshot().catch(() => {}))),
                  remove: (a) => void askRemove(a),
                  viewUsage: (a) => {
                    usageAsk.account = `${agent}:${a.id}`;
                    onViewUsage(agent, a.id);
                  },
                  addBrowser: (n) => signIn(agent, n),
                  addTerminal: (n) => add(agent, n),
                }}
              />
              {agent === 'codex' && <CodexResetSettings t={t} core={core} />}
            </Block>
            <ModelSection t={t} kind={agent} />
            <Block title={t('agents.new.title')} note={t('providersPage.emptyIsDefault')}>
              <DefaultAccountRow t={t} name={name} accounts={mine} picked={picked} onPick={(id) => void pickDefault(agent, id)} />
              <PermissionRow t={t} core={core} agent={agent} name={name} />
              <ModelDefaults t={t} core={core} kind={agent} name={name} known={projects} />
            </Block>
            <Block title={t('providersPage.advanced')}>{found && <AgentCommandRow t={t} core={core} agent={agent} found={found.path ?? null} onView={(view) => setCommands((c) => ({ ...c, [agent]: view }))} />}</Block>
          </div>
        )}
      </div>
    );
  };

  const entryRow = (r: AcpRow) => {
    const open = openRow === r.name;
    const review = r.state !== 'approved';
    const missing = review ? [] : missingOf(r.env, r.env_set);
    const absent = !review && !r.found_path;
    const bad = !!r.refused || absent || missing.length > 0;
    // A test message needs an approved ACP entry that is installed and whole; a terminal-only CLI has none.
    const tryable = r.acp && !review && !bad;
    const runner = r.source === 'service' ? rows.find((x) => x.name === r.command.split('/').pop())?.label : undefined;
    const version = versionOf(r.version);
    const login = (
      <>
        <div className="prv-upd">
          <UpdateRow t={t} core={core} tool={r.name} path={r.found_path} onChanged={readAgents} />
        </div>
        {r.refused && (
          <div className="prv-exp">
            <div className="prv-fx">
              <span className="prv-tx">{r.refused}</span>
            </div>
          </div>
        )}
        {missing.length > 0 && (
          <div className="prv-exp">
            <MissingVars t={t} names={missing} primary />
          </div>
        )}
        {bad && <FailedActions t={t} core={core} diagnostics={r.diagnostics ?? ''} docs={r.docs_url} onRecheck={readAgents} />}
      </>
    );
    // Before approval, while changing, and after a refusal the 고급 block is the form; there is no sign-in or model list then.
    const form = review || changing === r.name || !!r.refused;
    return (
      <div key={r.name} className="acct-agent" data-agent={r.name}>
        <ProviderHead
          id={r.name}
          label={r.label}
          mark={<Mark name={r.name} service={r.source === 'service'} />}
          name={r.label}
          sub={
            <>
              <span className="prv-sx">
                {r.name} · ACP{version && ' · '}
              </span>
              <span className="prv-ver">{version}</span>
              <UpdateMark t={t} core={core} tool={r.name} path={r.found_path} inline />
            </>
          }
          mid={
            absent ? (
              <>
                <span>
                  <code className="mono">{r.command}</code> {t('providers.missing')}
                </span>
                {r.install_url && (
                  <button type="button" className="btn" onClick={() => void openExternal(r.install_url!)}>
                    {t('providers.install')}
                  </button>
                )}
                <button type="button" className="btn prv-ghost" onClick={() => (setOpenRow(r.name), setChanging(r.name))}>
                  {t('providers.change')}
                </button>
              </>
            ) : (
              (runner ?? (
                <>
                  <code className="mono prv-cmd" title={joinWords([r.command, ...r.args])}>{joinWords([r.command, ...r.args])}</code>
                  {r.env.length > 0 && <span className="mono">{r.env.join(', ')}</span>}
                </>
              ))
            )
          }
          chips={
            <>
              {absent ? <Chip word={t('agents.page.stMissing')} tone="bad" /> : bad ? <Chip word={t('providers.failed')} tone="bad" /> : review ? <Chip word={t('providers.needsApproval')} tone="warn" /> : <Chip word={t('providers.approved')} />}
              <AcpLoginChip t={t} name={r.name} bad={bad} />
              {tryable && <TryChip t={t} turn={turns[r.name]} version={r.version} />}
            </>
          }
          open={open}
          onToggle={() => toggle(r.name)}
        />
        {!open && <div className="prv-closed">{login}</div>}
        {open && (
          <div className="prv-exp prv-body">
            <Block title={t('providersPage.login')}>
              {login}
              {!form && <AcpLogin t={t} core={core} row={r} />}
              {!form && tryable && <AcpTry t={t} core={core} name={r.name} label={r.label} turn={turns[r.name]} onDone={() => void readAgents().catch(() => {})} />}
              <span className="prv-calm">{t('providersPage.calm')}</span>
            </Block>
            {!form && <AcpModelSection t={t} row={r} />}
            <Block title={t('providersPage.advanced')}>
              {form ? (
                <ProviderForm key={`${r.name}:${r.hash}`} t={t} core={core} row={r} taken={[]} onClose={() => (setChanging(''), review && setOpenRow(''))} onApproved={() => approved(r.label)} />
              ) : (
                <CommandSection t={t} row={r} removing={removing === r.name} onRemove={() => (removing === r.name ? void removeEntry(r) : setRemoving(r.name))} onChange={() => setChanging(r.name)} />
              )}
            </Block>
          </div>
        )}
      </div>
    );
  };

  const entries = rows.filter((r) => r.state != null);
  // Accounts probe 11-10: a "Your own" signed out by the page's opening check changes its word, not the page: "Nothing
  // connected" still follows only the owner's Check and the added accounts, as before that check existed.
  const counted = (a: Account) => !a.default || !!checks[a.agent]?.forced;
  // Ticket 991 C10: the agents' card shows its rows together, once the listing (which knows every row) is in; before it,
  // Claude and Codex alone, then 7 more popping in a second later, read as a list that was still being built.
  const listed = !opening;
  const empty = !!accounts && listed && !entries.length && AGENTS.every(([agent]) => {
    if (agentsOff.includes(agent)) return false; // the empty rows have no switch to turn it back on
    const mine = (drawn ?? []).filter((a) => a.agent === agent);
    return !mine.length || mine.every((a) => counted(a) && shownSigned(sessions, a) === 'no');
  });
  // No one connected: a login is the one thing to do, so each agent gets only that (or its install).
  const emptyRow = ([agent, name]: [AccountAgent, string]) => {
    const found = terminal?.find((x) => x.agent === agent);
    const own = drawn?.find((a) => a.agent === agent && a.default);
    const missing = found && !found.found;
    return (
      <div key={agent} className="prv-row nost" data-row={agent}>
        <Mark name={agent} />
        <span className="prv-name">{name}</span>
        <span className="prv-ver">{versionOf(found?.version)}</span>
        <span className="prv-meta" />
        <span className="prv-act">
          {missing ? (
            <button type="button" className="btn" onClick={() => void openExternal(INSTALL[agent])}>
              {t('providers.install')}
            </button>
          ) : (
            own && (
              <button type="button" className="btn" disabled={!!signin} onClick={() => void ownSignIn(own)}>
                {t('providers.loginTerminal')}
              </button>
            )
          )}
        </span>
      </div>
    );
  };

  const tile = (id: string) => {
    const unconfirmed = UNCONFIRMED.find((u) => u.name === id);
    const r = rows.find((x) => x.name === id);
    const name = r?.label ?? unconfirmed?.label ?? id;
    const label = <span className="prv-tname" title={name}>{name}</span>;
    const service = KEY_TILES.includes(id);
    const on = form?.id === id;
    const pick = () => setForm(on ? null : { row: r ?? null, start: unconfirmed && { name: unconfirmed.name, label: unconfirmed.label }, id });
    if (r?.state != null)
      return (
        <div key={id} className="prv-tile done" data-tile={id}>
          <Mark name={id} service={service} />
          {label}
          <span className="prv-st">{CHECK_MARK}</span>
        </div>
      );
    // Aider and the like run in a terminal: there is no ACP form for them.
    if (r && !r.acp && r.found_path)
      return (
        <div key={id} className="prv-tile" data-tile={id}>
          <Mark name={id} />
          {label}
          <span className="prv-st">{t('providers.terminalOnly')}</span>
        </div>
      );
    const install = !service && (r ? !r.found_path : unconfirmed?.url);
    const url = r?.install_url ?? unconfirmed?.url;
    return (
      <button key={id} type="button" className={`prv-tile go${on ? ' on' : ''}`} data-tile={id} aria-pressed={on} onClick={() => {
        if (install && url) void openExternal(url);
        if (!r || r.found_path || service) pick();
      }}>
        <Mark name={id} service={service} />
        {label}
        <span className="prv-st">
          {install ? (
            <>
              {t('providers.install')}
              {EXT_MARK}
            </>
          ) : !service && r ? (
            t('providers.installed')
          ) : (
            t('providers.setUp') // vc-4 (look 1117): a tile set up by hand (an API key, a tool with no install page) says so
          )}
        </span>
      </button>
    );
  };
  // Look 1117 v10 C-N3: at a 900 pt window three columns cut the names ("Gemini…", "OpenC…") and wrapped "Set up"; a tile
  // keeps about 200 px, so a narrow page takes fewer columns (at most `n`, the gap is the grid's 8 px).
  const tiles = (ids: string[], n = ids.length === 4 ? 4 : 3) => (
    <div className="prv-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(max(200px, calc((100% - ${n - 1} * var(--sp-8)) / ${n})), 1fr))` }}>
      {ids.map((id) => <TileSlot key={id} t={t} id={id} row={rows.find((r) => r.name === id)}>{tile(id)}</TileSlot>)}
    </div>
  );

  // agents.toml (from the Agents page): Finder shows it in the app; the path line under the lede is always there to copy.
  const openFile = () => {
    // Ticket 354: before the first agent is added the file is not written, and the click showed nothing.
    if (inApp() && file) void reveal(dirOf(file), file.split('/').pop()!).catch(() => setPathNote(t('settingsRef.noFile')));
  };
  const addAt = useRef<HTMLDivElement>(null);
  return (
    <section id="s-accounts" aria-labelledby="h-accounts" className="accounts ssec">
      <h2 id="h-accounts" className="sr">
        {t('settings.page.providers')}
      </h2>
      {/* Settings kit head: the title line holds the page's one action. What belongs to a section sits on that section's
          heading (Check again on Connected), and the agent list file is the page's last row. */}
      <PageSummary parts={accounts && listed ? [[t('summary.agents'), AGENTS.filter(([agent]) => !agentsOff.includes(agent)).length + entries.length], [t('summary.accounts'), accounts.length]] : []} />
      <PageActions>
        <button className="btn withicon" onClick={() => addAt.current?.scrollIntoView({ block: 'start' })}>
          <Icon name="plus" size={14} />
          {t('providers.addAgent')}
        </button>
      </PageActions>
      <ErrorLine t={t} error={error} />
      {!accounts && !error ? (
        <p className="lede" role="status">
          {t('settings.accounts.reading')}
        </p>
      ) : (
        opened && (
          <p className="lede" role="status">
            {opened}
          </p>
        )
      )}
      <div className="prv-sec">
        <div className="prv-head">
          <h3>
            {t('agents.new.title')} <span className="prv-dim">{t('providersPage.forAll')}</span>
          </h3>
        </div>
        <div className="scard prv-top">
          <DefaultAgentRow t={t} acp={rows} />
        </div>
      </div>
      <div className="prv-sec">
        <div className="prv-head">
          <h3>{t(empty ? 'providers.none' : 'providers.connected')}</h3>
          <span className="prv-pr">
            <UpdateAll t={t} core={core} shown={[...(terminal ?? []).map((x): [string, string | null | undefined] => [x.agent, x.path]), ...entries.map((r): [string, string | null] => [r.name, r.found_path])]} />
            <span role="status" data-field="agents-checked">
              {checkedAt ? t('providers.checked', { age: ageText(checkedAt, now, t) }) : ''}
            </span>
            <button type="button" className="btn withicon prv-ghost flush" aria-label={t('agents.page.recheck')} disabled={rechecking} aria-busy={rechecking} onClick={() => void recheck()}>
              <RefreshIcon />
              {t('agents.page.recheck')}
            </button>
          </span>
        </div>
        <div className="scard prv-card">
          {accounts && listed ? AGENTS.map(empty ? emptyRow : agentRow) : <p className="prv-closed" role="status">{t('agents.page.checking')}</p>}
          {listed && entries.map(entryRow)}
        </div>
      </div>
      <div className="prv-sec" ref={addAt}>
        <div className="prv-head">
          <h3>{t('providers.addAgent')}</h3>
          <button type="button" className="btn prv-ghost flush" aria-pressed={form?.id === 'custom'} onClick={() => setForm(form?.id === 'custom' ? null : { row: null, id: 'custom' })}>
            <Icon name="plus" size={14} />
            {t('providers.custom')}
          </button>
        </div>
        <div className="scard prv-card">
          <div className="prv-pick">
            <h6>{t('providers.groupAgents')}</h6>
            {tiles(AGENT_TILES.filter((id) => rows.some((r) => r.name === id) || UNCONFIRMED.some((u) => u.name === id)))}
          </div>
          <div className="prv-pick">
            <h6>{t('providers.groupKeys')}</h6>
            {tiles(KEY_TILES.filter((id) => rows.some((r) => r.name === id)))}
          </div>
          {form && <ProviderForm key={form.id} t={t} core={core} row={form.row} start={form.start} taken={entries.map((r) => r.name)} onClose={() => setForm(null)} onApproved={(view) => approved(form.row?.label ?? form.start?.label ?? view.name)} />}
        </div>
      </div>
      {file && (
        <div className="prv-sec">
          <div className="prv-head">
            <h3>{t('settingsRef.files')}</h3>
          </div>
          <div className="scard">
            <Row
              setting="agentsFile"
              label={t('settingsRef.agentsFile')}
              desc={
                <span data-field="agents-toml-path">
                  <code className="mono prv-file" title={file}>
                    <bdi>{file}</bdi>
                  </code>
                  {pathNote && <span role="status"> · {pathNote}</span>}
                </span>
              }
              control={
                <>
                  <button className="btn" aria-label={t('settingsRef.copyPath')} onClick={() => void copyText(file).then((ok) => setPathNote(t(ok ? 'agents.page.copied' : 'about.copyFailed')))}>
                    {t('agents.page.copy')}
                  </button>
                  <button className="btn withicon" aria-label={t('agents.page.openFile')} onClick={openFile}>
                    <StrokeIcon name="ext" size={14} />
                    {t('settingsRef.open')}
                  </button>
                </>
              }
            />
          </div>
        </div>
      )}
    </section>
  );
}

/** The remove confirm: names what goes (V2-6, not undoable), then the logout tab's progress, then its leftovers. */
function RemoveSheet({ t, removal, onLogout, onLeftovers, onCancel }: { t: T; removal: Removal; onLogout: () => void; onLeftovers: () => void; onCancel: () => void }) {
  const { account, sessions, phase, code, tabs } = removal;
  // Focus starts on the safe choice: Enter never removes by accident.
  const go = useRef<HTMLButtonElement>(null);
  // While logout runs both buttons are disabled, so focus moves to the progress line instead of falling to the page.
  const wait = useRef<HTMLParagraphElement>(null);
  useEffect(() => (phase === 'logout' ? wait : go).current?.focus(), [phase]);
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault(); // also during logout: the sheet ignores Esc then, but Settings must not close under it
      if (phase !== 'logout') onCancel();
    }
  };
  return (
    <div className="acct-add acct-remove" role="group" aria-label={t('settings.accounts.removeGroup', { label: account.label })} onKeyDown={keys}>
      {phase === 'leftovers' ? (
        <>
          <p>
            {t('settings.accounts.logout')} {code == null ? t('settings.accounts.didNotFinish') : t('settings.accounts.exited', { code })}. {account.agent === 'claude' ? t('settings.accounts.keychain') : t('settings.accounts.someLeft')}
            {t('settings.accounts.removeAnyway', { label: account.label })}
          </p>
          <button className="btn danger" onClick={onLeftovers}>
            {t('settings.accounts.removeAnywayBtn')}
          </button>
          <button ref={go} className="btn" onClick={onCancel}>
            {t('settings.accounts.keep')}
          </button>
        </>
      ) : phase === 'blocked' ? (
        <>
          <p>{t('settings.accounts.inUseByTab', { label: account.label, tabs: (tabs ?? []).map((s) => quoted(s.label)).join(', ') })}</p>
          <button className="btn danger" onClick={onLogout}>
            {t('settings.accounts.closeRemove')}
          </button>
          <button ref={go} className="btn" onClick={onCancel}>
            {t('settings.accounts.cancel')}
          </button>
        </>
      ) : (
        <>
          <p>
            {t('settings.accounts.confirm', { label: account.label, loss: lossLine(t, sessions) })}
          </p>
          {phase === 'logout' && (
            <p ref={wait} tabIndex={-1} className="cap">
              {t('settings.accounts.loggingOut')}
            </p>
          )}
          <button className="btn danger" disabled={phase === 'logout'} aria-busy={phase === 'logout'} onClick={onLogout}>
            {phase === 'logout' ? t('settings.accounts.loggingOutBtn') : t('settings.accounts.logoutRemove')}
          </button>
          <button ref={go} className="btn" disabled={phase === 'logout'} onClick={onCancel}>
            {t('settings.accounts.cancel')}
          </button>
        </>
      )}
    </div>
  );
}

/** Ticket 322: confirms a sign-out; focus starts on Cancel, and the sheet stays while the logout tab runs. */
function SignOutSheet({ t, account, running, sessions, onConfirm, onCancel }: { t: T; account: Account; running: boolean; sessions: number; onConfirm: () => void; onCancel: () => void }) {
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => stay.current?.focus(), []);
  const label = accountName(t, account);
  return (
    <div
      className="acct-add acct-remove"
      role="group"
      aria-label={t('accountCards.signOutGroup', { label })}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault(); // Settings must not close under it
        if (!running) onCancel();
      }}
    >
      <p>
        {t('accountCards.signOutConfirm', { label })}
        {sessions > 0 && ` ${t(sessions === 1 ? 'accountCards.signOutLive.one' : 'accountCards.signOutLive.other', { n: sessions })}`}
      </p>
      <button className="btn p" disabled={running} aria-busy={running} onClick={onConfirm}>
        {running ? t('accountCards.signingOut') : t('accountCards.signOut')}
      </button>
      <button ref={stay} className="btn" disabled={running} onClick={onCancel}>
        {t('settings.accounts.cancel')}
      </button>
    </div>
  );
}

/** Ticket 178 finding 20: the sign-in in progress: the browser opening, Copy link, Paste code (Claude), Cancel; on a
 * failure one line, Retry and the terminal login. The link is only ever the one the core let through its allowlist. */
function SignInPanel({ t, name, signin, onCode, onCancel, onRetry, onTerminal }: { t: T; name: string; signin: SignIn; onCode: (code: string) => Promise<void>; onCancel: () => void; onRetry: () => void; onTerminal?: () => void }) {
  const { label, state, error } = signin;
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState<boolean | null>(null);
  // Ticket 378: focus starts in the panel (as RemoveSheet), so Esc cancels right away and after coming back to the page.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  const failed = !!error || state?.phase === 'failed';
  const line = error ?? (state?.reason ? t(FAIL[state.reason], { name, label, code: state.code ?? '' }) : '');
  const link = state?.link ?? null;
  // The code leaves the field (and the page) as it is sent; it is never kept here.
  const submit = () => {
    const sent = code.trim();
    setCode('');
    if (sent) void onCode(sent);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <div ref={box} tabIndex={-1} className="acct-add acct-remove" role="group" aria-label={t('settings.accounts.signInGroup', { label })} onKeyDown={keys}>
      {failed ? (
        <>
          {/* Ticket 480: a refused sign-in step reads plainly, the core's words under Details. */}
          {error ? <ErrorLine t={t} error={error} className="" /> : <p role="alert">{line}</p>}
          <button className="btn p" onClick={onRetry}>
            {t('settings.accounts.retry')}
          </button>
          {onTerminal && (
            <button className="btn" onClick={onTerminal}>
              {t('settings.accounts.signInTerminal')}
            </button>
          )}
          <button className="btn" onClick={onCancel}>
            {t('settings.accounts.cancel')}
          </button>
        </>
      ) : (
        <>
          <p role="status">{link ? t('settings.accounts.browserOpened', { name }) : t('settings.accounts.opening')}</p>
          <button
            className="btn"
            disabled={!link}
            onClick={() => {
              if (!link) return;
              void copyText(link).then(setCopied);
            }}
          >
            {t(copied === null ? 'settings.accounts.copyLink' : copied ? 'settings.accounts.linkCopied' : 'about.copyFailed')}
          </button>
          {state?.paste && (
            <>
              <label>
                {t('settings.accounts.pasteCode')}{' '}
                <input {...PLAIN}
                  value={code}
                  disabled={!link}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <button className="btn p" disabled={!link || !code.trim()} onClick={submit}>
                {t('settings.accounts.submitCode')}
              </button>
            </>
          )}
          <button className="btn" onClick={onCancel}>
            {t('settings.accounts.cancel')}
          </button>
        </>
      )}
    </div>
  );
}
