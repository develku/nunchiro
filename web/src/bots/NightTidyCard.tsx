// Night tidy's card (approved design: bot memory mockup round 1, frame 2): in the Chief's chat at Home (each bot's own
// chat without a Chief) and in Decisions. Per bot: the lines the tidy would remove and add, checked; what waits from
// outside content, unchecked; how many lines were not kept. Apply checked sends the checked lines (`memory_tidy`);
// Discard answers the card No and leaves every index as it is. The core owns the rules (team/memory/tidy.rs).
import { useEffect, useMemo, useState } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine, rawError } from '../errors';
import type { Key } from '../i18n';
import type { OnAnswer, T } from '../tree/DecisionLine';
import type { Decision } from '../types';
import { LineIcon, type Fact, type Source } from './BotMemory';
import { MEMORY_TAB, openBots } from './bots';
import './night-tidy.css';

type Proposal = { id: string; date: string; text: string; from: Source; topic?: string; at_ms: number };
export type TidyPart = { id: string; name: string; removed: Fact[]; added: Fact[]; proposals: Proposal[]; not_kept: unknown[]; at_ms?: number; model?: string; tokens: number };
export type TidyStats = { runs: number; tokens: number; off: number };
type Checked = Record<string, { drop: string[]; add: string[]; keep: string[] }>;

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (at: number) => ((d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`)(new Date(at));
export const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const key = (bot: string, kind: string, v: string) => `${bot}\u0000${kind}\u0000${v}`;

export function NightTidyCard({ d, core, onAnswer, t }: { d: Decision; core: CoreClient; onAnswer: OnAnswer; t: T }) {
  const [parts, setParts] = useState<TidyPart[] | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const bots = d.owner?.type === 'night_tidy' ? d.owner.bots : [];
  useEffect(() => {
    let live = true;
    core.request({ op: 'memory_tidy' }).then(
      (r) => live && setParts((r as { parts: TidyPart[] }).parts.filter((p) => bots.includes(p.id))),
      (e) => live && setErr(rawError(e)),
    );
    return () => void (live = false);
  }, [core, d.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Every change starts checked; what waits from outside starts unchecked (approved: the owner checks it).
  const all = useMemo(
    () =>
      (parts ?? []).flatMap((p) => [
        ...p.removed.map((f) => ({ k: key(p.id, 'drop', f.text), on: true })),
        ...p.added.map((f) => ({ k: key(p.id, 'add', f.text), on: true })),
        ...p.proposals.map((x) => ({ k: key(p.id, 'keep', x.id), on: false })),
      ]),
    [parts],
  );
  const isOn = (k: string) => (all.find((a) => a.k === k)?.on ?? false) !== off.has(k);
  const flip = (k: string) => setOff((s) => ((n) => (n.has(k) ? n.delete(k) : n.add(k), n))(new Set(s)));
  if (d.owner?.type !== 'night_tidy') return null;
  if (!parts) return <ErrorLine t={t} error={err} />;
  const ran = parts.find((p) => p.at_ms);
  const tokens = parts.reduce((n, p) => n + p.tokens, 0);
  const title = parts.length === 1 ? t('tidy.night.title.one', { name: parts[0].name }) : t('tidy.night.title', { n: parts.length });
  const apply = () => {
    const checked: Checked = {};
    for (const p of parts) {
      checked[p.id] = {
        drop: p.removed.filter((f) => isOn(key(p.id, 'drop', f.text))).map((f) => f.text),
        add: p.added.filter((f) => isOn(key(p.id, 'add', f.text))).map((f) => f.text),
        keep: p.proposals.filter((x) => isOn(key(p.id, 'keep', x.id))).map((x) => x.id),
      };
    }
    setBusy(true);
    core.request({ op: 'memory_tidy', apply: checked }).then(
      () => setParts([]),
      (e) => (setErr(rawError(e)), setBusy(false)),
    );
  };
  const discard = () => {
    const p = onAnswer(d, { type: 'deny' });
    if (!p) return;
    setBusy(true);
    p.then(
      () => {},
      (e: Error) => (setErr(rawError(e)), setBusy(false)),
    );
  };
  const line = (bot: string, kind: 'drop' | 'add', f: Fact) => {
    const k = key(bot, kind, f.text);
    return (
      <label key={k} className="nt-line" data-nt={kind === 'drop' ? 'remove' : 'add'}>
        <input type="checkbox" checked={isOn(k)} disabled={busy} onChange={() => flip(k)} aria-label={t(kind === 'drop' ? 'tidy.night.remove' : 'tidy.night.add', { text: f.text })} />
        <span className="nt-sign" aria-hidden="true">{kind === 'drop' ? '−' : '+'}</span>
        <span className="nt-date">{f.date?.slice(5) ?? ''}</span>
        <span className="nt-text">{f.text}</span>
      </label>
    );
  };
  return (
    <div className="deccard hosted nt" role="group" aria-label={title} data-item={d.id} data-night-tidy>
      <div className="nt-head">
        <b>{title}</b>
        {ran?.at_ms && <span className="dim">{t('tidy.night.ran', { time: hhmm(ran.at_ms), model: ran.model ?? '', tokens: kTokens(tokens) })}</span>}
      </div>
      {parts.map((p) => {
        const changes = p.removed.length + p.added.length;
        return (
          <section key={p.id} className="nt-bot" aria-label={p.name} data-nt-bot={p.id}>
            <p className="nt-name">
              <b>{p.name}</b> <span className="dim">{t('tidy.night.counts', { changes, proposals: p.proposals.length })}</span>
              <span className="sp" />
              <button type="button" className="b" data-act="open-memory" onClick={() => openBots(p.id + MEMORY_TAB)}>
                {t('tidy.night.open', { name: p.name })}
              </button>
            </p>
            {changes > 0 && (
              <div className="nt-changes">
                {p.removed.map((f) => line(p.id, 'drop', f))}
                {p.added.map((f) => line(p.id, 'add', f))}
              </div>
            )}
            {p.proposals.map((x) => {
              const k = key(p.id, 'keep', x.id);
              return (
                <label key={k} className="nt-prop" data-nt="proposal">
                  <input type="checkbox" checked={isOn(k)} disabled={busy} onChange={() => flip(k)} aria-label={t('tidy.night.keep', { text: x.text })} />
                  <span>
                    <span className="nt-text">{x.text}</span>
                    <span className="nt-src dim">
                      <LineIcon name={x.from} />
                      {t('tidy.night.from', { source: t(`memory.from.${x.from}` as Key), date: x.date.slice(5) })}
                    </span>
                  </span>
                </label>
              );
            })}
            {p.not_kept.length > 0 && <p className="nt-notkept dim">{t(p.not_kept.length === 1 ? 'tidy.night.notKept.one' : 'tidy.night.notKept', { n: p.not_kept.length })}</p>}
          </section>
        );
      })}
      <p className="nt-note dim">{t('tidy.night.note')}</p>
      <ErrorLine t={t} error={err} className="dc-hint err" />
      <p className="nt-count dim">{t('tidy.night.checked', { n: all.filter((a) => isOn(a.k)).length, total: all.length })}</p>
      <div className="nt-foot">
        <span className="sp" />
        <button type="button" className="b" data-act="discard" disabled={busy} onClick={discard}>
          {t('tidy.night.discard')}
        </button>
        <button type="button" className="b y" data-act="apply" disabled={busy || !parts.length} onClick={apply}>
          {t('tidy.night.apply')}
        </button>
      </div>
    </div>
  );
}
