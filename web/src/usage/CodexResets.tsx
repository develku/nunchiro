// Codex reset tickets on Settings > Accounts and Usage (needs 225; mockup docs/design/usage-1106/usage.html v4: Accounts
// "남은 한도" and "에이전트의 리셋권 사용"; Usage, the Codex row of the limits card and "리셋권 요청과 기록"; design
// codex-reset.md). Off by default. Turning it on starts nothing: only the owner's Refresh press reads (the core starts
// the user's own codex once per Codex account), and "Use a reset" confirms every time, with no "don't ask again". The
// agent policy is the core's `settings.json` `features`, written only through the owner's `quit_settings`. The log is
// the core's `codex-resets.json` (who, when, why, rule, outcome). Confirm copy lifted from Orca (MIT License, Copyright
// (c) 2026 Lovecast Inc.; CodexSwitcherMenu.tsx "Reset Codex limits?").
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { accountName, type CoreClient } from '../api';
import type { Key } from '../i18n';
import { RadioCards, Reset, Row, Sec, Switch } from '../settings/shell/Row';
import { useCoreFeature } from '../settings/useFeatureSetting';
import './codex-resets.css';
import { ErrorLine, rawError } from '../errors';

type T = (key: Key, args?: Record<string, string | number>) => string;
export type ResetRead = { available: number; next_expires_at: number | null };
/** One account's line: the last read, a use in flight or confirming, its outcome or refusal. */
export type ResetLine = { read?: ResetRead; busy?: boolean; confirm?: boolean; outcome?: string; error?: string };
export type ResetEntry = { at: number; account: string; own?: boolean; how: 'owner' | 'approved' | 'auto' | 'asked' | 'denied' | 'refused'; session?: string; title?: string; rule?: string; why?: string; outcome?: string };
/** The core's word on a log it cannot read (now) or moved aside (`set_aside_at`, automatic uses refused 7 days). */
export type LogProblem = { unreadable: boolean; set_aside_at?: number };
type Mode = 'off' | 'ask' | 'allow';

