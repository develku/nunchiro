// C9 (ticket 217, T3 Code's live sample idea): beside the terminal font size, two chat lines in the chat's own face and one
// terminal line in the typed family and size, so each stepper move shows at once. Decorative, so hidden from readers: the
// fields beside it carry the values. Q5-7 (look 1117): the chat lines are prose the user would read in their language, so
// they are translated; the terminal line is a command and its output, which a shell prints the same in every language
// (iTerm's and T3 Code's previews show code too), so it stays as it is.
import type { T } from '../../i18n';

export function FontSample({ family, size, t }: { family: string; size: number; t: T }) {
  return (
    <span className="fsample" aria-hidden>
      <span className="fs-chat">{t('settings.appearance.sampleAsk')}</span>
      <span className="fs-chat">{t('settings.appearance.sampleDone')}</span>
      <span className="fs-term" style={{ fontFamily: family, fontSize: `${size}px` }}>
        {'~/api $ cargo test   ok'}
      </span>
    </span>
  );
}
