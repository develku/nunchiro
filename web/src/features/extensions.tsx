// Ticket 276 (needs 65, 197, 198; G16): Settings > Agent extensions, in the agents group. Three cards:
// (1) skills and hooks: the shipped Nunchiro skill and custom folders under $NUNCHIRO_HOME/extensions/, each a switch
//     stored in the core `features` key `extensions.enabled`; the core turns the list into the next launch's flags.
// (2) MCP: the agents' own servers, read-only (the core sends env names, never values), plus Nunchiro's own servers
//     (extensions/mcp.json, sealed on add; only sealed ones reach a session). All three ops are owner-only in the core.
// (3) Widgets: a link to the Widget library and each user widget's approval state; no switch here (needs 198).
// Ticket 391 part 2 (docs/design/providers-391/final.html scene b): the page is now 스킬·훅. On top, "Nunchiro 기본" gathers
// what Nunchiro puts into new sessions: the hook switch (was Advanced), the shipped skill (was this page's first row) and
// the orchestration skill (was Orchestration). The three cards above sit under "내 확장".
// Lift: Orca McpConfigSection.tsx (read-only list shape, its write path dropped) and PluginDevelopmentSection.tsx (a
// custom folder row), MIT License, Copyright (c) 2026 Lovecast Inc. Only the row shapes were taken; no code fit as-is.
import { PLAIN } from '../plainText';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import { baseName, reveal } from '../files/open';
import type { Key, T } from '../i18n';
import { registerSettingsPage, type PageContext } from './registry';
import { Reset, Row, Sec, SecReset, Switch, tilde, Why } from '../settings/shell/Row';
import { PageSummary } from '../settings/shell/PageActions';
import { Icon } from '../icons/Icon';
import { ErrorLine, rawError } from '../errors';
import { escaped, hasControl, joinWords, splitWords } from '../settings/agents/words';
import { useCoreFeature } from '../settings/useFeatureSetting';
import { useWidgetList } from '../widgets/api';
import type { ApprovalState } from '../approval/types';
import { HookLines, ItemFiles, NewSkill, type HookLine } from './extension-files';
import { AlertSheet } from '../tree/Dialogs';
import { flushSync } from 'react-dom';
import { askNew } from '../NewSession';
import { restartStart } from '../PermissionNeeded';
import { restartKeeping } from './restart-keeping';
import { sessionName } from '../sessionNames';
import { pastedServer } from './pasted-server';
import { status, type Session } from '../types';
import './extensions.css';

/** Mirrors core `extensions::Item`. */
export interface ExtItem {
  id: string;
  name: string;
  kind: 'skill' | 'hook' | 'plugin';
  source: 'default' | 'custom';
  /** Ticket 452: what the item holds; the core leaves out what is empty. */
  description?: string;
  skills?: string[];
  hooks?: string[];
  files?: number;
  /** Ticket 455: each command a hook item runs, and on which event. */
  hook_lines?: HookLine[];
}
/** Mirrors core `extensions::McpServer`: `env` holds names only. */
export interface McpServer {
  agent: 'claude' | 'codex' | 'nunchiro';
  name: string;
  command: string[];
  env: string[];
  /** An own server written or edited outside Nunchiro: no session gets it until removed or added again. */
  changed?: boolean;
}
export interface ExtList {
  dir: string;
  items: ExtItem[];
  mcp: McpServer[];
  /** Agent configs past the core's read cap: named with their size instead of reading as "no servers". */
  mcp_too_large?: { file: string; bytes: number }[];
  own: McpServer[];
  /** Ticket 455: Nunchiro's own hooks, exactly as a launch passes them. */
  hooks?: HookLine[];
}

const ENABLED = 'extensions.enabled';
/** The shipped skill is on until switched off; a custom folder is off until switched on (threat: same-user drop). */
const DEFAULT_ON = ['nunchiro'];

