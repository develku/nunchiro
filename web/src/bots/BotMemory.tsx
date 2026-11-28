// A bot's memory (approved design: three layers; mockup round 1, frames 1 and 3): the bot page's Memory tab, and the
// Bots view's Memory group for every bot. The core keeps the files (crates/nunchiro-core/src/team/memory.rs); the
// window reads them through `bot_memory` and changes them with its `change`: Forget, Edit and Undo of a saved copy.
import { useEffect, useState, type FormEvent } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine, rawError } from '../errors';
import type { Key, T } from '../i18n';
import { Icon } from '../icons/Icon';
import { PLAIN } from '../plainText';
import { Row, Sec, Seg, Select, Switch } from '../settings/shell/Row';
import { CoreFeatureClient, useCoreFeature } from '../settings/useFeatureSetting';
import { kTokens, type TidyStats } from './NightTidyCard';
import type { Bot } from './bots';

export type Source = 'you' | 'conversation' | 'unknown' | 'mail' | 'web' | 'tool';
export type Fact = { date?: string; text: string; from?: Source };
export type SavedCopy = { id: string; at_ms: number; kind: string; changed: number };
export type MemoryView = { facts: Fact[]; text: string; limit: number; soul_lines: number; user_lines: number; topics: [string, number][]; copies: SavedCopy[]; proposals: number; not_kept: number; keep_days: number };
type Change = { do: 'forget'; text: string } | { do: 'edit'; text: string } | { do: 'undo'; copy: string };

/** The Memory settings' key in the core's settings (`team::MEMORY_KEY`). */
export const MEMORY_KEY = 'team.memory';
export type MemorySettings = { keep_days: number; tidy: boolean; every: number; model: string; bots: Record<string, 'on' | 'off'> };
/** The core's defaults (team/memory.rs `Settings`): a stored value from an earlier build may lack the later fields. */
const DEFAULTS: MemorySettings = { keep_days: 30, tidy: true, every: 1, model: 'haiku', bots: {} };
const MODELS = ['haiku', 'sonnet'] as const; // tidy.rs MODELS
const EVERY = ['1', '3', '7'] as const;
/** Index lines shown before "N more lines". */
const SHOWN = 5;

const pad = (n: number) => String(n).padStart(2, '0');
function copyWhen(t: T, at: number) {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? t('memory.copy.today', { time }) : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}
const KINDS = ['tidy', 'edit', 'undo', 'before'];

