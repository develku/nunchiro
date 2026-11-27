// Owner 2026-11-16: Settings > Team. A teammate is a saved seat (name, job, agent, a memory file of its own); the core
// keeps the list and builds its brief (crates/nunchiro-core/src/team.rs, window-only ops). Opening one starts an ordinary
// session labelled with its name and sends the brief as its first message, so permissions, approvals and the room
// guards are the ones every session has. A project teammate works in that project; a Home teammate in the team's own
// folder, which all Home teammates share (one folder, one room).
// Concept after Grok Bot and superbot (https://github.com/davidondrej/superbot, MIT): a name, a job and a memory per
// teammate. No code is taken from it; superbot runs every bot with permission prompts off, which this does not do.
// Ticket 993 rule 7 (owner 11-18, "too much text"): a row is the name, the level chip, the place and agent in small type
// and one line of the job; a press opens the whole job in place; Open, and a menu with Edit and Remove. The form shows
// five fields, the rest under Advanced; what explained mechanics is behind an "i" (Info). Levels are one line that opens.
// Ticket 994 (owner 11-18, "advanced users"): a level reads as the model and effort it starts, after its bars; the level's
// own word is only a column head of the Levels table. That table has a row per agent the user has (Claude, Codex, each
// ACP agent Providers lists), three levels each; a teammate may run an ACP agent.
import { PLAIN } from '../plainText';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { AcpRow } from '../api';
import { ErrorLine, rawError } from '../errors';
import { Icon } from '../icons/Icon';
import { TABLES } from '../i18n';
import { efforts, type Option } from '../picker/catalog';
import { isOff, modelChoices, MODELS_OFF, useCustomModels } from '../settings/agents/newDefaults';
import { useFeatureSetting } from '../settings/useFeatureSetting';
import { Reset, Row, Sec, SecReset, Seg, Select, Why } from '../settings/shell/Row';
import { PageSummary } from '../settings/shell/PageActions';
import { useCoreFeature } from '../settings/useFeatureSetting';
import { agentKey, Bars, barsText, defaultPair, LEVELS, LEVELS_KEY, LevelMark, RuleText, isLevel, levelWord, oneLevel, samePair, setLevelTable, slotPair, slotText, useLevels, type Level, type LevelTable as Table, type Pair } from '../lead/level';
import { basename, openSession } from '../tree';
import { openSeat, setTeam, type Team, type Teammate } from '../lead/lead';
import { useScheduleList } from '../schedule/schedules';
import { PLACE_FIELD, PlaceSection } from '../lead/place';
import type { Place } from '../lead/tasks';
import { registerSettingsPage, type PageContext } from './registry';
import { LevelsMoved, OpenBots } from '../bots/BotsMoved'; // ticket 1168
import '../lead/lead.css'; // the row menu (.lead-more, .lead-menu), as the Schedules tab's rows
import './team.css';

