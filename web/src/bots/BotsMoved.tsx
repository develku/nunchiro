// Ticket 1168: Settings > Team and Settings > Assistants point to the Bots view (owner 2026-11-26: Bots is its own view in
// their place). Today's controls stay on those pages until lane 2 brings making a bot into the view.
import type { T } from '../i18n';
import { Row, Sec } from '../settings/shell/Row';
import { LEVELS_FOLD, openBots } from './bots';

/** The way to the Bots view, as a button (Settings > Team: in the Teammates section's head). */
export const OpenBots = ({ t }: { t: T }) => (
  <button type="button" className="btn" data-open-bots onClick={() => openBots()}>
    {t('bots.open')}
  </button>
);
/** Settings > Team's Levels line: the level table and Worker models live in the Bots view's Models and limits fold. */
export const LevelsMoved = ({ t }: { t: T }) => (
  <Sec label={t('bots.levelsMoved')}>
    <Row
      setting="levels"
      label={t('level.table')}
      control={
        <button type="button" className="btn" data-open-levels title={t('bots.levelsMoved')} aria-label={t('bots.levelsMoved')} onClick={() => openBots(LEVELS_FOLD)}>
          {t('bots.open')}
        </button>
      }
    />
  </Sec>
);
/** The same, as a row of its own (Settings > Assistants). */
export const BotsMoved = ({ t }: { t: T }) => (
  <Sec label={t('bots.title')}>
    <Row label={t('bots.moved')} desc={t('bots.movedDesc')} control={<OpenBots t={t} />} />
  </Sec>
);
