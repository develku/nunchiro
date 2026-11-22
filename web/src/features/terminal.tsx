// Ticket 251 (needs 197 G01, G02): Settings > Terminal gets Input and Look, from this one file through the ticket 250
// seams. The values live in the window store (`terminal.options`, one object cleaned field by field in
// terminal/options.ts); Terminal.tsx reads the same key, so a change reaches every open terminal without a restart.
// Rows use the final draft's row kit (settings/shell/Row.tsx; docs/design/settings-1103/final.html), Orca's rows as the
// peer (orca/src/renderer/src/components/settings/Terminal*Section.tsx, MIT License, Copyright (c) 2026 Lovecast Inc.).
import { PLAIN } from '../plainText';
import type { T } from '../i18n';
import { registerSettingsSection } from './registry';
import { currentFeature, defineSetting, useFeatureSetting } from '../settings/useFeatureSetting';
import type { ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import './terminal.css';
import { Reset, Row, Sec, SecReset, Seg, Stepper, Switch } from '../settings/shell/Row';
import { cleanPrefs, RANGES, TERM_DEFAULTS, type CursorShape, type OptionMeta, type TermPrefs } from '../terminal/options';

export const TERM_PREFS = defineSetting<TermPrefs>('terminal.options', TERM_DEFAULTS, cleanPrefs);

type NumKey = keyof typeof RANGES;
type BoolKey = { [K in keyof TermPrefs]: TermPrefs[K] extends boolean ? K : never }[keyof TermPrefs];

function useRows(t: T) {
  const [p, set] = useFeatureSetting(TERM_PREFS);
  const put = <K extends keyof TermPrefs>(k: K, v: TermPrefs[K]) => set({ ...p, [k]: v });
  const field = (k: string) => `term${k[0].toUpperCase()}${k.slice(1)}` as const;
  const label = (k: keyof TermPrefs) => t(`field.${field(k)}` as Parameters<T>[0]);
  const reset = (k: keyof TermPrefs) => <Reset t={t} label={label(k)} show={p[k] !== TERM_DEFAULTS[k]} run={() => put(k, TERM_DEFAULTS[k])} />;
  /** One card's "Reset to defaults": its own keys only, the others stay. */
  const secReset = (section: string, keys: (keyof TermPrefs)[]) => (
    <SecReset t={t} section={section} show={keys.some((k) => p[k] !== TERM_DEFAULTS[k])} run={() => set({ ...p, ...Object.fromEntries(keys.map((k) => [k, TERM_DEFAULTS[k]])) })} undo={() => {
      // Only what the reset set: a key edited since (no longer at its default) keeps the newer value, other cards are untouched.
      const now = currentFeature(TERM_PREFS);
      set({ ...now, ...Object.fromEntries(keys.filter((k) => now[k] === TERM_DEFAULTS[k]).map((k) => [k, p[k]])) });
    }} />
  );
  const num = (k: NumKey, desc?: string, unit = 'px', inc?: number, sub?: boolean) => {
    const [min, max, step] = RANGES[k];
    const dflt = t('settings.kit.default', { value: `${TERM_DEFAULTS[k]} ${unit}`.trim() });
    return <Row sub={sub} setting={field(k)} label={label(k)} desc={desc ? `${dflt} · ${desc}` : dflt} reset={reset(k)} control={<Stepper t={t} label={label(k)} min={min} max={max} step={step} inc={inc} unit={unit} value={p[k]} onChange={(v) => put(k, v)} />} />;
  };
  const bool = (k: BoolKey, desc?: string) => <Row setting={field(k)} label={label(k)} desc={desc} reset={reset(k)} control={<Switch label={label(k)} checked={p[k]} onChange={(v) => put(k, v)} />} />;
  return { p, put, field, label, num, bool, reset, secReset };
}

/** Ticket 391 (audit pick): the rows past a section's everyday ones, in one closed fold inside the same card. A search hit on
 *  a folded row opens the fold first (SettingsView). */
const More = ({ t, children }: { t: T; children: ReactNode }) => (
  <details className="hk-adv term-more">
    <summary>
      <Icon name="chevron-right" size={12} />
      <b>{t('terminal.more')}</b>
    </summary>
    {children}
  </details>
);

const INPUT_KEYS: (keyof TermPrefs)[] = ['scroll', 'fastScroll', 'tuiScroll', 'rightClickPaste', 'focusFollowsMouse', 'wordSeparators', 'optionMeta', 'hidePointer'];
const LOOK_KEYS: (keyof TermPrefs)[] = ['cursor', 'cursorBlink', 'cursorOpacity', 'fontWeight', 'boldWeight', 'ligatures', 'padLeft', 'padTop', 'gpu'];

function Input({ t }: { t: T }) {
  const { p, put, label, num, bool, reset, secReset } = useRows(t);
  const metas: [OptionMeta, string][] = (['auto', 'on', 'off', 'left', 'right'] as const).map((v) => [v, t(`terminal.${v}`)]);
  return (
    <Sec id="h-term-input" title={t('terminal.input')} action={secReset(t('terminal.input'), INPUT_KEYS)}>
      {num('scroll', t('terminal.scrollNote'), '×', 0.25)}
      <Row top setting="termOptionMeta" label={label('optionMeta')} desc={t('terminal.optionNote')} reset={reset('optionMeta')} control={<Seg name="termOptionMeta" label={label('optionMeta')} value={p.optionMeta} options={metas} onChange={(v) => put('optionMeta', v)} />} />
      <More t={t}>
        {num('fastScroll', t('terminal.fastScrollNote'), '×', 1, true)}
        {num('tuiScroll', t('terminal.tuiScrollNote'), '×', 1, true)}
        {bool('rightClickPaste', t('terminal.rightClickNote'))}
        {bool('focusFollowsMouse', t('terminal.focusNote'))}
        <Row
          setting="termWordSeparators"
          label={label('wordSeparators')}
          desc={t('terminal.wordNote')}
          reset={reset('wordSeparators')}
          control={<input {...PLAIN} className="sinp mono" aria-label={label('wordSeparators')} spellCheck={false} maxLength={64} value={p.wordSeparators} onChange={(e) => put('wordSeparators', e.target.value)} />}
        />
        {bool('hidePointer', t('terminal.pointerNote'))}
      </More>
    </Sec>
  );
}

function Look({ t }: { t: T }) {
  const { p, put, label, num, bool, reset, secReset } = useRows(t);
  const shapes: [CursorShape, string][] = (['block', 'bar', 'underline'] as const).map((v) => [v, t(`terminal.${v}`)]);
  return (
    <Sec id="h-term-look" title={t('terminal.look')} action={secReset(t('terminal.look'), LOOK_KEYS)}>
      <Row setting="termCursor" label={label('cursor')} reset={reset('cursor')} control={<Seg name="termCursor" label={label('cursor')} value={p.cursor} options={shapes} onChange={(v) => put('cursor', v)} />} />
      <More t={t}>
        {bool('cursorBlink')}
        {num('cursorOpacity', t('terminal.opacityNote'), '', 0.1)}
        {num('fontWeight', undefined, '', 100)}
        {num('boldWeight', undefined, '', 100)}
        {bool('ligatures', t('terminal.ligaturesNote'))}
        {num('padLeft', t('terminal.padNote'))}
        {num('padTop', undefined, 'px', 1, true)}
        {bool('gpu', t('terminal.gpuNote'))}
      </More>
    </Sec>
  );
}

// The search focuses a row's control through the row (`data-row`), not a `data-setting` on the control:
// settings-search.spec.ts checks every rendered data-setting against FIELDS as imported in Node, where no feature file loads.
const fields = (keys: (keyof TermPrefs)[]) =>
  keys.map((k) => {
    const key = `term${k[0].toUpperCase()}${k.slice(1)}`;
    return { key, at: `[data-row="${key}"] input` };
  });

registerSettingsSection({
  page: 'terminal',
  id: 'terminal.input',
  order: 10,
  fields: fields(INPUT_KEYS),
  render: ({ t }) => <Input t={t} />,
});
registerSettingsSection({
  page: 'terminal',
  id: 'terminal.look',
  order: 20,
  fields: fields(LOOK_KEYS),
  render: ({ t }) => <Look t={t} />,
});
