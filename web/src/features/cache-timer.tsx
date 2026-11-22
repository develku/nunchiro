// Ticket 257 (G13; needs 197): Settings > Agents' prompt-cache timer section: on/off (on by default) and the cache's
// duration, 5 minutes (default) or 1 hour; the tree's countdown (tree/CacheTimer.tsx) reads both. After Orca's
// settings/AgentCacheTimerSection.tsx (`:67` the switch, `:110` the duration),
// MIT License, Copyright (c) 2026 Lovecast Inc. (shape and wording only; theirs are Radix parts).
import type { T } from '../i18n';
import { Reset, Row, Sec, Seg, Switch } from '../settings/shell/Row';
import { useFeatureSetting } from '../settings/useFeatureSetting';
import { CACHE_TIMER, CACHE_TTL, FIVE_MIN, ONE_HOUR } from '../tree/CacheTimer';
import { registerSettingsSection } from './registry';

function CacheTimerSection({ t }: { t: T }) {
  const [on, setOn] = useFeatureSetting(CACHE_TIMER);
  const [ttl, setTtl] = useFeatureSetting(CACHE_TTL);
  const timer = t('field.cacheTimer');
  const duration = t('field.cacheTtl');
  return (
    <Sec id="h-cache-timer" title={t('cacheTimer.title')} lede={t('cacheTimer.lede')}>
      <Row
        setting="tree.cache_timer"
        label={timer}
        desc={t('cacheTimer.desc')}
        reset={<Reset t={t} label={timer} show={!on} run={() => setOn(true)} />}
        control={<Switch label={timer} checked={on} onChange={setOn} />}
      />
      <Row
        setting="tree.cache_ttl"
        sub
        label={duration}
        desc={t('cacheTimer.ttlDesc')}
        reset={<Reset t={t} label={duration} show={ttl !== FIVE_MIN} run={() => setTtl(FIVE_MIN)} />}
        control={
          <Seg
            name="cache-ttl"
            label={duration}
            value={ttl === ONE_HOUR ? '1h' : '5m'}
            onChange={(v) => setTtl(v === '1h' ? ONE_HOUR : FIVE_MIN)}
            options={[
              ['5m', t('cacheTimer.fiveMin')],
              ['1h', t('cacheTimer.oneHour')],
            ]}
          />
        }
      />
    </Sec>
  );
}

registerSettingsSection({
  page: 'providers',
  id: 'agents.cache-timer',
  order: 20,
  fields: [
    // data-row, not data-setting: a data-setting key must be in the static FIELDS list (settings-search spec).
    { key: 'cacheTimer', at: '[data-row="tree.cache_timer"] input' },
    { key: 'cacheTtl', at: '[data-row="tree.cache_ttl"] input:checked' },
  ],
  render: ({ t }) => <CacheTimerSection t={t} />,
});
