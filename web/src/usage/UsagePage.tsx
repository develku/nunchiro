// Settings · Usage (V2.5-10, needs 135): tokens and estimated cost per provider and account over the chosen range,
// and each account's session and weekly remaining share where the agent's own files record one. One local request
// (`account_usage`, transcripts on this Mac); no billing API and no outbound call (needs 82).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Key } from '../i18n';
import { accountName, type Account, type AccountUsage as CoreUsage, type CoreClient } from '../api';
import { usageAsk } from '../settings/accounts/AccountsPage';
import { Seg, Select } from '../settings/shell/Row';
import { PageSummary } from '../settings/shell/PageActions';
import type { Session } from '../types';
import '../settings/accounts/accounts.css';
import { ResetLineView, ResetLog, useResets, useResetsOn } from './CodexResets';
import { AGENTS, Daily, type Detail, dollars, Hours, Meter, Mix, Providers, type Tab, Tabs, Tiles } from './UsageDetail';
import './usage-v4.css';
import { ErrorDetails, ErrorLine, plainError, rawError } from '../errors';

export { dollars };
type Days = '1' | '7' | '30' | '90';
const RANGE_KEY = 'nunchiro.usage.range.v1';
type Scope = 'mac' | 'nunchiro';

type T = (key: Key, args?: Record<string, string | number>) => string;
/** Ticket 211: the core's row also says where a linked default folder points and which models it could not price. */
type AccountUsage = CoreUsage & { link?: { target: string; status: 'followed' | 'capped' | 'outside' | 'unsafe' }; unpriced_models?: string[] };
const REFRESH_MS = 60_000;
/** Look 1117 v5 (C S2-1): the core's first read of the records takes seconds. The last numbers this window had (rows, and
 *  each range's sums with when they were read) show at once on the next open, also after a relaunch, and refresh in place. */
const LAST_KEY = 'nunchiro.usage.last.v1';
type Kept = { rows?: AccountUsage[]; details?: [string, { detail: Detail; updated: number }][] };
let kept: Kept | null = null;
const lastKept = (): Kept => {
  if (kept) return kept;
  try {
    kept = JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') as Kept;
  } catch {
    kept = {};
  }
  return kept;
};
const keep = (patch: Kept) => {
  kept = { ...lastKept(), ...patch };
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(kept));
  } catch {
    // memory only: this window still shows them
  }
};
const keptDetail = (q: string) => lastKept().details?.find(([k]) => k === q)?.[1];

/** The note under an account name when its default folder is a link: where it goes, or why it was not read. */
function LinkNote({ t, link, onAllow }: { t: T; link: NonNullable<AccountUsage['link']>; onAllow: (target: string) => Promise<void> }) {
  const key = { followed: 'usage.viaLink', capped: 'usage.viaLink', outside: 'usage.linkOutside', unsafe: 'usage.linkUnsafe' } as const;
  const [busy, setBusy] = useState(false);
  return (
    <>
      {/* A path reference: right-click offers Copy path / Reveal (system.md Basic interactions). */}
      <div className={link.status === 'outside' || link.status === 'unsafe' ? 'dim' : 'dim mono'} data-menu="path" data-menu-arg={link.target} title={link.target}>
        {t(key[link.status], { target: link.target })}
      </div>
      {link.status === 'outside' && (
        <button
          type="button"
          className="btn"
          disabled={busy}
          aria-busy={busy}
          title={link.target}
          onClick={() => {
            setBusy(true);
            void onAllow(link.target).finally(() => setBusy(false));
          }}
        >
          {t('usage.allowFolder')}
        </button>
      )}
    </>
  );
}

/** Sixth look (C, S2): the first open in a new home showed only "Reading the records…" for 7 s (the core reads every
 *  transcript). A window that has kept no numbers yet reads the rows and the default range once in the background, so
 *  the page's first open shows them at once and refreshes in place. One request at a time: the window runs 4 at most. */
export async function warmUsage(core: CoreClient) {
  if (lastKept().rows) return;
  try {
    keep({ rows: (await core.accountUsage()).rows as AccountUsage[] });
    const q = JSON.stringify({ days: 30 });
    const reply = (await core.request({ op: 'usage_detail', days: 30 })) as { detail: Detail };
    keep({ details: [[q, { detail: reply.detail, updated: Date.now() }]] });
  } catch {
    // The page reads again when it opens and says what failed.
  }
}

