// Ticket 391: what a new session starts with, on the Providers page. The page's top block holds the default agent; each
// Claude or Codex card's 새 세션 기본값 block holds its model and effort. ModelPick moved here from
// features/new-session-defaults.tsx (ticket 223), split into its two lines; its logic is unchanged.
import { PLAIN } from '../../plainText';
import { useState } from 'react';
import type { AcpRow } from '../../api';
import { efforts, models } from '../../picker/catalog';
import { Reset, Row, Select, SourceTag, type Source } from '../shell/Row';
import { useFeatureSetting } from '../useFeatureSetting';
import { DEFAULT_AGENT } from '../onboarding/state';
import { AGENTS_OFF, isOff, MODEL_NAME, modelChoices, MODELS_OFF, NEW_DEFAULTS, useCustomModels, type AgentCli, type Defaults, type ModelDefault, type Stored } from '../agents/newDefaults';
import type { CoreClient } from '../../api';
import { Ln, type T } from './providers';
import { keyText } from '../../keys';

const CUSTOM = '__custom';

/** 기본 에이전트: a New session row id (onboarding/state.ts). A stored value the list lacks is shown as its own option and is
 *  never rewritten here: opening the page writes nothing. */
export function DefaultAgentRow({ t, acp }: { t: T; acp: AcpRow[] }) {
  const [agent, setAgent] = useFeatureSetting(DEFAULT_AGENT);
  const [off] = useFeatureSetting(AGENTS_OFF); // ticket 358: an agent that is off cannot be the default
  const clis: [AgentCli, string][] = [
    ['claude', 'Claude'],
    ['codex', 'Codex'],
  ];
  const options: [string, string][] = [
    ['', t('agents.new.lastUsed')],
    ...clis.filter(([v]) => !off.includes(v)),
    ...acp.filter((r) => r.state === 'approved').map((r): [string, string] => [`acp:${r.name}`, r.label]),
    ['terminal', t('providersPage.shell')],
  ];
  return (
    <Row
      setting="newDefaultAgent"
      label={t('agents.new.agent')}
      desc={t('providersPage.agentDesc', { key: keyText('session.new') })}
      reset={<Reset t={t} label={t('agents.new.agent')} show={agent !== ''} run={() => setAgent('')} />}
      control={
        <Select label={t('agents.new.agent')} value={agent} onChange={setAgent}>
          {/* A stored default whose 사용 switch is off keeps its proper name, marked off; anything else unknown shows its id. */}
          {!options.some(([v]) => v === agent) && <option value={agent}>{((n) => (n ? `${n} (${t('providersManage.off')})` : agent))(clis.find(([v]) => v === agent)?.[1])}</option>}
          {options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </Select>
      }
    />
  );
}

/** 모델 and 생각 수준 of one agent's 새 세션 기본값: for all projects (Providers), or for `project` (ticket 1040: its page on
 *  Settings > Projects, which draws one reset for the pair and no source tags). */
export function ModelDefaults({ t, core, kind, name, project = null, known = [] }: { t: T; core: CoreClient; kind: AgentCli; name: string; project?: string | null; known?: string[] }) {
  const [stored, setStored] = useFeatureSetting(NEW_DEFAULTS);
  const here: Defaults = (project ? stored.projects[project] : stored.all) ?? {};
  const write = (next: Defaults) => setStored(project ? { ...stored, projects: { ...stored.projects, [project]: next } } : { ...stored, all: next });
  // shortcut: a project cannot force "the agent's own default" over an all-projects model; add a value for it when someone asks.
  const unset = t(project ? 'agents.new.inherit' : 'agents.new.agentDefault');
  const source = (field: keyof ModelDefault) => (project ? null : sourceOf(stored, kind, field, project, known));
  return <ModelPick key={`${project ?? ''}:${kind}`} t={t} core={core} kind={kind} name={name} value={here[kind] ?? {}} unset={unset} tag={project ? '' : t('providersPage.perProject')} sources={{ model: source('model'), effort: source('effort') }} onChange={(v) => write({ ...here, [kind]: v })} />;
}

/** Ticket 518: where `kind`'s `field` comes from with `project` (null: All projects) in view; null when set right here.
 *  Under All projects an unset field shows nothing, as its select already says "Agent default". `known`: the window's
 *  projects; a leftover override of a removed project is left out (its scope cannot be opened) but never deleted. */
export function sourceOf(stored: Stored, kind: AgentCli, field: keyof ModelDefault, project: string | null, known: string[]): Source | null {
  if (project) return stored.projects[project]?.[kind]?.[field] ? null : stored.all[kind]?.[field] ? { from: 'all' } : { from: 'default' };
  const paths = Object.keys(stored.projects).filter((p) => known.includes(p) && stored.projects[p][kind]?.[field]);
  return paths.length ? { from: 'project', paths } : null;
}

/** One agent's model and effort, and the name field when the model is typed. */
function ModelPick({ t, core, kind, name, value, unset, tag, sources, onChange }: { t: T; core: CoreClient; kind: AgentCli; name: string; value: ModelDefault; unset: string; tag: string; sources: Record<keyof ModelDefault, Source | null>; onChange: (v: ModelDefault) => void }) {
  const [off] = useFeatureSetting(MODELS_OFF);
  const listed = (m?: string) => models(kind).some((o) => o.value === m);
  const custom = useCustomModels(core); // ticket 358
  const [typed, setTyping] = useState(!!value.model && !listed(value.model));
  // The stored ids arrive after the first draw: one of them is a row of the list, not a typed name.
  const typing = typed && !custom[kind]?.some((m) => m.id === value.model);
  const [draft, setDraft] = useState(value.model ?? '');
  const bad = typing && draft !== '' && !MODEL_NAME.test(draft);
  const store = (model?: string) => onChange({ model, effort: efforts(kind, model ?? null).some((e) => e.value === value.effort) ? value.effort : undefined });
  // An empty or refused name clears what was stored: the field and the next launch must say the same thing.
  const pick = (v: string) => {
    setTyping(v === CUSTOM);
    setDraft('');
    store(v === CUSTOM ? undefined : v || undefined);
  };
  const type = (v: string) => {
    setDraft(v);
    store(MODEL_NAME.test(v) ? v : undefined);
  };
  const scoped = tag && <span className="prv-scope">{tag}</span>;
  return (
    <>
      <div data-row="newDefaultModel">
        <Ln k={t('providers.modelOne')} reset={<Reset t={t} label={`${t('agents.new.model')} · ${name}`} show={!!tag && !!value.model} run={() => pick('')} />}>
          <Select label={`${t('agents.new.model')} · ${name}`} value={typing ? CUSTOM : (value.model ?? '')} onChange={pick}>
            <option value="">{unset}</option>
            {/* Ticket 357: a model turned off leaves this list, except the one stored here: it keeps working, marked, until changed. */}
            {modelChoices(kind, custom)
              .filter((o) => o.value !== null && (!isOff(off, kind, o.value) || o.value === value.model))
              .map((o) => (
                <option key={o.value} value={o.value!}>
                  {isOff(off, kind, o.value) ? t('providers.offTag', { label: o.label }) : o.label}
                </option>
              ))}
            <option value={CUSTOM}>{t('agents.new.custom')}</option>
          </Select>
          {typing && <input {...PLAIN} className="prv-inp mono" aria-label={t('agents.new.customName', { agent: name })} aria-invalid={bad} autoComplete="off" spellCheck={false} value={draft} onChange={(e) => type(e.target.value)} />}
          {scoped}
          <SourceTag t={t} source={sources.model} />
        </Ln>
        {bad && (
          <p className="conflict" role="alert">
            {t('agents.new.customBad')}
          </p>
        )}
      </div>
      <div data-row="newDefaultEffort">
        <Ln k={t('agents.new.effort')} reset={<Reset t={t} label={`${t('agents.new.effort')} · ${name}`} show={!!tag && !!value.effort} run={() => onChange({ ...value, effort: undefined })} />}>
          <Select label={`${t('agents.new.effort')} · ${name}`} value={value.effort ?? ''} onChange={(e) => onChange({ ...value, effort: e || undefined })}>
            <option value="">{unset}</option>
            {efforts(kind, value.model ?? null)
              .filter((o) => o.value !== null)
              .map((o) => (
                <option key={o.value} value={o.value!}>
                  {o.label}
                </option>
              ))}
          </Select>
          {scoped}
          <SourceTag t={t} source={sources.effort} />
        </Ln>
      </div>
    </>
  );
}