const PAGE = 'team';
// Ticket 994: `acp` with `agent`, the ACP agent's name in agents.toml.
type Kind = 'claude' | 'codex' | 'acp';
const KINDS: ['claude' | 'codex', string][] = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
];
type Listed = Team;
// `model` and `effort`: '' is the agent's default. Ticket 990: `lead` leads its place (at most one; a second moves the role).
// Ticket 992: `level` '' is Auto (`levelMax` '' no limit), else pinned; a `model` makes it a custom model, with no levels.
export type Draft = { id?: string; name: string; job: string; kind: Kind; agent?: string; project: string; model: string; effort: string; lead: boolean; level?: '' | Level; levelMax?: '' | Level };
const EMPTY: Draft = { name: '', job: '', kind: 'claude', project: '', model: '', effort: '', lead: false, level: '', levelMax: '' };
export const draftOf = (m: Teammate): Draft => ({ id: m.id, name: m.name, job: m.job, kind: m.kind, agent: m.agent ?? '', project: m.project ?? '', model: m.model ?? '', effort: m.effort ?? '', lead: !!m.lead, level: isLevel(m.level) ? m.level : '', levelMax: isLevel(m.level_max) ? m.level_max : '' });
/** The `team_save` op of a draft. */
export const saveOp = ({ id, name, job, kind, agent, project, model, effort, lead, level, levelMax }: Draft) => ({ op: 'team_save', ...(id ? { id } : {}), name, job, kind, ...(kind === 'acp' && agent ? { agent } : {}), ...(project ? { project } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(lead ? { lead } : {}), ...(level && !model ? { level } : {}), ...(!level && levelMax && !model ? { level_max: levelMax } : {}) });
/** The draft's rule as a teammate's (`RuleText`, `ownLevel`). */
const ruled = (d: Pick<Draft, 'kind' | 'agent' | 'model' | 'effort' | 'level' | 'levelMax' | 'lead'>) => ({ kind: d.kind, agent: d.agent, model: d.model, effort: d.effort, level: d.level, level_max: d.levelMax, lead: d.lead });
/** An agent's name as Providers shows it. */
const agentName = (agents: AcpRow[], kind: Kind, agent?: string | null) => (kind === 'acp' ? (agents.find((r) => r.name === agent)?.label ?? agent ?? 'ACP') : (KINDS.find(([v]) => v === kind)?.[1] ?? kind));

/** The row's one line of the job: the first sentence of its first line (the row's CSS cuts what does not fit). */
const jobLine = (job: string) => {
  const line = job.split('\n').find((l) => l.trim())?.trim() ?? '';
  return /^.+?[.!?。！？](?=\s|$)/.exec(line)?.[0] ?? line;
};

/** What a field means, behind a small "i": the app's tooltip on hover and on keyboard focus, and the button's own
 *  description for a screen reader. Never inside a <label> (a button there takes the label from its control). */
function Info({ t, label, text }: { t: PageContext['t']; label: string; text: string }) {
  return (
    <button type="button" className="team-info" aria-label={t('team.about', { label })} aria-description={text} data-tip={text}>
      <Icon name="info" size={12} />
    </button>
  );
}
/** A form field whose caption carries an Info: the control names itself (aria-label), as the Schedules form's fields. */
const Field = ({ caption, info, children }: { caption: string; info?: ReactNode; children: ReactNode }) => (
  <div className="team-f">
    <span className="team-k">
      <span aria-hidden>{caption}</span>
      {info}
    </span>
    {children}
  </div>
);

function TeamPage({ core, t, projects, closeSettings, toast, sessions }: Pick<PageContext, 'core' | 't' | 'projects' | 'closeSettings' | 'toast' | 'sessions'>) {
  const schedules = useScheduleList();
  const [placeSum, setPlaceSum] = useState<{ project: string; place: Place } | null>(null); // ticket 1099
  const [list, setList] = useState<Listed | null>(null);
  const [error, setError] = useState<unknown>('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // Look C S3: a row the menu's Remove opened (to ask in it) folds again on Cancel: it goes back to how it was.
  const openedToAsk = useRef(false);
  const askRemove = (id: string) => ((openedToAsk.current = shown !== id), setShown(id), setRemoving(id));
  const keep = () => (setRemoving(null), openedToAsk.current && setShown(null), (openedToAsk.current = false));
  const [shown, setShown] = useState<string | null>(null); // the row whose whole job shows
  const { table, agents } = useLevels(core, 'fresh');
  const [menu, setMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (op: { op: string; [k: string]: unknown }) => {
    setError('');
    setBusy(true);
    try {
      const got = (await core.request(op)) as Listed;
      setList(got);
      setTeam(got); // the tree and the leader's header follow at once
      return got;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => void act({ op: 'team_list' }), [core]); // eslint-disable-line react-hooks/exhaustive-deps
  // Q9 zh-hant-J11-4: Edit reads the list again first, so the form starts from the saved teammate, not this window's
  // old copy (a save from another window since would be written over).
  const edit = async (id: string) => {
    setMenu(null);
    const m = (await act({ op: 'team_list' }))?.teammates.find((x) => x.id === id);
    if (m) setDraft(draftOf(m));
  };
  // Q9 zh-hant-J11-1: an open form with typed changes keeps them: another row's Edit waits until Save or Cancel.
  const saved = draft?.id ? list?.teammates.find((m) => m.id === draft.id) : undefined;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved ? draftOf(saved) : EMPTY);

  // The form opens where its teammate's row is (Add: at the top of the list), comes into view and its Name takes the
  // focus (sixth look, Home S3: Edit must show something new on screen), also from one teammate's Edit to another's.
  // Cancel and Save give the focus back to what opened it: that row's "⋯", or Add.
  const form = useRef<HTMLFormElement>(null);
  const editing = draft ? (draft.id ?? 'new') : null;
  const opener = useRef<string | null>(null);
  useEffect(() => {
    if (editing) {
      opener.current = editing;
      form.current?.scrollIntoView({ block: 'nearest' });
      form.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
      return;
    }
    const from = opener.current;
    opener.current = null;
    if (from) document.querySelector<HTMLElement>(from === 'new' ? '.settings [data-setting="team"]' : `.settings [data-row="team:${CSS.escape(from)}"] .lead-more`)?.focus();
  }, [editing]);
  // Advanced starts open for a teammate that has one of its three set; it is the user's to fold after that.
  const advanced = useMemo(() => !!draft && !!(draft.model || draft.effort || draft.levelMax || draft.lead), [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  // The row menu, as the Schedules tab's: focus goes in, a press elsewhere or Esc closes it (Esc back to its button, and
  // not on to Settings: Overlay.tsx closes only on an Esc nothing took).
  useEffect(() => {
    if (!menu) return;
    const row = () => document.querySelector<HTMLElement>(`.settings [data-row="team:${CSS.escape(menu)}"]`);
    row()?.querySelector<HTMLElement>('.lead-menu button')?.focus();
    const away = (e: PointerEvent) => !(e.target as Element).closest?.('.lead-menu, .lead-more') && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), setMenu(null), row()?.querySelector<HTMLElement>('.lead-more')?.focus());
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => (document.removeEventListener('pointerdown', away, true), document.removeEventListener('keydown', esc));
  }, [menu]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    if (await act(saveOp(draft))) setDraft(null);
  };
  // One seat, one session: the core shows an open seat, or starts one in the teammate's folder with its brief.
  const opening = useRef<Teammate | null>(null); // the teammate a held open's Start anyway opens
  const open = async (m: Teammate, anyway = false) => {
    setError('');
    setBusy(true);
    opening.current = m;
    try {
      const { session, started } = await openSeat(core, m.id, anyway);
      toast?.(t(started ? 'team.started' : 'team.opened', { name: m.name }));
      flushSync(closeSettings);
      openSession(session.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  // Look 1117 v12 Home S3-8: the lead of a project removed from the tree stays a teammate (adding the project back finds
  // it again), but its row says the project is gone, as the Team icon no longer shows it.
  const where = (m: Teammate) => (!m.project ? t('assistants.title') : projects.includes(m.project) ? basename(m.project) : t('team.whereGone', { where: basename(m.project) }));

  // One form, in the place of what it edits: the edited teammate's row gives way to it; a new teammate's is the
  // card's first line, under the Add button that opened it.
  const formEl = draft && (
    <form
      ref={form}
      className="team-form"
      role="group"
      aria-label={t('team.form')}
      onSubmit={(e) => void save(e)}
      // Look v10 C: Esc here closed the whole Settings sheet and lost the typed name and job. Esc stays in the form: an
      // empty new form closes, a form with typed text keeps it (Cancel drops it on purpose).
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        if (!draft.id && !draft.name.trim() && !draft.job.trim()) setDraft(null);
      }}
    >
      <label>
        <span>{t('team.name')} <small className="req">{t('team.required')}</small></span>
        <input {...PLAIN} className="sinp" aria-label={t('team.name')} required value={draft.name} maxLength={40} autoComplete="off" spellCheck={false} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        {draft.name.length >= 40 && <small className="req" role="status">{t('team.nameMax')}</small>}
      </label>
      {/* v10-C-N7: a save error (a name already taken) shows here, by the Name field, not above the page. */}
      <ErrorLine t={t} error={error ? rawError(error) : ''} />
      <label>
        <span>{t('team.job')} <small className="req">{t('team.required')}</small></span>
        <textarea {...PLAIN} className="sinp" aria-label={t('team.job')} required rows={3} value={draft.job} maxLength={2000} placeholder={t('team.jobHint')} onChange={(e) => setDraft({ ...draft, job: e.target.value })} />
      </label>
      <div className="team-picks">
        <Field caption={t('team.where')} info={<Info t={t} label={t('team.where')} text={t('team.whereTip')} />}>
          <Select label={t('team.where')} value={draft.project} onChange={(project) => setDraft({ ...draft, project })}>
            <option value="">{t('team.home')}</option>
            {/* A saved project that left the tree stays pickable, so an edit does not move the teammate by itself. */}
            {[...new Set([...projects, ...(draft.project ? [draft.project] : [])])].map((p) => (
              <option key={p} value={p}>
                {basename(p)}
              </option>
            ))}
          </Select>
        </Field>
        <MatePicks t={t} core={core} draft={draft} setDraft={setDraft} part="agent" info={<Info t={t} label={t('team.agent')} text={t('team.agentTip')} />} />
      </div>
      <LevelRule t={t} table={table} draft={draft} setDraft={setDraft} />
      {/* The key reopens it per teammate. */}
      <details key={draft.id ?? 'new'} className="hk-adv team-adv" open={advanced || undefined}>
        <summary>
          <Icon name="chevron-right" size={12} />
          <b>{t('settings.keys.advanced')}</b>
        </summary>
        {/* "Up to" is Auto's limit: a fixed level, a custom model, a lead (its seat keeps its own level) and an agent whose
            levels are all the same have none. */}
        <UpTo t={t} table={table} draft={draft} setDraft={setDraft} />
        <Field caption={t('level.custom')} info={<Info t={t} label={t('level.custom')} text={t('level.customNote')} />}>
          <div className="team-picks" role="group" aria-label={t('level.custom')}>
            <MatePicks t={t} core={core} draft={draft} setDraft={setDraft} part="model" />
          </div>
        </Field>
        <div className="team-leads">
          <label className="team-lead">
            <input type="checkbox" checked={draft.lead} onChange={(e) => setDraft({ ...draft, lead: e.target.checked })} />
            <span>{t('lead.leads')}</span>
          </label>
          <Info t={t} label={t('lead.leads')} text={t('lead.leadsNote')} />
        </div>
      </details>
      <div className="team-acts">
        {/* Ticket 543: with no name or job yet it only waits for typing (data-idle). */}
        <button type="submit" className="btn p" disabled={busy || !draft.name.trim() || !draft.job.trim()} aria-busy={busy || undefined} data-idle={(!busy && (!draft.name.trim() || !draft.job.trim())) || undefined}>
          {t('team.save')}
        </button>
        <button type="button" className="btn" onClick={() => (setDraft(null), setError(''))}>
          {t('team.cancel')}
        </button>
      </div>
    </form>
  );
  return (
    <div className="ssec-group">
      <PageSummary parts={[[t('summary.teammates'), list?.teammates.length], ...(placeSum ? ([[basename(placeSum.project), t(`lead.way.${placeSum.place.way}`)], [t('lead.cap.group'), placeSum.place.cap ?? 4]] as [string, string | number][]) : [])]} />
      {/* Ticket 1099: how each project's lead works, first on the page (mockup panel 1). */}
      <PlaceSection core={core} t={t} projects={projects} sessions={sessions ?? []} onSummary={setPlaceSum} />
      {!draft && <ErrorLine t={t} error={error ? rawError(error) : ''} anyway={() => opening.current && void open(opening.current, true)} />}
      <Sec
        id="h-team"
        className="team-sec"
        title={t('team.section')}
        action={
          !draft && (
            <>
              {/* Ticket 1168: the Bots view shows these teammates as bots (face, seat, SOUL). */}
              <OpenBots t={t} />
              {/* Ticket 991 C15: the same Add button as Add machine (outlined, with the plus). */}
              <button type="button" className="btn withicon" data-setting="team" onClick={() => setDraft(EMPTY)}>
                <Icon name="plus" size={14} />
                {t('team.add')}
              </button>
            </>
          )
        }
      >
        {list && list.teammates.length === 0 && !draft && (
          <div className="team-none" role="status">
            <Icon name="people" size={24} />
            <p>{t('team.none')}</p>
          </div>
        )}
        {draft && !draft.id && formEl}
        {list?.teammates.map((m) => {
          if (draft?.id === m.id) return <Fragment key={m.id}>{formEl}</Fragment>;
          const isOpen = shown === m.id;
          return (
            <Row
              key={m.id}
              setting={`team:${m.id}`}
              className="team-row"
              label={
                <button type="button" className="team-go" aria-expanded={isOpen} aria-controls={isOpen ? `team-d-${m.id}` : undefined} onClick={() => (setRemoving(null), (openedToAsk.current = false), setShown(isOpen ? null : m.id))}>
                  <Icon name="chevron-right" size={12} />
                  {m.name}
                </button>
              }
              chip={
                <>
                  <span className="chip tag" data-rule>
                    <RuleText t={t} table={table} m={m} own={!!m.lead} />
                  </span>
                  {m.lead && <span className="chip tag" data-lead>{t('lead.tag')}</span>}
                  <span className="team-where">{t('team.row', { where: where(m), agent: agentName(agents, m.kind, m.agent) })}</span>
                </>
              }
              desc={isOpen ? undefined : jobLine(m.job)}
              extra={
                isOpen && (
                  <div className="team-detail" id={`team-d-${m.id}`} role="group" aria-label={m.name}>
                    <p className="team-job">{m.job}</p>
                    {removing === m.id && (
                      <div className="team-ask" role="group" aria-label={t('team.removeAsk', { name: m.name })}>
                        <span>
                          {/* Look 1117 v11 (C NC3): what hangs on it ends with it (the core's team_remove closes its seat and switches its schedules off). */}
                          {[
                            t('team.removeAsk', { name: m.name }),
                            sessions?.some((s) => s.teammate === m.id && s.state === 'running') && t('team.removeSeat'),
                            ((n) => n > 0 && t(n === 1 ? 'team.removeSchedules.one' : 'team.removeSchedules.other', { n }))((schedules ?? []).filter((x) => x.run.teammate === m.id && !x.paused).length),
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        </span>
                        <button type="button" className="btn danger" disabled={busy} aria-busy={busy || undefined} onClick={() => void act({ op: 'team_remove', id: m.id }).then(() => setRemoving(null))}>
                          {t('team.remove')}
                        </button>
                        <button type="button" className="btn" autoFocus onClick={keep}>
                          {t('team.cancel')}
                        </button>
                      </div>
                    )}
                  </div>
                )
              }
              control={
                <>
                  <button type="button" className="btn" disabled={busy} aria-busy={busy || undefined} aria-label={t('team.openOf', { name: m.name })} onClick={() => void open(m)}>
                    {t('team.open')}
                  </button>
                  <button type="button" className="lead-more" aria-label={t('lead.band.actions', { name: m.name })} aria-haspopup="menu" aria-expanded={menu === m.id} onClick={() => setMenu(menu === m.id ? null : m.id)}>
                    ⋯
                  </button>
                  {menu === m.id && (
                    <div className="lead-menu" role="menu">
                      <button type="button" role="menuitem" disabled={dirty} onClick={() => void edit(m.id)}>
                        {t('team.edit')}
                      </button>
                      <button type="button" role="menuitem" onClick={() => (setMenu(null), askRemove(m.id))}>
                        {t('team.remove')}
                      </button>
                    </div>
                  )}
                </>
              }
            />
          );
        })}
      </Sec>
      {/* Shown with no teammate too: levels also apply to staffed roles and schedules. Their table is in the Bots view. */}
      <LevelsMoved t={t} />
    </div>
  );
}

/** Auto's upper limit ("Up to"). Its own component since ticket 1168: a bot's page shows it too (bots/BotsView.tsx). */
export function UpTo({ t, table, draft, setDraft }: { t: PageContext['t']; table: Table; draft: Draft; setDraft: (d: Draft) => void }) {
  if (draft.model || draft.level || draft.lead || oneLevel(table, agentKey(draft.kind, draft.agent))) return null;
  return (
    <Field caption={t('level.upTo')}>
      <Select label={t('level.upTo')} value={draft.levelMax ?? ''} onChange={(v) => setDraft({ ...draft, levelMax: isLevel(v) ? v : '' })}>
        <option value="">{t('level.noLimit')}</option>
        {LEVELS.map((l) => (
          <option key={l} value={l}>
            {barsText(l)} {slotText(t, table, draft, l)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Ticket 992: the level rule, one choice: Auto or a fixed level, each level as the model and effort it starts for this
 *  teammate's agent (ticket 994). A custom model leaves it off, and says so on its own line (the kit's Why, ticket 475:
 *  why a control cannot work is never only a tooltip). Auto's "Up to" is under Advanced. No choice, and the rule as
 *  text, for a lead (its seat keeps its own level: no task's level replaces the conversation the user talks to) and for
 *  an agent whose levels are all the same. */
export function LevelRule({ t, table, draft, setDraft }: { t: PageContext['t']; table: Table; draft: Draft; setDraft: (d: Draft) => void }) {
  const off = !!draft.model;
  const one = oneLevel(table, agentKey(draft.kind, draft.agent));
  // The choices are one line while they fit the form, else a column (team.css): measured as a line, after every render
  // (the agent, the table and so the pairs change) and when the form's width changes.
  const box = useRef<HTMLDivElement>(null);
  const lay = () => {
    const seg = box.current?.querySelector<HTMLElement>('.sseg');
    if (!box.current || !seg) return;
    delete box.current.dataset.col;
    if (seg.scrollWidth > seg.clientWidth) box.current.dataset.col = '';
  };
  useLayoutEffect(lay);
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(lay);
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const caption = (
    <span className="team-k">
      <span aria-hidden>{t('level.rule')}</span>
      <Info t={t} label={t('level.rule')} text={t('level.ruleTip')} />
    </span>
  );
  if (!off && (draft.lead || one))
    return (
      <div className="team-f team-level" role="group" aria-label={t('level.rule')}>
        {caption}
        <span className="team-rule" data-rule>
          <RuleText t={t} table={table} m={ruled(draft)} own />
        </span>
        <small className="team-rulewhy">{t(one ? 'level.same' : 'level.leadKeeps')}</small>
      </div>
    );
  return (
    <div ref={box} className="team-f team-level" role="group" aria-label={t('level.rule')} aria-disabled={off || undefined} aria-describedby={off ? 'why-team-level' : undefined} data-off={off || undefined}>
      {caption}
      <Seg<'auto' | Level> name={`team-level-${draft.id ?? 'new'}`} label={t('level.rule')} value={off ? null : draft.level || 'auto'} options={[['auto', t('level.auto')], ...LEVELS.map((l): [Level, ReactNode] => [l, <LevelMark key={l} t={t} level={l} text={slotText(t, table, draft, l)} />])]} onChange={(v) => setDraft({ ...draft, level: v === 'auto' ? '' : v })} />
      {off && <Why id="why-team-level" reason={t('level.customOn')} />}
    </div>
  );
}

/** Ticket 992: Settings > Team > Levels, the model and effort each level starts with. Ticket 993: at rest one line of
 *  what is stored ("▂ Haiku · ▂▄ Sonnet · ▂▄▆ Opus"; Claude's, and another agent's once it is changed); Edit opens the
 *  table. Ticket 994: a row per agent the user has (Claude, Codex, each ACP agent Providers lists), a column per level;
 *  a cell is that agent's own model and, where it has them, effort (the Team form's pickers; the core checks Claude's
 *  and Codex's cells as a session start checks `--model` and `--effort`, and asks an ACP agent only for what it lists).
 *  A row whose three levels are the same says so. A changed row has the kit's row reset, the card its "Reset to
 *  defaults" (tickets 311, 453), so nothing here is a disabled button. */
export function LevelTable({ t, core, agents }: { t: PageContext['t']; core: PageContext['core']; agents: AcpRow[] }) {
  const [table, set, error] = useCoreFeature<Table>(LEVELS_KEY, {});
  const [open, setOpen] = useState(false);
  // The rows, chips and menus of the window follow the table at once (not the empty one this starts with, before the
  // core's answer: the window already has the stored table).
  const unread = useRef(true);
  useEffect(() => (unread.current ? void (unread.current = false) : setLevelTable(table)), [table]);
  const rows: { key: string; kind: Kind; agent?: string; name: string }[] = [...KINDS.map(([kind, name]) => ({ key: kind, kind, name })), ...agents.map((r) => ({ key: agentKey('acp', r.name), kind: 'acp' as const, agent: r.name, name: r.label }))];
  const changed = (key: string) => LEVELS.some((l) => !samePair(slotPair(table, key, l), defaultPair(key, l)));
  // `table` is the last edit until the core answers it (useCoreFeature), so two quick picks both land. Only what
  // differs from the defaults is stored: a table with nothing left is removed.
  const write = (next: Table) => {
    const kept = Object.entries(next).flatMap(([key, levels]) => {
      const cells = Object.entries(levels ?? {}).filter(([l, cell]) => !samePair(cell ?? {}, defaultPair(key, l as Level)));
      return cells.length ? [[key, Object.fromEntries(cells)] as const] : [];
    });
    void set(kept.length ? (Object.fromEntries(kept) as Table) : null);
  };
  const put = (key: string, l: Level, c: Pair) => write({ ...table, [key]: { ...table[key], [l]: { ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}) } } });
  const lines = rows.filter((r) => r.key === 'claude' || changed(r.key));
  return (
    <>
    <Sec id="h-levels" title={t('level.table')} action={open && <SecReset t={t} section={t('level.table')} show={rows.some((r) => changed(r.key))} run={() => write({})} undo={() => write(table)} />}>
      <ErrorLine t={t} error={error} />
      <Row
        setting="levels"
        className="team-lvline"
        // The "i" starts the line: its tooltip opens over the line's own words, clear of the Edit button (look C S3).
        icon={<Info t={t} label={t('level.table')} text={t('level.tableNote')} />}
        label={
          <span className="team-lvsum">
            {lines.map((r) => (
              <span key={r.key} className="team-lvl" data-agent={r.key}>
                {lines.length > 1 && <span className="team-lvagent">{r.name} </span>}
                {/* Look 1117 v10 (C6): an agent whose levels are all the same says its one choice once, not "Default Default Default". */}
                {oneLevel(table, r.key) ? (
                  <span title={t('level.same')}>{slotText(t, table, r, 'light')} </span>
                ) : (
                  LEVELS.map((l) => (
                    <Fragment key={l}>
                      <LevelMark t={t} level={l} text={slotText(t, table, r, l)} />{' '}
                    </Fragment>
                  ))
                )}
              </span>
            ))}
          </span>
        }
        control={
          <button type="button" className="btn" data-setting="levels" aria-expanded={open} aria-label={open ? undefined : t('team.editOf', { name: t('level.table') })} onClick={() => setOpen(!open)}>
            {open ? t('level.done') : t('team.edit')}
          </button>
        }
      />
      {open && (
        <div className="srow team-lvrow team-lvhead" aria-hidden>
          <div className="slab" />
          <div className="sctl">
            <div className="team-lvcells">
              <span />
              {LEVELS.map((l) => (
                <span key={l} className="team-lvcap">
                  <Bars t={t} level={l} /> {levelWord(t, l)}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      {open &&
        rows.map((r) => (
          <Row
            key={r.key}
            setting={`level:${r.key}`}
            className="team-lvrow"
            top
            label={r.name}
            desc={oneLevel(table, r.key) ? t('level.same') : undefined}
            reset={<Reset t={t} label={r.name} show={changed(r.key)} run={() => write(Object.fromEntries(Object.entries(table).filter(([key]) => key !== r.key)))} />}
            control={
              <div className="team-lvcells">
                {/* A line of models, then a line of efforts for an agent that has any (or has one stored). */}
                {(['model', 'effort'] as const)
                  .filter((only) => only === 'model' || r.kind !== 'acp' || !!agents.find((a) => a.name === r.agent)?.efforts?.length || LEVELS.some((l) => slotPair(table, r.key, l).effort))
                  .map((only) => {
                    const caption = only === 'model' ? t('providers.modelOne') : t('agents.new.effort');
                    return (
                      <Fragment key={only}>
                        <span className="team-lvk" aria-hidden>
                          {caption}
                        </span>
                        {LEVELS.map((l) => (
                          <MatePicks key={l} t={t} core={core} part="model" only={only} draft={{ kind: r.kind, agent: r.agent, model: slotPair(table, r.key, l).model ?? '', effort: slotPair(table, r.key, l).effort ?? '' }} setDraft={(d) => put(r.key, l, d)} named={`${levelWord(t, l)}, ${r.name} ${caption}`} />
                        ))}
                      </Fragment>
                    );
                  })}
              </div>
            }
          />
        ))}
    </Sec>
    <WorkerModels t={t} table={table} />
    </>
  );
}

/** Ticket 1055: Settings > Team > Worker models, the level rule of every Builder and Reviewer seat (the teammate rule
 *  reused: `level` fixes the seat, `level_max` clamps what the lead asks). The lead's own seat never reads it. Each
 *  option is the slot's real model and effort (ticket 994) on Claude's row, the agent the default roles run.
 *  shortcut: Claude's row only; draw the row of each role's agent when roles run another agent by default. */
const WORKERS_KEY = 'team.workers'; // team.rs WORKERS_KEY
function WorkerModels({ t, table }: { t: PageContext['t']; table: Table }) {
  const [rule, set, error] = useCoreFeature<{ level?: Level; level_max?: Level }>(WORKERS_KEY, {});
  const put = (k: 'level' | 'level_max', v: string) => {
    const next = { ...rule, [k]: isLevel(v) ? v : undefined };
    void set(next.level || next.level_max ? next : null);
  };
  const options = LEVELS.map((l) => (
    <option key={l} value={l}>
      {barsText(l)} {slotText(t, table, { kind: 'claude' }, l)}
    </option>
  ));
  return (
    <Sec id="h-workers" title={t('level.workers')}>
      <ErrorLine t={t} error={error} />
      <Row
        setting="workers-level"
        icon={<Info t={t} label={t('level.workers')} text={t('level.workersNote')} />}
        label={t('level.workersOn')}
        reset={<Reset t={t} label={t('level.workersOn')} show={!!rule.level} run={() => put('level', '')} />}
        control={
          <Select label={t('level.workersOn')} setting="workers-level" value={rule.level ?? ''} onChange={(v) => put('level', v)}>
            <option value="">{t('level.leadPicks')}</option>
            {options}
          </Select>
        }
      />
      <Row
        setting="workers-max"
        label={t('level.workersMax')}
        reset={<Reset t={t} label={t('level.workersMax')} show={!!rule.level_max} run={() => put('level_max', '')} />}
        control={
          <Select label={t('level.workersMax')} setting="workers-max" value={rule.level_max ?? ''} onChange={(v) => put('level_max', v)}>
            <option value="">{t('level.none')}</option>
            {options}
          </Select>
        }
      />
    </Sec>
  );
}
export function MatePicks<D extends Pick<Draft, 'kind' | 'agent' | 'model' | 'effort'>>({ t, core, draft, setDraft, part, only, named, info }: { t: PageContext['t']; core: PageContext['core']; draft: D; setDraft: (d: D) => void; part?: 'agent' | 'model'; only?: 'model' | 'effort'; named?: string; info?: ReactNode }) {
  const custom = useCustomModels(core);
  const [off] = useFeatureSetting(MODELS_OFF);
  const { agents: listed } = useLevels(core, true);
  const cap = (k: string) => named ?? k;
  const acp = draft.kind === 'acp' ? listed.find((r) => r.name === draft.agent) : undefined;
  const withStored = (list: Option[], stored: string) => (stored && !list.some((o) => o.value === stored) ? [...list, { value: stored, label: stored }] : list);
  const modelList = withStored(draft.kind === 'acp' ? (acp?.models ?? []) : modelChoices(draft.kind, custom).filter((o) => o.value !== null), draft.model);
  const effortsOf = (model: string) => (draft.kind === 'acp' ? (acp?.efforts ?? []) : efforts(draft.kind, model || null).filter((o) => o.value !== null));
  const effortList = withStored(effortsOf(draft.model), draft.effort);
  // An agent the teammate already runs stays in the list, also once it is no longer approved.
  const approved = listed.filter((r) => r.state === 'approved' || (draft.kind === 'acp' && r.name === draft.agent));
  const agents = (
    <Select
      label={t('team.agent')}
      value={agentKey(draft.kind, draft.agent)}
      onChange={(key) => setDraft({ ...draft, ...(key.startsWith('acp:') ? { kind: 'acp', agent: key.slice(4) } : { kind: key as Kind, agent: '' }), model: '', effort: '' })}
    >
      {KINDS.map(([v, name]) => (
        <option key={v} value={v}>
          {name}
        </option>
      ))}
      {approved.map((r) => (
        <option key={r.name} value={agentKey('acp', r.name)}>
          {r.label}
        </option>
      ))}
      {draft.kind === 'acp' && !approved.some((r) => r.name === draft.agent) && <option value={agentKey('acp', draft.agent)}>{draft.agent}</option>}
    </Select>
  );
  return (
    <>
      {part !== 'model' &&
        (info ? (
          <Field caption={t('team.agent')} info={info}>
            {agents}
          </Field>
        ) : (
          <label>
            <span>{t('team.agent')}</span>
            {agents}
          </label>
        ))}
      {part !== 'agent' && (
      <>
      {only !== 'effort' && (
      <label>
        {!named && <span>{t('providers.modelOne')}</span>}
        {/* An effort the new model does not have goes back to the default. */}
        <Select label={cap(t('providers.modelOne'))} value={draft.model} onChange={(model) => setDraft({ ...draft, model, effort: effortsOf(model).some((e) => e.value === draft.effort) ? draft.effort : '' })}>
          <option value="">{t('providers.default')}</option>
          {/* As Providers: a model turned off is not offered, except the one this teammate already has. */}
          {modelList
            .filter((o) => !isOff(off, draft.kind, o.value, draft.agent) || o.value === draft.model)
            .map((o) => (
              <option key={o.value} value={o.value!}>
                {o.label}
              </option>
            ))}
        </Select>
      </label>
      )}
      {only !== 'model' && effortList.length > 0 && (
      <label>
        {!named && <span>{t('agents.new.effort')}</span>}
        <Select label={cap(t('agents.new.effort'))} value={draft.effort} onChange={(effort) => setDraft({ ...draft, effort })}>
          <option value="">{t('providers.default')}</option>
          {effortList.map((o) => (
            <option key={o.value} value={o.value!}>
              {o.label}
            </option>
          ))}
        </Select>
      </label>
      )}
      </>
      )}
    </>
  );
}

const word = (key: 'team.title' | 'team.desc') => {
  const lang = document.documentElement.lang as keyof typeof TABLES;
  return TABLES[lang]?.[key] ?? TABLES.en[key] ?? 'Team';
};
registerSettingsPage({
  id: PAGE,
  get title() {
    return word('team.title');
  },
  get description() {
    return word('team.desc');
  },
  group: 'agents',
  order: 5,
  fields: [
    { key: PLACE_FIELD, at: '[data-setting="place"]' },
    { key: 'team', at: '[data-setting="team"]' },
    { key: 'levels', at: '[data-setting="levels"]' },
  ],
  render: (ctx) => <TeamPage core={ctx.core} t={ctx.t} projects={ctx.projects} closeSettings={ctx.closeSettings} toast={ctx.toast} sessions={ctx.sessions} />,
});