export function UsagePage({ t, core }: { t: T; core: CoreClient }) {
  const [rows, setRows] = useState<AccountUsage[] | null>(() => lastKept().rows ?? null);
  // This page's own first read is back (kept rows from before do not count: the sums wait for it, see `first`).
  const [read, setRead] = useState(false);
  const [labels, setLabels] = useState<Account[]>([]);
  const [error, setError] = useState(false);
  const busy = useRef(false);
  // A read asked for while another runs (after the owner allowed a folder) runs once the first ends.
  const again = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const fresh = (await core.accountUsage()).rows as AccountUsage[];
      setRows(fresh);
      keep({ rows: fresh });
      setRead(true);
      setError(false);
    } catch {
      setError(true);
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, [core]);
  const [allowError, setAllowError] = useState('');
  // Ticket 211: the owner names the folder a link points to; the core stores it (settings.json) and the next read follows it.
  const allow = async (target: string) => {
    setAllowError('');
    try {
      await core.request({ op: 'quit_settings', patch: { usage_allow_link: target } });
      if (busy.current) again.current = true; // only a read that began before the folder was allowed needs a repeat
      void load();
      void loadDetail(query);
    } catch (e) {
      setAllowError(rawError(e));
    }
  };
  useEffect(() => {
    void load();
    // Names only; the usage cells never wait for the sign-in probes behind this list.
    core.accounts().then(
      (r) => setLabels(r.accounts),
      () => {},
    );
    const tick = () => document.visibilityState === 'visible' && void load();
    const timer = setInterval(tick, REFRESH_MS);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [core, load]);
  // The v4 page (usage.html v4): the range's sums, read on open, on a range change and on Refresh (never on the timer).
  // Look 1117 v4f (C S3-2): the chosen range is kept after a relaunch, in this window's storage.
  const [days, setDaysState] = useState<Days>(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      return v === '1' || v === '7' || v === '30' || v === '90' ? v : '30';
    } catch {
      return '30';
    }
  });
  const setDays = (d: Days) => {
    setDaysState(d);
    try {
      localStorage.setItem(RANGE_KEY, d);
    } catch {
      // memory only
    }
  };
  // Ticket 324 (usage.html toolbar): what the range's sums count; "" is every account.
  const [scope, setScope] = useState<Scope>('mac');
  const [account, setAccount] = useState('');
  useEffect(() => {
    if (!usageAsk.account) return;
    setAccount(usageAsk.account);
    usageAsk.account = '';
  }, []);
  // The filtered account is gone: back to all accounts, not a page of zeros under a filter the list no longer shows.
  useEffect(() => {
    if (rows && account && !rows.some((r) => `${r.agent}:${r.id}` === account)) setAccount('');
  }, [rows, account]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [updated, setUpdated] = useState<number | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tab, setTab] = useState<Tab>('project');
  const [now, setNow] = useState(() => Date.now());
  const [resetsOn] = useResetsOn(core);
  const resets = useResets(core);
  // Only the newest question's answer is drawn: a slow 90-day read must not replace the filter picked after it.
  const asked = useRef('');
  const loadDetail = useCallback(
    async (q: string) => {
      asked.current = q;
      try {
        const reply = (await core.request({ op: 'usage_detail', ...JSON.parse(q) })) as { detail: Detail };
        if (asked.current !== q) return;
        const at = Date.now();
        setDetail(reply.detail);
        setDetailError('');
        setUpdated(at);
        // The newest few ranges and filters only.
        keep({ details: [[q, { detail: reply.detail, updated: at }] as [string, { detail: Detail; updated: number }], ...(lastKept().details ?? []).filter(([k]) => k !== q)].slice(0, 4) });
      } catch (e) {
        if (asked.current === q) setDetailError(rawError(e));
      }
    },
    [core],
  );
  const query = JSON.stringify({
    days: Number(days),
    account: account || undefined,
    sessions: scope === 'nunchiro' ? sessions.flatMap((s) => (s.agent_session_id ? [s.agent_session_id] : [])) : undefined,
  });
  // After the first usage read: the window runs at most 4 jobs at once, and opening the page already takes 2 (usage, and
  // the account list with its sign-in probes); a click must still find one. W10 core 14: not after the account list too,
  // whose probes take seconds per account; the names fill in when it comes.
  const first = read || error;
  // The kept sums of this question show before its read is back (before the first paint, so no empty page flashes).
  useLayoutEffect(() => {
    const k = keptDetail(query);
    if (k) (setDetail(k.detail), setUpdated(k.updated));
  }, [query]);
  useEffect(() => {
    if (first) void loadDetail(query);
  }, [first, query, loadDetail]);
  const loadSessions = useCallback(() => core.request({ op: 'snapshot' }).then((r) => setSessions((r as { sessions: Session[] }).sessions), () => {}), [core]);
  useEffect(() => void loadSessions(), [loadSessions]);
  // Refresh: usage, the session list (a new session changes `query`, which reads the sums again), the range's sums and,
  // only while "Show Codex resets" is on, one codex read per Codex account.
  const refresh = () => {
    setNow(Date.now());
    void load();
    void loadSessions();
    void loadDetail(query);
    if (resetsOn) void resets.refresh((rows ?? []).filter((r) => r.agent === 'codex').map((r) => r.id));
  };
  const ownName = (agent: string) => accountName(t, labels.find((a) => a.agent === agent && a.default) ?? { default: true, label: 'Default' });
  const name = (r: AccountUsage) => (r.id === 'own' ? ownName(r.agent) : labels.find((a) => a.agent === r.agent && a.id === r.id)?.label ?? r.id.slice(0, 8));

  const accounts = AGENTS.flatMap(([agent, title]) => (rows ?? []).filter((r) => r.agent === agent).map((r) => ({ r, agent, title, key: `${agent}:${r.id}` })));
  const counts = Object.fromEntries(AGENTS.map(([agent]) => [agent, accounts.filter((a) => a.agent === agent).length]));
  const ranges: [Days, string][] = [
    ['1', t('usage.col.day')],
    ['7', t('usage.col.week')],
    ['30', t('usage.v4.d30')],
    ['90', t('usage.v4.d90')],
  ];

  const rangeName = ranges.find(([d]) => d === days)![1];

  // Needs 225 and D2: the page follows the mockup's rows; its title and description are the page header's.
  return (
    <section id="s-usage" aria-label={t('usage.title')} className="accounts ssec usage4">
      <PageSummary parts={[[t('summary.range'), rangeName], [t('summary.accounts'), rows && accounts.length]]} />
      <div className="u4-toolbar">
        <Seg<Days> name="u4-range" label={t('usage.v4.range')} value={days} options={ranges} onChange={setDays} />
        <Seg<Scope>
          name="u4-scope"
          label={t('usage.v4.scope')}
          value={scope}
          options={[
            ['mac', t('usage.v4.scopeMac')],
            ['nunchiro', t('usage.v4.scopeNunchiro')],
          ]}
          onChange={setScope}
        />
        <Select label={t('usage.v4.account')} value={account} onChange={setAccount}>
          <option value="">{t('usage.v4.allAccounts')}</option>
          {accounts.map((a) => (
            <option key={a.key} value={a.key}>
              {a.title} · {name(a.r)}
            </option>
          ))}
        </Select>
        <span className="u4-gap" />
        {updated && <span className="dim">{t('usage.v4.updated', { time: new Date(updated).toLocaleTimeString(document.documentElement.lang || undefined, { hour: 'numeric', minute: '2-digit' }) })}</span>}
        <button type="button" className="btn" aria-label={t('usage.v4.refreshAria')} disabled={resets.busy} aria-busy={resets.busy || undefined} onClick={refresh}>
          {t('usage.v4.refresh')}
        </button>
      </div>
      {rows === null && !error && (
        <p className="dim" role="status">
          {t('usage.loading')}
        </p>
      )}
      {error && (
        <p className="conflict" role="alert">
          {t('usage.error')}
        </p>
      )}
      <ErrorLine t={t} error={detailError} />
      {allowError && (
        <div className="conflict" role="alert">
          {t('usage.allowError', { error: plainError(t, allowError) })}
          <ErrorDetails t={t} details={allowError} />
        </div>
      )}
      {detail?.partial && <p className="dim">{t('usage.v4.partial')}</p>}
      <div className="u4-r1">
        <div className="u4-col">
          <h3>{t('usage.v4.summary')}</h3>
          {detail ? <Tiles t={t} d={detail} /> : <p className="dim">{t('usage.v4.loading')}</p>}
          {resetsOn && <ResetLog t={t} log={resets.log} problem={resets.logProblem} />}
        </div>
        <div className="u4-col">
          <h3>{t('usage.v4.limits')}</h3>
          <div className="scard u4-lims" role="group" aria-label={t('usage.v4.limits')}>
            {accounts
              .filter((a) => !account || a.key === account)
              .map(({ r, agent, title, key }) => (
                <div key={key} className="lim" data-limit={key} tabIndex={-1}>
                  <div className="who">
                    {title} · {name(r)}
                    <small>{t(r.session || r.weekly ? 'usage.v4.fromRecords' : 'usage.v4.noRecords')}</small>
                    {r.link && <LinkNote t={t} link={r.link} onAllow={allow} />}
                  </div>
                  <Meter t={t} label={t('usage.v4.session')} limit={r.session} span={5 * 3600} now={now} />
                  <Meter t={t} label={t('usage.v4.weekly')} limit={r.weekly} span={7 * 86_400} now={now} />
                  {agent === 'codex' && resetsOn && (
                    <ResetLineView
                      t={t}
                      line={resets.lines[r.id] ?? {}}
                      onAsk={() => resets.confirm(r.id, true)}
                      onUse={() => void resets.use(r.id)}
                      onCancel={() => resets.confirm(r.id, false)}
                    />
                  )}
                </div>
              ))}
          </div>
          <p className="dim u4-note">{t('usage.v4.paceNote')}</p>
        </div>
      </div>
      {detail && (
        <div className="u4-r3">
          <Daily t={t} d={detail} />
          <Mix t={t} d={detail.total} range={rangeName} />
          <Hours t={t} d={detail} range={rangeName} />
        </div>
      )}
      <Tabs t={t} tab={tab} onTab={setTab} d={detail} sessions={sessions} ownName={ownName} agentPanel={detail && <Providers t={t} d={detail} sessions={sessions} counts={counts} only={account} filtered={days !== '90' || scope !== 'mac' || !!account} />} />
      <div className="retain">
        <span className="ic" aria-hidden>
          !
        </span>
        <div>
          <p>{t('usage.v4.retain')}</p>
          <p>{t('usage.v4.retain2')}</p>
        </div>
      </div>
    </section>
  );
}
