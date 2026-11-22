// Ticket 992 (teammate levels): a seat opens at a level that picks its model and effort from Settings > Team > Levels.
// Ticket 994: what the window shows of a level is the real model and effort, as the agent names them, after the level's
// bars ("▂ Haiku", "▂▄▆ Opus · high"); the level's own word (Light, Standard, Deep) is only a column head of the Levels
// table and the bars' tooltip. A seat shows what its session runs; a choice shows what its level would start now.
// Here: the bars, the pair's words, the table as the window knows it, and the menu on a seat's row and chat header
// where the user picks the level of the bot's next task. The running seat never changes; the pick is offered as a note
// for the place, kept through the note path (`note keep`), so the lead reads it from its next brief.
import { PLAIN } from '../plainText';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AcpRow, CoreClient } from '../api';
import { useReported } from '../chat/ContextRing';
import { lineError } from '../errors';
import type { Key, T } from '../i18n';
import { Icon } from '../icons/Icon';
import { noteOp } from '../notes/notes';
import { CLAUDE_MODELS, CODEX_MODELS, efforts, reportedLabel } from '../picker/catalog';
import { cleanCustomModels, CUSTOM_MODELS, type CustomModels } from '../settings/agents/newDefaults';
import type { AgentKind, Session } from '../types';
import { setTeam, useTeam, type Team, type Teammate } from './lead';

export type Level = 'light' | 'standard' | 'deep';
export const LEVELS: Level[] = ['light', 'standard', 'deep'];
export const isLevel = (v: unknown): v is Level => LEVELS.includes(v as Level);
/** The level's own word: a column head of the Levels table and the bars' tooltip, nowhere else (ticket 994). */
export const levelWord = (t: T, l: Level) => t(`level.${l}` as Key);
/** "▂ Haiku" for a native menu's option, which holds no drawing. */
export const barsText = (l: Level) => '▂▄▆'.slice(0, LEVELS.indexOf(l) + 1);

/** One cell of the level table: what a seat at that level starts with; an absent part is the agent's own choice. */
export type Pair = { model?: string | null; effort?: string | null };
/** The core's `team.levels`: per agent ("claude", "codex", an ACP agent as "acp:<name>") and level. */
export type LevelTable = Record<string, Partial<Record<Level, Pair>> | undefined>;
export const LEVELS_KEY = 'team.levels';
/** The core's defaults (team.rs `level_default`): Claude by model, Codex by effort on its default model, an ACP agent
 *  its own choice at every level. */
const DEFAULTS: Record<string, Record<Level, Pair>> = {
  claude: { light: { model: 'haiku' }, standard: { model: 'sonnet' }, deep: { model: 'opus' } },
  codex: { light: { effort: 'low' }, standard: { effort: 'medium' }, deep: { effort: 'high' } },
};
/** An agent's row in the table (team.rs `agent_key`). */
export const agentKey = (kind: string, agent?: string | null) => (kind === 'acp' ? `acp:${agent ?? ''}` : kind);
export const defaultPair = (key: string, l: Level): Pair => DEFAULTS[key]?.[l] ?? {};
export const slotPair = (table: LevelTable, key: string, l: Level): Pair => table[key]?.[l] ?? defaultPair(key, l);
export const samePair = (a: Pair, b: Pair) => (a.model ?? '') === (b.model ?? '') && (a.effort ?? '') === (b.effort ?? '');
/** Every level starts the same pair on this agent (an ACP agent nobody filled): there is nothing to choose between. */
export const oneLevel = (table: LevelTable, key: string) => LEVELS.every((l) => samePair(slotPair(table, key, l), slotPair(table, key, 'light')));