/** What the two core-stored switches read and write (`quit_settings`); the hook one is stored inverted. */
type Base = { disable_hook_injection: boolean; orchestration: { enabled: boolean }; orchestration_override: string };
type BasePatch = { disable_hook_injection?: boolean; orchestration?: { enabled?: boolean; create_override?: boolean } };
const message = (e: unknown) => rawError(e);


/** The `open` value while Nunchiro's own hooks are shown (no item has this id: a custom id starts with `custom:`). */
const HOOKS = 'nunchiro-hooks';
const KIND: Record<ExtItem['kind'], Key> = { skill: 'extView.kind.skill', hook: 'extView.kind.hook', plugin: 'extView.kind.plugin' };
/** A kind or source word beside a row's name: a plain tag, not a status (no dot). */
const tag = (text: string) => <span className="chip tag">{text}</span>;
/** Ticket 452: what an item holds, in one line: its skills, the events its hooks run on, how many files. */
const holds = (t: T, i: ExtItem) =>
  [i.skills?.length && t('extView.skills', { names: i.skills.join(', ') }), i.hooks?.length && t('extView.hooks', { names: i.hooks.join(', ') }), i.files !== undefined && t('extView.fileCount', { n: i.files })].filter(Boolean).join(' · ');

/** Nunchiro 기본: Settings > 스킬·훅 draws it `full` (with the examples fold and 내 재정의 사본); onboarding step 6 draws the
 *  three switches only (NunchiroSwitches). `skills` is the caller's `extensions.enabled` pair, so the page's custom rows
 *  never write back a stale copy of it. Each switch shows at once and rolls back with the error line when the core refuses. */
