// Ticket 355: the sections of an open row on Settings > Accounts, one component each (계정, 경로, 명령, 모델), so a later lane
// adds to a section without rewriting AccountsPage. Only controls with a working core operation are here. Claude's and Codex's
// path and arguments are `command.tsx`; an account's rename is `rename.tsx`.
import { PLAIN } from '../../plainText';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { accountName, type Account, type AccountAgent, type AccountUsage, type AcpRow, type CoreClient, type UsageLimit } from '../../api';
import type { Key } from '../../i18n';
import { Icon } from '../../icons/Icon';
import { openSession } from '../../tree';
import { agentState, type Session } from '../../types';
import { AGENTS_OFF, cleanCustomModels, CUSTOM_MODELS, legacyChoice, MODEL_NAME, modelChoices, MODELS_OFF, NEW_DEFAULTS, validName, withoutDefaultModel, type AgentChoice, type AgentCli, type CustomModel } from '../agents/newDefaults';
import { joinWords } from '../agents/words';
import { Reset, Select, Switch, Why, WhyFix } from '../shell/Row';
import { currentFeature, useCoreFeature, useFeatureSetting } from '../useFeatureSetting';
import { Chip, Ln, type T } from './providers';
import { RenameRow } from './rename';
import { Block } from './head';
import { ErrorLine } from '../../errors';

const SIGNED: Record<Account['signed_in'], Key> = {
  yes: 'settings.accounts.signedIn',
  no: 'settings.accounts.signedOut',
  unknown: 'settings.accounts.unknown',
};
export { validName };
const inside = (p: string, folder: string) => p === folder || p.startsWith(`${folder}/`);
/** The sessions the core's remove refuses on (sessions.rs `account_users`): live, or not closed and resumable by kind
 * (`resumable`: an agent, not a side chat, with a conversation id, whether it shows as exited or resumable); on the
 * account, or live in its folder. */
export const blockers = (sessions: Session[], a: Account) =>
  sessions.filter((s) => {
    const live = s.state === 'running';
    const resumable = s.state !== 'closed' && s.kind !== 'shell' && !s.side_chat && !!s.agent_session_id;
    return (s.config_dir === a.folder || (live && (inside(s.cwd, a.folder) || inside(s.project, a.folder)))) && (live || resumable);
  });
/** A session name for a sentence: quoted, at most 48 characters (React renders it as text). */
export const quoted = (name: string) => `“${[...name].length > 48 ? `${[...name].slice(0, 47).join('')}…` : name}”`;
/** Live agents on this account; "Your own" is the sessions fixed to no account folder. */
export const runningOn = (sessions: Session[], a: Account) => sessions.filter((s) => s.kind === a.agent && s.state === 'running' && (a.default ? !s.config_dir : s.config_dir === a.folder)).length;
/** Ticket 391 follow-up A, round 2: proof of a sign-in is an agent on the account that is still running (`agentState`: not
 *  one that quit and left its shell) and has completed a turn (`completion_seq`, turns completed, as chat/held.ts reads it).
 *  `agentState` cannot tell an agent at its login prompt from one at work, and the core sets `problem` only once a session
 *  ended, so a turn is the proof: an agent at its login prompt has none. */
const provesSignedIn = (s: Session, a: Account) =>
  s.kind === a.agent && agentState(s) === 'running' && ((s as Session & { completion_seq?: number }).completion_seq ?? 0) > 0 && (a.default ? !s.config_dir : s.config_dir === a.folder);
/** The state the page shows: such an agent outweighs an older status run; `unknown` is never shown as signed out. */
export const shownSigned = (sessions: Session[], a: Account): Account['signed_in'] => (sessions.some((s) => provesSignedIn(s, a)) ? 'yes' : a.signed_in);
/** The word for `state`: "Checking…" while a "Your own" check runs, "Not checked" for one no one checked yet, "Couldn't check"
 *  for a probe that gave no answer. */
