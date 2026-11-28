// V2-8b: the PR badge (tier 1): the last PR state the agent's own `gh` calls left in the transcript. No network here.
// V2-8c (tier 2, opt-in): the state the core last read through the user's gh, "Watch PR", and the one-time offer.
import { useEffect, useState } from 'react';
import { CoreClient, type PrLive } from '../api';
import { tEn, type Key, type T } from '../i18n';
import { PrView, type PrFrom } from '../pr/PrView';

export type PrState = 'draft' | 'open' | 'checks_pass' | 'checks_fail' | 'approved' | 'merged' | 'closed';
/** A session's PR changed outside its chat (the Diff panel created one): the chat header reads its chip again. */
export const PR_CHIP_EVENT = 'nunchiro:pr.chip';
export const prChipChanged = (session: string) => window.dispatchEvent(new CustomEvent(PR_CHIP_EVENT, { detail: { session } }));

export interface PrChipData {
  state: PrState;
  url: string;
  at: string | null;
  /** The agent whose terminal output the app linked this PR from (core pr_live.rs `link_later`); absent otherwise. */
  linked?: string;
}

const WORD: Record<PrState, Key> = {
  draft: 'chat.pr.draft',
  open: 'chat.pr.open',
  checks_pass: 'chat.pr.checks_pass',
  checks_fail: 'chat.pr.checks_fail',
  approved: 'chat.pr.approved',
  merged: 'chat.pr.merged',
  closed: 'chat.pr.closed',
};

/** "just now" under a minute, then minutes, hours, days; no text when the event has no time (stored before V2-8b). */
export function ageText(at: string | null, now: number, t: T = tEn): string {
  const ms = at ? Date.parse(at) : NaN;
  if (Number.isNaN(ms)) return '';
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return t('chat.pr.justNow');
  if (min < 60) return t('chat.pr.minutes', { n: min });
  if (min < 1440) return t('chat.pr.hours', { n: Math.floor(min / 60) });
  return t('chat.pr.days', { n: Math.floor(min / 1440) });
}

/** The transcript is outside text: only a plain https GitHub pull link ever opens. */
export function pullUrl(raw: string): string | null {
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(raw) ? raw : null;
}

/** The core's live answer for this chip, if it names a known state for this very PR. */
function liveState(chip: PrChipData, pr: PrLive | null): PrState | null {
  const s = pr?.live?.state;
  return pr?.live?.url === chip.url && s && Object.hasOwn(WORD, s) ? (s as PrState) : null;
}

export function PrChipView({ chip, now, pr, onWatch, onOffer, onOpen, t = tEn }: { chip: PrChipData | null; now: number; pr: PrLive | null; onWatch: (on: boolean) => void; onOffer: (on: boolean) => void; onOpen?: () => void; t?: T }) {
  if (!chip) return null;
  const link = pullUrl(chip.url);
  const live = liveState(chip, pr);
  const state = live ?? chip.state;
  const age = live ? t('chat.pr.live') : ageText(chip.at, now, t);
  const label = (
    <>
      <b>{t(WORD[state])}</b>
      {age && <span className="dim"> · {age}</span>}
    </>
  );
  return (
    <div className="prchip" data-state={state} data-live={live ? '' : undefined}>
      {link ? (
        // V2.5-8: the chip opens the PR view; GitHub is one more click from there.
        <button className="btn" title={link} onClick={onOpen}>
          {t('chat.pr.prefix')} {label}
        </button>
      ) : (
        <span title={chip.url}>{t('chat.pr.prefix')} {label}</span>
      )}
      {chip.linked && <span className="linked">{t('gitActions.linked', { agent: chip.linked })}</span>}
      {pr?.on && link && (
        <button className="btn watch" aria-pressed={pr.watched} title={t('chat.pr.watchTitle')} onClick={() => onWatch(!pr.watched)}>
          {pr.watched ? t('chat.pr.watching') : t('chat.pr.watch')}
        </button>
      )}
      {pr && !pr.offered && !pr.on && (
        <span className="offer" role="group" aria-label={t('chat.pr.offerGroup')}>
          {t('chat.pr.offer')}{' '}
          <button className="btn" onClick={() => onOffer(true)}>
            {t('chat.pr.turnOn')}
          </button>{' '}
          <button className="btn" onClick={() => onOffer(false)}>
            {t('chat.pr.noThanks')}
          </button>
        </span>
      )}
    </div>
  );
}

type PrReq = Parameters<CoreClient['prLive']>[0];

/** One chip action (watch, or an answer to the offer), then the chip's fresh read. `front`: a "Turn on" tells the
 * core at once that the window is in front, instead of at the next heartbeat. */
export async function prAct(core: Pick<CoreClient, 'prLive'>, url: string, req: PrReq, front = false): Promise<PrLive> {
  await core.prLive(req);
  if (front) await core.prLive({ op: 'pr_front', front: typeof document === 'undefined' || document.hasFocus() });
  return core.prLive({ op: 'pr_live', url });
}

/** `from`: the session showing the chip, so the PR view's Fix with agent can ask its agent (ticket 373). */
export function PrChip({ chip, now, from, t }: { chip: PrChipData | null; now: number; from?: PrFrom; t?: T }) {
  const [pr, setPr] = useState<PrLive | null>(null);
  const [open, setOpen] = useState(false);
  const url = chip?.url;
  useEffect(() => {
    const core = CoreClient.main;
    setPr(null);
    if (!url || !core) return;
    let alive = true;
    const read = () => core.prLive({ op: 'pr_live', url }).then((r) => alive && setPr(r), () => {});
    read();
    // Reads what the core already has; the core alone decides when gh runs.
    const timer = setInterval(read, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [url]);
  const act = (req: PrReq, front = false) => {
    const core = CoreClient.main;
    // On failure the chip keeps its tier-1 state.
    if (core && url) prAct(core, url, req, front).then(setPr, () => {});
  };
  const link = chip && pullUrl(chip.url);
  return (
    <>
      <PrChipView chip={chip} now={now} pr={pr} t={t} onOpen={() => setOpen(true)} onWatch={(on) => url && void act({ op: 'pr_watch', url, on })} onOffer={(on) => void act({ op: 'pr_live_set', on, offered: true }, on)} />
      {open && link && <PrView url={link} from={from} t={t} onClose={() => setOpen(false)} />}
    </>
  );
}
