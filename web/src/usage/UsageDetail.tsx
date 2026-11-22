// The v4 Usage page's parts (docs/design/usage-1106/usage.html v4, owner 2026-11-06 15:40 "대체적으로 시안 좋은데 배치만
// 신경쓰면 좋겠다"): summary tiles, the limits card, the 6-week grid, the token mix, busy hours and the four tabs. Their
// numbers come from the core's `usage_detail` (one read of the local records, nothing stored); the per-account table
// and limits from `account_usage`. Lifted from Orca (MIT License, Copyright (c) 2026 Lovecast Inc.; 1.4.214): the
// intensity steps by share of the best day (0, <=25%, <=50%, <=75%, above; `usage-overview-daily-series.ts:8-24`), the
// token mix bar and the cache share (`usage-overview-sections.tsx:38-126`, `usage-overview-model.ts:72-73`).
import type { KeyboardEvent, ReactNode } from 'react';
import type { AccountAgent } from '../api';
import type { Key } from '../i18n';
import type { Session } from '../types';
import { openSession } from '../tree';
import { tokens } from '../settings/accounts/AccountsPage';

type T = (key: Key, args?: Record<string, string | number>) => string;
export type Sum = { tokens: number; parts: [number, number, number, number]; cost_micro: number; unpriced: number; turns: number };
export type Group = Sum & { key: string; sessions: number; top_model?: string; agent?: 'claude' | 'codex'; account?: string; cwd?: string };
export type Detail = { days: number; total: Sum; active_days: number; first_day: number; daily: number[]; hours: number[]; agents: Group[]; models: Group[]; folders: Group[]; sessions: Group[]; partial: boolean };
export type Limit = { left_pct: number; resets_at: number };
export const TABS = ['agent', 'model', 'project', 'session'] as const;
export const AGENTS: [AccountAgent, string][] = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
];
export type Tab = (typeof TABS)[number];

