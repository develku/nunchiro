// Settings · Alerts (needs 31, 54): how a waiting session shows outside the tree. B4 (ticket 217): the notify level a new
// session starts with, whether the system delivers, and a test notification (layout idea from Orca's NotificationsPane and
// T3 Code's NotificationSettings, both MIT; no code fit: Orca's permission card is Electron IPC).
import { useEffect, useState } from 'react';
import type { Key } from '../../i18n';
import { askPermission, readPermission, sendTest, type Level, type Permission, type TestResult } from '../../queue/notify';
import { DEFAULTS, SOUNDS, type Settings, type SoundChoice, type Strip } from '../../settings';
import { play } from '../../sound'; // v1a-38
import { StrokeIcon } from '../shell/NavIcon';
import { PageSummary } from '../shell/PageActions';
import { RadioCards, Reset, Row, Sec, Seg, Select, Switch, Why } from '../shell/Row';

const MODES: [Strip, Key, Key][] = [
  // final.html order: the strip, signal only, no strip.
  ['on', 'settings.alerts.onTitle', 'settings.alerts.onCap'],
  ['signal', 'settings.alerts.signalTitle', 'settings.alerts.signalCap'],
  ['off', 'settings.alerts.offTitle', 'settings.alerts.offCap'],
];
import { Icon } from '../../icons/Icon';

type T = (key: Key, args?: Record<string, string | number>) => string;

export function AlertsPage({ t, settings, update }: { t: T; settings: Settings; update: (patch: Partial<Settings>) => void }) {
  // Ticket 250 r3: the final draft's three cards: when an answer is needed, sounds, macOS notifications.
  const mode = MODES.find(([v]) => v === settings.strip);
  const level = LEVELS.find(([v]) => v === settings.notifyDefault);
  return (
    <>
      <PageSummary parts={[[t('summary.answer'), mode && t(mode[1])], [t('summary.level'), level && t(level[1])]]} />
      <Sec id="h-alerts" title={t('settings.section.whenWaiting')}>
        <Row
          top
          id="h-strip"
          label={t('settingsReset.strip')}
          reset={<Reset t={t} label={t('settingsReset.strip')} show={settings.strip !== DEFAULTS.strip} run={() => update({ strip: DEFAULTS.strip })} />}
          extra={<RadioCards name="strip" cols labelledBy="h-strip" value={settings.strip} onChange={(v) => update({ strip: v })} options={MODES.map(([v, title, cap]): [Strip, string, string] => [v, t(title), t(cap)])} />}
        />
        <Row
          id="h-notify-default"
          label={t('settingsA.notifyDefault')}
          desc={t('settingsA.notifyDefaultNote')}
          reset={<Reset t={t} label={t('settingsA.notifyDefault')} show={settings.notifyDefault !== DEFAULTS.notifyDefault} run={() => update({ notifyDefault: DEFAULTS.notifyDefault })} />}
          control={<Seg name="notify-default" setting="notifyDefault" label={t('settingsA.notifyDefault')} value={settings.notifyDefault} onChange={(v) => update({ notifyDefault: v })} options={LEVELS.map(([v, label]): [Level, string] => [v, t(label)])} />}
        />
        <Row
          label={t('settingsA.notifyFocused')}
          desc={t('settingsA.notifyFocusedNote')}
          reset={<Reset t={t} label={t('settingsA.notifyFocused')} show={settings.notifyFocused !== DEFAULTS.notifyFocused} run={() => update({ notifyFocused: DEFAULTS.notifyFocused })} />}
          control={<Switch setting="notifyFocused" label={t('settingsA.notifyFocused')} checked={settings.notifyFocused} onChange={(v) => update({ notifyFocused: v })} />}
        />
      </Sec>
      {/* v1a-38: macOS system sounds; a muted session stays silent (its notify level). */}
      <Sec id="h-sounds" title={t('settings.alerts.sounds')}>
        <SoundRow t={t} event="done" label={t('settings.alerts.done')} value={settings.soundDone} dflt={DEFAULTS.soundDone} volume={settings.soundVolume} onChange={(v) => update({ soundDone: v })} />
        <SoundRow t={t} event="waiting" label={t('settings.alerts.waiting')} value={settings.soundWaiting} dflt={DEFAULTS.soundWaiting} volume={settings.soundVolume} onChange={(v) => update({ soundWaiting: v })} />
        <Row
          label={t('settings.alerts.volume')}
          desc={`${t('settings.kit.default', { value: `${Math.round(DEFAULTS.soundVolume * 100)}%` })} · ${t('settings.alerts.soundsNote')}`}
          reset={<Reset t={t} label={t('settings.alerts.volume')} show={settings.soundVolume !== DEFAULTS.soundVolume} run={() => update({ soundVolume: DEFAULTS.soundVolume })} />}
          control={
            <span className="range">
              <input type="range" min={0} max={1} step={0.05} value={settings.soundVolume} aria-label={t('settings.alerts.volume')} data-setting="soundVolume" onChange={(e) => update({ soundVolume: Number(e.target.value) })} />
              <span className="valb">{Math.round(settings.soundVolume * 100)}%</span>
            </span>
          }
        />
      </Sec>
      <SystemNotes t={t} />
    </>
  );
}

