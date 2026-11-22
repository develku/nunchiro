// Ticket 270 (needs 197; G30, G31, G34 of docs/design/settings-1103/gap.md): three small rows on built-in pages, all from
// this one file through the ticket 250 seams. Values (small-rows-values.ts): G30 and G31 are window values (defineSetting),
// G34 a core value (`features` key `pr.strip_agent_credits`, read by crates/nunchiro-core/src/pr/mod.rs at merge time).
// Row shapes after Orca's NotificationHostToggles.tsx (a switch per host) and RecentTabOrderControl.tsx (strip / recent),
// MIT License, Copyright (c) 2026 Lovecast Inc., and T3 Code's ProjectDefaultsSettings.tsx (a switch with its note),
// MIT License, Copyright (c) 2026 T3 Tools Inc. (shape only: no code fit, theirs are Radix/Electron components).
import { useEffect, useState } from 'react';
import type { CoreClient } from '../api';
import { plainError } from '../errors';
import type { T } from '../i18n';
import { Reset, Row, Sec, Seg, Switch } from '../settings/shell/Row';
import { useCoreFeature, useFeatureSetting } from '../settings/useFeatureSetting';
import { registerSettingsSection } from './registry';
import { ALERT_MACHINES, alertsOn, CYCLE_ORDER, SMALL_ROWS_FIELDS as F, STRIP_CREDITS, THIS_MAC } from './small-rows-values';


function MachineAlerts({ core, t }: { core: CoreClient; t: T }) {
  const [map, setMap] = useFeatureSetting(ALERT_MACHINES);
  const [aliases, setAliases] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    // The SSH machines of Settings > SSH Machines; on an error only this Mac is listed.
    core.request({ op: 'machine_details' }).then(
      (r) => live && setAliases(((r as { machines?: { machine: string }[] }).machines ?? []).map((m) => m.machine)),
      () => {},
    );
    return () => void (live = false);
  }, [core]);
  return (
    <Sec id="h-alert-machines" title={t('smallRows.machines')} lede={t('smallRows.machinesDesc')}>
      {[THIS_MAC, ...aliases].map((alias) => {
        const name = alias === THIS_MAC ? t('smallRows.thisMac') : alias;
        return (
          <Row
            key={alias}
            label={name}
            // Ticket 543: every machine starts on; the reset drops its entry, as the stored map holds only what was changed.
            reset={<Reset t={t} label={name} show={!alertsOn(map, alias)} run={() => setMap(Object.fromEntries(Object.entries(map).filter(([k]) => k !== alias)))} />}
            control={<Switch label={t('smallRows.machineAlerts', { name })} setting="alertMachines" checked={alertsOn(map, alias)} onChange={(on) => setMap({ ...map, [alias]: on })} />}
          />
        );
      })}
    </Sec>
  );
}

function CycleOrderRow({ t }: { t: T }) {
  const [order, setOrder] = useFeatureSetting(CYCLE_ORDER);
  return (
    <Sec label={t('field.tabCycleOrder')}>
      <Row
        label={t('field.tabCycleOrder')}
        desc={t('smallRows.cycleDesc')}
        reset={<Reset t={t} label={t('field.tabCycleOrder')} show={order !== 'strip'} run={() => setOrder('strip')} />}
        control={
          <Seg
            name="tab-cycle-order"
            label={t('field.tabCycleOrder')}
            setting="tabCycleOrder"
            value={order}
            onChange={setOrder}
            options={[
              ['strip', t('smallRows.cycleStrip')],
              ['mru', t('smallRows.cycleMru')],
            ]}
          />
        }
      />
    </Sec>
  );
}

function StripCreditsRow({ t }: { t: T }) {
  const [on, set, error] = useCoreFeature(STRIP_CREDITS, false);
  return (
    <Sec label={t('field.stripAgentCredits')}>
      <Row
        label={t('field.stripAgentCredits')}
        desc={error ? <span role="alert" title={error}>{plainError(t, error)}</span> : t('smallRows.stripDesc')}
        reset={<Reset t={t} label={t('field.stripAgentCredits')} show={on !== false} run={() => void set(null)} />}
        control={<Switch label={t('field.stripAgentCredits')} setting="stripAgentCredits" checked={on} onChange={(v) => void set(v)} />}
      />
    </Sec>
  );
}

registerSettingsSection({ page: 'alerts', id: 'small-rows.machines', order: 10, fields: [F.alerts], render: ({ core, t }) => <MachineAlerts core={core} t={t} /> });
registerSettingsSection({ page: 'keys', id: 'small-rows.cycle', order: 10, fields: [F.keys], render: ({ t }) => <CycleOrderRow t={t} /> });
registerSettingsSection({ page: 'git', id: 'small-rows.credits', order: 10, fields: [F.git], render: ({ t }) => <StripCreditsRow t={t} /> });