/** Millionths of a dollar as `$3.00`; below a cent `<$0.01`. */
export const dollars = (micro: number) => (micro > 0 && micro < 10_000 ? '<$0.01' : `$${(micro / 1e6).toFixed(2)}`);
const pct = (n: number, of: number) => (of > 0 ? Math.round((100 * n) / of) : 0);
const dayLabel = (day: number) => new Date(day * 86_400_000).toLocaleDateString(document.documentElement.lang || undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** Orca's five steps by share of the best value. */
const step = (v: number, max: number) => (v <= 0 || max <= 0 ? 0 : v <= max * 0.25 ? 1 : v <= max * 0.5 ? 2 : v <= max * 0.75 ? 3 : 4);
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

export function Tiles({ t, d }: { t: T; d: Detail }) {
  if (d.total.tokens === 0)
    return (
      <div className="tiles" role="group" aria-label={t('usage.v4.summary')}>
        <p className="dim" role="status">
          {t('usage.v4.noRange')}
        </p>
      </div>
    );
  const of = (agent: string) => d.agents.find((g) => g.key === agent)?.tokens ?? 0;
  // The grid is always the last 42 days; only its last `days` are inside the range, so the best day cannot outweigh the total.
  const inRange = d.daily.slice(-d.days);
  const peak = Math.max(0, ...inRange);
  const best = d.first_day + d.daily.length - inRange.length + inRange.indexOf(peak);
  const cache = pct(d.total.parts[3], d.total.parts[0] + d.total.parts[3]);
  const tile = (k: string, v: string, s: string) => (
    <div className="tile">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      <span className="s">{s}</span>
    </div>
  );
  return (
    <div className="tiles" role="group" aria-label={t('usage.v4.summary')}>
      {tile(t('usage.v4.total'), tokens(d.total.tokens), t('usage.v4.totalSub', { claude: tokens(of('claude')), codex: tokens(of('codex')) }))}
      {tile(t('usage.v4.cost'), dollars(d.total.cost_micro), t(d.total.unpriced > 0 ? 'usage.v4.costSome' : 'usage.v4.costAll'))}
      {tile(t('usage.v4.active'), t('usage.v4.activeVal', { n: d.active_days, days: d.days }), peak > 0 ? t('usage.v4.bestDay', { day: dayLabel(best), tokens: tokens(peak) }) : '')}
      {tile(t('usage.v4.cache'), `${cache}%`, t('usage.v4.cacheSub'))}
    </div>
  );
}

/** One window's bar: used share, and a line at the share of the window already gone (T3 Code's pace, ticket 218). */
export function Meter({ t, label, limit, span, now }: { t: T; label: string; limit?: Limit; span: number; now: number }) {
  if (!limit)
    return (
      <div className="meter off">
        <div className="t">
          <span>{label}</span>
          <span>{t('usage.v4.noLimit')}</span>
        </div>
        <div className="track" />
      </div>
    );
  const used = 100 - limit.left_pct;
  const gone = Math.min(100, Math.max(0, 100 * (1 - (limit.resets_at - now / 1000) / span)));
  const lang = document.documentElement.lang || undefined;
  const time = new Date(limit.resets_at * 1000).toLocaleString(lang, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  // The floor estimate is a straight line through the window so far (usage.html: 단순 선형), shown only when it lands
  // before the reset and at least 5% of the window has passed (earlier, a handful of tokens swings the line wildly).
  const empties = used > gone && gone >= 5 && used < 100 ? now + (((100 - used) / used) * (gone / 100) * span * 1000) : null;
  const pace = empties
    ? t('usage.v4.paceFloor', { when: new Date(empties).toLocaleString(lang, { weekday: 'long', dayPeriod: 'long' }) })
    : t(used > gone ? 'usage.v4.paceFast' : used < gone * 0.6 ? 'usage.v4.paceSlack' : 'usage.v4.paceNormal');
  return (
    <div className="meter">
      <div className="t">
        <span>{label}</span>
        <span>{t('usage.v4.used', { pct: used, time })}</span>
      </div>
      <div className={`track${used >= 100 ? ' hot full' : used > gone ? ' hot' : ''}`}>
        <span className="used" style={{ width: `${used}%` }} />
        <span className="pace" style={{ left: `${gone}%` }} />
      </div>
      <span className="u4-pace">{pace}</span>
    </div>
  );
}

export function Daily({ t, d }: { t: T; d: Detail }) {
  const today = d.first_day + d.daily.length - 1;
  // Six Monday-first weeks ending with this one (usage.html); 1970-01-01 was a Thursday. The core's 42 days always cover them.
  const start = today - ((today + 3) % 7) - 35;
  const of = (day: number) => d.daily[day - d.first_day] ?? 0;
  const shown = Array.from({ length: today - start + 1 }, (_, i) => of(start + i));
  const max = Math.max(0, ...shown);
  const best = start + shown.indexOf(max);
  const names = t('usage.v4.weekdays').split(' ');
  const short = (day: number) => {
    const at = new Date(day * 86_400_000);
    return `${at.getUTCMonth() + 1}/${at.getUTCDate()}`;
  };
  return (
    <div className="u4-card">
      <div className="hm-head">
        <div>
          <h4>{t('usage.v4.daily')}</h4>
          <p>{t('usage.v4.dailySub')}</p>
        </div>
        {max > 0 && <span className="acct-badge">{t('usage.v4.best', { day: dayLabel(best) })}</span>}
      </div>
      <div className="cal" role="img" aria-label={t('usage.v4.dailyAria')}>
        <span />
        {/* Every other week: the mockup's six labels run into each other at this cell size. */}
        {Array.from({ length: 6 }, (_, w) => (
          <span key={`w${w}`} className="wk">
            {w % 2 === 0 ? short(start + w * 7) : ''}
          </span>
        ))}
        {names.map((name, r) => [
          <span key={`l${r}`} className="dl">
            {name}
          </span>,
          ...Array.from({ length: 6 }, (_, w) => {
            const day = start + w * 7 + r;
            if (day > today) return <i key={day} className="cell fut" title={dayLabel(day)} />;
            return <i key={day} className={`cell h${step(of(day), max)}${day === best && max > 0 ? ' best' : ''}`} title={`${dayLabel(day)} · ${tokens(of(day))}`} />;
          }),
        ])}
      </div>
      <div className="hm-foot">
        <span>{dayLabel(start)}</span>
        <span className="steps" aria-hidden>
          {t('usage.v4.less')} {[0, 1, 2, 3, 4].map((h) => <i key={h} className={`cell h${h}`} />)} {t('usage.v4.more')}
        </span>
        <span>{dayLabel(today)}</span>
      </div>
    </div>
  );
}

export function Mix({ t, d, range }: { t: T; d: Sum; range: string }) {
  const all = d.parts.reduce((a, b) => a + b, 0);
  const share = d.parts.map((p) => pct(p, all));
  const names: Key[] = ['usage.v4.in', 'usage.v4.out', 'usage.v4.cw', 'usage.v4.cr'];
  const cls = ['m-in', 'm-out', 'm-cw', 'm-cr'];
  return (
    <div className="u4-card">
      <div className="hm-head">
        <div>
          <h4>{t('usage.v4.mix')}</h4>
          <p>{t('usage.v4.mixSub', { range })}</p>
        </div>
      </div>
      <div className="mix" role="img" aria-label={t('usage.v4.mixAria', { a: share[0], b: share[1], c: share[2], d: share[3] })}>
        {d.parts.map((p, i) => (
          <span key={i} className={cls[i]} style={{ width: `${all ? (100 * p) / all : 0}%` }} />
        ))}
      </div>
      <div className="mixleg">
        {d.parts.map((p, i) => (
          <div key={i}>
            <i className={`sw ${cls[i]}`} />
            {t(names[i])}
            <b>{tokens(p)}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Hours({ t, d, range }: { t: T; d: Detail; range: string }) {
  const max = Math.max(0, ...d.hours);
  const days = t('usage.v4.weekdays').split(' ');
  return (
    <div className="u4-card">
      <div className="hm-head">
        <div>
          <h4>{t('usage.v4.hours')}</h4>
          <p>{t('usage.v4.hoursSub', { range })}</p>
        </div>
      </div>
      <div className="hours" role="img" aria-label={t('usage.v4.hoursAria')}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={`h${h}`} className="hl">
            {h % 6 === 0 ? h : ''}
          </span>
        ))}
        {days.map((name, w) => [
          <span key={`l${w}`} className="dl">
            {name}
          </span>,
          ...d.hours.slice(w * 24, w * 24 + 24).map((v, h) => <i key={`${w}-${h}`} className={`cell h${step(v, max)}`} title={`${name} ${h}:00 · ${tokens(v)}`} />),
        ])}
      </div>
    </div>
  );
}

/** Folders to Nunchiro projects: a folder inside a session's folder or a project root counts for that project
 *  (longest match first, so a worktree counts for its project); any other folder is "Other". Orca's
 *  worktree-attribution.ts does the same against worktrees (idea only). */
const homesOf = (sessions: Session[]) => [...new Map(sessions.flatMap((s) => [[s.cwd, s.project] as const, [s.project, s.project] as const])).entries()].sort((a, b) => b[0].length - a[0].length);
const projectOf = (folder: string, homes: ReturnType<typeof homesOf>) => homes.find(([p]) => folder === p || folder.startsWith(`${p}/`))?.[1] ?? null;
/** The worktree a project's folder belongs to, or null for the project's own folders.
 *  ponytail: read from the path (outside the root, or under a `worktrees` folder); ask git in the core if it miscounts. */
function worktreeOf(folder: string, project: string) {
  if (folder === project) return null;
  if (!folder.startsWith(`${project}/`)) return folder;
  return /^(.*\/\.?worktrees?\/[^/]+)/.exec(folder)?.[1] ?? null;
}

export function byProject(folders: Group[], sessions: Session[]) {
  const homes = homesOf(sessions);
  const out = new Map<string | null, { tokens: number; cost: number; sessions: number; top?: string; topTokens: number; trees: Set<string> }>();
  for (const g of folders) {
    const key = g.key ? projectOf(g.key, homes) : null;
    const row = out.get(key) ?? { tokens: 0, cost: 0, sessions: 0, topTokens: 0, trees: new Set<string>() };
    const tree = key === null ? null : worktreeOf(g.key, key);
    if (tree) row.trees.add(tree);
    row.tokens += g.tokens;
    row.cost += g.cost_micro;
    row.sessions += g.sessions;
    if (g.tokens > row.topTokens) Object.assign(row, { top: g.top_model, topTokens: g.tokens });
    out.set(key, row);
  }
  return [...out.entries()].map(([project, r]) => ({ project, ...r })).sort((a, b) => (a.project === null ? 1 : b.project === null ? -1 : b.tokens - a.tokens));
}

function Share({ n, of }: { n: number; of: number }) {
  const p = pct(n, of);
  return (
    <td>
      <span className="bar-in" aria-hidden>
        <span style={{ width: `${p}%` }} />
      </span>
      {p}%
    </td>
  );
}

/** The Agent tab (usage.html `provs`): a card per provider, then the agents that keep no token record. */
export function Providers({ t, d, sessions, counts, only, filtered }: { t: T; d: Detail; sessions: Session[]; counts: Record<string, number>; only: string; filtered: boolean }) {
  const homes = homesOf(sessions);
  return (
    <div className="provs">
      {AGENTS.filter(([agent]) => !only || only.startsWith(`${agent}:`)).map(([agent, title]) => {
        const g = d.agents.find((x) => x.key === agent);
        // ponytail: the agent's biggest folder, named by its project; sum per project in the core if a split project misleads.
        const main = g ? [g.top_model, g.cwd && base(projectOf(g.cwd, homes) ?? g.cwd)].filter(Boolean) : [];
        const cost = !g || g.unpriced === g.tokens ? '—' : `${g.unpriced > 0 ? '≥' : ''}${dollars(g.cost_micro)}`;
        return (
          <div key={agent} className={`prov${g ? '' : ' none'}`} data-agent-name={title}>
            <div className="h">
              <b>{title}</b>
              <span className={`chip${g ? ' ok' : ''}`}>{t(g ? 'usage.v4.hasRecords' : filtered ? 'usage.v4.noRange' : 'usage.v4.noLocal')}</span>
              <span className="dim">{t('usage.v4.nAccounts', { n: counts[agent] ?? 0 })}</span>
            </div>
            {g && (
              <>
                {main.length > 0 && <div className="sub">{main.map((name) => t('usage.v4.mainly', { name: name! })).join(' · ')}</div>}
                <div className="nums">
                  <span>
                    {t('usage.v4.colTokens')}
                    <b>{tokens(g.tokens)}</b>
                  </span>
                  <span>
                    {t('usage.v4.colSessionsTurns')}
                    <b>
                      {g.sessions} · {g.turns.toLocaleString()}
                    </b>
                  </span>
                  <span>
                    {t('usage.v4.colCost')}
                    <b>{cost}</b>
                  </span>
                </div>
                <div className="share" aria-hidden>
                  <span style={{ width: `${pct(g.tokens, d.total.tokens)}%` }} />
                </div>
              </>
            )}
          </div>
        );
      })}
      {!only && (
        <div className="prov none">
          <div className="h">
            <b>Gemini, OpenCode</b>
            <span className="chip">{t('usage.v4.noLocal')}</span>
          </div>
          <div className="sub">{t('usage.v4.acp')}</div>
        </div>
      )}
    </div>
  );
}

/** Row 4: one card, four tabs (mockup `tabbar`); arrow keys move between tabs (basic interactions). */
export function Tabs({ t, tab, onTab, d, sessions, ownName, agentPanel }: { t: T; tab: Tab; onTab: (t: Tab) => void; d: Detail | null; sessions: Session[]; ownName: (agent: string) => string; agentPanel: ReactNode }) {
  const names: Record<Tab, Key> = { agent: 'usage.v4.tabAgent', model: 'usage.v4.tabModel', project: 'usage.v4.tabProject', session: 'usage.v4.tabSession' };
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const next = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i + TABS.length - 1) % TABS.length] : null;
    if (!next) return;
    e.preventDefault();
    onTab(next);
    document.getElementById(`u4-t-${next}`)?.focus();
  };
  const total = d?.total.tokens ?? 0;
  const th = (k: Key, n = false) => <th className={n ? 'n' : undefined}>{t(k)}</th>;
  let panel: ReactNode = agentPanel;
  if (!d) panel = <p className="dim">{t('usage.v4.loading')}</p>;
  else if (tab === 'model' && d)
    panel = (
      <table className="u4-t">
        <thead>
          <tr>
            {th('usage.v4.colModel')}
            {th('usage.v4.colTokens', true)}
            {th('usage.v4.colTurns', true)}
            {th('usage.v4.colCost', true)}
            {th('usage.v4.colShare')}
          </tr>
        </thead>
        <tbody>
          {[...d.models].sort((a, b) => Number(a.unpriced === a.tokens) - Number(b.unpriced === b.tokens)).map((g) => (
            <tr key={g.key}>
              <td className="mono">{!g.key ? t('usage.v4.noModel') : g.unpriced === g.tokens ? t('usage.costUnknown', { models: g.key }) : g.key}</td>
              <td className="n">{tokens(g.tokens)}</td>
              <td className="n">{g.turns}</td>
              <td className="n">{g.unpriced === g.tokens ? '—' : dollars(g.cost_micro)}</td>
              <Share n={g.tokens} of={total} />
            </tr>
          ))}
        </tbody>
      </table>
    );
  else if (tab === 'project' && d)
    panel = (
      <table className="u4-t">
        <thead>
          <tr>
            {th('usage.v4.colProject')}
            {th('usage.v4.colSessions', true)}
            {th('usage.v4.colTokens', true)}
            {th('usage.v4.colCost', true)}
            {th('usage.v4.colShare')}
            {th('usage.v4.colTopModel')}
          </tr>
        </thead>
        <tbody>
          {byProject(d.folders, sessions).map((r) => (
            <tr key={r.project ?? ''}>
              <td title={r.project ?? undefined}>{r.project === null ? <span className="dim">{t('usage.v4.other')}</span> : <b>{base(r.project)}</b>}{r.trees.size > 0 && <span className="dim"> {t('usage.v4.worktrees', { n: r.trees.size })}</span>}</td>
              <td className="n">{r.sessions}</td>
              <td className="n">{tokens(r.tokens)}</td>
              <td className="n">{dollars(r.cost)}</td>
              <Share n={r.tokens} of={total} />
              <td className="mono">{r.top ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  else if (tab === 'session' && d)
    panel = (
      <table className="u4-t">
        <thead>
          <tr>
            {th('usage.v4.colSession')}
            {th('usage.v4.colProject')}
            {th('usage.v4.colAccount')}
            {th('usage.v4.colModel')}
            {th('usage.v4.colTurns', true)}
            {th('usage.v4.colTokens', true)}
            {th('usage.v4.colCost', true)}
            {th('usage.v4.colCache', true)}
            <th>
              <span className="sr">{t('usage.v4.open')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {d.sessions.map((g) => {
            const id = g.key.slice(g.key.indexOf(':') + 1);
            const s = sessions.find((x) => x.agent_session_id === id);
            const cache = pct(g.parts[3], g.parts[0] + g.parts[3]);
            const agent = g.agent === 'codex' ? 'Codex' : 'Claude';
            return (
              <tr key={g.key}>
                <td title={id}>{s?.label || id.slice(0, 8)}</td>
                <td>{s ? base(s.project) : g.cwd ? base(g.cwd) : '—'}</td>
                <td>
                  {agent} · {g.account === 'own' || !g.account ? ownName(g.agent ?? 'claude') : g.account.slice(0, 8)}
                </td>
                <td className="mono">{g.top_model ?? '—'}</td>
                <td className="n">{g.turns}</td>
                <td className="n">{tokens(g.tokens)}</td>
                <td className="n">{dollars(g.cost_micro)}</td>
                <td className="n">
                  {cache}%{g.parts[0] + g.parts[3] > 0 && cache < 30 && <span className="low"> {t('usage.v4.lowCache')}</span>}
                </td>
                <td>
                  {s && (
                    <button type="button" className="btn" onClick={() => openSession(s.id)}>
                      {t('usage.v4.open')}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  return (
    <div className="scard u4-tabs">
      <div className="u4-tabbar" role="tablist" aria-label={t('usage.v4.by')} onKeyDown={onKey}>
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" id={`u4-t-${k}`} aria-controls={`u4-p-${k}`} aria-selected={tab === k} tabIndex={tab === k ? 0 : -1} onClick={() => onTab(k)}>
            {t(names[k])}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`u4-p-${tab}`} aria-labelledby={`u4-t-${tab}`} className="u4-panel">
        {panel}
      </div>
    </div>
  );
}