const LEVELS: [Level, Key][] = [
  ['all', 'settingsA.levelAll'],
  ['waiting', 'settingsA.levelWaiting'],
  ['muted', 'settingsA.levelMuted'],
];

const CHIP: Partial<Record<Permission, [Key, string]>> = {
  granted: ['settingsA.allowed', 'ok'],
  denied: ['settingsA.blocked', 'warn'],
  default: ['settingsA.notAsked', ''],
};

/** B4, ticket 316: what the system really says, and what a test notification really did. */
function SystemNotes({ t }: { t: T }) {
  const [perm, setPerm] = useState<Permission>('unknown');
  const [result, setResult] = useState<TestResult | null>(null);
  const [asking, setAsking] = useState(false); // the shell waits on the person's answer, up to two minutes
  useEffect(() => {
    const read = () => void readPermission().then(setPerm);
    read();
    window.addEventListener('focus', read); // back from System Settings with the switch flipped
    return () => window.removeEventListener('focus', read);
  }, []);
  useEffect(() => {
    if (result !== 'sent') return;
    const back = setTimeout(() => setResult(null), 2000);
    return () => clearTimeout(back);
  }, [result]);
  const asked = (work: Promise<unknown>) => (setAsking(true), void work.finally(() => setAsking(false)));
  const test = () => asked(sendTest(() => {}).then((r) => (setResult(r), readPermission().then(setPerm))));
  const chip = CHIP[perm];
  // Ticket 475: blocked is a why line that says where to turn them on; no button, because the window capability may not
  // open that pane (permission-needed.spec.ts pins the allowed System Settings URLs).
  const why = perm === 'denied' && <Why id="notifications" reason={t('settingsWhy.notifyBlocked')} />;
  const note = perm === 'denied' ? null : result === 'failed' ? t('settingsA.testFailed') : result === 'unconfirmed' ? t('settingsA.testUnconfirmed') : null;
  return (
    <Sec id="h-system-notes" title={t('settings.row.macNotes')}>
      <Row
        icon={<StrokeIcon name="bell" />}
        label={t('settingsA.system')}
        chip={chip && <span className={`chip ${chip[1]}`}>{t(chip[0])}</span>}
        desc={t('settings.row.macNotesDesc')}
        why={why}
        extra={note && <div className="sds" role="status">{note}</div>}
        control={
          <>
            <button type="button" className="btn" onClick={test}>
              {result === 'sent' ? t('settingsA.sent') : t('settingsA.sendTest')}
            </button>
            <span className="sr" role="status">
              {result === 'sent' ? t('settingsA.sent') : ''}
            </span>
            {perm === 'default' && (
              <button type="button" className="btn" disabled={asking} onClick={() => asked(askPermission().then(setPerm))}>
                {t('settingsA.askNow')}
              </button>
            )}
          </>
        }
      />
    </Sec>
  );
}

function SoundRow({ t, event, label, value, dflt, volume, onChange }: { t: T; event: 'done' | 'waiting'; label: string; value: SoundChoice; dflt: SoundChoice; volume: number; onChange: (v: SoundChoice) => void }) {
  return (
    <Row
      label={label}
      reset={<Reset t={t} label={label} show={value !== dflt} run={() => onChange(dflt)} />}
      control={
        <>
          <Select setting={event === 'done' ? 'soundDone' : 'soundWaiting'} label={t(event === 'done' ? 'settings.alerts.soundDone' : 'settings.alerts.soundWaiting')} value={value} onChange={(v) => onChange(v as SoundChoice)}>
            <option value="off">{t('settings.alerts.off')}</option>
            {SOUNDS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <button type="button" className="btn icon" aria-label={t(event === 'done' ? 'settings.alerts.previewDone' : 'settings.alerts.previewWaiting')} disabled={value === 'off'} data-idle={value === 'off' || undefined} onClick={() => play(value, volume)}>
            <Icon name="triangle-right" size={14} />
          </button>
        </>
      }
    />
  );
}
