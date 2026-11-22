// V2-8c (needs 82): live PR status through the user's own gh, off by default. Stored by the core (settings.json).
import { useEffect, useState } from 'react';
import type { CoreClient, PrLive } from '../../api';
import type { Key } from '../../i18n';
import { Row, Switch, Why, WhyFix } from '../shell/Row';

type T = (key: Key, args?: Record<string, string | number>) => string;

/** Ticket 475: what the Connected services probe says about gh, and its fixes (the page's own buttons do the same). */
export type GhWhy = { state: 'missing' | 'signed_out'; install: () => void; signIn: () => void };

export function LivePrStatusView({ t, pr, gh, onChange }: { t: T; pr: PrLive; gh?: GhWhy | null; onChange: (on: boolean) => void }) {
  // Ticket 250 r3: the final draft's row; the hint (gh missing, signed out) sits under the description.
  // Ticket 475: with gh missing the switch cannot be turned on (it can still be turned off); the probe's reason replaces
  // the core's hint, which says the same in English only.
  const why =
    gh?.state === 'missing' ? (
      <Why id="why-live-pr" reason={t('settingsWhy.ghMissing')} fix={<WhyFix label={t('git.install')} run={gh.install} />} />
    ) : gh?.state === 'signed_out' ? (
      <Why id="why-live-pr" reason={t('settingsWhy.ghOut')} fix={<WhyFix label={t('git.signIn')} run={gh.signIn} />} />
    ) : null;
  return (
    <Row
      setting="livePrStatus"
      label={t('field.livePrStatus')}
      desc={t('settings.lifetime.prNote')}
      why={why}
      extra={
        !why &&
        pr.on &&
        pr.hint && (
          <div className="sds" role="status" data-hint="livePrStatus">
            {pr.hint}
          </div>
        )
      }
      control={<Switch setting="livePrStatus" label={t('field.livePrStatus')} checked={pr.on} disabled={gh?.state === 'missing' && !pr.on} describedBy={why ? 'why-live-pr' : undefined} onChange={onChange} />}
    />
  );
}

export function LivePrStatus({ t, core, gh }: { t: T; core: CoreClient; gh?: GhWhy | null }) {
  const [pr, setPr] = useState<PrLive | null>(null);
  useEffect(() => {
    core.prLive({ op: 'pr_live' }).then(setPr, () => {});
  }, [core]);
  if (!pr) return null;
  // Answering here also answers the chip's one-time offer.
  const change = async (on: boolean) => {
    const next = await core.prLive({ op: 'pr_live_set', on, offered: true });
    // Turned on: the core starts polling now instead of at the next 30 s heartbeat.
    setPr(on ? await core.prLive({ op: 'pr_front', front: document.hasFocus() }) : next);
  };
  return <LivePrStatusView t={t} pr={pr} gh={gh} onChange={(on) => void change(on).catch(() => {})} />;
}
