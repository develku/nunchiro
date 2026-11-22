// The hint alphabet field (the letters hint labels are made of): typed, checked and stored one way, on Settings > Keyboard >
// Hints and on the onboarding keys step.
import { PLAIN } from '../../plainText';
import { useState } from 'react';
import { DEFAULT_HINT_KEYS, effectiveAlphabet, parseAlphabet, type HintKeys } from '../../hintLabels';
import type { Key } from '../../i18n';
import type { Settings } from '../../settings';

type T = (key: Key, args?: Record<string, string | number>) => string;

export function useHintAlphabet(t: T, settings: Settings, update: (patch: Partial<Settings>) => void) {
  const hk = settings.hintKeys;
  // What the field shows while a typed value is refused; null shows the saved value.
  const [draft, setDraft] = useState<string | null>(null);
  const [refused, setRefused] = useState('');
  /** Saves a new value unless it leaves fewer than two keys for labels; the message names why. */
  const save = (next: HintKeys) => {
    if (effectiveAlphabet(next).length < 2) return setRefused(t('hints.fewKeys')), false;
    setRefused('');
    setDraft(null);
    update({ hintKeys: next });
    return true;
  };
  const type = (text: string) => {
    setDraft(text);
    const r = parseAlphabet(text, t);
    if (!r.ok) return setRefused(r.error);
    if (save({ ...hk, alphabet: r.keys })) setDraft(null);
  };
  return { hk, draft, refused, setDraft, setRefused, save, type, changed: hk.alphabet.join('') !== DEFAULT_HINT_KEYS.alphabet.join(''), reset: () => void save({ ...hk, alphabet: DEFAULT_HINT_KEYS.alphabet }) };
}

export function AlphabetField({ t, alpha }: { t: T; alpha: ReturnType<typeof useHintAlphabet> }) {
  const { hk, draft, refused, setDraft, setRefused } = alpha;
  // Ticket 389: only the p and s prefix keys leave the labels; the other kind keys are Shift filters and label too.
  const kindKeys = new Set([hk.kinds.project, hk.kinds.session]);
  return (
    <div className="hk-row">
      <input {...PLAIN}
        className="sinp mono"
        data-setting="hintKeys"
        aria-label={t('settings.keys.alphabet')}
        spellCheck={false}
        autoComplete="off"
        value={draft ?? hk.alphabet.join('')}
        onChange={(e) => alpha.type(e.target.value)}
        onBlur={() => (setDraft(null), setRefused(''))}
      />
      <ul className="hk-alpha" aria-label={t('settings.keys.usedInLabels')}>
        {hk.alphabet.map((c) => (
          <li key={c} className="kbd" data-used-as-kind={kindKeys.has(c) || undefined} title={kindKeys.has(c) ? t('settings.keys.usedAsKind') : undefined}>
            {c}
            {kindKeys.has(c) && <span className="sr"> {t('settings.keys.usedAsKind')}</span>}
          </li>
        ))}
      </ul>
      {hk.alphabet.some((c) => kindKeys.has(c)) && <p className="hk-note">{t('hints.struck')}</p>}
      {refused && (
        <div className="hk-note conflict" role="alert">
          <p>{refused}</p>
        </div>
      )}
    </div>
  );
}
