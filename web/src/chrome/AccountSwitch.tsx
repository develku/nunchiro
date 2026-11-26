// Ticket 451: the status bar's account switch (as Orca's status-bar menu). One chip per agent that has more than one account;
// its menu lists the accounts with what is left of each one's limits, and a pick is the account new sessions start on
// (the same stored choice as Settings > Providers > New session defaults). A running session keeps the account it started on.
// Ticket 1126: that pick is where every new session starts, the agents' too (the core applies it). At the owner's level of the
// pick's week (`accounts.near_percent`, 98 unless set; round 4) the core writes a record (account_near.rs) and a card above the chip offers the next account with one button; only that
// click switches (every usage number is one a session can write). The 5-hour share never counts.
import { errorNote, FailedNote, heldNote, notePlain, startOp, type Note } from '../errors';
import { agentName } from '../chat/conversation';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { accountName, type Account, type AccountAgent, type AccountUsage, type CoreClient } from '../api';
import type { T } from '../i18n';
import { Icon } from '../icons/Icon';
import { limitUsed } from '../settings/accounts/sections';
import { Select } from '../settings/shell/Row';
import { ACCOUNTS_CHANGED } from '../tree';
import type { Session } from '../types';
import { restartRequest } from './restart';

const AGENTS: [AccountAgent, string][] = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
];
/** The core's near-limit records (`settings.json` `features` `accounts.<kind>.<agent>`), read with the owner's settings read. */
type Near = { id: string; used?: number | null; next: string; next_used?: number | null; resets_at: number };
type AllNear = { id: string; used?: number | null; first: string; first_reset: number };
type Features = Record<string, unknown>;
/** The card's level, as the core reads it (account_near.rs `near_percent`): 50..=99, else 98. */
const nearAt = (f: Features) => ((p) => (typeof p === 'number' && Number.isInteger(p) && p >= 50 && p <= 99 ? p : 98))(f['accounts.near_percent']);
const LEVELS = [50, 60, 70, 75, 80, 85, 90, 95, 98, 99];
const featuresOf = (r: unknown): Features => (r as { settings?: { features?: Features } }).settings?.features ?? {};
/** The records are written when a weekly share changes; reading them is cheap (the core's own settings), so once a minute. */
const RECORDS_MS = 60_000;
const when = (at: number) => new Date(at * 1000).toLocaleString(document.documentElement.lang || undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function AccountSwitch({ t, core, connected, onManage, current, onOpen }: { t: T; core: CoreClient; connected: boolean; onManage: () => void; current: Session | null; onOpen: (id: string) => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [usage, setUsage] = useState<AccountUsage[]>([]);
  const [open, setOpen] = useState<AccountAgent | null>(null);
  const [note, setNote] = useState<Note>('');
  const [features, setFeatures] = useState<Features>({});
  const [closedCard, setClosedCard] = useState(''); // Close hides a card until the core writes another record
  const [cardAt, setCardAt] = useState({ right: 0, bottom: 0 });
  // The status bar clips what leaves it, so the menu is placed against the window (fixed), above its chip.
  const [at, setAt] = useState({ right: 0, bottom: 0 });
  const root = useRef<HTMLSpanElement>(null);
  const recordsNow = useRef(() => {});
  // The list is read when the window connects and whenever an account changes anywhere (Settings fires the event).
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const read = (share = false) => void core.accounts(share).then((r) => live && setAccounts(r.accounts), () => {});
    const records = () => void core.request({ op: 'quit_settings' }).then((r) => live && setFeatures(featuresOf(r)), () => {});
    recordsNow.current = records;
    read(true); // the split glue reads it at connect too: one request (splits.spec `split_agent_uses_last_account`)
    records();
    const again = () => (read(), records());
    const timer = setInterval(() => document.visibilityState === 'visible' && records(), RECORDS_MS);
    window.addEventListener(ACCOUNTS_CHANGED, again);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener(ACCOUNTS_CHANGED, again);
    };
  }, [core, connected]);
  // What is left of each limit is read when a menu opens, not kept fresh behind a closed one.
  useEffect(() => {
    if (!open) return;
    let live = true;
    // Ticket 1031: the menu shows limits only, so the cheap read. The core runs its near-limit rule after each usage read
    // (account_near::after_usage), so its records are read right after one.
    void core.accountUsage(true).then((r) => (live && setUsage(r.rows), recordsNow.current()), () => {});
    root.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"], [role="menuitemradio"]')?.focus();
    const off = (e: Event) => !root.current?.contains(e.target as Node) && setOpen(null);
    document.addEventListener('pointerdown', off);
    return () => {
      live = false;
      document.removeEventListener('pointerdown', off);
    };
  }, [open, core]);
  useEffect(() => {
    if (!note || typeof note !== 'string') return; // a failure stays until closed (476)
    const id = setTimeout(() => setNote(''), 6000);
    return () => clearTimeout(id);
  }, [note]);

  const close = (agent: AccountAgent) => {
    setOpen(null);
    root.current?.querySelector<HTMLElement>(`[data-switch="${agent}"]`)?.focus();
  };
  // The owner's write of the stored pick and the near-limit keys (`quit_settings` is owner-only: no session reaches it).
  const save = async (patch: Features) => setFeatures(featuresOf(await core.request({ op: 'quit_settings', patch: { features: patch } })));
  const pick = async (agent: AccountAgent, name: string, a: Account) => {
    close(agent);
    if (a.session_default) return;
    try {
      await save({ [`accounts.default.${agent}`]: a.id });
      setAccounts((list) => list.map((x) => (x.agent === agent ? { ...x, session_default: x.id === a.id } : x)));
      window.dispatchEvent(new Event(ACCOUNTS_CHANGED));
      setNote(t('accountSwitch.done', { name, label: accountName(t, a) }));
    } catch (e) {
      setNote(errorNote(t('accountSwitch.failed', { error: notePlain(t, e) }), e));
    }
  };
  const setLeadsAny = async (on: boolean) => {
    try {
      await save({ 'accounts.leads_any': on ? true : null }); // absent is off
    } catch (e) {
      setNote(errorNote(t('accountSwitch.failed', { error: notePlain(t, e) }), e));
    }
  };
  // Round 4 (owner 2026-11-25): the level the card shows at. The usage read after it runs the core's rule at the new level.
  const setNearAt = async (pct: number) => {
    try {
      await save({ 'accounts.near_percent': pct === 98 ? null : pct }); // absent is 98
      void core.accountUsage(true).then((r) => (setUsage(r.rows), recordsNow.current()), () => {});
    } catch (e) {
      setNote(errorNote(t('accountSwitch.failed', { error: notePlain(t, e) }), e));
    }
  };
  // Step 2: the shown session continues on another account. The core copies the conversation's record into that account's
  // folder and resumes it there (sessions.rs, account_carry.rs); the account it ran on keeps its copy. Ticket 1126: a running
  // session not in the middle of a turn ends first (a resumed conversation cannot start while its old run is live, as
  // PermissionNeeded's restart); one mid-turn is never offered, so nothing here stops a turn.
  /** `anyway`: a low-memory hold's Start anyway, the same carry past the hold. */
  const carry = async (agent: AccountAgent, a: Account, anyway = false) => {
    close(agent);
    if (!current || (current.state === 'running' && current.attention.working)) return;
    const label = accountName(t, a);
    const started = async (session: object, past = false) => {
      const reply = (await core.request(startOp({ op: 'start', session }, past))) as { session?: Session };
      if (!reply.session) throw new Error('the core started no session');
      onOpen(reply.session.id);
    };
    let ended = false;
    try {
      if (current.state === 'running') await core.request({ op: 'close', id: current.id });
      ended = current.state === 'running';
      await started({ ...restartRequest(current), account: a.default ? '' : a.label }, anyway);
      setNote(t('accountSwitch.continued', { label }));
    } catch (e) {
      // Round 2 review SHOULD 2: its old run was ended first, so the conversation reopens on the account it ran on.
      const back = ended && (await started(restartRequest(current)).then(() => true, () => false));
      const held = !back && heldNote(t, e, agentName(current.kind, current.acp_agent), () => void carry(agent, a, true));
      setNote(held || errorNote(t(back ? 'accountSwitch.notContinuedBack' : 'accountSwitch.notContinued', { error: notePlain(t, e) }), e));
    }
  };
  // The menu pattern of the icon bar's ⋯: arrows move (wrapping), Home and End jump, Esc closes and focus returns to the chip.
  const keys = (agent: AccountAgent) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLSelectElement && e.key !== 'Escape') return; // the level's own arrows
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => (e.preventDefault(), list[(i + list.length) % list.length]?.focus());
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close(agent));
  };

  // Per agent: its accounts, the checked one, and the card its core records ask for (red all-near, then near).
  const seconds = Date.now() / 1000;
  const views = AGENTS.map(([agent, name]) => {
    const mine = accounts.filter((a) => a.agent === agent);
    const now = mine.find((a) => a.session_default) ?? mine.find((a) => a.default) ?? mine[0];
    const byId = (id: string) => mine.find((a) => a.id === id);
    const rec = <R,>(k: string) => features[`accounts.${k}.${agent}`] as R | undefined;
    const all = rec<AllNear>('all_near');
    const near = rec<Near>('near');
    const card =
      mine.length < 2 || !now
        ? undefined
        : all && all.id === now.id && all.first_reset > seconds && byId(all.first)
          ? { kind: 'all' as const, key: JSON.stringify(all), all, first: byId(all.first)! }
          : near && near.id === now.id && near.resets_at > seconds && byId(near.next)
            ? { kind: 'near' as const, key: JSON.stringify(near), near, next: byId(near.next)! }
            : undefined;
    return { agent, name, mine, now, leadsAny: features['accounts.leads_any'] === true, card: card && card.key !== closedCard && open !== agent ? card : undefined };
  });
  const shown = views.find((v) => v.card);
  const level = nearAt(features);
  // The card sits against the window above its chip, as the menu does (the status bar clips what leaves it).
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const r = root.current?.querySelector(`[data-switch="${shown.agent}"]`)?.getBoundingClientRect();
      if (r) setCardAt({ right: Math.max(4, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 4 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [shown?.agent, shown?.card?.key]);

  // Step 2 / ticket 1126: the accounts the shown Claude session can continue on, and whether it must wait for its turn.
  const carryable = (agent: AccountAgent) => agent === 'claude' && current?.kind === 'claude' && !!current.agent_session_id && !current.side_chat;
  const carryTo = (mine: Account[]) => (current ? mine.filter((a) => a.signed_in !== 'no' && (a.default ? !!current.account : a.label !== current.account)) : []);
  const midTurn = !!current && current.state === 'running' && current.attention.working;

  return (
    <span className="acsw" ref={root}>
      {views.map(({ agent, name, mine, now, leadsAny, card }) => {
        if (mine.length < 2) return null; // one account: nothing to switch
        const label = (a: Account) => (accountName(t, a));
        const nowLabel = label(now);
        const tab = current?.label ?? '';
        const continueButton = (a: Account) =>
          carryable(agent) && carryTo(mine).some((x) => x.id === a.id) ? (
            <button type="button" className="btn" disabled={midTurn} title={midTurn ? t('accountSwitch.waitsTurn') : undefined} onClick={() => void carry(agent, a)}>
              {t('accountSwitch.continueTab', { session: tab, label: label(a) })}
            </button>
          ) : null;
        return (
          <span className="acsw-one" key={agent}>
            <button type="button" className="it acsw-chip" data-hint-quiet data-switch={agent} aria-haspopup="menu" aria-expanded={open === agent} aria-label={t('accountSwitch.chip', { name, label: nowLabel })} data-tip={t('accountSwitch.tip', { name })} onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setAt({ right: Math.max(4, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 4 });
                setOpen((o) => (o === agent ? null : agent));
              }}>
              <span className="acsw-agent">{name}</span>
              <span className="acsw-label">{nowLabel}</span>
              <Icon name="chevron-down" size={12} />
            </button>
            {card && (
              <div className={`acsw-card glass${card.kind === 'all' ? ' bad' : ''}`} role="region" data-card={card.kind} aria-label={card.kind === 'all' ? t('accountSwitch.allTitle', { name, pct: level }) : t('accountSwitch.nearTitle', { label: nowLabel, pct: card.near.used ?? level })} style={cardAt}>
                <div className="top">
                  <Icon name="info" size={14} />
                  <b>{card.kind === 'all' ? t('accountSwitch.allTitle', { name, pct: level }) : t('accountSwitch.nearTitle', { label: nowLabel, pct: card.near.used ?? level })}</b>
                  <button type="button" className="x" aria-label={t('accountSwitch.close')} onClick={() => setClosedCard(card.key)}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
                {card.kind === 'near' && (
                  <>
                    <p>
                      {[t('accountSwitch.nearText', { name, label: nowLabel }), card.near.next_used != null && t('accountSwitch.nextUsed', { label: label(card.next), pct: card.near.next_used }), t('accountSwitch.resets', { label: nowLabel, when: when(card.near.resets_at) })].filter(Boolean).join(' ')}
                    </p>
                    <div className="acts">
                      <button type="button" className="btn p" onClick={() => void pick(agent, name, card.next)}>
                        {t('accountSwitch.startOn', { label: label(card.next) })}
                      </button>
                      {continueButton(card.next)}
                    </div>
                    {/* Codex security looks P1 (rounds 2, 3): status lines and rollouts are files a session can write, so only this click moves it. */}
                    <p>{t('accountSwitch.clickOnly', { name })}</p>
                  </>
                )}
                {card.kind === 'all' && (
                  <>
                    <p>{t('accountSwitch.allText', { label: nowLabel, pct: card.all.used ?? level, first: label(card.first), when: when(card.all.first_reset) })}</p>
                    <div className="acts">
                      <button type="button" className="btn" onClick={() => onManage()}>
                        {t('accountSwitch.manage')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            {open === agent && (
              <div className="acsw-pop glass" role="menu" aria-label={t('accountSwitch.menu', { name })} style={at} onKeyDown={keys(agent)}>
                <div className="hd">{t('accountSwitch.startsOn', { name })}</div>
                {mine.map((a) => {
                  const row = usage.find((u) => u.agent === agent && u.id === a.id);
                  const out = a.signed_in === 'no';
                  return (
                    <button type="button" key={a.id} role="menuitemradio" aria-checked={a.id === now.id} disabled={out} data-account={a.id} onClick={() => void pick(agent, name, a)}>
                      <span className="acsw-check" aria-hidden>
                        {a.id === now.id && <Icon name="check" size={12} />}
                      </span>
                      <span className="acsw-name">{label(a)}</span>
                      <span className="acsw-facts">
                        {out
                          ? t('settings.accounts.signedOut')
                          : [a.plan && a.plan[0].toUpperCase() + a.plan.slice(1), row?.session && `${t('usage.v4.session')} ${limitUsed(t, row.session)}`, row?.weekly && `${t('usage.v4.weekly')} ${limitUsed(t, row.weekly)}`, row?.limit_resets && t('settings.accounts.limit', { when: row.limit_resets })]
                              .filter(Boolean)
                              .join(' · ')}
                      </span>
                    </button>
                  );
                })}
                {/* Step 2: only Claude finds a conversation by its record alone (checked); Codex is not offered. */}
                {carryable(agent) && current && (
                  <div className="acsw-carry" role="group" aria-label={t('accountSwitch.thisSession', { label: current.account ?? accountName(t, mine.find((a) => a.default) ?? now) })}>
                    <div className="hd">{t('accountSwitch.thisSession', { label: current.account ?? accountName(t, mine.find((a) => a.default) ?? now) })}</div>
                    {carryTo(mine).map((a) => (
                      <button type="button" key={a.id} role="menuitem" className="acsw-two" data-carry={a.id} disabled={midTurn} onClick={() => void carry(agent, a)}>
                        <span className="acsw-check" aria-hidden />
                        <span className="acsw-name">
                          {t('accountSwitch.continueOn', { label: label(a) })}
                          {current.state === 'running' && <span className="acsw-sub">{midTurn ? t('accountSwitch.waitsTurn') : t('accountSwitch.continueSub', { session: tab, label: label(a) })}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="acsw-grp">
                  {/* Owner 2026-11-25: one switch for every agent; only the owner writes it (a session's ask is a card). */}
                  <button type="button" role="menuitemcheckbox" className="acsw-two" aria-checked={leadsAny} data-leads-any onClick={() => void setLeadsAny(!leadsAny)}>
                    <span className={`acsw-box${leadsAny ? ' on' : ''}`} aria-hidden>
                      {leadsAny && <Icon name="check" size={10} />}
                    </span>
                    <span className="acsw-name plain">
                      {t('accountSwitch.leadsAny')}
                      <span className="acsw-sub">{t('accountSwitch.leadsAnySub')}</span>
                    </span>
                  </button>
                  <div className="acsw-level">
                    <span className="acsw-name plain">{t('accountSwitch.nearAt')}</span>
                    <Select label={t('accountSwitch.nearAt')} value={String(level)} onChange={(v) => void setNearAt(Number(v))}>
                      {(LEVELS.includes(level) ? LEVELS : [...LEVELS, level].sort((a, b) => a - b)).map((p) => (
                        <option key={p} value={p}>
                          {t('accountSwitch.nearAtOption', { pct: p })}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="acsw-foot">{t('accountSwitch.foot')}</div>
                <button type="button" role="menuitem" className="acsw-manage" onClick={() => (close(agent), onManage())}>
                  {t('accountSwitch.manage')}
                </button>
              </div>
            )}
          </span>
        );
      })}
      {/* Only while set: the status bar's specs read any `.lnote` as a notice shown (frame-chrome-status). */}
      {note && (
        <span className="lnote" role="status">
          {typeof note === 'string' ? note : <FailedNote t={t} note={note} onDismiss={() => setNote('')} />}
        </span>
      )}
    </span>
  );
}