export const signedWord = (state: Account['signed_in'], unchecked: boolean, checking = false): Key =>
  state === 'unknown' ? (checking ? 'agents.page.checking' : unchecked ? 'providers.unchecked' : 'providers.couldNotCheck') : SIGNED[state];
/** Ticket 1041 (N085, N088): one near-limit rule with the status bar's usage block: yellow from 80 % used, red at 100 %. */
export const pillTone = (limit: UsageLimit) => (limit.left_pct <= 0 ? 'full' : limit.left_pct <= 20 ? 'warn' : undefined);
/** The chip's thin used-share bar (ticket 1041 N085), as the status bar block draws it. */
const usedBar = (limit: UsageLimit) => ({ '--used': `${Math.max(0, Math.min(100, 100 - limit.left_pct))}%` }) as CSSProperties;
// ponytail: a module slot, because SettingsView's page map hands Usage only t and core; pass PageContext.focus to drop it.
/** Ticket 324: the account "View usage" asked for; the Usage page takes it when it opens. */
export const usageAsk = { account: '' };
/** A limit's share used and its reset time, on Accounts' chips and the account switch (ticket 1031: "used", as Usage's bars say it). */
export function limitUsed(t: T, limit: UsageLimit) {
  const time = new Date(limit.resets_at * 1000).toLocaleString(document.documentElement.lang || undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return t('usage.v4.used', { pct: 100 - limit.left_pct, time });
}

export type AccountActions = {
  /** Probes "Your own" (the owner's press only). */
  check: () => void;
  /** Reads the account list again; an added account is probed on every list. */
  reread: () => void;
  signIn: (a: Account) => void;
  signOut: (a: Account) => void;
  /** Ticket 358: refuses (throws) with the core's reason; the row stays open to say it. */
  rename: (a: Account, label: string) => Promise<void>;
  remove: (a: Account) => void;
  viewUsage: (a: Account) => void;
  addBrowser: (name: string) => Promise<void>;
  /** false: refused; the form stays open with the typed name (Q9 pin-J20-1). A browser sign-in's failure shows in its panel. */
  addTerminal: (name: string) => Promise<boolean>;
};

/** 계정: the agent's accounts and the new-account row. `picked` is the default for new sessions (ticket 391: chosen in the card's
 *  새 세션 기본값, `DefaultAccountRow`). */
export function AccountsSection({ t, agent, name, accounts, sessions, usage, picked, checked, checking, rowChecks, signingIn, locked, on }: { t: T; agent: AccountAgent; name: string; accounts: Account[]; sessions: Session[]; usage: AccountUsage[] | null; picked: string; checked: boolean; checking: boolean; rowChecks: boolean; signingIn: boolean; locked: boolean; on: AccountActions }) {
  const [renaming, setRenaming] = useState('');
  return (
    <>
      <span className="accts">
        {accounts.map((a) => {
          if (a.id === renaming) return <RenameRow key={a.id} t={t} account={a} taken={accounts.filter((x) => !x.default && x.id !== a.id).map((x) => x.label)} onSave={on.rename} onClose={() => setRenaming('')} />;
          const signed = shownSigned(sessions, a);
          const row = signed === 'no' || (!a.default && signed === 'unknown') ? undefined : usage?.find((u) => u.agent === a.agent && u.id === a.id);
          const shown = accountName(t, a);
          const here = runningOn(sessions, a);
          const canRemove = !a.default && !a.session_default;
          return (
            <div key={a.id} className="acct-card" data-account={a.id} data-agent-name={name}>
              <span className="acct-main">
                <span className="acct-name" title={a.folder}>
                  {shown}
                </span>
                {/* Ticket 450: Rename is on the row, next to the name it changes (owner 11-16: the agent's own account too). */}
                <button type="button" className="acct-pencil" aria-label={t('providersManage.renameAria', { name, label: shown })} data-tip={t('providersManage.rename')} disabled={locked} onClick={() => setRenaming(a.id)}>
                  <Icon name="pencil" size={12} />
                </button>
                {/* Real-app look 2026-11-16: an account whose name is already "Default" needs no chip that says the same word beside it. */}
                {a.id === picked && shown.toLowerCase() !== t('providers.default').toLowerCase() && <Chip word={t('providers.default')} tone="plain" />}
                {a.id === picked && (a.fell_back || (!a.default && signed === 'no')) &&<small>{t('providersManage.fellBack')}</small>}
                {/* The row's chip says it for the agent; per account it is drawn only when it is not signed in. */}
                <span className={`pchip acct-signed${signed === 'yes' ? ' sr' : ''}`} data-signed={signed}>
                  {t(signedWord(signed, a.default && !checked, a.default && checking))}
                </span>
                {here > 0 && <small>{t(here === 1 ? 'providers.count.sessions.one' : 'providers.count.sessions.other', { n: here })}</small>}
                {signed === 'yes' && a.plan && <small>{t('accountCards.plan', { name: a.plan[0].toUpperCase() + a.plan.slice(1) })}</small>}
                {row?.session && <span className="acct-chip lim" data-tone={pillTone(row.session)} style={usedBar(row.session)}>{t('usage.v4.session')} · {limitUsed(t, row.session)}</span>}
                {row?.weekly && <span className="acct-chip lim" data-tone={pillTone(row.weekly)} style={usedBar(row.weekly)}>{t('usage.v4.weekly')} · {limitUsed(t, row.weekly)}</span>}
                {/* V2-2c: the agent's own limit line, read from a session's screen; never a switch suggestion. */}
                {row?.limit_resets && <span className="acct-chip">{t('settings.accounts.limit', { when: row.limit_resets })}</span>}
                {!a.default &&
                  blockers(sessions, a).map((s) => (
                    <button key={s.id} type="button" className="acct-badge acct-open" data-tab-session={s.id} title={s.label || s.id} onClick={() => openSession(s.id)}>
                      {t(agentState(s) === 'running' ? 'settings.accounts.tabOpen' : 'settings.accounts.tabResumable', { tab: quoted(s.label || s.id) })}
                    </button>
                  ))}
              </span>
              <span className="acct-acts">
                <button type="button" className="acct-link" aria-label={t('settings.accounts.viewUsageAria', { name: `${name} · ${shown}` })} onClick={() => on.viewUsage(a)}>
                  {t('settings.accounts.viewUsage')}
                </button>
                {/* The row carries Check while its status is unknown; here only when the row's chip says otherwise. */}
                {a.default && signed !== 'yes' && !rowChecks && (
                  <button className="btn acct-slot" aria-label={t('settings.accounts.checkOwn', { name, label: shown })} disabled={checking} aria-busy={checking} onClick={on.check}>
                    {t('settings.accounts.check')}
                  </button>
                )}
                {signed === 'no' && (
                  <button className="btn acct-slot" aria-label={t('settings.accounts.signInGroup', { label: shown })} disabled={locked} onClick={() => on.signIn(a)}>
                    {t('settings.accounts.signIn')}
                  </button>
                )}
                {!a.default && signed === 'unknown' && (
                  <button className="btn acct-slot" aria-label={t('accountCards.checkAgainAria', { label: shown })} disabled={locked} onClick={on.reread}>
                    {t('accountCards.checkAgain')}
                  </button>
                )}
                {/* Only what works today; drawn only when it holds something. Sign in or Sign out by state, never both (owner 11-09). */}
                {(signed !== 'unknown' || canRemove) && (
                  <details className="acct-more">
                    <summary aria-label={t('providers.more', { label: shown })}>⋯</summary>
                    <div className="acct-menu" onClick={(e) => e.currentTarget.closest('details')?.removeAttribute('open')}>
                      {signed === 'no' && (
                        <button className="acct-link" aria-label={t('providersManage.signInAria', { name: `${name} · ${shown}` })} disabled={locked} onClick={() => on.signIn(a)}>
                          {t('settings.accounts.signIn')}
                        </button>
                      )}
                      {signed === 'yes' && (
                        <button className="acct-link" aria-label={t('accountCards.signOutAria', { name: `${name} · ${shown}` })} disabled={locked} onClick={() => on.signOut(a)}>
                          {t('accountCards.signOut')}
                        </button>
                      )}
                      {canRemove && signed !== 'unknown' && <div className="acct-menu-sep" role="separator" />}
                      {canRemove && (
                        <button className="acct-link acct-danger" aria-label={t('settings.accounts.removeAria', { name, label: a.label })} disabled={locked} onClick={() => on.remove(a)}>
                          {t('settings.accounts.remove')}
                        </button>
                      )}
                    </div>
                  </details>
                )}
              </span>
            </div>
          );
        })}
        <AddRow t={t} agent={agent} name={name} taken={accounts.filter((x) => !x.default).map((x) => x.label)} busy={signingIn} onSignIn={on.addBrowser} onAdd={on.addTerminal} />
      </span>
    </>
  );
}

/** Ticket 450: one "Add account" button; the form it opens has the name filled in already ("Account 2"), so Enter alone
 *  signs in through the browser. The terminal login is the quiet second way. */
function AddRow({ t, agent, name, taken, busy, onSignIn, onAdd }: { t: T; agent: AccountAgent; name: string; taken: string[]; busy: boolean; onSignIn: (name: string) => Promise<void>; onAdd: (name: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const duplicate = taken.includes(value.trim());
  const ok = validName(value) && !duplicate && !sending && !busy;
  // Ticket 543: a name the core would refuse says so on the form's line; an empty name only waits for typing (data-idle).
  const refused = duplicate ? 'accountAdd.duplicate' : value.trim() !== '' && !validName(value) ? 'settingsWhy.accountName' : null;
  const whyId = `why-acct-${agent}`;
  const stop = { 'aria-describedby': refused ? whyId : undefined, 'aria-busy': sending || busy || undefined, 'data-idle': (!refused && !sending && !busy && !ok) || undefined } as const;
  // "Your own" is the first account, so the first added one is "Account 2"; a taken name moves to the next number.
  const suggested = () => {
    for (let n = taken.length + 2; ; n++) {
      const s = t('accountAdd.suggested', { n });
      if (!taken.includes(s)) return s;
    }
  };
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => opener.current?.focus());
  };
  // Enter and the first button sign in through the browser; the terminal login is the link under them.
  const submit = async (go: (name: string) => Promise<unknown> = onSignIn) => {
    if (!ok) return;
    setSending(true);
    const done = await go(value);
    setSending(false);
    if (done !== false) close();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // A key that belongs to an IME composition (Hangul) is the IME's: Enter then commits the syllable, never submits.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // Settings must not close under it
      close();
    }
  };
  if (!open)
    return (
      <div className="acct-add">
        <button ref={opener} type="button" className="btn withicon" disabled={busy} aria-busy={busy || undefined} onClick={() => (setValue(suggested()), setOpen(true))}>
          <Icon name="plus" size={14} />
          {t('accountAdd.open')}
        </button>
      </div>
    );
  return (
    <div className="acct-add open" role="group" aria-label={t('settings.accounts.addGroup', { name })}>
      <div className="acct-add-row">
        <label htmlFor={`acct-name-${agent}`}>{t('settings.accounts.name')}</label>
        <input {...PLAIN} id={`acct-name-${agent}`} className="prv-inp" aria-label={t('settings.accounts.name')} placeholder={t('providers.newAccount')} title={t(agent === 'codex' ? 'settings.accounts.cleanCodex' : 'settings.accounts.cleanClaude', { page: t('settings.page.extensions') })} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} onFocus={(e) => e.currentTarget.select()} autoFocus autoComplete="off" spellCheck={false} />
        <button type="button" className="btn p" disabled={!ok} {...stop} onClick={() => void submit()}>
          {t('accountAdd.browser')}
        </button>
        <button type="button" className="btn" onClick={close}>
          {t('settings.accounts.cancel')}
        </button>
      </div>
      <div className={`prv-note${refused ? ' bad' : ''}`}>
        {refused ? <Why id={whyId} reason={t(refused)} /> : t('accountAdd.note')}{' '}
        <button type="button" className="acct-link" disabled={!ok} {...stop} onClick={() => void submit(onAdd)}>
          {t('settings.accounts.signInTerminal')}
        </button>
      </div>
    </div>
  );
}