function NunchiroBase({ core, t, full, skills, shipped, view, panel, hookView, hookPanel, more }: { core: CoreClient; t: T; full?: boolean; skills: [string[], (v: string[]) => unknown, string?]; shipped?: ExtItem; view?: ReactNode; panel?: ReactNode; hookView?: ReactNode; hookPanel?: ReactNode; more?: { on: number; all: number; mcp: number } }) {
  const [values, setValues] = useState<Base | null>(null);
  const [error, setError] = useState('');
  const [orchOpen, setOrchOpen] = useState(false);
  const [enabled, setEnabled, skillsError] = skills;
  const load = () => {
    core.request({ op: 'quit_settings' }).then((r) => (setValues((r as { settings: Base }).settings), setError('')), (e) => setError(message(e)));
  };
  useEffect(load, [core]); // eslint-disable-line react-hooks/exhaustive-deps
  const patch = async (p: BasePatch) => ((await core.request({ op: 'quit_settings', patch: p })) as { settings: Base }).settings;
  const apply = async (p: BasePatch) => {
    setError('');
    const stored = values;
    setValues((v) => v && ({ ...v, ...p } as Base));
    try {
      setValues(await patch(p));
    } catch (e) {
      setValues(stored);
      setError(message(e));
    }
  };
  const openOverride = async () => {
    setError('');
    try {
      const dir = (await patch({ orchestration: { create_override: true } })).orchestration_override;
      await reveal(dir.slice(0, dir.lastIndexOf('/')), baseName(dir));
    } catch (e) {
      setError(message(e));
    }
  };
  // Walk 9: the shipped item's name and description (extensions.rs DEFAULT_ID, plugin.json) are English data; the row
  // shows them in the window's language.
  const skill = t('settings.extensions.skillName');
  const kind = (key: Key) => (full ? tag(t(key)) : undefined);
  // Ticket 455: all three on is the recommended setting. A row that is off says so and has the kit's reset; the card
  // puts all three back at once.
  const skillOn = enabled.includes('nunchiro');
  const setSkill = (on: boolean) => void setEnabled(on ? [...new Set([...enabled, 'nunchiro'])] : enabled.filter((x) => x !== 'nunchiro'));
  const off = (isOff: boolean) => (full && isOff ? <span className="chip warn tag">{t('extView.recommendedOn')}</span> : undefined);
  const back = (label: string, isOff: boolean, run: () => void) => (full ? <Reset t={t} label={label} show={isOff} run={run} /> : undefined);
  const anyOff = !!values && (values.disable_hook_injection || !skillOn || !values.orchestration.enabled);
  const allOn = () => {
    setSkill(true);
    void apply({ disable_hook_injection: false, orchestration: { enabled: true } });
  };
  return (
    <Sec
      id={full ? 'h-ext-base' : undefined}
      title={full ? t('settings.extensions.base') : undefined}
      right={full ? `${t('settings.extensions.baseNote')} · ${t('extView.recommendedAll')}` : undefined}
      label={full ? undefined : t('settings.extensions.base')}
      className="ext-base"
      action={
        full && values ? (
          <SecReset
            t={t}
            section={t('settings.extensions.base')}
            show={anyOff}
            run={allOn}
            undo={((was, wasSkill) => () => (setSkill(wasSkill), void apply({ disable_hook_injection: was.disable_hook_injection, orchestration: { enabled: was.orchestration.enabled } })))(values, skillOn)}
          />
        ) : undefined
      }
    >
      {/* Ticket 1043: the page's summary counts every switch it shows: these three and the custom rows (`more`). */}
      {full && <PageSummary parts={values && more ? [[t('summary.itemsOn'), t('summary.of', { n: Number(!values.disable_hook_injection) + Number(skillOn) + Number(values.orchestration.enabled) + more.on, all: 3 + more.all })], [t('summary.mcp'), more.mcp]] : []} />}
      <ErrorLine t={t} error={error || skillsError || ''} retry={values === null ? load : undefined} />
      {values === null ? (
        !error && (
          <p className="lede srow" role="status">
            {t('orch.reading')}
          </p>
        )
      ) : (
        <Row
          label={t('settings.row.hooks')}
          setting="ext:nunchiro-hooks"
          chip={
            full && (
              <>
                {kind('extView.kind.hook')}
                {off(values.disable_hook_injection)}
              </>
            )
          }
          reset={back(t('settings.row.hooks'), values.disable_hook_injection, () => void apply({ disable_hook_injection: false }))}
          desc={full ? `${t('settings.row.hooksDesc')} ${t('extView.hooksCodex')}` : t('settings.row.hooksDesc')}
          control={
            <>
              {hookView}
              <Switch setting="hooks" label={t('settings.row.hooks')} checked={!values.disable_hook_injection} onChange={(v) => void apply({ disable_hook_injection: !v })} />
            </>
          }
        />
      )}
      {hookPanel}
      <Row
        label={skill}
        setting="ext:nunchiro"
        chip={
          full && (
            <>
              {kind('extView.kind.skill')}
              {tag(t('extView.shipped'))}
              {off(!skillOn)}
            </>
          )
        }
        desc={full && shipped ? `${t('settings.extensions.skillAbout')} ${t('settings.extensions.skillDesc')}` : t('settings.extensions.skillDesc')}
        extra={full && shipped && <div className="sds ext-meta">{holds(t, shipped)}</div>}
        control={
          <>
            {view}
            <Switch label={skill} checked={skillOn} onChange={setSkill} />
          </>
        }
        reset={back(skill, !skillOn, () => setSkill(true))}
      />
      {panel}
      {values && (
        <Row
          top
          label={t('field.orchEnabled')}
          chip={
            full && (
              <>
                {kind('extView.kind.skill')}
                {tag(t('extView.shipped'))}
                {off(!values.orchestration.enabled)}
              </>
            )
          }
          reset={back(t('field.orchEnabled'), !values.orchestration.enabled, () => void apply({ orchestration: { enabled: true } }))}
          desc={t('orch.enabledHint')}
          control={
            <>
              {full && (
                <button type="button" className="btn" aria-expanded={orchOpen} aria-label={`${t('extView.view')}: ${t('field.orchEnabled')}`} onClick={() => setOrchOpen(!orchOpen)}>
                  {t(orchOpen ? 'extView.close' : 'extView.view')}
                </button>
              )}
              <Switch setting="orchEnabled" label={t('field.orchEnabled')} checked={values.orchestration.enabled} onChange={(v) => void apply({ orchestration: { enabled: v } })} />
            </>
          }
        />
      )}
      {values && !full && (
        // Onboarding: the step is done once shown, so it names what is on (ticket 582 follow-up, F1).
        <p className="ob-why" role="status">
          {t('onboarding.skills.done', {
            hooks: t(values.disable_hook_injection ? 'onboarding.state.off' : 'onboarding.state.on'),
            n: enabled.filter((id) => id !== 'nunchiro').length + (skillOn ? 1 : 0) + (values.orchestration.enabled ? 1 : 0),
          })}
        </p>
      )}
      {/* Owner 2026-11-16: the same shape as the two rows above (View beside the switch); the examples and the override copy open under it. */}
      {values && full && orchOpen && (
        <div className="exth" role="group" aria-label={`${t('extView.view')}: ${t('field.orchEnabled')}`}>
          <div className="sds">
            <b>{t('orch.howTo')}</b>
          </div>
          <div className="sds">{t('orch.example1')}</div>
          <div className="sds">{t('orch.example2')}</div>
          <div className="sds">{t('orch.example3')}</div>
          <Row
            sub
            label={t('orch.override')}
            desc={t('orch.overrideHint')}
            control={
              <button type="button" className="btn" aria-label={t('orch.overrideOpen')} onClick={() => void openOverride()}>
                {t('settings.row.open')}
              </button>
            }
          />
        </div>
      )}
    </Sec>
  );
}

