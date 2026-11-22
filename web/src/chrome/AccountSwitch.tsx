// Ticket 451: the status bar's account switch (as Orca's status-bar menu). One chip per agent that has more than one account;
// its menu lists the accounts with what is left of each one's limits, and a pick is the account new sessions start on
// (the same stored choice as Settings > Providers > New session defaults). A running session keeps the account it started on.
import { errorNote, FailedNote, notePlain, type Note } from '../errors';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { accountName, type Account, type AccountAgent, type AccountUsage, type CoreClient } from '../api';
import type { T } from '../i18n';
import { Icon } from '../icons/Icon';
import { limitUsed } from '../settings/accounts/sections';
import { ACCOUNTS_CHANGED } from '../tree';
import type { Session } from '../types';
import { restartRequest } from './restart';

const AGENTS: [AccountAgent, string][] = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
];

export function AccountSwitch({ t, core, connected, onManage, current, onOpen }: { t: T; core: CoreClient; connected: boolean; onManage: () => void; current: Session | null; onOpen: (id: string) => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [usage, setUsage] = useState<AccountUsage[]>([]);
  const [open, setOpen] = useState<AccountAgent | null>(null);
  const [note, setNote] = useState<Note>('');
  // The status bar clips what leaves it, so the menu is placed against the window (fixed), above its chip.
  const [at, setAt] = useState({ right: 0, bottom: 0 });
  const root = useRef<HTMLSpanElement>(null);
  // The list is read when the window connects and whenever an account changes anywhere (Settings fires the event).
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const read = (share = false) => void core.accounts(share).then((r) => live && setAccounts(r.accounts), () => {});
    read(true); // the split glue reads it at connect too: one request (splits.spec `split_agent_uses_last_account`)
    const again = () => read();
    window.addEventListener(ACCOUNTS_CHANGED, again);
    return () => {
      live = false;
      window.removeEventListener(ACCOUNTS_CHANGED, again);
    };
  }, [core, connected]);
  // What is left of each limit is read when a menu opens, not kept fresh behind a closed one.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void core.accountUsage(true).then((r) => live && setUsage(r.rows), () => {}); // ticket 1031: the menu shows limits only, so the cheap read
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
  const pick = async (agent: AccountAgent, name: string, a: Account) => {
    close(agent);
    if (a.session_default) return;
    try {
      await core.request({ op: 'quit_settings', patch: { features: { [`accounts.default.${agent}`]: a.id } } });
      setAccounts((list) => list.map((x) => (x.agent === agent ? { ...x, session_default: x.id === a.id } : x)));
      window.dispatchEvent(new Event(ACCOUNTS_CHANGED));
      setNote(t('accountSwitch.done', { name, label: accountName(t, a) }));
    } catch (e) {
      setNote(errorNote(t('accountSwitch.failed', { error: notePlain(t, e) }), e));
    }
  };
  // Step 2: the shown session continues on another account. The core copies the conversation's record into that account's
  // folder and resumes it there (sessions.rs, account_carry.rs); the account it ran on keeps its copy. Only for a session
  // that has ended: nothing here stops a running one.
  const carry = async (agent: AccountAgent, a: Account) => {
    close(agent);
    if (!current) return;
    const label = accountName(t, a);
    try {
      const reply = (await core.request({ op: 'start', session: { ...restartRequest(current), account: a.default ? '' : a.label } })) as { session?: Session };
      if (!reply.session) throw new Error('the core started no session');
      onOpen(reply.session.id);
      setNote(t('accountSwitch.continued', { label }));
    } catch (e) {
      setNote(errorNote(t('accountSwitch.notContinued', { error: notePlain(t, e) }), e));
    }
  };
  // The menu pattern of the icon bar's ⋯: arrows move (wrapping), Home and End jump, Esc closes and focus returns to the chip.
  const keys = (agent: AccountAgent) => (e: KeyboardEvent<HTMLDivElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => (e.preventDefault(), list[(i + list.length) % list.length]?.focus());
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close(agent));
  };

  return (
    <span className="acsw" ref={root}>
      {AGENTS.map(([agent, name]) => {
        const mine = accounts.filter((a) => a.agent === agent);
        if (mine.length < 2) return null; // one account: nothing to switch
        const now = mine.find((a) => a.session_default) ?? mine.find((a) => a.default) ?? mine[0];
        const label = (a: Account) => (accountName(t, a));
        return (
          <span className="acsw-one" key={agent}>
            <button type="button" className="it acsw-chip" data-hint-quiet data-switch={agent} aria-haspopup="menu" aria-expanded={open === agent} aria-label={t('accountSwitch.chip', { name, label: label(now) })} data-tip={t('accountSwitch.tip', { name })} onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setAt({ right: Math.max(4, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 4 });
                setOpen((o) => (o === agent ? null : agent));
              }}>
              <span className="acsw-agent">{name}</span>
              <span className="acsw-label">{label(now)}</span>
              <Icon name="chevron-down" size={12} />
            </button>
            {open === agent && (
              <div className="acsw-pop glass" role="menu" aria-label={t('accountSwitch.menu', { name })} style={at} onKeyDown={keys(agent)}>
                <div className="hd">{t('accountSwitch.menu', { name })}</div>
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
                {agent === 'claude' && current?.kind === 'claude' && current.agent_session_id && !current.side_chat && (
                  <div className="acsw-carry" role="group" aria-label={t('accountSwitch.thisSession', { label: current.account ?? accountName(t, mine.find((a) => a.default) ?? now) })}>
                    <div className="hd">{t('accountSwitch.thisSession', { label: current.account ?? accountName(t, mine.find((a) => a.default) ?? now) })}</div>
                    {current.state === 'running' ? (
                      <div className="acsw-foot plain">{t('accountSwitch.endFirst')}</div>
                    ) : (
                      mine
                        .filter((a) => a.signed_in !== 'no' && (a.default ? !!current.account : a.label !== current.account))
                        .map((a) => (
                          <button type="button" key={a.id} role="menuitem" data-carry={a.id} onClick={() => void carry(agent, a)}>
                            <span className="acsw-check" aria-hidden />
                            <span className="acsw-name">{t('accountSwitch.continueOn', { label: label(a) })}</span>
                          </button>
                        ))
                    )}
                  </div>
                )}
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
