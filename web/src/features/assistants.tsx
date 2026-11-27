// Ticket 1002 lane 1 (mockup docs/design/home-chief-of-staff-1120.html frame 5): Settings > Assistants, the Home chief of
// staff's mode and reach. The limits are the core's launch flags and hook (crates/nunchiro-core/src/home_lock.rs), not
// words in the brief; this page only picks the mode (`home.chief_mode`, absent = Ask) and says what is fixed. Owner
// decision B (2026-11-20): a fourth mode lets shell commands run without asking, with its warning line.
import { useEffect, useState, type ReactNode } from 'react';
import { TABLES } from '../i18n';
import type { CoreClient } from '../api';
import { ErrorLine, rawError } from '../errors';
import { leadOf, setTeam as shareTeam, type Team, type Teammate } from '../lead/lead';
import { PLAIN } from '../plainText';
import { openSchedules } from '../schedule/schedules';
import { nameAssistant } from '../settings/agents/open';
import { Reset, Row, Sec, Seg, Switch } from '../settings/shell/Row';
import { PageSummary } from '../settings/shell/PageActions';
import { useCoreFeature } from '../settings/useFeatureSetting';
import { registerSettingsPage, type PageContext } from './registry';
import { draftOf, saveOp } from './team';
import { BotsMoved } from '../bots/BotsMoved'; // ticket 1168

const PAGE = 'assistants';
type Mode = 'ask' | 'accept-edits' | 'full-access' | 'full-access-shell';
const MODES: string[] = ['ask', 'accept-edits', 'full-access', 'full-access-shell'];

/** Ticket 1034: names the main assistant through `team_save`, which starts nothing. With no Home lead yet it adds one (a
 *  Claude seat, the default job, leading Home); with one it changes only the name. The tree and the headers follow at once. */
export async function saveAssistant(core: CoreClient, t: PageContext['t'], name: string, lead: Teammate | null) {
  const list = (await core.request(saveOp(lead ? { ...draftOf(lead), name } : { name, job: t('assistants.defaultJob'), kind: 'claude', project: '', model: '', effort: '', lead: true }))) as Team;
  shareTeam(list);
  return list;
}

/** The Name row: Enter or leaving the field saves; Esc, an empty field or a refused name puts the saved name back. */
function NameRow({ core, t, lead, onSaved }: { core: CoreClient; t: PageContext['t']; lead: Teammate; onSaved: (team: Team) => void }) {
  const [name, setName] = useState(lead.name);
  const [error, setError] = useState<unknown>('');
  useEffect(() => setName(lead.name), [lead.name]);
  const commit = () => {
    const next = name.trim();
    if (!next || next === lead.name) return setName(lead.name);
    setError('');
    void saveAssistant(core, t, next, lead).then(onSaved, (e) => (setError(e), setName(lead.name)));
  };
  return (
    <Row
      label={t('team.name')}
      desc={t('assistants.nameDesc')}
      extra={<ErrorLine t={t} error={error ? rawError(error) : ''} />}
      control={<input {...PLAIN} className="sinp" data-assistant-name aria-label={t('team.name')} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => (e.key === 'Enter' ? e.currentTarget.blur() : e.key === 'Escape' && name !== lead.name && (e.stopPropagation(), setName(lead.name)))} />}
    />
  );
}