/** 사용 (ticket 358): off hides the agent from every new-session surface (newDefaults `AGENTS_OFF`); running sessions go on.
 *  Ticket 391: the switch sits in the card head. */
export function UseSwitch({ t, agent, name, onOff }: { t: T; agent: AgentCli; name: string; onOff: () => void }) {
  const [off, setOff] = useFeatureSetting(AGENTS_OFF);
  const change = (on: boolean) => {
    setOff(on ? off.filter((a) => a !== agent) : [...off, agent]);
    if (!on) onOff(); // the card closes showing 꺼짐
  };
  return (
    <span data-field="use" data-agent={agent} title={t('providersManage.useNote')}>
      <Switch label={t('providersManage.useAria', { name })} checked={!off.includes(agent)} onChange={change} />
    </span>
  );
}

/** 기본 계정 (ticket 391): the account new sessions of this agent start on, the old "기본으로" button as one select. */
export function DefaultAccountRow({ t, name, accounts, picked, onPick }: { t: T; name: string; accounts: Account[]; picked: string; onPick: (id: string) => void }) {
  const own = accounts.find((a) => a.default)?.id; // the agent's own account is what a new session starts on until one is picked
  return (
    <div data-row="newDefaultAccount">
      <Ln k={t('providersPage.defaultAccount')} reset={<Reset t={t} label={t('providersPage.defaultAccount')} show={!!own && picked !== own} run={() => own && onPick(own)} />}>
        <Select label={t('providersPage.defaultAccountAria', { name })} value={picked} onChange={onPick}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {accountName(t, a)}
            </option>
          ))}
        </Select>
      </Ln>
    </div>
  );
}