/** Onboarding step 6: the card's three switches, on the same stored values as the page. */
export function NunchiroSwitches({ core, t }: { core: CoreClient; t: T }) {
  const [enabled, setEnabled, error] = useCoreFeature<string[]>(ENABLED, DEFAULT_ON);
  return <NunchiroBase core={core} t={t} skills={[enabled, setEnabled, error]} />;
}

/** Ticket 456: what a custom item would run, listed as `nunchiro extensions on` lists it (the core's `hook_lines`), and a
 *  second click to turn it on. Cancel changes nothing. */
function TurnOnSheet({ t, item, error, onCancel, onConfirm }: { t: T; item: ExtItem; error: string; onCancel: () => void; onConfirm: () => void }) {
  const hooks = !!item.hook_lines?.length || !!item.hooks?.length || item.kind === 'hook';
  return (
    <AlertSheet wide label={t('extView.onAsk', { name: item.name })} onClose={onCancel}>
      {hooks ? (
        <>
          <p className="sds">{t('extView.onRuns')}</p>
          {!!item.hook_lines?.length && <HookLines whole t={t} lines={item.hook_lines} label={t('extView.hooksOf', { name: item.name })} />}
          <p className="sds">{t('extView.onRunsMore')}</p>
        </>
      ) : (
        <p className="sds">{t('extView.onOwn')}</p>
      )}
      {error && (
        <div role="alert" className="rmerr">
          {error}
        </div>
      )}
      <p className="rmacts">
        <button type="button" className="btn" onClick={onCancel}>
          {t('extView.cancel')}
        </button>
        <button type="button" className="btn p" onClick={onConfirm}>
          {t('extView.onConfirm')}
        </button>
      </p>
    </AlertSheet>
  );
}

