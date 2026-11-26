// Ticket 1168 (owner 2026-11-26, mockup docs/design/bots-1166.html panels 1 and 2): the Bots view. Every bot on one screen,
// in two groups (in a seat, no seat); a press opens the bot's page: who it is (SOUL.md, read and edited here), its chat,
// its schedules, and "Models and limits", closed, holding the controls Settings > Team has today. Workers are not listed
// (1115: a worker is work). The words Light, Standard and Deep are not on this screen (994).
// Lane 1 of three: making a bot here (lane 2) and the handover card (lane 3) are not in it; "New bot" opens today's form.
import { useEffect, useState, type FormEvent } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine, rawError } from '../errors';
import type { T } from '../i18n';
import { Icon } from '../icons/Icon';
import { PLAIN } from '../plainText';
import { draftOf, LevelRule, MatePicks, saveOp, UpTo, type Draft } from '../features/team';
import { openSeat, setTeam, useTeam, type Team, type Teammate } from '../lead/lead';
import { isLevel, pairText, slotText, useLevels, type LevelTable } from '../lead/level';
import { openSchedules, useScheduleList, whenWords } from '../schedule/schedules';
import { basename } from '../tree';
import type { Session } from '../types';
import { eyesOf, type Bot, type Eyes } from './bots';
import { Face } from './Face';
import './bots.css';

const agentWord = (bot: Bot) => (bot.agent === 'claude' ? 'Claude Code' : bot.agent === 'codex' ? 'Codex' : bot.agent.replace(/^acp:/, ''));
const seatWord = (t: T, bot: Bot) => (bot.seat.kind === 'chief' ? t('bots.seat.chief') : bot.seat.kind === 'lead' ? t('bots.seat.lead', { project: basename(bot.seat.project) }) : '');
/** "follows Claude Code", or "pinned: Opus · high" for a bot held to one model (its own, or a level's as the table has it now). */
function modelLine(t: T, table: LevelTable, bot: Bot, mate: Teammate | undefined) {
  if (bot.model.rule === 'pinned') return t('bots.model.pinned', { model: mate ? pairText(t, mate.kind, bot.model, { agent: mate.agent }) : bot.model.model });
  if (mate && isLevel(mate.level)) return t('bots.model.pinned', { model: slotText(t, table, mate, mate.level) });
  return t('bots.model.follows', { agent: agentWord(bot) });
}

type Props = { core: CoreClient; t: T; sessions: Session[]; first?: string | null; open: (id: string) => void; onNew: () => void };