/** What a new session starts with when nothing is stored (agent_permission.rs `stored_choice`). */
const DEFAULT_PERMISSION = 'full-access';
type Permissions = Record<AgentCli, AgentChoice> & { claude_bypass_disabled?: boolean };
/** 권한 (ticket 358): the existing per-agent setting; it applies from the next new session. Only what the agent has is listed:
 *  Codex has no accept-edits, and its launch treats a stored one as ask (agent_permission.rs `codex_args`). */
export function PermissionRow({ t, core, agent, name }: { t: T; core: CoreClient; agent: AgentCli; name: string }) {
  const [now, setNow] = useState<Permissions | null>(null);
  const [error, setError] = useState<unknown>('');
  const fail = setError;
  // Ticket 391: while an old stored permission is being moved into the core (features/new-session-defaults.tsx), the core's
  // value is about to change: the select waits and reads it after the move, never showing the value from before it.
  const [defaults] = useFeatureSetting(NEW_DEFAULTS);
  const moving = !!legacyChoice(defaults);
  useEffect(() => {
    if (moving) return;
    let live = true;
    (core.request({ op: 'agent_permission_get' }) as Promise<Permissions>).then((r) => live && setNow(r), (e) => live && fail(e));
    return () => void (live = false);
  }, [core, moving]);
  const set = (choice: string) => {
    setError('');
    (core.request({ op: 'agent_permission_set', agent, choice }) as Promise<Permissions>).then(setNow, fail);
  };
  const codex = agent === 'codex';
  const blocked = !codex && !!now?.claude_bypass_disabled;
  const shown = now ? (codex && now.codex === 'accept-edits' ? 'ask' : now[agent]) : '';
  return (
    <div className="prv-rule" data-field="permission" data-agent={agent}>
      <Ln k={t('providersManage.permission')} reset={now && <Reset t={t} label={`${t('providersManage.permission')} · ${name}`} show={!blocked && shown !== DEFAULT_PERMISSION} run={() => set(DEFAULT_PERMISSION)} />}>
        {now && (
          <Select label={`${t('providersManage.permission')} · ${name}`} describedBy={blocked ? `why-bypass-${agent}` : undefined} value={shown} onChange={set}>
            <option value="own">{t('agents.new.permOwn')}</option>
            <option value="ask">{t('agents.new.permAsk')}</option>
            {!codex && <option value="accept-edits">{t('agents.new.permEdits')}</option>}
            <option value="auto">{t('mode.auto')}</option>
            <option value="full-access" disabled={blocked}>
              {t(codex ? 'agents.new.permYolo' : 'mode.bypass permissions')}
            </option>
          </Select>
        )}
        {/* Ticket 475: Claude's own settings turn it off, so no fix here; the reason says what happens instead. */}
        {blocked ? <Why id={`why-bypass-${agent}`} reason={t('providersManage.bypassOff')} /> : <small>{t('providersManage.permissionNote')}</small>}
      </Ln>
      <ErrorLine t={t} error={error} />
    </div>
  );
}

