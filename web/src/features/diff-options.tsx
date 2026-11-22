// Ticket 261 (needs 197, G14): the Diff view's options, a section on Settings > Appearance. Window values (one window's
// view preference); diff/Diff.tsx reads the same keys, and its header toggles whitespace and wrap with them.
// The row set follows Orca's diff and editor settings (CollapseUnchangedRegionsSetting.tsx, DiffShowWhitespaceSetting.tsx,
// EditorWordWrapSetting.tsx under orca/src/renderer/src/components/settings/), MIT License, Copyright (c) 2026 Lovecast Inc.
// (the choice of rows only; the rows are drawn with the house row kit, no code taken).
import type { T } from '../i18n';
import { registerSettingsSection } from './registry';
import { Reset, Row, Sec, SecReset, Seg, Switch } from '../settings/shell/Row';
import { defineSetting, useFeatureSetting, type FeatureKey } from '../settings/useFeatureSetting';

const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
export const HIDE_WHITESPACE = defineSetting('diff.hide_whitespace', false, bool);
export const WRAP = defineSetting('diff.wrap', false, bool);
export const COLLAPSE = defineSetting('diff.collapse_unchanged', false, bool);
export const HIDE_LIST = defineSetting('diff.hide_file_list', false, bool);
export type Colours = 'theme' | 'colour_blind';
export const COLOURS = defineSetting<Colours>('diff.colours', 'theme', (v) => (v === 'theme' || v === 'colour_blind' ? v : undefined));

const SWITCHES: [FeatureKey<boolean>, string, 'hideWhitespace' | 'wrap' | 'collapse' | 'hideList'][] = [
  [HIDE_WHITESPACE, 'diffHideWhitespace', 'hideWhitespace'],
  [WRAP, 'diffWrap', 'wrap'],
  [COLLAPSE, 'diffCollapse', 'collapse'],
  [HIDE_LIST, 'diffHideList', 'hideList'],
];

function SwitchRow({ k, field, desc, t }: { k: FeatureKey<boolean>; field: string; desc: string; t: T }) {
  const [on, set] = useFeatureSetting(k);
  const label = t(`field.${field}` as never);
  return <Row label={label} desc={t(`diffopt.${desc}.desc` as never)} reset={<Reset t={t} label={label} show={on !== false} run={() => set(false)} />} control={<Switch setting={field} label={label} checked={on} onChange={set} />} />;
}

function DiffOptions({ t }: { t: T }) {
  const [colours, setColours] = useFeatureSetting(COLOURS);
  const [ws, setWs] = useFeatureSetting(HIDE_WHITESPACE);
  const [wrap, setWrap] = useFeatureSetting(WRAP);
  const [collapse, setCollapse] = useFeatureSetting(COLLAPSE);
  const [list, setList] = useFeatureSetting(HIDE_LIST);
  return (
    <Sec
      id="h-diff-options"
      title={t('diffopt.title')}
      action={<SecReset t={t} section={t('diffopt.title')} show={ws || wrap || collapse || list || colours !== 'theme'} run={() => (setWs(false), setWrap(false), setCollapse(false), setList(false), setColours('theme'))} undo={() => (setWs(ws), setWrap(wrap), setCollapse(collapse), setList(list), setColours(colours))} />}
    >
      {SWITCHES.map(([k, field, desc]) => (
        <SwitchRow key={field} k={k} field={field} desc={desc} t={t} />
      ))}
      <Row
        label={t('field.diffColours')}
        desc={t('diffopt.colours.desc')}
        reset={<Reset t={t} label={t('field.diffColours')} show={colours !== 'theme'} run={() => setColours('theme')} />}
        control={
          <Seg
            name="diff-colours"
            setting="diffColours"
            label={t('field.diffColours')}
            value={colours}
            onChange={setColours}
            options={[
              ['theme', t('diffopt.colours.theme')],
              ['colour_blind', t('diffopt.colours.colourBlind')],
            ]}
          />
        }
      />
    </Sec>
  );
}

registerSettingsSection({
  page: 'appearance',
  id: 'diff.options',
  order: 10,
  fields: [...SWITCHES.map(([, key]) => ({ key, at: `[data-setting="${key}"]` })), { key: 'diffColours', at: 'input[name="diff-colours"]:checked' }],
  render: ({ t }) => <DiffOptions t={t} />,
});
