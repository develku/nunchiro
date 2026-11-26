// Ticket 1168 (mockup docs/design/bots-1166.html, the same drawing): a bot's face. Drawn here, no image file: a head shape
// on a pastel tile, and eyes that carry the state. The core picks the shape and the tile from the bot's id
// (team/bots.rs `face_of`) and keeps them, so a bot has the same face everywhere. "Needs you" is also an orange ring,
// because under about 20 px the eyes cannot be read.
import type { CSSProperties } from 'react';
import type { T } from '../i18n';
import type { BotFace, Eyes } from './bots';
import './bots.css';

// No colour is written here: each part has a class, and bots.css gives it a --face-* token (tokens.css) by the tile.
function Head({ shape }: { shape: string }) {
  if (shape === 'bot')
    return (
      <>
        <path className="f-inks" d="M32 20V10" strokeWidth="3.5" strokeLinecap="round" />
        <circle className="f-ink" cx="32" cy="9" r="4" />
        <rect className="f-ink" x="9" y="19" width="46" height="52" rx="17" />
      </>
    );
  return (
    <>
      {shape === 'cat' && <path className="f-ink f-inks" d="M12 31 15 10 30 21ZM52 31 49 10 34 21Z" strokeWidth="4" strokeLinejoin="round" />}
      {shape === 'bear' && (
        <>
          <circle className="f-ink" cx="14" cy="23" r="8" />
          <circle className="f-ink" cx="50" cy="23" r="8" />
        </>
      )}
      {shape === 'bun' && (
        <>
          <ellipse className="f-ink" cx="21" cy="16" rx="6" ry="13" />
          <ellipse className="f-ink" cx="43" cy="16" rx="6" ry="13" />
        </>
      )}
      {shape === 'drop' && <path className="f-ink" d="M32 6c8 6 8 13 0 17-8-4-8-11 0-17Z" />}
      <circle className="f-ink" cx="32" cy="42" r="23" />
    </>
  );
}
const Eye = ({ x, y, ry, shine }: { x: number; y: number; ry: number; shine: number }) => (
  <>
    <ellipse className="f-eye" cx={x} cy={y} rx="3.3" ry={ry} />
    <circle className="f-shine" cx={x - 1} cy={y + shine} r="1.2" />
  </>
);
function EyesOf({ eyes }: { eyes: Eyes }) {
  if (eyes === 'look')
    return (
      <>
        <Eye x={25.5} y={44} ry={4.6} shine={-1.8} />
        <Eye x={38.5} y={44} ry={4.6} shine={-1.8} />
        <ellipse className="f-eye" cx="32" cy="52.5" rx="1.9" ry="2.2" />
      </>
    );
  if (eyes === 'work')
    return (
      <>
        <path className="f-line" d="M21.5 41h8M34.5 41h8" />
        <g className="scan">
          <Eye x={25.5} y={46} ry={3.1} shine={0.6} />
          <Eye x={38.5} y={46} ry={3.1} shine={0.6} />
        </g>
        <path className="f-line" d="M29.8 52.4h4.4" />
      </>
    );
  return (
    <>
      <path className="f-line" d="M22 44q3.5 3.2 7 0M35 44q3.5 3.2 7 0" />
      <path className="f-line" d="M29.8 51q2.2 1.8 4.4 0" />
    </>
  );
}

/** One face. `size` in px; its label is "<name>, resting | working | needs you". */
export function Face({ t, face, name, eyes, size = 40 }: { t: T; face: BotFace; name: string; eyes: Eyes; size?: number }) {
  return (
    <span className="face" data-shape={face.shape} data-tile={face.tile} data-eyes={eyes} data-you={eyes === 'look' || undefined} style={{ '--s': `${size}px` } as CSSProperties}>
      <svg viewBox="0 0 64 64" role="img" aria-label={t('bots.face', { name, state: t(`bots.state.${eyes}`) })}>
        <rect className="f-tile" width="64" height="64" />
        <Head shape={face.shape} />
        {face.shape === 'bot' ? <rect className="f-skin" x="15" y="31" width="34" height="28" rx="12" /> : <ellipse className="f-skin" cx="32" cy="47" rx="16.5" ry="14" />}
        <ellipse className="f-blush" cx="20" cy="50.5" rx="2.6" ry="1.6" />
        <ellipse className="f-blush" cx="44" cy="50.5" rx="2.6" ry="1.6" />
        <EyesOf eyes={eyes} />
      </svg>
    </span>
  );
}
