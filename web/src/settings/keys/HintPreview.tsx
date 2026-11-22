// Settings > Keys > Hints (V1A-48, needs 118, ticket 389): a mock window with the labels the current alphabet and kind
// keys give, live while editing: p1 s1 on projects and sessions (a tab shares its session's), one key by screen region.
import type { Key } from '../../i18n';
import { assign, type HintItem, type HintKeys } from '../../hintLabels';

type T = (key: Key, args?: Record<string, string | number>) => string;

type Mock = { item: HintItem; text: string; area: 'il' | 'ir' | 'side' | 'tabs' | 'term' };
const MOCK: Mock[] = [
  ...['Projects', 'Files', 'Search'].map((t, i): Mock => ({ item: { kind: 'left', order: i, region: 'left' }, text: t, area: 'il' })),
  ...['Terminal', 'Board', 'Settings'].map((t, i): Mock => ({ item: { kind: 'right', order: 10 + i, region: 'right' }, text: t, area: 'ir' })),
  ...['nunchiro', 'lumen'].map((t, i): Mock => ({ item: { kind: 'project', order: i }, text: t, area: 'side' })),
  ...['api-server', 'login-page', 'docs'].map((t, i): Mock => ({ item: { kind: 'session', order: i }, text: t, area: 'side' })),
  ...['api-server', 'login-page', 'docs'].map((t, i): Mock => ({ item: { kind: 'tab', order: i }, text: t, area: 'tabs' })),
  { item: { kind: 'path', order: 30 }, text: 'web/src/App.tsx:12', area: 'term' },
  { item: { kind: 'url', order: 31 }, text: 'https://localhost:5173', area: 'term' },
  { item: { kind: 'other', order: 20, region: 'composer' }, text: 'Send', area: 'term' },
];

export function HintPreview({ t, keys }: { t: T; keys: HintKeys }) {
  const labels = assign(
    MOCK.map((m) => m.item),
    keys,
  );
  const cell = (area: Mock['area']) =>
    MOCK.map((m, i) => ({ m, i }))
      .filter(({ m }) => m.area === area)
      .map(({ m, i }) => (
        <span key={i} className="hp-t" title={m.text}>
          <span className="hk-label" data-hint-kind={m.item.kind}>
            {labels[i].join('')}
          </span>
          {area === 'il' || area === 'ir' ? '' : m.text}
        </span>
      ));
  return (
    <div className="hint-preview" role="img" aria-label={t('settings.keys.previewLabel')}>
      <div className="hp-col">{cell('il')}</div>
      <div className="hp-side">{cell('side')}</div>
      <div className="hp-main">
        <div className="hp-tabs">{cell('tabs')}</div>
        <div className="hp-term">{cell('term')}</div>
      </div>
      <div className="hp-col">{cell('ir')}</div>
    </div>
  );
}