const OUTCOMES = ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed', 'unknown', 'failed'];
const RULES = ['off', 'expiring', 'conditions', 'weekly_not_used_up', 'week_max', 'keep_last', 'none_left', 'account_gone', 'codex_error'];
const KEY = 'usage.codex_resets';
const message = (e: unknown) => rawError(e);
const day = (s: number) => new Date(s * 1000).toLocaleDateString(document.documentElement.lang || undefined, { month: 'short', day: 'numeric' });
const when = (s: number) => new Date(s * 1000).toLocaleString(document.documentElement.lang || undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// "Show Codex resets" is read by the Accounts part (its switch) and the Usage part (the limits card), so one value
// serves both: read once from the core, written through `quit_settings`, every reader told.
let shownOn: boolean | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const publish = (v: boolean) => ((shownOn = v), listeners.forEach((l) => l()));
type SettingsReply = { settings: { features?: Record<string, unknown> } };
const take = (r: unknown) => publish((r as SettingsReply).settings.features?.[KEY] === true);
export function useResetsOn(core: CoreClient): [boolean, (v: boolean) => Promise<void>, string] {
  const on = useSyncExternalStore(subscribe, () => shownOn) ?? false;
  const [error, setError] = useState('');
  useEffect(() => void core.request({ op: 'quit_settings' }).then(take, (e) => setError(message(e))), [core]);
  const set = useCallback(
    (v: boolean) =>
      core.request({ op: 'quit_settings', patch: { features: { [KEY]: v } } }).then(
        (r) => (take(r), setError('')),
        (e) => setError(message(e)),
      ),
    [core],
  );
  return [on, set, error];
}

export function resetCount(t: T, r: ResetRead) {
  if (r.available === 0) return t('usage.reset.none');
  if (r.next_expires_at === null) return t('usage.reset.countNoDate', { n: r.available });
  return r.available === 1 ? t('usage.reset.countOne', { date: day(r.next_expires_at) }) : t('usage.reset.count', { n: r.available, date: day(r.next_expires_at) });
}
const outcomeText = (t: T, o?: string) => (o && OUTCOMES.includes(o) ? t(`usage.reset.out.${o}` as Key) : o ?? '');

/** The Usage page's reset state: one line per Codex account, the log, Refresh (one codex at a time) and Use. */
export function useResets(core: CoreClient) {
  const [lines, setLines] = useState<Record<string, ResetLine>>({});
  const [log, setLog] = useState<ResetEntry[]>([]);
  const [logProblem, setLogProblem] = useState<LogProblem | undefined>();
  const set = (id: string, l: ResetLine) => setLines((all) => ({ ...all, [id]: l }));
  const loadLog = useCallback(() => core.request({ op: 'codex_reset_log' }).then((r) => {
        const { entries, problem } = r as { entries: ResetEntry[]; problem?: LogProblem };
        setLog(entries);
        setLogProblem(problem);
      }, () => {}), [core]);
  useEffect(() => void loadLog(), [loadLog]);
  const refresh = async (ids: string[]) => {
    for (const id of ids) {
      set(id, { busy: true });
      try {
        set(id, { read: (await core.request({ op: 'codex_reset_read', account: id })) as ResetRead });
      } catch (e) {
        set(id, { error: message(e) });
      }
    }
  };
  const use = async (id: string) => {
    set(id, { ...lines[id], busy: true, confirm: false, outcome: undefined, error: undefined });
    try {
      const r = (await core.request({ op: 'codex_reset_use', account: id, reason: '' })) as { outcome: string; after?: ResetRead };
      set(id, { read: r.after, outcome: r.outcome });
    } catch (e) {
      // No read: Use stays hidden until a fresh Refresh succeeds (a result that is not known may have been spent).
      set(id, { error: message(e) });
    }
    void loadLog();
  };
  const confirm = (id: string, open: boolean) => set(id, { ...lines[id], confirm: open, outcome: undefined });
  return { lines, log, logProblem, refresh, use, confirm, busy: Object.values(lines).some((l) => l.busy) };
}

/** The Codex row's reset line in the limits card (mockup `.rst`): count and expiry, Use a reset, its confirm. */
export function ResetLineView({ t, line, onAsk, onUse, onCancel }: { t: T; line: ResetLine; onAsk: () => void; onUse: () => void; onCancel: () => void }) {
  return (
    // `data-ask`: the status bar's popover lays the open confirm out on the whole line (chrome/usage-block.css).
    <div className="rst" data-ask={line.confirm || undefined}>
      <span>{line.busy ? t('usage.reset.reading') : line.read ? resetCount(t, line.read) : t('usage.reset.notRead')}</span>
      {line.read && line.read.available > 0 && !line.confirm && !line.busy && (
        <button type="button" className="btn" onClick={onAsk}>
          {t('usage.reset.use')}
        </button>
      )}
      {line.confirm && (
        <span className="cxr-confirm" role="group" aria-label={t('usage.reset.confirmAria')}>
          <span>{t('usage.reset.confirm')}</span>
          <button type="button" className="btn pri" onClick={onUse}>
            {t('usage.reset.confirmUse')}
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            {t('usage.reset.cancel')}
          </button>
        </span>
      )}
      {line.outcome && <span role="status">{outcomeText(t, line.outcome)}</span>}
      <ErrorLine t={t} error={line.error} />
    </div>
  );
}

/** "리셋권 사용 기록": who, when, which session, why (the rule, the agent's reason, the outcome). */
export function ResetLog({ t, log, problem }: { t: T; log: ResetEntry[]; problem?: LogProblem }) {
  const detail = (e: ResetEntry) => {
    const rule = e.rule && RULES.includes(e.rule) ? t(`usage.reset.rule.${e.rule}` as Key) : '';
    return [rule, e.why, e.outcome ? outcomeText(t, e.outcome) : ''].filter(Boolean).join(' · ');
  };
  return (
    <div className="cxr-logcard">
      <h3>{t('usage.reset.log')}</h3>
      {problem && (
        <p className="conflict" role="alert">
          {problem.unreadable || problem.set_aside_at === undefined
            ? t('usage.reset.logUnreadable')
            : t('usage.reset.logSetAside', { file: `codex-resets.json.bad-${problem.set_aside_at}`, date: day(problem.set_aside_at + 7 * 86_400) })}
        </p>
      )}
      {log.length === 0 ? (
        <p className="dim">{t('usage.reset.logEmpty')}</p>
      ) : (
        <ul className="cxr-log" aria-label={t('usage.reset.log')}>
          {log.map((e, i) => (
            <li key={i}>
              <span className="dim mono">{when(e.at)}</span>
              <span>
                <b>{t(`usage.reset.how.${e.how}` as Key)}</b>
                {e.title ? ` · ${e.title}` : ''} · {accountName(t, { default: e.own, label: e.account })}
              </span>
              <span className="dim">{detail(e)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Accounts part: "Limits" (Show Codex resets) and the agents' policy with its four conditions. */
export function CodexResetSettings({ t, core }: { t: T; core: CoreClient }) {
  const [on, setOn, onError] = useResetsOn(core);
  const [mode, setMode] = useCoreFeature<Mode>('usage.codex_reset_agent', 'ask');
  const [weekly, setWeekly] = useCoreFeature('usage.codex_reset_weekly_only', true);
  const [max, setMax] = useCoreFeature('usage.codex_reset_week_max', 2);
  const [keep, setKeep] = useCoreFeature('usage.codex_reset_keep_last', true);
  const [expiring, setExpiring] = useCoreFeature('usage.codex_reset_expiring', true);
  return (
    <div id="s-codex-resets" className="cxr">
      <Sec id="h-limits" title={t('usage.reset.limitsTitle')}>
        <Row
          label={t('usage.reset.show')}
          desc={<span id="cxr-show-desc">{t('usage.reset.showDesc')}</span>}
          setting={KEY}
          reset={<Reset t={t} label={t('usage.reset.show')} show={on} run={() => void setOn(false)} />}
          control={<Switch label={t('usage.reset.show')} describedBy="cxr-show-desc" setting={KEY} checked={on} onChange={(v) => void setOn(v)} />}
        />
        <ErrorLine t={t} error={onError} />
      </Sec>
      <Sec id="h-reset-agent" title={t('usage.reset.agentTitle')}>
        <Row
          id="cxr-agent"
          label={t('usage.reset.agent')}
          desc={t('usage.reset.agentDesc')}
          top
          setting="usage.codex_reset_agent"
          // The mode and its four conditions go back together: the conditions are part of what "allow" means.
          reset={<Reset t={t} label={t('usage.reset.agent')} show={mode !== 'ask' || !weekly || max !== 2 || !keep || !expiring} run={() => void Promise.all([setMode(null), setWeekly(null), setMax(null), setKeep(null), setExpiring(null)])} />}
          extra={
            <>
              <RadioCards<Mode>
                name="cxr-agent"
                value={mode}
                labelledBy="cxr-agent"
                cols
                setting="usage.codex_reset_agent"
                options={[
                  ['off', t('usage.reset.mode.off'), t('usage.reset.mode.offCap')],
                  ['ask', t('usage.reset.mode.ask'), t('usage.reset.mode.askCap')],
                  ['allow', t('usage.reset.mode.allow'), t('usage.reset.mode.allowCap')],
                ]}
                onChange={(v) => void setMode(v)}
              />
              {mode === 'allow' && (
                <div className="cxr-conds" role="group" aria-label={t('usage.reset.conds')}>
                  <span className="cxr-h" aria-hidden>
                    {t('usage.reset.conds')}
                  </span>
                  <label>
                    <input type="checkbox" checked={weekly} onChange={(e) => void setWeekly(e.target.checked)} /> {t('usage.reset.cond.weekly')}
                  </label>
                  <span className="cxr-cap">
                    <input type="checkbox" aria-label={t('usage.reset.cond.capToggle')} checked={max > 0} onChange={(e) => void setMax(e.target.checked ? 2 : 0)} />
                    <span aria-hidden>{t('usage.reset.cond.cap')}</span>
                    <input
                      type="number"
                      min={1}
                      max={9}
                      aria-label={t('usage.reset.cond.capAria')}
                      disabled={max === 0}
                      data-idle={max === 0 || undefined}
                      value={max || 2}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isInteger(n) && n >= 1 && n <= 9) void setMax(n);
                      }}
                    />
                    <span aria-hidden>{t('usage.reset.cond.capUnit')}</span>
                  </span>
                  <label>
                    <input type="checkbox" checked={keep} onChange={(e) => void setKeep(e.target.checked)} /> {t('usage.reset.cond.keep')}
                  </label>
                  <label>
                    <input type="checkbox" checked={expiring} onChange={(e) => void setExpiring(e.target.checked)} /> {t('usage.reset.cond.expiring')} <span className="dim">{t('usage.reset.cond.expiringWhy')}</span>
                  </label>
                  <span className="dim">{t('usage.reset.cond.foot')}</span>
                </div>
              )}
            </>
          }
        />
      </Sec>
    </div>
  );
}