// The approved mockup's line icons (stroked, unlike the filled Octicons of `Icon`): a line's source and a topic file.
const LINE_ICONS: Record<Source | 'file' | 'moon', string[]> = {
  moon: ['M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5Z'],
  you: ['M3 13.5a5 5 0 0 1 10 0', 'M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
  conversation: ['M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z'],
  unknown: ['M6.2 6a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.6', 'M8 11.6v.1'],
  mail: ['M3.25 3.25h9.5a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5v-6.5a1.5 1.5 0 0 1 1.5-1.5Z', 'm2.2 4 5.8 4.5L13.8 4'],
  web: ['M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5Z', 'M2.5 8h11M8 2.25c2 2 2 9.5 0 11.5M8 2.25c-2 2-2 9.5 0 11.5'],
  tool: ['M10 2.5a3 3 0 0 0-3 4L2.75 10.75a1.4 1.4 0 0 0 2 2L9 8.5a3 3 0 0 0 4-3l-1.75 1.75-1.75-1.75 1.75-1.75Z'],
  file: ['M4 1.75h5l3 3v9.5H4Z', 'M9 1.75v3h3'],
};
export function LineIcon({ name }: { name: Source | 'file' | 'moon' }) {
  return (
    <svg className="mem-icon" viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {(LINE_ICONS[name] ?? []).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
const copyWhat = (t: T, c: SavedCopy) => t(`memory.copy.${KINDS.includes(c.kind) ? c.kind : 'edit'}` as Key, { n: c.changed });

export function MemoryTab({ core, t, bot }: { core: CoreClient; t: T; bot: Bot }) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [error, setError] = useState<unknown>('');
  const [draft, setDraft] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const ask = (change?: Change) =>
    core.request({ op: 'bot_memory', id: bot.id, ...(change ? { change } : {}) }).then(
      (r) => (setView((r as { view: MemoryView }).view), setError(''), setDraft(null), setAsking(null)),
      (e) => setError(e),
    );
  useEffect(() => void ask(), [core, bot.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (e: FormEvent) => (e.preventDefault(), void ask({ do: 'edit', text: draft ?? '' }));
  if (!view) return <ErrorLine t={t} error={error ? rawError(error) : ''} />;
  const facts = all ? view.facts : view.facts.slice(0, SHOWN);
  const more = view.facts.length - SHOWN;
  return (
    <div className="mem" data-bot-memory={bot.id}>
      <CoreFeatureClient.Provider value={core}>
        <TidyChoice t={t} bot={bot} />
      </CoreFeatureClient.Provider>
      <section className="bot-card" aria-label={t('memory.always')}>
        <header>
          {t('memory.always')} <small>{t('memory.always.note')}</small>
        </header>
        <div className="mem-files">
          {(
            [
              ['SOUL.md', t('memory.soul.note', { name: bot.name, n: view.soul_lines })],
              ['MEMORY.md', t('memory.index.note', { n: view.facts.length, limit: view.limit })],
              ['USER.md', t('memory.user.note')],
            ] as const
          ).map(([file, note]) => (
            <div className="mem-file" key={file}>
              <code>{file}</code>
              <span className="dim">{note}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="bot-card" aria-label={t('memory.index')} data-memory-index>
        <header>
          {t('memory.index')} <small>{t('memory.index.lede')}</small>
          <span className="sp" />
          {draft === null && (
            <button type="button" className="btn" data-memory-edit onClick={() => setDraft(view.text)}>
              {t('memory.edit')}
            </button>
          )}
        </header>
        <ErrorLine t={t} error={error ? rawError(error) : ''} />
        {draft !== null ? (
          <form onSubmit={save}>
            <textarea {...PLAIN} className="sinp" aria-label={t('memory.edit.label', { name: bot.name })} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
            <div className="bot-acts">
              <button type="submit" className="btn">
                {t('memory.edit.save')}
              </button>
              <button type="button" className="btn" onClick={() => (setDraft(null), setError(''))}>
                {t('memory.edit.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <>
            {view.facts.length === 0 && <span className="dim">{t('memory.index.empty', { name: bot.name })}</span>}
            <ul className="mem-lines">
              {facts.map((f) => (
                <li key={f.text} data-memory-line={f.text} data-asking={asking === f.text || undefined}>
                  <div className="mem-line">
                    <span className="mem-date">{f.date?.slice(5) ?? ''}</span>
                    <span className="mem-text">{f.text}</span>
                    {f.from && (
                      <span className="mem-from" data-from={f.from}>
                        <LineIcon name={f.from} />
                        {t('memory.from', { source: t(`memory.from.${f.from}` as Key) })}
                      </span>
                    )}
                    <button type="button" className="btn q sm danger mem-forget" onClick={() => setAsking(f.text)}>
                      {t('memory.forget')}
                    </button>
                  </div>
                  {asking === f.text && (
                    <div className="mem-ask" role="group" aria-label={t('memory.forget.ask')}>
                      <span>
                        <b>{t('memory.forget.ask')}</b> {t('memory.forget.why')}
                      </span>
                      <button type="button" className="btn danger" data-memory-forget onClick={() => void ask({ do: 'forget', text: f.text })}>
                        {t('memory.forget')}
                      </button>
                      <button type="button" className="btn q" onClick={() => setAsking(null)}>
                        {t('memory.forget.cancel')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {(more > 0 || view.proposals > 0) && (
              <span className="mem-foot dim">
                {more > 0 && (
                  <button type="button" className="btn q sm" data-memory-more onClick={() => setAll(!all)}>
                    {all ? t('memory.fewer') : t(more === 1 ? 'memory.more.one' : 'memory.more', { n: more })}
                  </button>
                )}
                {view.proposals > 0 && <span data-memory-proposals>{t(view.proposals === 1 ? 'memory.proposals.one' : 'memory.proposals', { n: view.proposals })}</span>}
              </span>
            )}
          </>
        )}
      </section>
      <div className="mem-two">
        <section className="bot-card" aria-label={t('memory.topics')}>
          <header>
            {t('memory.topics')} <small>{t('memory.topics.note')}</small>
          </header>
          {view.topics.length === 0 && <span className="dim">{t('memory.topics.none')}</span>}
          {view.topics.map(([name, n]) => (
            <div className="mem-row" key={name} data-memory-topic={name}>
              <LineIcon name="file" />
              <code>{name}</code>
              <span className="dim">{t(n === 1 ? 'memory.topic.one' : 'memory.topic.lines', { n })}</span>
            </div>
          ))}
        </section>
        <section className="bot-card" aria-label={t('memory.copies')}>
          <header>
            {t('memory.copies')} <small>{t('memory.copies.note', { n: view.keep_days })}</small>
          </header>
          {view.copies.length === 0 && <span className="dim">{t('memory.copies.none')}</span>}
          {view.copies.map((c) => (
            <div className="mem-row" key={c.id} data-memory-copy={c.kind}>
              <span className="dim">{copyWhen(t, c.at_ms)}</span>
              <span className="mem-text">{copyWhat(t, c)}</span>
              <button type="button" className="btn q sm withicon" onClick={() => void ask({ do: 'undo', copy: c.id })}>
                <Icon name="history" size={12} />
                {t('memory.undo')}
              </button>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

/** The Bots view's Memory group: settings for every bot (inside a CoreFeatureClient provider). */
export function MemoryRows({ t, core }: { t: T; core: CoreClient }) {
  const [stored, set, error] = useCoreFeature<MemorySettings>(MEMORY_KEY, DEFAULTS);
  const settings = { ...DEFAULTS, ...stored };
  const [stats, setStats] = useState<TidyStats | null>(null);
  useEffect(() => void core.request({ op: 'memory_tidy' }).then((r) => setStats((r as { stats: TidyStats }).stats), () => {}), [core]);
  const days = ['7', '30', '90'] as const;
  const save = (change: Partial<MemorySettings>) => void set({ ...settings, ...change });
  return (
    <Sec label={t('memory.settings')}>
      <Row
        label={t('memory.tidy')}
        desc={t('memory.tidy.desc')}
        setting={MEMORY_KEY}
        control={
          <span className="mem-ctl">
            <Switch checked={settings.tidy} label={t('memory.tidy')} onChange={(on) => save({ tidy: on })} />
            <Seg name="memory-every" label={t('memory.tidy.every')} value={String(settings.every) as (typeof EVERY)[number]} options={EVERY.map((n) => [n, t(`memory.tidy.every.${n}` as Key)])} onChange={(n) => save({ every: Number(n) })} />
          </span>
        }
      />
      <Row
        label={t('memory.tidy.runs')}
        desc={t('memory.tidy.runs.desc')}
        setting={MEMORY_KEY}
        control={
          <span className="mem-ctl">
            {/* Only an agent that runs with no tools tidies: Claude. Codex is shown, off, with why. */}
            <Select value="claude" label={t('memory.tidy.agent')} onChange={() => {}}>
              <option value="claude">Claude</option>
              <option value="codex" disabled>
                {t('memory.tidy.codex')}
              </option>
            </Select>
            <Select value={settings.model} label={t('memory.tidy.model')} onChange={(m) => save({ model: m })}>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </span>
        }
        extra={stats && <p className="mem-stats dim" data-memory-stats>{t('memory.tidy.stats', { runs: stats.runs, tokens: kTokens(stats.tokens), off: stats.off })}</p>}
      />
      <Row
        label={t('memory.keep')}
        desc={t('memory.keep.desc')}
        setting={MEMORY_KEY}
        control={<Seg name="memory-keep" label={t('memory.keep')} value={String(settings.keep_days) as (typeof days)[number]} options={days.map((d) => [d, t('memory.keep.days', { n: d })])} onChange={(d) => save({ keep_days: Number(d) })} />}
      />
      <ErrorLine t={t} error={error} />
    </Sec>
  );
}

/** The Memory tab's night tidy row: this bot follows the setting for every bot, or turns it on or off for itself. */
function TidyChoice({ t, bot }: { t: T; bot: Bot }) {
  const [stored, set, error] = useCoreFeature<MemorySettings>(MEMORY_KEY, DEFAULTS);
  const settings = { ...DEFAULTS, ...stored };
  const choice = settings.bots[bot.id] ?? 'follow';
  const state = settings.tidy ? t('memory.tidy.state.on', { every: t(`memory.tidy.every.${settings.every}` as Key), model: settings.model }) : t('memory.tidy.state.off');
  const pick = (c: 'follow' | 'on' | 'off') => {
    const bots = { ...settings.bots };
    if (c === 'follow') delete bots[bot.id];
    else bots[bot.id] = c;
    void set({ ...settings, bots });
  };
  return (
    <section className="bot-card mem-tidy" aria-label={t('memory.tidy.bot', { name: bot.name })} data-memory-tidy>
      <span>
        <b>{t('memory.tidy.bot', { name: bot.name })}</b> <span className="dim">{t('memory.tidy.bot.follow', { state })}</span>
      </span>
      <Seg name={`memory-tidy-${bot.id}`} label={t('memory.tidy.choice', { name: bot.name })} value={choice} options={[['follow', t('memory.tidy.choice.follow')], ['on', t('memory.tidy.choice.on')], ['off', t('memory.tidy.choice.off')]]} onChange={pick} />
      <ErrorLine t={t} error={error} />
    </section>
  );
}
