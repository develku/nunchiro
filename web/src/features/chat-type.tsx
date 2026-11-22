// Ticket 258 (needs 197 G09): chat and UI typography on Settings > Appearance. Each value is a window feature setting
// (`type.*`); a value other than its default becomes a CSS variable on the window root, so the defaults (tokens.css)
// leave the chat exactly as it was. Frames keep their own fonts: nothing here reaches an artifact or widget frame.
// Row set and contrast idea after Orca's AppearanceChatSection / AppearanceChatContrastControls and T3 Code's
// TypographySettings (behaviour reference only; no code taken).
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { KEY, parse } from '../settings';
import { registerSettingsSection } from './registry';
import { defineSetting, useFeatureSetting, type FeatureKey } from '../settings/useFeatureSetting';
import { allFonts, installedFonts } from '../settings/appearance/fonts';
import { SYMBOLS } from '../settings/appearance/serve';
import { Reset, Row, Sec, Seg, Select, Stepper, Switch } from '../settings/shell/Row';
import type { T } from '../i18n';

const NAME = /^[\p{L}\p{N} ._-]{1,60}$/u; // one family name; quotes and commas can not get in
const font = (v: unknown) => (v === '' || (typeof v === 'string' && NAME.test(v)) ? v : undefined);
const num = (min: number, max: number) => (v: unknown) => (typeof v === 'number' && v >= min && v <= max ? v : undefined);
const one = <V extends string>(...vs: V[]) => (v: unknown) => (vs.includes(v as V) ? (v as V) : undefined);

// Defaults are today's values (tokens.css carries the same numbers).
const K = {
  uiFont: defineSetting('type.ui_font', '', font),
  chatFont: defineSetting('type.chat_font', '', font),
  chatSize: defineSetting('type.chat_size', 14.5, num(11, 24)),
  chatLine: defineSetting('type.chat_line', 1.65, num(1.2, 2.2)),
  codeSize: defineSetting('type.code_size', 11.5, num(11, 20)),
  codeFont: defineSetting('type.code_font', 'default' as 'default' | 'terminal', one('default', 'terminal')),
  composerFont: defineSetting('type.composer_font', '', font),
  composerSize: defineSetting('type.composer_size', 14.5, num(11, 24)),
  contrast: defineSetting('type.contrast', 'normal' as 'normal' | 'high', one('normal', 'high')),
  math: defineSetting('type.math', false, (v) => (typeof v === 'boolean' ? v : undefined)),
};
export const MATH = K.math;
/** Ticket 1043: the Appearance summary names the chat text size (mockup settings-1122 A). */
export const CHAT_SIZE = K.chatSize;
const DEFAULT = { uiFont: '', chatFont: '', chatSize: 14.5, chatLine: 1.65, codeSize: 11.5, codeFont: 'default', composerFont: '', composerSize: 14.5, contrast: 'normal', math: false } as const;
type Values = { -readonly [k in keyof typeof K]: (typeof K)[k] extends FeatureKey<infer V> ? V : never };

function useValues(): [Values, { [k in keyof Values]: (v: Values[k]) => void }] {
  const out = {} as Record<string, unknown>;
  const set = {} as Record<string, unknown>;
  // A fixed key list, so the hook order never changes.
  for (const k of Object.keys(K) as (keyof Values)[]) [out[k], set[k]] = useFeatureSetting(K[k] as FeatureKey<unknown>);
  return [out as Values, set as { [k in keyof Values]: (v: Values[k]) => void }];
}

/** Writes the values as root variables; a default value removes its variable, so tokens.css's default shows. */
function apply(v: Values, termFont: string) {
  const root = document.documentElement;
  const put = (name: string, value: string | null) => (value === null ? root.style.removeProperty(name) : root.style.setProperty(name, value));
  const face = (f: string, rest: string) => (f ? `"${f}", ${rest}` : null);
  put('--font-ui', face(v.uiFont, "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Segoe UI', sans-serif"));
  put('--font-chat', face(v.chatFont, 'var(--font-ui)'));
  put('--fs-chat', v.chatSize === DEFAULT.chatSize ? null : `${v.chatSize}px`);
  put('--lh-chat', v.chatLine === DEFAULT.chatLine ? null : String(v.chatLine));
  put('--fs-code', v.codeSize === DEFAULT.codeSize ? null : `${v.codeSize}px`);
  put('--font-code', v.codeFont === 'terminal' ? termFont : null);
  put('--font-composer', face(v.composerFont, "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif"));
  put('--fs-composer', v.composerSize === DEFAULT.composerSize ? null : `${v.composerSize}px`);
  if (v.contrast === 'high') root.dataset.chatContrast = 'high';
  else delete root.dataset.chatContrast;
}

// The variables apply from start-up, not only while Settings is open: a small root outside the app's tree follows the
// window store. shortcut: the terminal font is read from the stored settings when a type value changes and by the
// section on each Settings draw; a terminal font changed elsewhere (palette) applies on the next of those.
function Applier() {
  const [v] = useValues();
  // parse, not load(): load() also notes migrations and may write a backup, which the Applier must not do.
  useEffect(() => apply(v, parse(localStorage.getItem(KEY)).settings.termFont), [v]);
  return null;
}
if (typeof document !== 'undefined') createRoot(document.createElement('div')).render(<Applier />);

