// F11 (ticket 305): the empty centre, after Orca's Landing: the mark, one button, the keys to know. Setup lives in Settings > Onboarding.
import type { T } from '../i18n';
import { askAddProject } from '../NewSession';
import { PREFIX_SYMBOL } from '../keys';
import './firstrun.css';

// Ticket 469: with a project known, the one action is a new session (the palette's session.new), not another project.
export function Landing({ t, line, keys, onKeySheet, onNewSession, other }: { t: T; line: string; keys: { prefix: string; palette: string; hints: string }; onKeySheet: () => void; onNewSession?: () => void; /** Look 1117 v12 C-V8: a project whose tabs are hidden, and showing it. */ other?: { name: string; show: () => void } }) {
  return (
    <div className="landing">
      <svg className="landing-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Nunchiro">
        <path d="M5 19V11.25M19 5V19" />
        <path d="M6.9 8.1L8.1 6.9L19 13.1V19.9Z" fill="currentColor" strokeWidth="1" />
        <circle cx="5" cy="5.25" r="2.5" fill="currentColor" stroke="none" />
      </svg>
      <p>{line}</p>
      <button className="btn p" onClick={onNewSession ?? askAddProject}>
        {t(onNewSession ? 'empty.startSession' : 'landing.addProject')}
      </button>
      {other && (
        <button className="btn" onClick={other.show}>
          {t('landing.showOther', { other: other.name })}
        </button>
      )}
      <p className="landing-keys">
        {/* Look 1117 v4f (A q10b-1): the ◆ form the status bar and the Keyboard page use, and what ◆ is. */}
        <span className="kbd">{keys.hints}</span> {t('firstrun.hintsEverywhere')} <span className="kbd">{keys.palette}</span> {t('firstrun.listsCommands')} <span className="dim">{PREFIX_SYMBOL} = {keys.prefix}</span>
      </p>
      <button className="btn" onClick={onKeySheet}>
        {t('firstrun.keySheet')}
      </button>
    </div>
  );
}