export function BotsView({ core, t, sessions, first, open, onNew }: Props) {
  const team = useTeam(core, true);
  const { table } = useLevels(core, true);
  const [shown, setShown] = useState<string | null>(first ?? null);
  const bots = team.bots ?? [];
  const mates = new Map(team.teammates.map((m) => [m.id, m]));
  const eyes = new Map(bots.map((b) => [b.id, eyesOf(sessions, b.id)]));
  const bot = bots.find((b) => b.id === shown);
  const chat = (id: string) => void openSeat(core, id).then(({ session }) => open(session.id), () => {});
  if (bot) return <BotPage core={core} t={t} bot={bot} mate={mates.get(bot.id)} eyes={eyes.get(bot.id)!} table={table} line={modelLine(t, table, bot, mates.get(bot.id))} back={() => setShown(null)} chat={() => chat(bot.id)} />;
  const n = (e: Eyes) => bots.filter((b) => eyes.get(b.id) === e).length;
  const groups: [string, string, string, Bot[]][] = [
    ['seat', t('bots.group.seat'), t('bots.group.seatNote'), bots.filter((b) => b.seat.kind !== 'none')],
    ['none', t('bots.group.none'), t('bots.group.noneNote'), bots.filter((b) => b.seat.kind === 'none')],
  ];
  return (
    <div className="botsv" data-bots>
      <div className="botsv-in">
        <div className="bots-top">
          <span className="dim" data-bots-sum>
            {[t(bots.length === 1 ? 'bots.count.one' : 'bots.count.other', { n: bots.length }), n('look') && t('bots.sum.look', { n: n('look') }), n('work') && t('bots.sum.work', { n: n('work') }), n('rest') && t('bots.sum.rest', { n: n('rest') })].filter(Boolean).join(' · ')}
          </span>
          <span className="sp" />
          <button type="button" className="btn withicon" data-bots-new onClick={onNew}>
            <Icon name="plus" size={14} />
            {t('bots.new')}
          </button>
        </div>
        {bots.length === 0 && <p className="bots-none">{t('bots.empty')}</p>}
        {groups.map(
          ([key, title, note, list]) =>
            list.length > 0 && (
              <section className="bots-g" key={key} data-bots-group={key} aria-label={title}>
                <header>
                  {title} <small>{note}</small>
                </header>
                <div className="bots-list">
                  {list.map((b) => (
                    <button type="button" className="bot-row" key={b.id} data-bot={b.id} onClick={() => setShown(b.id)}>
                      <Face t={t} face={b.face} name={b.name} eyes={eyes.get(b.id)!} />
                      <span>
                        <b className="bot-name">
                          <span className="wordcut">{b.name}</span>
                          {b.seat.kind !== 'none' && <i className="bot-seat" data-seat={b.seat.kind}>{seatWord(t, b)}</i>}
                        </b>
                        <span className="dim wordcut">{b.job.split('\n')[0]}</span>
                      </span>
                      <span>
                        <span className="bot-now" data-eyes={eyes.get(b.id)}>
                          {t(`bots.now.${eyes.get(b.id)!}`)}
                        </span>
                      </span>
                      <span>
                        <span className="dim wordcut" data-bot-model>
                          {modelLine(t, table, b, mates.get(b.id))}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ),
        )}
      </div>
    </div>
  );
}

function BotPage({ core, t, bot, mate, eyes, table, line, back, chat }: { core: CoreClient; t: T; bot: Bot; mate?: Teammate; eyes: Eyes; table: LevelTable; line: string; back: () => void; chat: () => void }) {
  const schedules = (useScheduleList() ?? []).filter((s) => s.run.teammate === bot.id);
  const pinned = line !== t('bots.model.follows', { agent: agentWord(bot) });
  return (
    <div className="botsv" data-bots data-bot-page={bot.id}>
      <div className="botsv-in">
        <button type="button" className="bot-back" onClick={back}>
          ← {t('bots.back')}
        </button>
        <div className="bot-head">
          <Face t={t} face={bot.face} name={bot.name} eyes={eyes} size={56} />
          <div>
            <h2>
              <span className="wordcut">{bot.name}</span>
              {bot.seat.kind !== 'none' && <i className="bot-seat" data-seat={bot.seat.kind}>{seatWord(t, bot)}</i>}
            </h2>
            <p>{bot.job.split('\n')[0]}</p>
            <span className="dim">{pinned ? `${agentWord(bot)} · ${line}` : line}</span>
          </div>
          <button type="button" className="btn p" data-bot-chat onClick={chat}>
            {t('bots.openChat')}
          </button>
        </div>
        <Soul core={core} t={t} bot={bot} />
        <section className="bot-card" aria-label={t('bots.schedules')}>
          <header>
            {t('bots.schedules')}
            <span className="sp" />
            <button type="button" className="btn" onClick={() => openSchedules()}>
              {t('bots.schedules.open')}
            </button>
          </header>
          {schedules.length === 0 && <span className="bot-sched dim">{t('bots.schedules.none')}</span>}
          {schedules.map((s) => (
            <div className="bot-sched" key={s.id} data-bot-schedule={s.id}>
              <span className="wordcut">{(s.run.task ?? '').split('\n')[0]}</span>
              <span className="dim">
                {whenWords(t, s)}
                {s.paused ? ` · ${t('bots.schedules.paused')}` : ''}
              </span>
            </div>
          ))}
        </section>
        {/* Closed until asked for (owner: model handles stay off the default screen). The key reopens it closed per bot. */}
        <details className="bot-card bot-models" data-bot-models key={bot.id}>
          <summary>
            <Icon name="chevron-right" size={12} />
            {t('bots.models')} <small>{pinned ? t('bots.models.pinned', { model: line.replace(/^[^:]*:\s*/, '') }) : t('bots.models.follow')}</small>
          </summary>
          {mate && <Models core={core} t={t} mate={mate} table={table} />}
        </details>
      </div>
    </div>
  );
}

/** Who the bot is: its SOUL.md, shown as it is; Edit changes the file itself (the core keeps it beside the bot's memory). */
function Soul({ core, t, bot }: { core: CoreClient; t: T; bot: Bot }) {
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<unknown>('');
  const ask = (text?: string) =>
    core.request({ op: 'bot_soul', id: bot.id, ...(text === undefined ? {} : { text }) }).then(
      (r) => (setText((r as { text: string }).text), setDraft(null), setError('')),
      (e) => setError(e),
    );
  useEffect(() => void ask(), [core, bot.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (e: FormEvent) => (e.preventDefault(), void ask(draft ?? ''));
  return (
    <section className="bot-card" data-bot-soul aria-label={t('bots.soul')}>
      <header>
        {t('bots.soul')} <small>{t('bots.soul.who', { name: bot.name })}</small>
        <span className="sp" />
        {draft === null && text !== null && (
          <button type="button" className="btn" data-soul-edit onClick={() => setDraft(text)}>
            {t('bots.soul.edit')}
          </button>
        )}
      </header>
      <ErrorLine t={t} error={error ? rawError(error) : ''} />
      {draft === null ? (
        <pre className="bot-soul">{text}</pre>
      ) : (
        <form onSubmit={save}>
          <textarea {...PLAIN} className="sinp" aria-label={t('bots.soul.label', { name: bot.name })} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
          <div className="bot-acts">
            <button type="submit" className="btn p" disabled={!draft.trim()}>
              {t('bots.soul.save')}
            </button>
            <button type="button" className="btn" onClick={() => (setDraft(null), setError(''))}>
              {t('bots.soul.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Today's model controls for one bot, as Settings > Team has them: the agent, the level rule, Auto's limit and a custom
 *  model. Saved through the same `team_save`, so the core's rules are the same ones. */
function Models({ core, t, mate, table }: { core: CoreClient; t: T; mate: Teammate; table: LevelTable }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(mate));
  const [error, setError] = useState<unknown>('');
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(mate));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const got = (await core.request(saveOp(draft))) as Team;
      setTeam(got);
      const now = got.teammates.find((m) => m.id === mate.id);
      if (now) setDraft(draftOf(now));
      setError('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void save(e)}>
      <div className="team-picks">
        <MatePicks t={t} core={core} draft={draft} setDraft={setDraft} part="agent" />
      </div>
      <LevelRule t={t} table={table} draft={draft} setDraft={setDraft} />
      <UpTo t={t} table={table} draft={draft} setDraft={setDraft} />
      <div className="team-picks" role="group" aria-label={t('level.custom')}>
        <MatePicks t={t} core={core} draft={draft} setDraft={setDraft} part="model" />
      </div>
      <ErrorLine t={t} error={error ? rawError(error) : ''} />
      <div className="bot-acts">
        <button type="submit" className="btn p" disabled={busy || !dirty} aria-busy={busy || undefined}>
          {t('bots.models.save')}
        </button>
      </div>
    </form>
  );
}