function FontSelect({ t, label, value, fonts, onChange }: { t: T; label: string; value: string; fonts: string[]; onChange: (v: string) => void }) {
  const list = value && !fonts.includes(value) ? [value, ...fonts] : fonts;
  return (
    <Select label={label} value={value} onChange={onChange}>
      <option value="">{t('chatType.system')}</option>
      {list.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
    </Select>
  );
}

function Typography({ t, termFont }: { t: T; termFont: string }) {
  const [v, set] = useValues();
  useEffect(() => apply(v, termFont), [v, termFont]);
  // Owner 11-17: every installed family, as the terminal font picker lists (the app's `font_list`); in a browser, or
  // until the list answers, the coding fonts the page can detect.
  const [every, setEvery] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void allFonts().then((all) => live && setEvery(all.map((f) => f.name)));
    return () => void (live = false);
  }, []);
  const fonts = useMemo(() => (every.length ? every : installedFonts()).filter((f) => f !== SYMBOLS), [every]);
  const reset = () => (Object.keys(DEFAULT) as (keyof Values)[]).forEach((k) => (set[k] as (x: unknown) => void)(DEFAULT[k]));
  const back = (k: keyof Values, label: string) => <Reset t={t} label={label} show={v[k] !== DEFAULT[k]} run={() => (set[k] as (x: unknown) => void)(DEFAULT[k])} />;
  return (
    <Sec id="h-chat-type" title={t('chatType.title')}>
      <Row setting="type.ui" label={t('field.uiFont')} reset={back('uiFont', t('field.uiFont'))} control={<FontSelect t={t} label={t('field.uiFont')} value={v.uiFont} fonts={fonts} onChange={set.uiFont} />} />
      <Row setting="type.chat" label={t('field.chatFont')} reset={back('chatFont', t('field.chatFont'))} control={<FontSelect t={t} label={t('field.chatFont')} value={v.chatFont} fonts={fonts} onChange={set.chatFont} />} />
      <Row setting="type.chatSize" label={t('field.chatSize')} reset={back('chatSize', t('field.chatSize'))} control={<Stepper t={t} label={t('field.chatSize')} min={11} max={24} step={0.5} value={v.chatSize} onChange={set.chatSize} />} />
      <Row setting="type.chatLine" label={t('field.chatLine')} reset={back('chatLine', t('field.chatLine'))} control={<Stepper t={t} label={t('field.chatLine')} min={1.2} max={2.2} step={0.05} unit="" value={v.chatLine} onChange={set.chatLine} />} />
      <Row setting="type.codeFont" label={t('field.codeFont')} reset={back('codeFont', t('field.codeFont'))} control={<Seg name="type-code-font" label={t('field.codeFont')} value={v.codeFont} options={[['default', t('chatType.codeDefault')], ['terminal', t('chatType.codeTerminal')]]} onChange={set.codeFont} />} />
      <Row setting="type.codeSize" label={t('field.codeSize')} reset={back('codeSize', t('field.codeSize'))} control={<Stepper t={t} label={t('field.codeSize')} min={11} max={20} step={0.5} value={v.codeSize} onChange={set.codeSize} />} />
      <Row setting="type.composer" label={t('field.composerFont')} reset={back('composerFont', t('field.composerFont'))} control={<FontSelect t={t} label={t('field.composerFont')} value={v.composerFont} fonts={fonts} onChange={set.composerFont} />} />
      <Row setting="type.composerSize" label={t('field.composerSize')} reset={back('composerSize', t('field.composerSize'))} control={<Stepper t={t} label={t('field.composerSize')} min={11} max={24} step={0.5} value={v.composerSize} onChange={set.composerSize} />} />
      <Row setting="type.contrast" label={t('field.chatContrast')} reset={back('contrast', t('field.chatContrast'))} control={<Seg name="type-contrast" label={t('field.chatContrast')} value={v.contrast} options={[['normal', t('chatType.normal')], ['high', t('chatType.high')]]} onChange={set.contrast} />} />
      <Row setting="type.math" label={t('field.chatMath')} desc={t('chatType.mathNote')} reset={back('math', t('field.chatMath'))} control={<Switch label={t('field.chatMath')} checked={v.math} onChange={set.math} />} />
      <Row label={null} control={<button type="button" className="btn" onClick={reset}>{t('chatType.reset')}</button>} />
    </Sec>
  );
}

const at = (row: string, control: string) => ({ at: `[data-row="${row}"] ${control}` });
registerSettingsSection({
  page: 'appearance',
  id: 'appearance.typography',
  order: 10,
  fields: [
    { key: 'uiFont', ...at('type.ui', 'select') },
    { key: 'chatFont', ...at('type.chat', 'select') },
    { key: 'chatSize', ...at('type.chatSize', 'input') },
    { key: 'chatLine', ...at('type.chatLine', 'input') },
    { key: 'codeFont', ...at('type.codeFont', 'input') },
    { key: 'codeSize', ...at('type.codeSize', 'input') },
    { key: 'composerFont', ...at('type.composer', 'select') },
    { key: 'composerSize', ...at('type.composerSize', 'input') },
    { key: 'chatContrast', ...at('type.contrast', 'input') },
    { key: 'chatMath', ...at('type.math', 'input') },
  ],
  render: ({ t, settings }) => <Typography t={t} termFont={settings.termFont} />,
});