// What the window knows for a pair's words: the stored table, the owner's own model ids, and the ACP agents the user
// declared (the list Providers shows) with the models and thinking levels each last reported. Read once per core
// (Settings > Team hands in the table it writes, and reads the agents again each time it opens: `fresh`); the ACP
// listing only for a view that shows an ACP agent, since it runs each approved agent's `--version`.
type Known = { table: LevelTable; custom: CustomModels; agents: AcpRow[] };
let known: Known = { table: {}, custom: {}, agents: [] };
let readFor: CoreClient | null = null;
let agentsFor: CoreClient | null = null;
const subs = new Set<() => void>();
const publish = (next: Partial<Known>) => ((known = { ...known, ...next }), subs.forEach((f) => f()));
const isTable = (v: unknown): v is LevelTable => !!v && typeof v === 'object' && !Array.isArray(v);
export const setLevelTable = (table: LevelTable) => publish({ table });
export function useLevels(core: CoreClient, acp: boolean | 'fresh' = false): Known {
  useEffect(() => {
    if (readFor !== core) readTable(core);
  }, [core]);
  useEffect(() => readAgents(core, acp), [core, acp]);
  return useSyncExternalStore(subscribe, () => known);
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
/** The stored table and the owner's model ids. A view that is drawn before the window has its core (a widget kept in a
 *  rail) asks too early: the read is tried again, a few times, so a table the user changed shows after a restart
 *  without a visit to Settings (found by levels994_narrow). A window the core refuses (a browser tab) keeps the defaults. */
function readTable(core: CoreClient, tried = 0) {
  readFor = core;
  core.request({ op: 'quit_settings' }).then(
    (r) => {
      const features = (r as { settings: { features?: Record<string, unknown> } }).settings.features ?? {};
      publish({ table: isTable(features[LEVELS_KEY]) ? features[LEVELS_KEY] : {}, custom: cleanCustomModels(features[CUSTOM_MODELS]) });
    },
    () => {
      if (readFor !== core) return;
      readFor = null;
      if (tried < 5) setTimeout(() => readFor === null && readTable(core, tried + 1), 500 * (tried + 1));
    },
  );
}
function readAgents(core: CoreClient | null | undefined, acp: boolean | 'fresh') {
  if (!core || !acp || (acp !== 'fresh' && agentsFor === core)) return;
  agentsFor = core;
  core.acpAgents().then(
    (r) => publish({ agents: r.acp.filter((x) => x.acp && x.state != null) }),
    () => void (agentsFor = null),
  );
}
/** The tree names an ACP seat's model as its agent reported it: the agents are read once such a seat shows (`on`). */
export function useAcpNames(core: CoreClient | null | undefined, on: boolean) {
  useEffect(() => readAgents(core, on), [core, on]);
  useSyncExternalStore(subscribe, () => known.agents);
}

/** A model in short, as its agent names it: Claude's alias ("Opus"), a Codex model by the catalogue's label, the owner's
 *  own id by the name they gave it, an ACP model by the name its agent reported; any other by its own id. */
function modelName(kind: string, model: string, agent?: string | null): string {
  const listed = kind === 'claude' ? CLAUDE_MODELS : kind === 'codex' ? CODEX_MODELS : (known.agents.find((r) => r.name === agent)?.models ?? []);
  const own = kind === 'claude' || kind === 'codex' ? known.custom[kind]?.find((m) => m.id === model)?.name : undefined;
  return listed.find((m) => m.value === model)?.label ?? own ?? model;
}
/** The effort in the agent's own word ("xHigh"; an ACP agent's by the name it reported). */
const effortName = (kind: string, pair: Pair, agent?: string | null) =>
  (kind === 'acp' ? known.agents.find((r) => r.name === agent)?.efforts : efforts(kind as AgentKind, pair.model ?? null))?.find((e) => e.value === pair.effort)?.label ?? pair.effort ?? '';
/** A pair in words: "Haiku", "Opus · high", "GPT-6.1 Sol · low"; with no model "Default", and "Default · Opus 5.5" once
 *  its session reported what that is (`reported`, the agent's model id; one the catalogue cannot name shows as it came). */
export function pairText(t: T, kind: string, pair: Pair, o: { agent?: string | null; reported?: string } = {}): string {
  const model = pair.model ? modelName(kind, pair.model, o.agent) : [t('providers.default'), o.reported ? reportedLabel(kind as AgentKind, o.reported) || o.reported : ''].filter(Boolean).join(' · ');
  return pair.effort ? `${model} · ${effortName(kind, pair, o.agent)}` : model;
}
/** A pair's short form for a narrow place (`LevelMark`): the effort alone when the model is left to the agent
 *  ("Default · medium" reads "medium" beside its bars); '' when there is none (a named model, or nothing set). */
export const pairShort = (kind: string, pair: Pair, agent?: string | null) => (!pair.model && pair.effort ? effortName(kind, pair, agent) : '');
/** What a level would start now for a teammate (or a schedule's stored agent), from the table. */
export const slotText = (t: T, table: LevelTable, who: { kind: string; agent?: string | null }, l: Level) => pairText(t, who.kind, slotPair(table, agentKey(who.kind, who.agent), l), who);
/** What a seat runs: its session's own model and effort, also after the table changed; an effort the seat was not
 *  started with is the one its agent reported running at (`effort`), else none is claimed. */
export const seatText = (t: T, s: Session & Pair, reported?: string, effort?: string) =>
  pairText(t, s.kind, { model: s.model, effort: s.effort || effort }, { agent: s.acp_agent, reported });

/** What decides a teammate's level: its agent, its own model and its rule (a `Teammate`, or the Team form's draft). */
export type Ruled = { kind: string; agent?: string | null; model?: string | null; effort?: string | null; level?: unknown; level_max?: unknown; lead?: boolean };
/** The level a seat opens at when no task picks one (team.rs `seat_level`): its fixed level, else the middle one, up to
 *  Auto's limit. A lead's seat always opens so: a task's level never applies to it. */
export const ownLevel = (m: Ruled): Level => (isLevel(m.level) ? m.level : m.level_max === 'light' ? 'light' : 'standard');

/** The level's mark: three small ascending bars, `level` of them filled, in the surrounding text colour. Its tooltip names
 *  the level; the words beside it are the caller's (a pair's). */
export function Bars({ t, level, quiet }: { t: T; level: Level; quiet?: boolean }) {
  const filled = LEVELS.indexOf(level) + 1;
  const name = t('level.aria', { n: filled, level: levelWord(t, level) });
  // `quiet`: the tooltip only, kept out of a menu item's accessible name, which says the pair as its text does (look 1117 v9 Home S3-2).
  return (
    <span className="lvl" role="img" aria-label={name} aria-hidden={quiet || undefined} title={name} data-level={level}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
        {[0, 1, 2].map((i) => (
          <rect key={i} x={0.5 + i * 4} y={7 - i * 3} width="3" height={4 + i * 3} rx="0.75" fill="currentColor" opacity={i < filled ? 1 : 0.3} />
        ))}
      </svg>
    </span>
  );
}
// A narrow place: a tree row under 260 px, a row of the Schedules side widget, an Assistants row of the Team view (its
// column is 250 px in the wide tab too). The Schedules wide tab and every other place (the chat header, Settings, cards,
// menus) are not.
const HOSTS = '.row.wt2, .sched-row, .lead-row';
const narrow = (host: Element) => (host.matches('.row.wt2') ? host.clientWidth < 260 : host.matches('.lead-row') || !host.closest('.schedv')?.hasAttribute('data-wide'));
let ruler: CanvasRenderingContext2D | null | undefined;
const widthOf = (el: Element, words: string) => {
  ruler ??= document.createElement('canvas').getContext('2d');
  if (!ruler) return 0;
  ruler.font = getComputedStyle(el).font;
  return ruler.measureText(words).width;
};
/** Bars, then the pair they stand for. The pair is never cut inside a word: in a narrow place `short` (the effort alone,
 *  `pairShort`) stands for it, and a pair that still does not fit ends after a whole word, with an ellipsis. The whole
 *  pair is its tooltip. The room is the pair's own box, which CSS keeps as wide as the whole text or the room it has
 *  (`.lvl-pair::before` holds the whole text unseen), whatever is drawn in it. */
export function LevelMark({ t, level, text, short }: { t: T; level: Level; text: string; short?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState({ base: text, shown: text });
  const place = () => {
    const el = box.current;
    if (!el) return;
    const host = el.closest(HOSTS);
    const base = short && host && narrow(host) ? short : text;
    let shown = base;
    // Measured only once the box holds this base (its width follows `data-base`, set by the render after this one).
    if (el.dataset.base === base && el.scrollWidth > el.clientWidth + 1) {
      const words = base.split(' ');
      shown = `${words[0]}…`;
      for (let n = words.length - 1; n > 0; n--) {
        const cut = `${words.slice(0, n).join(' ').replace(/ ·$/, '')}…`;
        if (widthOf(el, cut) <= el.clientWidth) {
          shown = cut;
          break;
        }
      }
    }
    setFit((was) => (was.base === base && was.shown === shown ? was : { base, shown }));
  };
  useLayoutEffect(place); // after every render: the text, or the place's width (its own `data-wide`), may have changed
  useEffect(() => {
    const el = box.current;
    const host = el?.closest(HOSTS);
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    if (host) ro.observe(host);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="lvl-mark">
      <Bars t={t} level={level} />
      <span ref={box} className="lvl-pair" title={text} data-base={fit.base}>
        <span>{fit.base === text || fit.base === short ? fit.shown : text}</span>
      </span>
    </span>
  );
}

/** A teammate's level rule in a few words, with no seat open: "Auto", "Auto, up to Opus", a fixed level's bars and pair,
 *  its custom model, or the one pair of an agent whose levels are all the same. `own`: the pair its seat opens with when
 *  no task picks a level, for a lead (whose seat always opens so). */
export function RuleText({ t, table, m, own }: { t: T; table: LevelTable; m: Ruled; own?: boolean }) {
  if (m.model) return <span title={t('level.custom')}>{pairText(t, m.kind, m, m)}</span>;
  if (oneLevel(table, agentKey(m.kind, m.agent))) return <span title={t('level.same')}>{slotText(t, table, m, 'light')}</span>;
  const level = isLevel(m.level) ? m.level : own ? ownLevel(m) : null;
  if (level) return <LevelMark t={t} level={level} text={slotText(t, table, m, level)} />;
  return <>{isLevel(m.level_max) ? t('level.autoUpTo', { level: slotText(t, table, m, m.level_max) }) : t('level.auto')}</>;
}

/** The first line of the seat's task, for the note: a schedule's task in the brief or after it, else the newest message. */
export function taskLine(s: Session): string {
  const log = (s as Session & { send_log?: { content?: string }[] }).send_log ?? [];
  for (const { content = '' } of [...log].reverse()) {
    const after = content.includes('## Scheduled task\n') ? content.split('## Scheduled task\n')[1] : content.startsWith('Scheduled task from the user') ? content.split('\n\n').slice(1).join('\n') : content.includes('standing role') ? '' : content;
    const line = after.split('\n').find((l) => l.trim())?.trim();
    // Short, cut at a word, so the kept note stays one line in Settings > Notes (look v9 Home S3-8).
    if (line) return line.length > 32 ? `${line.slice(0, 32).replace(/\s+\S*$/, '')}…` : line;
  }
  return '';
}

/** The level chip of a seat: bars, then the model and effort the seat runs. An Auto bot's chip opens the level menu; a
 *  pinned bot's, and one on an agent whose levels are all the same, has nothing to pick and only says why.
 *  Nothing for a session that is not a seat at a level (a custom model, any other session). */
export function LevelChip({ t, core, session }: { t: T; core: CoreClient; session: Session }) {
  const team = useTeam(core, true);
  const { table } = useLevels(core, session.kind === 'acp');
  const reported = useReported(session.id, 'model');
  const effort = useReported(session.id, 'effort');
  const mate = team.teammates.find((m) => m.id === session.teammate);
  const level = session.level;
  if (!mate || !isLevel(level) || mate.model) return null;
  const text = seatText(t, session, reported, effort);
  const short = pairShort(session.kind, session as Pair, session.acp_agent);
  const fixed = mate.level ? t('level.pinned') : oneLevel(table, agentKey(mate.kind, mate.agent)) ? t('level.same') : '';
  if (fixed)
    return (
      <span className="chip qlevel-btn lvl-chip" title={fixed}>
        <LevelMark t={t} level={level} text={text} short={short} />
      </span>
    );
  return <LevelMenu t={t} core={core} team={team} table={table} mate={mate} session={session} level={level} text={text} short={short} />;
}

function LevelMenu({ t, core, team, table, mate, session, level, text, short }: { t: T; core: CoreClient; team: Team; table: LevelTable; mate: Teammate; session: Session; level: Level; text: string; short: string }) {
  const [open, setOpen] = useState(false);
  // After a pick: the note line offered for the place, then whether it was kept.
  const [offer, setOffer] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const [err, setErr] = useState('');
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const next = isLevel(mate.next_level) ? mate.next_level : level;
  // Look 1117 v12 Home S3-5: the chip names the running seat; a level picked for the next task shows after it.
  const pending = next !== level ? t('level.pending', { level: slotText(t, table, mate, next) }) : '';
  // Sixth look: in a chat header at a narrow centre the menu and its note card shift left by what would run past the
  // header's right edge (a Team view row lays them out in the row's own width: lead.css).
  const fit = (el: HTMLDivElement | null) => {
    if (!el) return;
    el.style.marginLeft = '';
    const edge = el.closest('.shead')?.getBoundingClientRect().right;
    if (edge !== undefined) el.style.marginLeft = `${Math.min(0, edge - el.getBoundingClientRect().right)}px`;
  };
  const close = () => (setOpen(false), setOffer(null), setKept(false), setErr(''));
  // NotifyLevel's menu pattern: focus goes in on open (on the checked level), arrows move, Esc closes back to the button.
  useEffect(() => void (open && !offer && (menu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus()), [open, offer]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => e.code === 'Escape' && !e.isComposing && (close(), button.current?.focus());
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const move = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => (e.preventDefault(), list[(i + list.length) % list.length]?.focus());
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
  };
  const pick = async (l: Level) => {
    if (l === next) return close();
    setErr('');
    try {
      // Back to the seat's own level: the earlier pick is taken back, and there is nothing to note.
      setTeam((await core.request({ op: 'team_level', id: mate.id, ...(l === level ? {} : { level: l }) })) as Team);
      if (l === level) return close();
      // The user reads the model they picked; the lead reads the level word it passes to `team open --level` (team.rs brief).
      const task = taskLine(session);
      const words = `${slotText(t, table, mate, l)} (${l})`;
      setOffer(task ? t('level.note', { name: mate.name, level: words, task }) : t('level.noteAny', { name: mate.name, level: words }));
    } catch (e) {
      setErr(lineError(t, e));
    }
  };
  const keep = async () => {
    if (!offer?.trim()) return;
    try {
      await noteOp(core, { operation: 'keep', text: offer.trim(), scope: { kind: 'project', project: mate.project ?? team.home } });
      setKept(true);
    } catch (e) {
      setErr(lineError(t, e));
    }
  };
  return (
    <span className="qlevel lvl-menu" ref={root}>
      <button ref={button} className="chip qlevel-btn lvl-chip" aria-label={[t('level.chip', { name: mate.name, level: text }), pending].filter(Boolean).join('. ')} aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <LevelMark t={t} level={level} text={text} short={short} />
        {pending && (
          <span className="lvl-next" title={pending} aria-hidden>
            →<Bars t={t} level={next} />
          </span>
        )}
        <Icon name="triangle-down" size={10} />
      </button>
      {open && !offer && (
        <div ref={(el) => void ((menu.current = el), fit(el))} className="plusmenu qlevel-menu lvl-list" role="menu" aria-label={t('level.menu', { name: mate.name })} onKeyDown={move}>
          {LEVELS.map((l) => (
            <button key={l} role="menuitemradio" aria-checked={l === next} data-level={l} onClick={() => void pick(l)}>
              <span className="lvl-check" aria-hidden>
                {l === next && <Icon name="check" size={12} />}
              </span>
              <Bars t={t} level={l} quiet />
              <span className="lvl-words">
                <b>{slotText(t, table, mate, l)}</b>
                <small>{t(`level.hint.${l}` as Key)}</small>
              </span>
            </button>
          ))}
          <p className="lvl-foot" role="presentation">
            {t('level.foot', { name: mate.name })}
          </p>
          {err && <p className="lvl-foot err">{err}</p>}
        </div>
      )}
      {open && offer !== null && (
        <div ref={fit} className="plusmenu qlevel-menu lvl-list lvl-offer" role="group" aria-label={t('level.noteAsk')}>
          {kept ? (
            <p className="lvl-foot" role="status">
              {t('level.noteKept')}
            </p>
          ) : (
            <>
              <p className="lvl-ask">{t('level.noteAsk')}</p>
              <input {...PLAIN} className="sinp" autoFocus aria-label={t('level.noteText')} value={offer} maxLength={300} onChange={(e) => setOffer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void keep()} />
              <div className="lvl-acts">
                <button type="button" className="btn p" disabled={!offer.trim()} onClick={() => void keep()}>
                  {t('level.noteKeep')}
                </button>
                <button type="button" className="btn" onClick={close}>
                  {t('level.noteSkip')}
                </button>
              </div>
              <p className="lvl-foot">{t('level.foot', { name: mate.name })}</p>
            </>
          )}
          {err && <p className="lvl-foot err">{err}</p>}
        </div>
      )}
    </span>
  );
}