function AssistantsPage({ core, t, reveal, closeSettings }: Pick<PageContext, 'core' | 't' | 'reveal' | 'closeSettings'>) {
  const [mode, setMode, error, , modeRead] = useCoreFeature<string>('home.chief_mode', 'ask');
  // Off (`home.connectors_off`): the seat starts with no MCP server, so the claude.ai connectors never load.
  const [off, setOff, offError] = useCoreFeature<boolean>('home.connectors_off', false);
  const [team, setTeam] = useState<Team | null>(null);
  useEffect(() => void core.request({ op: 'team_list' }).then((r) => setTeam(r as Team), () => setTeam({ teammates: [], home: '' })), [core]);
  const lead = team && leadOf(team, '');
  // The lock is keyed on Claude seats in v1 (check SHOULD): a Codex or ACP lead gets no lock, so the rows say so.
  const claude = !lead || lead.kind === 'claude';
  const names: Record<Mode, string> = { ask: t('agents.new.permAsk'), 'accept-edits': t('agents.new.permEdits'), 'full-access': t('onboarding.quick.permFull'), 'full-access-shell': t('assistants.fullShell') };
  // Look v35 c S3-4: the recommendation is a tag beside the row's name, as other rows place a tag, not inside the segment.
  const options: [Mode, ReactNode][] = [
    ['ask', names.ask],
    ['accept-edits', names['accept-edits']],
    ['full-access', names['full-access']],
    ['full-access-shell', names['full-access-shell']],
  ];
  const value = MODES.includes(mode) ? (mode as Mode) : 'ask';
  return (
    <div>
      <PageSummary parts={[[t('summary.assistant'), lead ? lead.name : team && t('summary.noAssistant')], [t('summary.mode'), modeRead && names[value]]]} />
      <BotsMoved t={t} />
      <Sec label={t('assistants.title')}>
        {/* Ticket 1034 (mockup bot-statusbar-1121 3-5): the main assistant's name and job; with none yet, its set-up. */}
        {lead ? (
          <>
            <NameRow core={core} t={t} lead={lead} onSaved={setTeam} />
            <Row
              label={t('team.job')}
              desc={lead.job.split('\n')[0]}
              control={
                <button type="button" className="btn" onClick={() => reveal('team', '[data-setting="team"]')}>
                  {t('assistants.editJob')}
                </button>
              }
            />
          </>
        ) : (
          <Row
            label={t('assistants.noLead')}
            control={
              <button type="button" className="btn" onClick={nameAssistant}>
                {t('assistants.setUp')}
              </button>
            }
          />
        )}
        {!claude && <Row label={t('assistants.claudeOnly')} />}
        <Row
          label={t('assistants.mode')}
          chip={<span className="chip tag" data-recommended>{`${t('assistants.recommended')}: ${names.ask}`}</span>}
          reset={claude && <Reset t={t} label={t('assistants.mode')} show={value !== 'ask'} run={() => void setMode(null)} />}
          desc={
            <>
              {t('assistants.modeDesc')} {t('assistants.applies')}
              {value === 'full-access-shell' && (
                <span className="warn" role="note">
                  {' '}
                  {t('assistants.fullShellWarn')}
                </span>
              )}
              {error && <span role="alert"> {error}</span>}
            </>
          }
          control={
            <fieldset disabled={!claude} style={{ border: 0, margin: 0, padding: 0 }}>
              <Seg name="home-chief-mode" setting="homeChief" label={t('assistants.mode')} value={value} options={options} onChange={(v) => void setMode(v === 'ask' ? null : v)} />
            </fieldset>
          }
        />
        <Row
          label={t('assistants.briefs')}
          desc={t('assistants.briefsDesc')}
          control={
            <button type="button" className="btn" onClick={() => (closeSettings?.(), openSchedules())}>
              {t('assistants.openSchedules')}
            </button>
          }
        />
      </Sec>
      <Sec id="assistants-connectors" title={t('assistants.connectors')}>
        <Row label={t('assistants.mail')} chip={claude ? <span className="chip tag">{t(off ? 'assistants.connectorsOff' : 'assistants.readDrafts')}</span> : undefined} desc={t(off ? 'assistants.mailOffDesc' : 'assistants.mailDesc')} />
        <Row label={t('assistants.calendar')} chip={<span className="chip tag">{t('assistants.calendarOff')}</span>} desc={t('assistants.calendarDesc')} />
        <Row
          label={t('assistants.accountConnectors')}
          desc={
            <>
              {t('assistants.accountConnectorsDesc')} {t('assistants.applies')}
              {offError && <span role="alert"> {offError}</span>}
            </>
          }
          control={claude && <Switch setting="homeConnectors" label={t('assistants.accountConnectors')} checked={!off} onChange={(v) => void setOff(v ? null : true)} />}
        />
        <Row label={t('assistants.allowed')} chip={<span className="chip tag">{t('assistants.fixed')}</span>} desc={t(off ? 'assistants.allowedOffDesc' : 'assistants.allowedDesc')} />
      </Sec>
    </div>
  );
}

const word = (key: 'assistants.title' | 'assistants.desc') => {
  const lang = document.documentElement.lang as keyof typeof TABLES;
  return TABLES[lang]?.[key] ?? TABLES.en[key] ?? 'Assistants';
};
registerSettingsPage({
  id: PAGE,
  get title() {
    return word('assistants.title');
  },
  get description() {
    return word('assistants.desc');
  },
  group: 'agents',
  order: 5.5, // between Team (5) and Notes (6)
  fields: [
    { key: 'homeChief', at: '[data-setting="homeChief"]' },
    { key: 'homeConnectors', at: '[data-setting="homeConnectors"]' },
  ],
  render: (ctx) => <AssistantsPage core={ctx.core} t={ctx.t} reveal={ctx.reveal} closeSettings={ctx.closeSettings} />,
});
