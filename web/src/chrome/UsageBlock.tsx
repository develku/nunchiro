// Ticket 1031: the status bar's usage block and its popover (mockups docs/design/usage-home-1121/index.html part 1 and
// docs/design/bot-statusbar-1121/index.html 1-1; the shape is Orca's status-bar usage). "Used", then per agent its logo, a
// tiny bar (the most used window) and "used % + time to reset" per window. The numbers are the core's `account_usage`
// rows, read with `limits` (only the records that carry limits, so the timer never reads days of transcripts): the
// agents' own records on this Mac, no outbound call. Codex writes its limits there; Claude's come from what Claude
// Code hands its status line in a Nunchiro session (ticket 1036, `limits_at`), so Claude reads "no data" only before
// any Claude session ran, and "as of <time>" when that record is older than `STALE`. The Codex reset tickets are usage/CodexResets:
// off by default, read only on the owner's Refresh press, and every use confirms.
import { useCallback, useEffect, useRef, useState } from 'react';
import { accountName, type Account, type AccountAgent, type AccountUsage, type CoreClient, type UsageLimit } from '../api';
import type { T } from '../i18n';
import { Icon } from '../icons/Icon';
import { ageText } from '../chat/PrChip';
import { openUsage } from '../settings/agents/open';
import { ACCOUNTS_CHANGED } from '../tree';
import { AgentLogo } from '../tree/AgentLogo';
import { ResetLineView, useResets, useResetsOn } from '../usage/CodexResets';
import './usage-block.css';

const AGENTS: [AccountAgent, string][] = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
];
// The timer reads records only; a codex is started by the owner's Refresh press alone (usage/CodexResets.tsx).
const READ_MS = 5 * 60_000;
const COMPACT = 'nunchiro.usage.compact';
// Ticket 1036: a Claude record older than this (no Claude session wrote one since) says when it was made.
const STALE = 10 * 60;
type Window = { label: string; used: number; resets_at: number };

const tone = (used: number) => (used >= 100 ? 'full' : used >= 80 ? 'warn' : undefined);
/** "4h 12m", "5d 6h", "40m": the two largest units of the time left, as the mockup writes it. */
export function timeLeft(t: T, seconds: number) {
  const m = Math.max(1, Math.round(seconds / 60));
  const [d, h, min] = [Math.floor(m / 1440), Math.floor((m % 1440) / 60), m % 60];
  const parts = d ? [t('board.watch.ago.d', { n: d }), h && t('board.watch.ago.h', { n: h })] : h ? [t('board.watch.ago.h', { n: h }), min && t('board.watch.ago.m', { n: min })] : [t('board.watch.ago.m', { n: min })];
  return parts.filter(Boolean).join(' ');
}
const windows = (t: T, row?: AccountUsage): Window[] => {
  const one = (label: string, l?: UsageLimit) => (l ? [{ label, used: 100 - l.left_pct, resets_at: l.resets_at }] : []);
  return [...one(t('usageBar.session'), row?.session), ...one(t('usageBar.weekly'), row?.weekly)];
};
const most = (ws: Window[]) => ws.reduce<Window | undefined>((a, w) => (!a || w.used > a.used ? w : a), undefined);
const Refresh = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8M21 3v5h-5" />
  </svg>
);