/** 명령: an approved ACP entry, read-only; 변경 opens the form, and 제거 asks a second time. */
export function CommandSection({ t, row, removing, onRemove, onChange }: { t: T; row: AcpRow; removing: boolean; onRemove: () => void; onChange: () => void }) {
  return (
    <>
      <Ln k={t('providers.command')}>
        <span className="mono">{joinWords([row.found_path ?? row.command, ...row.args])}</span>
        <span className="prv-end">
          <button type="button" className="btn prv-ghost danger" onClick={onRemove}>
            {t(removing ? 'providers.removeSure' : 'providers.remove')}
          </button>
          <button type="button" className="btn" onClick={onChange}>
            {t('providers.change')}
          </button>
        </span>
      </Ln>
      <Ln k={t('providers.envNames')}>
        {row.env.map((n) => (
          <span key={n} className="prv-tag">
            {n}
          </span>
        ))}
      </Ln>
    </>
  );
}

/** 모델 of an ACP agent (ticket 358 #acpmodels): the list it last reported, with `ModelSection`'s rows; it reported none, no section.
 *  The agent owns the list, so there is no filter, add, change or remove. */
export function AcpModelSection({ t, row }: { t: T; row: AcpRow }) {
  const [off, setOff] = useFeatureSetting(MODELS_OFF);
  const list = row.models ?? [];
  if (!list.length) return null;
  const here = off.acp?.[row.name] ?? [];
  const on = list.filter((m) => !here.includes(m.value)).length;
  const write = (next: string[]) => setOff({ ...off, acp: { ...off.acp, [row.name]: next } });
  return (
    <div data-field="models" data-agent={row.name}>
      <Block title={t('providers.models')} note={t('providers.modelsOn', { on, all: list.length })}>
        <div className="prv-mds">
          <div className="prv-mds-top">
            <button type="button" className="btn prv-ghost" onClick={() => write(on ? list.map((m) => m.value) : [])}>
              {t(on ? 'providers.allOff' : 'providers.allOn')}
            </button>
          </div>
        {list.map((m) => {
          const isOn = !here.includes(m.value);
          return (
            <div key={m.value} className={`prv-mr${isOn ? '' : ' off'}`}>
              <span title={m.label}>{m.label}</span>
              <span className="mono" title={m.value}>{m.value}</span>
              <Switch label={m.label} checked={isOn} onChange={(v) => write(v ? here.filter((x) => x !== m.value) : [...here, m.value])} />
            </div>
          );
        })}
      </div>
      <div className="prv-note">{t('providers.modelsNote')}</div>
      </Block>
    </div>
  );
}

