// Settings: session lifetime, start at login, terminal history (spec Core and window; needs 19, 40, 79).
// These live in the core's settings.json (quit_settings), not in the window's localStorage: the menu bar app
// and a terminal read the same values.
import { useEffect, useState } from 'react';
import type { CoreClient } from '../../api';
import type { Key } from '../../i18n';
import { app } from './tauri';
import { RadioCards, Reset, Row, Switch } from '../shell/Row';
import { PageSummary } from '../shell/PageActions';
import { StrokeIcon } from '../shell/NavIcon';
import { ErrorLine, rawError } from '../../errors';
import { useFeatureSetting } from '../useFeatureSetting';
import { ASK_CLOSE_RUNNING } from '../../chrome/closeAsk';
import { keyText } from '../../keys';

export interface LifetimeValues {
  lifetime: 'keep_running' | 'end_with_app';
  start_at_login: boolean;
  disable_hook_injection: boolean;
  keep_history: boolean;
  mask_history: boolean;
  keep_awake: boolean;
}
type Patch = Partial<LifetimeValues>;
// The core's defaults (sessions.rs `Settings`, api.rs `Lifetime`): agents keep running, nothing starts at login, the Mac may
// sleep, terminal history is kept and not masked.
const DEFAULT_LIFETIME: LifetimeValues['lifetime'] = 'keep_running';
type T = (key: Key, args?: Record<string, string | number>) => string;

export function LifetimeSection({ core, t, part }: { core: CoreClient; t: T; part: 'general' | 'history' }) {
  const [values, setValues] = useState<LifetimeValues | null>(null);
  const [error, setError] = useState('');
  const [askClose, setAskClose] = useFeatureSetting(ASK_CLOSE_RUNNING);
  const apply = async (patch: Patch) => {
    setError('');
    const stored = values;
    // Shown at once; the core's reply (or a rollback to what it stored) replaces it.
    setValues((v) => v && { ...v, ...patch });
    try {
      // The login item first: if the plist cannot be written, the stored setting must not claim it is on.
      if (patch.start_at_login !== undefined) await app('set_start_at_login', { on: patch.start_at_login });
      const reply = (await core.request({ op: 'quit_settings', patch })) as { settings: LifetimeValues };
      setValues(reply.settings);
    } catch (e) {
      setValues(stored);
      setError(rawError(e));
    }
  };
  const load = () => {
    core.request({ op: 'quit_settings' }).then((r) => (setValues((r as { settings: LifetimeValues }).settings), setError('')), (e) => setError(rawError(e)));
  };
  useEffect(load, [core]);

  // Ticket 250 (final draft): General shows when agents end, start at login and keep awake; Terminal History shows the saved
  // history. Same values, one core request per page (the hook switch moved to 스킬·훅, features/extensions.tsx, ticket 391). r3: the draft's rows (Row kit), every string
  // from the catalogue.
  const head = { general: ['h-lifetime', t('settings.section.windowAgents')], history: ['h-history', t('settings.section.termHistory')] }[part];
  const rows = !values ? null : part === 'general' ? (
    <>
      <Row
        top
        id="h-lifetime-when"
        label={t('settings.row.close')}
        desc={t('settings.row.closeDesc')}
        reset={<Reset t={t} label={t('settings.row.close')} show={values.lifetime !== DEFAULT_LIFETIME} run={() => void apply({ lifetime: DEFAULT_LIFETIME })} />}
        extra={
          <RadioCards
            name="lifetime"
            labelledBy="h-lifetime-when"
            value={values.lifetime}
            onChange={(v) => void apply({ lifetime: v })}
            options={[
              ['keep_running', t('settings.row.keepRunning'), t('settings.row.keepRunningDesc')],
              ['end_with_app', t('settings.row.endWithApp'), t('settings.row.endWithAppDesc')],
            ]}
          />
        }
      />
      <Row label={t('settings.row.startAtLogin')} desc={t('settings.row.startAtLoginDesc')} reset={<Reset t={t} label={t('settings.row.startAtLogin')} show={values.start_at_login} run={() => void apply({ start_at_login: false })} />} control={<Switch setting="startAtLogin" label={t('settings.row.startAtLogin')} checked={values.start_at_login} onChange={(v) => void apply({ start_at_login: v })} />} />
      <Row label={t('lifetime.keepAwake')} desc={t('lifetime.keepAwakeHint')} reset={<Reset t={t} label={t('lifetime.keepAwake')} show={values.keep_awake} run={() => void apply({ keep_awake: false })} />} control={<Switch setting="keepAwake" label={t('lifetime.keepAwake')} checked={values.keep_awake} onChange={(v) => void apply({ keep_awake: v })} />} />
      <Row label={t('closeAsk.row')} desc={t('closeAsk.rowDesc', { key: keyText('tab.close') })} reset={<Reset t={t} label={t('closeAsk.row')} show={askClose !== false} run={() => setAskClose(false)} />} control={<Switch setting="confirmCloseRunning" label={t('closeAsk.row')} checked={askClose} onChange={setAskClose} />} />
    </>
  ) : (
    <>
      <Row icon={<StrokeIcon name="history" />} label={t('settings.row.history')} desc={t('settings.row.historyDesc')} reset={<Reset t={t} label={t('settings.row.history')} show={!values.keep_history} run={() => void apply({ keep_history: true })} />} control={<Switch setting="history" label={t('settings.row.history')} checked={values.keep_history} onChange={(v) => void apply({ keep_history: v })} />} />
      {values.keep_history && <Row sub label={t('settings.row.mask')} desc={t('settings.row.maskDesc')} reset={<Reset t={t} label={t('settings.row.mask')} show={values.mask_history} run={() => void apply({ mask_history: false })} />} control={<Switch setting="maskHistory" label={t('settings.row.mask')} checked={values.mask_history} onChange={(v) => void apply({ mask_history: v })} />} />}
    </>
  );
  return (
    <section className="ssec" id={`s-${part === 'general' ? 'lifetime' : 'history'}`} aria-labelledby={head[0]}>
      <h2 id={head[0]}>{head[1]}</h2>
      {/* General's summary is the language (LanguagePicker); this page's are the history switches. */}
      {part === 'history' && values && <PageSummary parts={[[t('summary.history'), t(values.keep_history ? 'summary.on' : 'summary.off')], [t('summary.masked'), values.keep_history && t(values.mask_history ? 'summary.on' : 'summary.off')]]} />}
      <ErrorLine t={t} error={error} retry={values ? undefined : load} />
      {(rows || !error) && (
        <div className="scard">
          {rows ?? (
            <p className="lede srow" role="status">
              {t('settings.row.reading')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
