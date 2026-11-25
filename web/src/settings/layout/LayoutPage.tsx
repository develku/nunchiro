// Settings · Layout [배치] (SPLITNEW): what a new split opens when a key makes it (⌘D, ⌘⇧D, prefix % or "). A widget
// dragged onto the session view opens itself. Ticket 872: the Widgets section holds the script widgets switch.
import { useEffect, useState } from 'react';
import type { CoreClient } from '../../api';
import { ErrorLine, rawError } from '../../errors';
import type { Key } from '../../i18n';
import { DEFAULTS, type NewSplit, type Settings } from '../../settings';
import { toggleBarsAuto } from '../../layout/bars';
import { PageSummary } from '../shell/PageActions';
import { RadioCards, Reset, Row, Sec, Switch } from '../shell/Row';

type T = (key: Key, args?: Record<string, string | number>) => string;
const CHOICES: [NewSplit, Key, Key][] = [
  ['chooser', 'settings.layout.chooser', 'settings.layout.chooserCap'],
  ['chat', 'settings.layout.chat', 'settings.layout.chatCap'],
  ['terminal', 'settings.layout.terminal', 'settings.layout.terminalCap'],
];

export function LayoutPage({ t, core, settings, update }: { t: T; core: CoreClient; settings: Settings; update: (patch: Partial<Settings>) => void }) {
  // Ticket 250 r3: the final draft's card: the three choices side by side.
  const split = CHOICES.find(([v]) => v === settings.newSplit);
  return (
    <>
      <PageSummary parts={[[t('summary.newSplit'), split && t(split[1])]]} />
      <Sec label={t('settings.layout.newSplit')}>
        {/* Ticket 543: the choice is a row, so it carries the reset like every other row; its label is the card's old title. */}
        <Row
          top
          id="h-newsplit"
          label={t('settings.layout.newSplit')}
          reset={<Reset t={t} label={t('settings.layout.newSplit')} show={settings.newSplit !== DEFAULTS.newSplit} run={() => update({ newSplit: DEFAULTS.newSplit })} />}
          extra={
            <RadioCards
              name="newsplit"
              cols
              labelledBy="h-newsplit"
              value={settings.newSplit}
              onChange={(v) => update({ newSplit: v })}
              options={CHOICES.map(([v, title, cap]): [NewSplit, string, string] => [v, t(title), t(cap)])}
              ariaLabels={Object.fromEntries(CHOICES.map(([v, title]) => [v, t(title === 'settings.layout.chooser' ? 'settings.layout.chooserName' : title)]))}
            />
          }
        />
      </Sec>
      <Sec label={t('shell.chrome.barsAutohide')}>
        {/* Ticket 1047: the Dock-style bars; the setting lives with the arrangement (bars.barsAuto), so each layout keeps its own. */}
        <Row
          label={t('shell.chrome.barsAutohide')}
          desc={t('shell.chrome.barsAutohideDesc')}
          reset={<Reset t={t} label={t('shell.chrome.barsAutohide')} show={settings.bars.barsAuto === true} run={() => update({ bars: toggleBarsAuto(settings.bars) })} />}
          control={<Switch setting="barsAutohide" label={t('shell.chrome.barsAutohide')} checked={settings.bars.barsAuto === true} onChange={() => update({ bars: toggleBarsAuto(settings.bars) })} />}
        />
      </Sec>
      <Sec id="h-widgets" title={t('settings.section.widgets')}>
        <ScriptWidgets core={core} t={t} />
      </Sec>
    </>
  );
}

/** Ticket 872: GitPage's AutoClean row for the core's settings.json `script_widgets` (off by default). */
function ScriptWidgets({ core, t }: { core: CoreClient; t: T }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const take = (r: unknown) => setOn(!!(r as { settings: { script_widgets?: boolean } }).settings.script_widgets);
  const load = () => void core.request({ op: 'quit_settings' }).then((r) => (take(r), setError('')), (e: Error) => setError(rawError(e)));
  useEffect(load, [core]);
  const set = (v: boolean) => core.request({ op: 'quit_settings', patch: { script_widgets: v } }).then((r) => (take(r), setError('')), (e: Error) => setError(rawError(e)));
  return (
    <Row
      label={t('settings.row.scriptWidgets')}
      desc={t('settings.row.scriptWidgetsDesc')}
      reset={<Reset t={t} label={t('settings.row.scriptWidgets')} show={on === true} run={() => void set(false)} />}
      extra={<ErrorLine t={t} error={error} retry={on === null ? load : undefined} className="err" />}
      // Drawn once the core answered, so a jump from the widgets-off note focuses a live box.
      control={on !== null ? <Switch setting="scriptWidgets" label={t('settings.row.scriptWidgets')} checked={on} onChange={(v) => void set(v)} /> : null}
    />
  );
}