/** The core's limit on one stored value (sessions.rs `FEATURE_VALUE_MAX`). */
const VALUE_MAX = 4096;
const named = (id: string, name: string): CustomModel => (name.trim() && name.trim() !== id ? { id, name: name.trim() } : { id });

/** 모델 (ticket 357; 358 #models2): one agent's model list; what is off leaves every list that offers a model (newDefaults `MODELS_OFF`).
 *  Filter, add, change and remove are ported from t3code ProviderModelsSection.tsx (`visibleModels`, `handleAdd`, `handleRemove`, `handleSaveEdit`)
 *  and customModelEditor.logic.ts (`draftFromDefinition`), MIT License, Copyright (c) 2026 T3 Tools Inc. Capability editing, favourites and order are left out. */
export function ModelSection({ t, kind }: { t: T; kind: AgentCli }) {
  const [off, setOff] = useFeatureSetting(MODELS_OFF);
  const [, setDefaults] = useFeatureSetting(NEW_DEFAULTS);
  // `unread` is set while the first read failed: writing then would replace a list this window never saw.
  const [stored, setStored, coreError, unread] = useCoreFeature<Record<string, unknown>>(CUSTOM_MODELS, {});
  const [filter, setFilter] = useState('');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const custom = cleanCustomModels(stored);
  const mine = custom[kind] ?? [];
  const list = modelChoices(kind, custom).filter((m): m is { value: string; label: string } => m.value !== null);
  const here = off[kind] ?? [];
  const on = list.filter((m) => !here.includes(m.value)).length;
  const write = (next: string[]) => setOff({ ...off, [kind]: next });
  const needle = filter.trim().toLowerCase();
  const shown = list.filter((m) => m.label.toLowerCase().includes(needle) || m.value.toLowerCase().includes(needle));
  // Saves work on the list as stored, not as cleaned for showing: an entry this version cannot read, of any agent, stays.
  const raw: unknown[] = Array.isArray(stored[kind]) ? stored[kind] : [];
  const isModel = (entry: unknown, slug: string) => (entry as { id?: unknown } | null)?.id === slug;
  const save = async (next: unknown[]) => {
    const value = { ...stored, [kind]: next };
    if (new TextEncoder().encode(JSON.stringify(value)).length > VALUE_MAX) {
      setProblem(t('providerModels.full', { max: VALUE_MAX }));
      return false;
    }
    setProblem('');
    return setStored(value);
  };
  const add = async () => {
    const slug = id.trim();
    if (!MODEL_NAME.test(slug)) return setProblem(t('agents.new.customBad'));
    if (list.some((m) => m.value === slug)) return setProblem(t('providerModels.duplicate'));
    if (name.trim() && !validName(name)) return setProblem(t('providerModels.badName'));
    if (!(await save([...raw, named(slug, name)]))) return;
    setFilter('');
    setId('');
    setName('');
  };
  const saveEdit = async (slug: string) => {
    if (draft.trim() && !validName(draft)) return setProblem(t('providerModels.badName'));
    if (await save(raw.map((m) => (isModel(m, slug) ? named(slug, draft) : m)))) setEditing('');
  };
  const remove = async (slug: string) => {
    if (!(await save(raw.filter((m) => !isModel(m, slug))))) return; // refused: it keeps its off state and any default
    if (editing === slug) setEditing('');
    // Read now, not at the press: the write took a round trip. Added again later, it starts on.
    const nowOff = currentFeature(MODELS_OFF);
    setOff({ ...nowOff, [kind]: (nowOff[kind] ?? []).filter((x) => x !== slug) });
    setDefaults(withoutDefaultModel(currentFeature(NEW_DEFAULTS), kind, slug));
  };
  const keys = (enter: () => void, escape: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // the IME's Enter commits a syllable
    if (e.key === 'Enter') {
      e.preventDefault();
      enter();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // Settings must not close under it
      escape();
    }
  };
  const failed = problem || coreError;
  return (
    <div data-field="models" data-agent={kind}>
      <Block title={t('providers.models')} note={t('providers.modelsOn', { on, all: list.length })}>
      <div className="prv-mds">
        <div className="prv-mds-top">
        <input {...PLAIN} className={`prv-inp w${filter ? ' mono' : ''}`} aria-label={t('providerModels.filter')} placeholder={t('providerModels.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} autoComplete="off" spellCheck={false} />
        {shown.length > 0 && (
          <button type="button" className="btn prv-ghost" onClick={() => write(on ? list.map((m) => m.value) : [])}>
            {t(on ? 'providers.allOff' : 'providers.allOn')}
          </button>
        )}
        </div>
        {shown.length === 0 && <div className="prv-mds-none">{t('providerModels.none')}</div>}
        {shown.map((m) => {
          const isOn = !here.includes(m.value);
          const own = mine.find((x) => x.id === m.value);
          if (own && editing === m.value)
            return (
              <div key={m.value} className="prv-mr">
                <input {...PLAIN} className="prv-inp" aria-label={t('providerModels.nameOf', { id: m.value })} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={keys(() => saveEdit(m.value), () => setEditing(''))} autoFocus autoComplete="off" spellCheck={false} />
                <span className="mono">{m.value}</span>
                <span className="prv-mr-ac">
                  <button type="button" className="btn prv-ghost" onClick={() => saveEdit(m.value)}>
                    {t('providersManage.save')}
                  </button>
                  <button type="button" className="btn prv-ghost" onClick={() => setEditing('')}>
                    {t('providers.cancel')}
                  </button>
                </span>
              </div>
            );
          const toggle = <Switch label={m.label} checked={isOn} onChange={(v) => write(v ? here.filter((x) => x !== m.value) : [...here, m.value])} />;
          return (
            <div key={m.value} className={`prv-mr${isOn ? '' : ' off'}`}>
              <span>{m.label}</span>
              <span className="mono">{m.value}</span>
              {own ? (
                <span className="prv-mr-ac">
                  <button type="button" className="btn prv-ghost" aria-label={t('providerModels.changeAria', { id: m.value })} onClick={() => (setDraft(own.name ?? ''), setEditing(m.value))}>
                    {t('providers.change')}
                  </button>
                  <button type="button" className="btn prv-ghost danger" aria-label={t('providerModels.removeAria', { id: m.value })} onClick={() => remove(m.value)}>
                    {t('providers.remove')}
                  </button>
                  {toggle}
                </span>
              ) : (
                toggle
              )}
            </div>
          );
        })}
      </div>
      <Ln k={t('providerModels.add')}>
        <input {...PLAIN} className="prv-inp mono prv-grow" aria-label={t('providerModels.id')} placeholder={t('providerModels.id')} value={id} onChange={(e) => setId(e.target.value)} onKeyDown={keys(add, () => setId(''))} autoComplete="off" spellCheck={false} />
        <input {...PLAIN} className="prv-inp prv-grow" aria-label={t('providerModels.name')} placeholder={t('providerModels.name')} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={keys(add, () => setName(''))} autoComplete="off" spellCheck={false} />
        <button type="button" className="btn withicon" disabled={!!unread} aria-describedby={unread ? `why-models-${kind}` : undefined} onClick={add}>
          <Icon name="plus" size={14} />
          {t('providers.add')}
        </button>
      </Ln>
      {/* Ticket 543: while the stored list was never read, adding would replace a list this window never saw. */}
      {unread && (
        <p className="prv-note bad">
          <Why id={`why-models-${kind}`} reason={t('settingsWhy.modelsUnread')} fix={<WhyFix label={t('settings.kit.retry')} run={unread} />} />
        </p>
      )}
      <div className="prv-note">{t('providers.modelsNote')}</div>
      {kind === 'claude' && <div className="prv-note">{t('providerModels.claudeSwitch')}</div>}
      {failed && (
        <p role="alert" className="prv-note bad">
          {failed}
        </p>
      )}
      </Block>
    </div>
  );
}