export function UsageBlock({ t, core, connected, onManage }: { t: T; core: CoreClient; connected: boolean; onManage: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rows, setRows] = useState<AccountUsage[] | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, bottom: 0 });
  const [compact, setCompact] = useState(() => {
    try {
      return localStorage.getItem(COMPACT) === '1';
    } catch {
      return false;
    }
  });
  const [resetsOn, setResetsOn] = useResetsOn(core);
  const resets = useResets(core);
  const root = useRef<HTMLSpanElement>(null);

  const read = useCallback(() => {
    void core.accounts(true).then((r) => setAccounts(r.accounts), () => {});
    void core.accountUsage(true).then((r) => (setRows(r.rows), setAt(Date.now()), setNow(Date.now())), () => {});
  }, [core]);
  useEffect(() => {
    if (!connected) return;
    const seen = () => document.visibilityState === 'visible' && read();
    seen();
    const timer = setInterval(seen, READ_MS);
    const clock = setInterval(() => setNow(Date.now()), 60_000); // the time to reset counts down between reads
    window.addEventListener(ACCOUNTS_CHANGED, read);
    return () => {
      clearInterval(timer);
      clearInterval(clock);
      window.removeEventListener(ACCOUNTS_CHANGED, read);
    };
  }, [connected, read]);
  const close = useCallback(() => {
    setOpen(false);
    root.current?.querySelector<HTMLElement>('button.usg')?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const off = (e: Event) => !root.current?.contains(e.target as Node) && setOpen(false);
    // WebKit (the app's webview) does not focus a clicked button, so the wrapper's onKeyDown never sees Escape: listen on the document too.
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !root.current?.contains(document.activeElement) && (e.preventDefault(), close());
    document.addEventListener('pointerdown', off);
    document.addEventListener('keydown', esc);
    return () => (document.removeEventListener('pointerdown', off), document.removeEventListener('keydown', esc));
  }, [open, close]);

  const mine = (agent: AccountAgent) => accounts.filter((a) => a.agent === agent);
  const rowOf = (a: Account) => rows?.find((r) => r.agent === a.agent && r.id === a.id);
  const codexIds = mine('codex').map((a) => a.id);
  // The owner's press: the records again, and (only with the reset feature on) one codex per Codex account.
  const refresh = () => {
    read();
    if (resetsOn) void resets.refresh(codexIds);
  };
  const density = (v: boolean) => {
    setCompact(v);
    try {
      localStorage.setItem(COMPACT, v ? '1' : '0');
    } catch {
      /* storage went away: the choice lasts until the window closes */
    }
  };
  const left = (w: Window) => timeLeft(t, w.resets_at - now / 1000);
  const asOf = (row?: AccountUsage) =>
    row?.limits_at && now / 1000 - row.limits_at > STALE
      ? t('usageBar.asOf', { time: new Date(row.limits_at * 1000).toLocaleTimeString(document.documentElement.lang || undefined, { hour: 'numeric', minute: '2-digit' }) })
      : '';
  const text = (ws: Window[]) => (compact ? [most(ws)!] : ws).map((w) => `${w.used}% ${left(w)}`).join(' · ');
  const refreshButton = (cls: string) => (
    <button type="button" className={cls} data-hint-quiet aria-label={t('usage.v4.refreshAria')} data-tip={t('usage.v4.refreshAria')} disabled={resets.busy} aria-busy={resets.busy || undefined} onClick={refresh}>
      <Refresh />
    </button>
  );

  return (
    <span className="usg-wrap" ref={root} onKeyDown={(e) => open && e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), close())}>
      <button
        type="button"
        id="usage-block"
        className={`it usg${open ? ' on' : ''}`}
        data-hint-quiet
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ left: Math.max(4, r.left), bottom: window.innerHeight - r.top + 4 });
          setOpen((o) => !o);
        }}
      >
        <span className="usg-w">{t('usageBar.used')}</span>
        {AGENTS.map(([agent, name]) => {
          const list = mine(agent);
          // One account per agent on the bar: the one new sessions start on (the account switch's pick).
          const a = list.find((x) => x.session_default) ?? list.find((x) => x.default) ?? list[0];
          if (!a) return null;
          const ws = windows(t, rowOf(a));
          const top = most(ws);
          const n = agent === 'codex' ? (resets.lines[a.id]?.read?.available ?? 0) : 0;
          return (
            <span className="usg-p" key={agent} data-usage={agent}>
              <AgentLogo kind={agent} size={12} />
              <span className="sr">{name}</span>
              {top && (
                <i className="mini" data-tone={tone(top.used)}>
                  <b style={{ width: `${Math.max(3, Math.min(100, top.used))}%` }} />
                </i>
              )}
              {top ? (
                <span className="usg-t" data-tone={tone(top.used)}>
                  {text(ws)}
                  {asOf(rowOf(a)) && <span className="dim"> · {asOf(rowOf(a))}</span>}
                </span>
              ) : (
                <span className="usg-t dim">{t('usageBar.noData')}</span>
              )}
              {n > 0 && <span className="usg-rst">{n === 1 ? t('usageBar.oneReset') : t('usage.reset.countNoDate', { n })}</span>}
            </span>
          );
        })}
      </button>
      {refreshButton('it usg-ref')}
      {open && (
        <div className="usg-pop glass" role="dialog" aria-label={t('usage.title')} style={pos}>
          <div className="u-head">
            <b>{t('usage.title')}</b>
            <span className="grow" />
            <span className="dim">{[t('usageBar.all'), at && ageText(new Date(at).toISOString(), now, t)].filter(Boolean).join(' · ')}</span>
            {refreshButton('u-refresh')}
          </div>
          <div className="u-seg">
            <span className="dseg" role="radiogroup" aria-label={t('usageBar.density')}>
              {([false, true] as const).map((v) => (
                <label key={String(v)}>
                  <input type="radio" name="usg-density" checked={compact === v} onChange={() => density(v)} />
                  {t(v ? 'usageBar.compact' : 'usageBar.detailed')}
                </label>
              ))}
            </span>
          </div>
          <div className="u-rows">
            {AGENTS.flatMap(([agent, name]) =>
              mine(agent).map((a, i) => {
                const row = rowOf(a);
                const ws = windows(t, row);
                const top = most(ws);
                const soon = ws.reduce<Window | undefined>((x, w) => (!x || w.resets_at < x.resets_at ? w : x), undefined);
                const line = resets.lines[a.id] ?? {};
                return (
                  <div className="u-row" key={`${agent}:${a.id}`} data-usage-row={`${agent}:${a.id}`}>
                    <div className="u-top">
                      <span className="u-ic">
                        <AgentLogo kind={agent} size={12} />
                      </span>
                      <span className="u-name">
                        {name}
                        <span className="dim"> · {accountName(t, a)}</span>
                      </span>
                      {top &&
                        (compact ? (
                          <span className="u-reset">
                            <span className="l">{left(top)}</span> <b className="v" data-tone={tone(top.used)}>{top.used}%</b>
                          </span>
                        ) : (
                          <span className="u-reset">{t('usageBar.resetsIn', { time: left(soon!) })}</span>
                        ))}
                    </div>
                    {top && asOf(row) && <div className="u-line dim">{asOf(row)}</div>}
                    {!top && <div className="u-line dim">{row?.limit_resets ? t('settings.accounts.limit', { when: row.limit_resets }) : t('usage.v4.noRecords')}</div>}
                    {top && !compact && (
                      <div className="u-bars">
                        {ws.map((w) => (
                          <span className="u-m" key={w.label}>
                            <span className="l">{w.label}</span>
                            <i className="bar" data-tone={tone(w.used)}>
                              <b style={{ width: `${Math.max(3, Math.min(100, w.used))}%` }} />
                            </i>
                            <span className="v" data-tone={tone(w.used)}>
                              {w.used}%
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                    {/* The reset tickets stay in Compact too: an action is never hidden by a density. */}
                    {agent === 'codex' && resetsOn && <ResetLineView t={t} line={line} onAsk={() => resets.confirm(a.id, true)} onUse={() => void resets.use(a.id).then(read)} onCancel={() => resets.confirm(a.id, false)} />}
                    {agent === 'codex' && !resetsOn && i === 0 && (
                      <>
                        <div className="rst">
                          <span className="dim">{t('usageBar.resetsOff')}</span>
                          <button type="button" className="btn" onClick={() => void setResetsOn(true)}>
                            {t('chat.pr.turnOn')}
                          </button>
                        </div>
                        <div className="u-hint">{t('usageBar.resetsNote')}</div>
                      </>
                    )}
                  </div>
                );
              }),
            )}
          </div>
          <button type="button" className="u-foot" onClick={() => (setOpen(false), openUsage())}>
            <span>{t('usageBar.details')}</span>
            <Icon name="chevron-right" size={12} />
          </button>
          <button type="button" className="u-foot" onClick={() => (setOpen(false), onManage())}>
            <span>{t('accountSwitch.manage')}</span>
            <Icon name="chevron-right" size={12} />
          </button>
        </div>
      )}
    </span>
  );
}
