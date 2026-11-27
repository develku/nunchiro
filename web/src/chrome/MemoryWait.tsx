// The status bar's item while new sessions wait for memory (mockup docs/design/memory-hold-m8/index.html, panel 3): one
// waiting start is its line with Start anyway and Cancel; several are a count that opens the list above the bar, in the
// usage popover's glass. A start that went by itself opens as a background tab and leaves one note; a dropped one says so.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoreClient, MemoryWait as Waiting, MemoryWaitEntry } from '../api';
import { ageText } from '../chat/PrChip';
import { errorNote, notePlain, type Note } from '../errors';
import { Icon } from '../icons/Icon';
import type { T } from '../i18n';
import './memory-wait.css';

type Props = { t: T; core: CoreClient; addTab: (id: string) => void; open: (id: string) => void; setNote: (note: Note) => void };

export function MemoryWait({ t, core, addTab, open, setNote }: Props) {
  const [wait, setWait] = useState<Waiting | null>(core.memoryWait);
  const [shown, setShown] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Notes are said once: those already there when this window first heard the list are old.
  const said = useRef<number | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => core.onMemoryWait(setWait), [core]);
  useEffect(() => {
    if (!wait) return;
    const last = Math.max(0, ...wait.notes.map((n) => n.n));
    // The first list heard, or a restarted core's (its count starts again): nothing new to say.
    if (said.current === null || last < said.current) return void (said.current = last);
    for (const n of wait.notes.filter((n) => n.n > said.current!)) {
      if (n.outcome === 'started' && n.session && n.mine) addTab(n.session); // in the tree and the strip, the view stays
      setNote(
        n.outcome === 'started'
          ? t('err.memWait.started', { agent: n.agent })
          : n.outcome === 'dropped'
            ? t('err.memWait.dropped', { agent: n.agent })
            : errorNote(t('err.memWait.failed', { agent: n.agent, error: notePlain(t, n.error ?? '') }), n.error ?? ''),
      );
    }
    said.current = last;
  }, [wait]); // eslint-disable-line react-hooks/exhaustive-deps
  const entries = wait?.entries ?? [];
  const many = entries.length > 1;
  useEffect(() => {
    if (!many) setShown(false);
  }, [many]);
  useEffect(() => {
    if (!shown) return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    const off = (e: Event) => !root.current?.contains(e.target as Node) && setShown(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setShown(false);
    document.addEventListener('pointerdown', off);
    document.addEventListener('keydown', esc);
    return () => (clearInterval(clock), document.removeEventListener('pointerdown', off), document.removeEventListener('keydown', esc));
  }, [shown]);
  const answer = useCallback(
    (e: MemoryWaitEntry, go: boolean) =>
      void core.request({ op: go ? 'memory_wait_go' : 'memory_wait_cancel', id: e.id }).then(
        (r) => {
          const started = r as { session?: string; mine?: boolean };
          if (go && started.session && started.mine) open(started.session);
        },
        (err) => setNote(errorNote(t('err.memWait.failed', { agent: e.agent, error: notePlain(t, err) }), err)),
      ),
    [core, open, setNote, t],
  );
  if (!entries.length) return null;
  const buttons = (e: MemoryWaitEntry) => (
    <>
      <button type="button" className="btn" data-tip={t('err.startAnyway.tip')} onClick={() => answer(e, true)}>
        {t('err.startAnyway')}
      </button>
      <button type="button" className="btn q" onClick={() => answer(e, false)}>
        {t('err.memWait.cancel')}
      </button>
    </>
  );
  if (!many) {
    const e = entries[0];
    return (
      <span className="memwait" role="status" data-tip={t('err.memWait.tip', { agent: e.agent })}>
        <span className="clk">
          <Icon name="clock" size={12} />
        </span>
        <span className="memwait-t">{t('err.memWait.one', { agent: e.agent })}</span>
        {buttons(e)}
      </span>
    );
  }
  const asked = (e: MemoryWaitEntry) => {
    const when = ageText(new Date(e.at).toISOString(), now, t);
    return e.asker === 'you' ? t('err.memWait.you', { when }) : e.asker === 'schedule' ? t('err.memWait.schedule', { when }) : t('err.memWait.by', { name: e.by ?? '', when });
  };
  return (
    <span className="memwait-wrap" ref={root}>
      <button type="button" className={`it memwait-n${shown ? ' on' : ''}`} aria-haspopup="dialog" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
        <span className="clk">
          <Icon name="clock" size={12} />
        </span>
        {t('err.memWait.many', { n: entries.length })}
      </button>
      {shown && (
        <div className="memwait-pop glass" role="dialog" aria-label={t('err.memWait.title')}>
          <h4>
            <span className="clk">
              <Icon name="clock" size={14} />
            </span>
            {t('err.memWait.title')}
          </h4>
          <p>{t('err.memWait.line')}</p>
          {entries.map((e) => (
            <div className="memwait-row" key={e.id}>
              <div className="n">
                <b>{e.project ? `${e.agent} · ${e.project}` : e.agent}</b>
                <small>{asked(e)}</small>
              </div>
              {buttons(e)}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
