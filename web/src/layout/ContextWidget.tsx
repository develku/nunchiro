// Ticket 1048: the Context widget, the context fill of the session in view ("36% used · 359.9K / 1M", one bar, the
// model, where the number comes from). The read is the composer ring's (useSessionContext: 30 s cache, read again at a
// turn end). Shape after T3 Code's ContextWindowMeter (percent, then used / window) and Orca's context ring (red at 90%);
// yellow from 80% as the status bar's usage (chrome/UsageBlock.tsx tone).
// Ticket 1059: Show breakdown (never automatic) types /context into an idle local Claude; the core reads the table Claude
// writes to its transcript and sends it with the context read.
import { useState } from 'react';
import type { ContextBreakdown, CoreClient } from '../api';
import { forgetContext, useSessionContext } from '../chat/ContextRing';
import { lineError } from '../errors';
import type { T } from '../i18n';
import { status, type Session } from '../types';
import './context-widget.css';

/** "359.9K", "1M", "812": one decimal, as Claude Desktop writes the counts. */
const count = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));
const tone = (pct: number) => (pct >= 90 ? ' bad' : pct >= 80 ? ' warn' : '');

export function ContextWidget({ core, session, t }: { core: CoreClient; session: Session | null; t: T }) {
  // shortcut: the window's connection state is not in WindowCtx; a read while disconnected fails and shows "no number yet".
  const value = useSessionContext(core, session, true, true);
  const why = !session
    ? t('shell.context.none')
    : session.kind !== 'claude' && session.kind !== 'codex'
      ? t('shell.context.agent')
      : session.machine
        ? t('shell.context.remote')
        : value?.type === 'session_model'
          ? t('shell.context.noWindow', { model: value.model })
          : value?.type === 'unknown' || (value?.type === 'session_context' && value.window <= 0)
            ? t('shell.context.noTurn')
            : null;
  const known = value?.type === 'session_context' && value.window > 0 ? value : null;
  const pct = known ? Math.round((Math.min(known.used, known.window) / known.window) * 100) : 0;
  const [fresh, setFresh] = useState<{ id: string; value: ContextBreakdown } | null>(null);
  const [asked, setAsked] = useState<{ id: string; error?: unknown } | null>(null);
  const mine = fresh && fresh.id === session?.id ? fresh.value : undefined;
  const breakdown = mine && (!known?.breakdown || mine.at > known.breakdown.at || (mine.at === known.breakdown.at && !mine.rows.length)) ? mine : known?.breakdown;
  const asking = asked && asked.id === session?.id ? asked : null;
  const state = session ? status(session) : null;
  const reason = !session || session.kind !== 'claude' || session.machine ? t('shell.context.onlyClaude') : state === 'waiting' ? t('shell.context.asking') : state !== 'idle' ? t('shell.context.idle') : null;
  const show = async () => {
    if (!session) return;
    const id = session.id;
    const before = breakdown?.at ?? 0;
    setAsked({ id });
    try {
      await core.sessionContext(id, true);
      forgetContext(core, id);
      // Claude writes its answer just after the command runs: read it again (no second send) for up to 15 s.
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const v = await core.sessionContext(id).catch(() => null);
        const b = v?.type === 'session_context' ? v.breakdown : undefined;
        if (b && b.at > before) return setFresh({ id, value: b }), setAsked(null);
      }
      // The previous time, not now: a table Claude writes later is newer and replaces this "could not read".
      setFresh({ id, value: { at: before, rows: [] } });
      setAsked(null);
    } catch (error) {
      setAsked({ id, error });
    }
  };
  return (
    <section className="ctxw" aria-label={t('shell.context.source')}>
      {why ? (
        <p className="ctxw-why">{why}</p>
      ) : known ? (
        <>
          <div className="ctxw-head">
            <b>{t('shell.context.used', { pct })}</b>
            <span className="ctxw-n">
              {count(known.used)} / {count(known.window)}
            </span>
          </div>
          <div className={`ctxw-bar${tone(pct)}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('chat.context', { used: count(known.used), window: count(known.window) })}>
            <i style={{ width: `${pct}%` }} />
          </div>
          {known.model && <span className="ctxw-model">{known.model}</span>}
          <small className="ctxw-src">{t('shell.context.source')}</small>
          {breakdown &&
            (breakdown.rows.length ? (
              <>
                <ul className="ctxw-rows">
                  {breakdown.rows.map((r, i) => (
                    <li key={i}>
                      <span>{r.label}</span>
                      <span className="ctxw-n">
                        {count(r.tokens)} · {r.pct}%
                      </span>
                      <div className="ctxw-rowbar">
                        <i style={{ width: `${Math.min(r.pct, 100)}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
                <small className="ctxw-asof">{t('shell.context.asOf', { time: new Date(breakdown.at).toLocaleTimeString(document.documentElement.lang || undefined, { hour: 'numeric', minute: '2-digit' }) })}</small>
              </>
            ) : (
              <p className="ctxw-why">{t('shell.context.unread')}</p>
            ))}
          <button type="button" className="btn ctxw-show" disabled={!!reason || (!!asking && !asking.error)} title={reason ?? undefined} onClick={show}>
            {asking && !asking.error ? t('shell.context.reading') : breakdown ? t('shell.context.refresh') : t('shell.context.show')}
          </button>
          <small className="ctxw-note">{t('shell.context.note')}</small>
          {asking?.error ? (
            <p className="ctxw-why" role="alert">
              {lineError(t, asking.error)}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
