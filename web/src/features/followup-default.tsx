// Ticket 517: the follow-up default (owner pick 2026-11-12). Queue keeps the composer keys as they were; Steer swaps
// Enter and the send-now chord while an agent works (ComposerWidget reads FOLLOWUP). The row sits on the Keyboard page
// beside the composer keys. Choice after T3 Code's follow-up setting (behaviour only; no code or text taken).
import type { T } from '../i18n';
import { Reset, Row, Sec, Seg } from '../settings/shell/Row';
import { defineSetting, useFeatureSetting } from '../settings/useFeatureSetting';
import { registerSettingsSection } from './registry';
import { keyText } from '../keys';

export type Followup = 'queue' | 'steer';
export const FOLLOWUP = defineSetting<Followup>('composer.followup', 'queue', (v) => (v === 'queue' || v === 'steer' ? v : undefined));

function FollowupRow({ t }: { t: T }) {
  const [value, set] = useFeatureSetting(FOLLOWUP);
  const label = t('field.followupDefault');
  return (
    <Sec label={label}>
      <Row
        setting="composer.followup"
        label={label}
        desc={t(value === 'steer' ? 'followup.steerDesc' : 'followup.queueDesc', { key: keyText('composer.steerNow') })}
        reset={<Reset t={t} label={label} show={value !== 'queue'} run={() => set('queue')} />}
        control={<Seg name="followup-default" label={label} value={value} onChange={set} options={[['queue', t('followup.queue')], ['steer', t('followup.steer')]]} />}
      />
    </Sec>
  );
}

registerSettingsSection({ page: 'keys', id: 'composer.followup', order: 5, fields: [{ key: 'followupDefault', at: '[data-row="composer.followup"] input:checked' }], render: ({ t }) => <FollowupRow t={t} /> });