function ExtensionsPage({ core, t, commands, closeSettings, current, focus }: PageContext) {
  const [list, setList] = useState<ExtList | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled, featureError, , enabledRead] = useCoreFeature<string[]>(ENABLED, DEFAULT_ON);
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false); // a name typed by hand is kept when the command changes
  const commandField = useRef<HTMLInputElement>(null); // ticket 550: the empty MCP line's button puts the cursor here
  const [command, setCommand] = useState('');
  const [added, setAdded] = useState(''); // ticket 1123 T10: the server just added, for the restart line
  const { list: widgets } = useWidgetList(core);
  // Ticket 452: the item whose files are shown (one at a time), and whether the New skill form is open.
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<'skill' | 'hook' | false>(false);
  // Ticket 991 C11: the custom item whose Remove asks first.
  const [removing, setRemoving] = useState<string | null>(null);
  // Ticket 456: the item whose On asks first (it can run commands), as `nunchiro extensions on` does.
  const [asking, setAsking] = useState<ExtItem | null>(null);

  const act = async (request: { op: string; [k: string]: unknown }) => {
    setBusy(true);
    setError('');
    try {
      setList((await core.request(request)) as ExtList);
      return true;
    } catch (e) {
      setError(rawError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => void act({ op: 'extensions_list' }), [core]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (i: ExtItem, on: boolean) => (on ? setAsking(i) : void setEnabled(enabled.filter((x) => x !== i.id)));
  // The core takes the new id only with `extensions_confirmed` naming it (sessions.rs quit_settings).
  const confirmOn = (id: string) => void setEnabled([...new Set([...enabled, id])], { extensions_confirmed: [id] }).then((ok) => ok && setAsking(null));
  const custom = (list?.items ?? []).filter((i) => i.source === 'custom');
  const reload = () => void act({ op: 'extensions_list' });
  // Off first, so a later item of the same name does not start on; then the folder moves aside (the core keeps the files).
  const remove = async (id: string) => {
    if (enabled.includes(id) && !(await setEnabled(enabled.filter((x) => x !== id)))) return;
    if (await act({ op: 'extensions_item_remove', id })) (setRemoving(null), open === id && setOpen(null));
  };
  const viewButton = (i: ExtItem, name: string) => (
    <button type="button" className="btn" aria-expanded={open === i.id} aria-label={t(i.source === 'custom' ? 'extView.editOf' : 'extView.viewOf', { name })} onClick={() => setOpen(open === i.id ? null : i.id)}>
      {t(open === i.id ? 'extView.close' : i.source === 'custom' ? 'extView.edit' : 'extView.view')}
    </button>
  );
  const files = (i: ExtItem, name: string) => open === i.id && <ItemFiles core={core} t={t} id={i.id} name={name} onSaved={reload} hooks={i.hook_lines} />;
  const itemRow = (i: ExtItem) => (
    <Fragment key={i.id}>
      <Row
        setting={`ext:${i.id}`}
        label={<span className="mono">{i.name}</span>}
        chip={tag(t(KIND[i.kind]))}
        desc={i.description || t('extView.noDescription')}
        extra={<div className="sds ext-meta">{holds(t, i)}</div>}
        control={
          <>
            {viewButton(i, i.name)}
            {i.source === 'custom' && (
              <button type="button" className="btn" disabled={busy} aria-label={t('extView.removeOf', { name: i.name })} onClick={() => setRemoving(i.id)}>
                {t('extView.remove')}
              </button>
            )}
            <Switch label={i.name} checked={enabled.includes(i.id)} onChange={(on) => toggle(i, on)} />
          </>
        }
      />
      {removing === i.id && (
        <div className="ext-remove" role="group" aria-label={t('extView.removeOf', { name: i.name })}>
          <p className="sds">{t('extView.removeAsk', { name: i.name, folder: `${list?.dir ?? 'extensions'}/.removed` })}</p>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void remove(i.id)}>
            {t('extView.remove')}
          </button>{' '}
          <button type="button" className="btn" autoFocus onClick={() => setRemoving(null)}>
            {t('extView.cancel')}
          </button>
        </div>
      )}
      {files(i, i.name)}
      {asking?.id === i.id && <TurnOnSheet t={t} item={i} error={featureError} onCancel={() => setAsking(null)} onConfirm={() => confirmOn(i.id)} />}
    </Fragment>
  );
  const shipped = (list?.items ?? []).find((i) => i.source === 'default');
  const showFolder = () => {
    const dir = list?.dir;
    if (dir) void reveal(dir.slice(0, dir.lastIndexOf('/')), baseName(dir)).catch((e) => setError(message(e)));
  };
  const server = (s: McpServer, remove?: boolean) => (
    <Row
      key={`${s.agent}:${s.name}`}
      label={<span className="mono">{s.name}</span>}
      desc={
        <>
          <span className="mono">{`${s.agent}: ${tilde(escaped(joinWords(s.command)))}`}</span>
          {s.env.length > 0 && <span> · {t('settings.extensions.envHidden', { names: s.env.join(', ') })}</span>}
          {s.changed && <span> · {t('settings.extensions.changedOutside')}</span>}
        </>
      }
      control={
        remove ? (
          <button className="btn" disabled={busy} onClick={() => void act({ op: 'extensions_mcp_remove', name: s.name })}>
            {t('settings.extensions.mcpRemove', { name: s.name })}
          </button>
        ) : undefined
      }
    />
  );
  const stateText: Record<ApprovalState, string> = {
    approved: t('settings.extensions.state.approved'),
    unapproved: t('settings.extensions.state.unapproved'),
    changed: t('settings.extensions.state.changed'),
  };
  const openLibrary = commands.find((c) => c.id === 'layout.edit');
  // The sheet's own reading of a command line: quotes group words, and the core gets an argument list, never a shell line.
  const words = splitWords(command);
  const pasted = words?.length ? pastedServer(words) : null;
  const argv = pasted ? pasted.command : words;
  const typeCommand = (v: string) => {
    setCommand(v);
    const w = splitWords(v);
    if (!named) setName(w?.length ? pastedServer(w).name : '');
  };
  // Ticket 1123 T10: with no server of your own yet, the page opens on the one field.
  // Not when the page opened on a target (a Settings search hit, a palette field, a reveal): that focus is the user's.
  const target = useRef(!!focus);
  const noOwn = list?.own.length === 0;
  useEffect(() => void (noOwn && !target.current && !focus && commandField.current?.focus()), [noOwn]); // eslint-disable-line react-hooks/exhaustive-deps
  // Owner 11-25 Q3: the open agent session restarts with the server; Restart session resumes its conversation.
  const live = current && current.kind !== 'shell' && current.state === 'running' && !current.side_chat ? current : null;
  // Restart waits until the session is idle: not working, not waiting on a question, not stale. Only a conversation id
  // says it resumes.
  const notIdle = !!live && status(live) !== 'idle';
  const resumes = !!live && !!restartStart(live).resume;
  const restartWith = async (s: Session) => {
    setError('');
    try {
      await restartKeeping(core, s, () => flushSync(closeSettings));
    } catch (e) {
      setError(message(e));
    }
  };
  const commandProblem = argv === null ? t('agents.sheet.unclosed') : argv.some(hasControl) ? t('agents.sheet.control') : pasted?.refused ? t(pasted.refused === 'agent' ? 'firstUse.mcp.agentLine' : 'firstUse.mcp.remote') : '';
  // Ticket 378: Add stays pressable; pressed with an empty box, that box turns red and one line says what is missing.
  const [tried, setTried] = useState(false);
  const noName = tried && !name.trim();
  const noCommand = tried && !argv?.length;
  const mcpProblem = commandProblem || (noName || noCommand ? t('settings.extensions.mcpNeed') : '');

  // Owner 11-25 Q3: under the server just added, before the empty field (mockup T10).
  const addedLine = (
    <div className="srow ext-added">
      <p className="ok-line" role="status">
        {t('firstUse.mcp.added', { name: added })}
      </p>
      <div className="ob-acts">
        {live && (
          <button type="button" className="btn p" data-go="restart" disabled={notIdle} aria-describedby={notIdle ? 'why-restart' : undefined} onClick={() => void restartWith(live)}>
            {t('firstUse.mcp.restart', { name: sessionName(live) })}
          </button>
        )}
        {live && notIdle && <Why id="why-restart" reason={t('firstUse.mcp.working', { name: sessionName(live) })} />}
        {live && !notIdle && resumes && <span className="ext-keeps">{t('firstUse.mcp.keeps')}</span>}
        <button type="button" className={live ? 'btn' : 'btn p'} data-go="new" onClick={() => (flushSync(closeSettings), askNew(live?.project))}>
          {t('firstUse.mcp.new')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="ssec-group">
      <ErrorLine t={t} error={error || featureError} />
      <NunchiroBase
        core={core}
        t={t}
        full
        skills={[enabled, setEnabled]}
        more={list && enabledRead ? { on: custom.filter((i) => enabled.includes(i.id)).length, all: custom.length, mcp: list.mcp.length + list.own.length } : undefined}
        shipped={shipped}
        view={shipped && viewButton(shipped, t('settings.extensions.skillName'))}
        panel={shipped && files(shipped, t('settings.extensions.skillName'))}
        hookView={
          !!list?.hooks?.length && (
            <button type="button" className="btn" aria-expanded={open === HOOKS} aria-label={t('extView.viewHooks')} onClick={() => setOpen(open === HOOKS ? null : HOOKS)}>
              {t(open === HOOKS ? 'extView.close' : 'extView.view')}
            </button>
          )
        }
        hookPanel={open === HOOKS && !!list?.hooks?.length && <HookLines t={t} lines={list.hooks} label={t('extView.hooksOfNunchiro')} note={t('extView.hooksNunchiroNote')} />}
      />
      <h2 className="ext-mine" id="h-ext-mine">
        {t('settings.extensions.mine')}
      </h2>
      <section className="ssec" aria-labelledby="h-ext-skills">
        <h2 id="h-ext-skills">{t('settings.extensions.skills')}</h2>
        {/* Look 1117 v15 Q6-11: the kit's section Add (Sec `action`, as Team and Notes); the empty card no longer repeats them. */}
        <div className="sec-act">
          <button type="button" className="btn withicon" aria-expanded={adding === 'skill'} onClick={() => setAdding('skill')}>
            <Icon name="plus" size={14} />
            {t('extView.newSkill')}
          </button>
          <button type="button" className="btn withicon" aria-expanded={adding === 'hook'} onClick={() => setAdding('hook')}>
            <Icon name="plus" size={14} />
            {t('extView.newHook')}
          </button>
        </div>
        <p className="lede">{t('extView.lede')}</p>
        {/* Ticket 584: codex_flags (extensions.rs) passes own MCP servers only; custom folders reach Claude alone. */}
        <p className="lede" data-note="claude-only">
          {t('extView.claudeOnly')}
        </p>
        <div className="scard">
          {adding && (
            <NewSkill<ExtList>
              key={adding}
              core={core}
              t={t}
              hook={adding === 'hook'}
              onCancel={() => setAdding(false)}
              onMade={(made, id) => {
                setList(made);
                // An id left on by a folder deleted earlier must not turn the new skill on.
                if (enabled.includes(id)) void setEnabled(enabled.filter((x) => x !== id));
                setAdding(false);
                setOpen(id); // straight into the new skill's text
              }}
            />
          )}
          {custom.map(itemRow)}
          {!custom.length && !adding && (
            <div className="empty ext-empty">
              <p>{t('extView.empty')}</p>
            </div>
          )}
          {list && (
            <Row
              sub
              label={t('extView.folder')}
              desc={
                <code className="mono ext-dir" title={list.dir}>
                  <bdi>{list.dir}</bdi>
                </code>
              }
              control={
                <button type="button" className="btn" aria-label={t('extView.showFolder')} onClick={showFolder}>
                  {t('extView.show')}
                </button>
              }
            />
          )}
        </div>
      </section>
      <section className="ssec" aria-labelledby="h-ext-mcp">
        <h2 id="h-ext-mcp">{t('settings.extensions.mcp')}</h2>
        <p className="lede">{t('settings.extensions.mcpNote')}</p>
        <div className="scard" data-mcp="agents">
          {list?.mcp.map((s) => server(s))}
          {list?.mcp_too_large?.map((f) => (
            <p key={f.file} className="empty" role="status">
              {t('settings.extensions.mcpTooLarge', { file: f.file, mb: Math.ceil(f.bytes / 2 ** 20) })}
            </p>
          ))}
          {!list?.mcp.length && !list?.mcp_too_large?.length && (
            <p className="empty">
              {t('settings.extensions.mcpNone')}{' '}
              <button type="button" className="btn" onClick={() => commandField.current?.focus()}>
                {t('empty.addMcp')}
              </button>
            </p>
          )}
        </div>
        <h3>{t('settings.extensions.mcpOwn')}</h3>
        <div className="scard" data-mcp="own">
          {(list?.own ?? []).map((s) => (
            <Fragment key={s.name}>
              {server(s, true)}
              {s.name === added && addedLine}
            </Fragment>
          ))}
          <form
            className="srow ext-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || !argv?.length || commandProblem) return setTried(true);
              const added = name.trim();
              void act({ op: 'extensions_mcp_add', name: added, command: argv }).then((ok) => ok && (setName(''), setNamed(false), setCommand(''), setTried(false), setAdded(added)));
            }}
          >
            <div className="ext-paste">
              <input {...PLAIN} ref={commandField} aria-label={t('settings.extensions.mcpCommand')} placeholder={t('firstUse.mcp.paste')} className="mono" aria-invalid={!!commandProblem || noCommand} value={command} onChange={(e) => typeCommand(e.target.value)} />
              <button className="btn" type="submit" aria-label={t('settings.extensions.mcpAdd')} disabled={busy || !!commandProblem} aria-busy={busy || undefined} aria-describedby={mcpProblem ? 'why-mcp' : undefined}>
                <Icon name="plus" size={14} />
                {t('settings.row.add')}
              </button>
            </div>
            <label className="ext-name">
              {t('firstUse.mcp.name')}
              <input {...PLAIN} className="mono" aria-label={t('settings.extensions.mcpName')} aria-invalid={noName} value={name} onChange={(e) => (setName(e.target.value), setNamed(true))} />
              <span>{t('firstUse.mcp.hint')}</span>
            </label>
          </form>
          {mcpProblem && (
            <p className="empty" role="alert" data-field="mcp-problem">
              <Why id="why-mcp" reason={mcpProblem} />
            </p>
          )}
          {!mcpProblem && !!pasted?.dropped.length && (
            <p className="empty" role="status" data-field="mcp-env">
              {t('firstUse.mcp.envDropped', { names: pasted.dropped.join(', ') })}
            </p>
          )}
        </div>
      </section>
      <section className="ssec" aria-labelledby="h-ext-widgets" data-section="widgets">
        <h2 id="h-ext-widgets">{t('settings.extensions.widgets')}</h2>
        <p className="lede">{t('settings.extensions.widgetsNote')}</p>
        <div className="scard">
          <Row
            label={t('settings.extensions.library')}
            why={!openLibrary && <Why id="why-widget-library" reason={t('settingsWhy.noLibrary')} />}
            control={
              <button className="btn" disabled={!openLibrary} aria-describedby={openLibrary ? undefined : 'why-widget-library'} aria-label={t('settings.extensions.openLibrary')} onClick={() => (closeSettings(), openLibrary?.run())}>
                {t('settings.row.open')}
              </button>
            }
          />
          {widgets?.widgets.length ? (
            widgets.widgets.map((w) => {
              const state = w.state ?? 'unapproved';
              return <Row key={w.name} setting={`widget:${w.name}`} label={<span className="mono">{w.name}</span>} chip={<span className={`chip ${state === 'approved' ? 'ok' : state === 'changed' ? 'warn' : ''}`}>{stateText[state]}</span>} />;
            })
          ) : (
            <p className="empty">{t('settings.extensions.noWidgets')}</p>
          )}
        </div>
      </section>
    </div>
  );
}

// The id stays `extensions` (stored as a window's last page); the nav reads `settings.page.extensions` (스킬·훅).
registerSettingsPage({ id: 'extensions', title: 'Skills & hooks', group: 'agents', order: 10, fields: [
  { key: 'extSkills', at: 'section[aria-labelledby="h-ext-skills"] input[role="switch"]' },
  { key: 'extMcp', at: '[data-mcp="own"] input' },
  { key: 'extWidgets', at: 'section[data-section="widgets"] button' },
], render: (ctx) => <ExtensionsPage {...ctx} /> });
