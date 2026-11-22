// Settings > Keyboard > Hints tab (V1A-48; needs 61, 118): the label alphabet as a text field and on the same drawing, the
// kind keys, and a live preview. The key map that shared this section went with needs 166 (page A: one list, no map).
import { PLAIN } from '../../plainText';
import { DEFAULT_HINT_KEYS, DRAWN, effectiveAlphabet, KINDS, letterOf, REGIONS, resetHintBindings, ROWS, type Kind, type Region } from '../../hintLabels';
import type { Settings } from '../../settings';
import { around, type Key } from '../../i18n';
import { AlphabetField, useHintAlphabet } from './HintAlphabet';
import { HintPreview } from './HintPreview';
import { Reset, Row, Sec } from '../shell/Row';
import { Icon } from '../../icons/Icon';
import { Chord } from './KeysPage';
import { DEFAULT_BINDINGS, label } from '../../keys';
import './hints.css';

type T = (key: Key, args?: Record<string, string | number>) => string;
const KIND_NAME: Record<Kind, Key> = {
  project: 'settings.keys.kind_project',
  session: 'settings.keys.kind_session',
  tab: 'settings.keys.kind_tab',
  left: 'settings.keys.kind_left',
  right: 'settings.keys.kind_right',
  pane: 'settings.keys.kind_pane',
  path: 'settings.keys.kind_path',
  url: 'settings.keys.kind_url',
  hash: 'settings.keys.kind_hash',
  other: 'settings.keys.kind_other',
};

// final.html CALLOUTS: what each letter on the drawing above stands for, in the draft's short words.
const CALLOUTS: [Kind, Key][] = [
  ['project', 'settings.keys.kind_project'],
  ['session', 'settings.keys.kind_session'],
  ['tab', 'settings.keys.kind_tab'],
  ['left', 'settings.kbd.callout_left'],
  ['right', 'settings.kbd.callout_right'],
  ['pane', 'settings.kbd.callout_pane'],
  ['path', 'settings.kbd.callout_path'],
  ['url', 'settings.keys.kind_url'],
];

export function HintsSection({ t, settings, update }: { t: T; settings: Settings; update: (patch: Partial<Settings>) => void }) {
  const alpha = useHintAlphabet(t, settings, update);
  const { hk, save, setDraft, setRefused } = alpha;
  // Owner 11-10: hint keys are letters, typed as shown; the drawing is a QWERTY picture of them.
  const g = (c: string) => c;
  // Ticket 389: only the p and s prefix keys leave the labels; the other kind keys are Shift filters and label too.
  const kindKeys = new Set([hk.kinds.project, hk.kinds.session]);
  const usable = effectiveAlphabet(hk);
  const prefix = (k: Kind) => k === 'project' || k === 'session';
  const regionOf = (code: string) => (usable.includes(code) ? (Object.keys(REGIONS) as Region[]).find((r) => (REGIONS[r] as readonly string[]).includes(code)) : undefined);

  const toggle = (code: string) => {
    const alphabet = hk.alphabet.includes(code) ? hk.alphabet.filter((c) => c !== code) : [...hk.alphabet, code];
    if (alphabet.length < 2) return setRefused(t('settings.keys.twoKeys'));
    save({ ...hk, alphabet });
  };
  const typeKind = (kind: Kind, text: string) => {
    const ch = text.slice(-1).toLowerCase();
    const code = DRAWN.has(ch) ? ch : null;
    if (!code) return setRefused(t('settings.keys.notKey', { key: text.slice(-1) }));
    // Two kinds never share a key: the kind already there takes this kind's old key.
    const other = KINDS.find((k) => k !== kind && hk.kinds[k] === code);
    save({ ...hk, kinds: { ...hk.kinds, [kind]: code, ...(other ? { [other]: hk.kinds[kind] } : {}) } });
  };
  const reset = () => {
    setDraft(null);
    setRefused('');
    update({ hintKeys: DEFAULT_HINT_KEYS, bindings: resetHintBindings(settings.bindings) });
  };

  // What sits on each drawn key, in words for the key's accessible name; the face shows a dot per kind or label key (V1A-56).
  const on = (code: string) => {
    const region = regionOf(code);
    return [
      ...KINDS.filter((k) => hk.kinds[k] === code).map((k) =>
        prefix(k) ? { type: 'kind', name: t('hints.prefixKey', { kind: t(KIND_NAME[k]) }) } : { type: 'filter', name: t('hints.filterKey', { key: g(code), kind: t(KIND_NAME[k]) }) },
      ),
      ...(hk.alphabet.includes(code) && !kindKeys.has(code) ? [{ type: 'index', name: t('settings.keys.labelKey', { n: usable.indexOf(code) + 1 }) }] : []),
      ...(region ? [{ type: 'region', name: t(`hints.region_${region}`) }] : []),
    ];
  };
  const keyboard = (
    <div className="hk-board" role="group" aria-label={t('settings.keys.keyboard')}>
      {ROWS.map((row, r) => (
        <div key={r} className="hk-krow" style={{ paddingLeft: r * 12 }}>
          {row.map((code) => {
            const key = letterOf(code);
            const here = on(key);
            const dots = here.filter((h) => h.type !== 'region');
            return (
              <button
                key={code}
                className="hk-key"
                data-code={code}
                data-used={here[0]?.type}
                data-region={regionOf(key)}
                aria-label={`${key}${here.length ? `: ${here.map((h) => h.name).join(', ')}` : ''}`}
                onClick={() => toggle(key)}
              >
                <span className="g">{hk.kinds.project === key || hk.kinds.session === key ? `${key}1` : key}</span>
                {dots.length > 0 && (
                  <span className="dots" aria-hidden>
                    {dots.map((h, i) => (
                      <span key={i} className="dot" data-type={h.type} />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
  // Ticket 250 r3: the final draft's hints part: what hints are, the letters, the kind keys, then the advanced fold with
  // the key names and the keyboard drawing, closed until asked for (final.html HINT_ADV).
  const show = (settings.bindings['hints.show'] ?? DEFAULT_BINDINGS['hints.show'] ?? [])[0] ?? '';
  const copy = (settings.bindings['hints.copy'] ?? DEFAULT_BINDINGS['hints.copy'] ?? [])[0] ?? '';
  const step = (key: Key, binding: string) => {
    const [a, b] = around(t, key, 'keys', label(binding));
    return (
      <>
        {a}
        {binding && <Chord binding={binding} bindings={settings.bindings} />}
        {b}
      </>
    );
  };
  const legend = (
    <ul className="hk-legend" aria-label={t('settings.keys.onDrawing')}>
      {/* V1A-57: label keys get a ring dot and a legend entry, so they can be found on the drawing too. */}
      <li key="index">
        <span className="dot" data-type="index" aria-hidden /> <span className="kbd">{usable.map(g).join(' ')}</span> {t('settings.keys.legendHint')}
      </li>
      {KINDS.map((k) => (
        <li key={k}>
          <span className="dot" data-type={prefix(k) ? 'kind' : 'filter'} aria-hidden /> <span className="kbd">{prefix(k) ? `${g(hk.kinds[k])}1` : `⇧${g(hk.kinds[k])}`}</span>{' '}
          {prefix(k) ? t('hints.prefixKey', { kind: t(KIND_NAME[k]) }) : t('hints.filterKey', { key: g(hk.kinds[k]), kind: t(KIND_NAME[k]) })}
        </li>
      ))}
      <li key="regions">{t('hints.regionsLegend')}</li>
      {(Object.keys(REGIONS) as Region[]).map((r) => (
        <li key={r}>
          <span className="swatch" data-region={r} aria-hidden /> {t(`hints.region_${r}`)}
        </li>
      ))}
    </ul>
  );
  const [kindBefore, kindAfter] = around(t, 'hints.oneKindDesc', 'key', g(hk.kinds.tab));
  return (
    <div className="hints-set">
      <section aria-label={t('settings.hints')} className="hk-hints">
        <Sec id="h-hints-what" title={t('settings.row.hintsWhat')}>
          <div className="hk-what">
            <HintPreview t={t} keys={hk} />
            <div className="hk-callouts">
              {CALLOUTS.map(([k, name]) => (
                <div key={k}>
                  <span className="hk-label">{prefix(k) ? `${g(hk.kinds[k])}1` : `⇧${g(hk.kinds[k])}`}</span>
                  {t(name)}
                </div>
              ))}
            </div>
          </div>
          <ol className="hk-steps">
            <li>{step('settings.row.hintsStep1', show)}</li>
            <li>{t('settings.row.hintsStep2')}</li>
            <li>{step('settings.row.hintsStep3', copy)}</li>
          </ol>
        </Sec>
        {/* Ticket 1041 (N090): one reset per row. The row's arrow resets the letters; the wider reset (letters and the hint
            bindings) is the section's action, beside its title. */}
        <Sec
          id="h-hints-letters"
          title={t('settings.keys.hintKeys')}
          action={
            <button className="btn" onClick={reset}>
              {t('settings.keys.reset')}
            </button>
          }
        >
          <Row
            top
            label={t('settings.keys.alphabet')}
            desc={t('settings.keys.anyKeys')}
            reset={<Reset t={t} label={t('settings.keys.alphabet')} show={alpha.changed} run={alpha.reset} />}
            extra={<AlphabetField t={t} alpha={alpha} />}
          />
        </Sec>
        <Sec id="h-hints-kinds" title={t('settings.keys.kindKeys')}>
          <Row
            label={t('settings.row.hintsOneKind')}
            reset={<Reset t={t} label={t('settings.row.hintsOneKind')} show={KINDS.some((k) => hk.kinds[k] !== DEFAULT_HINT_KEYS.kinds[k])} run={() => save({ ...hk, kinds: DEFAULT_HINT_KEYS.kinds })} />}
            desc={
              <>
                {t('hints.prefixDesc', { p: g(hk.kinds.project), s: g(hk.kinds.session) })} {kindBefore}
                <span className="hk-label">{g(hk.kinds.tab)}</span>
                {kindAfter}
              </>
            }
          />
          <div className="hk-chips" role="group" aria-label={t('settings.keys.kindKeys')}>
            {KINDS.map((k) => (
              <label key={k} className="hk-chip kind">
                <span>{t(KIND_NAME[k])}</span>
                <input {...PLAIN} className="mono" data-setting="hintKinds" aria-label={t('settings.keys.kindKey', { kind: t(KIND_NAME[k]) })} maxLength={2} size={2} value={g(hk.kinds[k])} onChange={(e) => typeKind(k, e.target.value)} />
              </label>
            ))}
          </div>
        </Sec>
        <section className="ssec" aria-label={t('settings.keys.advanced')}>
          <div className="scard">
            <details className="hk-adv">
              <summary>
                <Icon name="chevron-right" size={12} />
                <b>{t('settings.keys.advanced')}</b> <span className="sds">{t('settings.row.hintsAdvDesc')}</span>
              </summary>
              <div className="hk-scroll" role="group" aria-label={t('settings.keys.advanced')}>
                <Row top label={t('settings.kbd.drawing')} desc={t('settings.kbd.drawingDesc')} extra={<>{keyboard}{legend}</>} />
              </div>
            </details>
          </div>
        </section>
      </section>
    </div>
  );
}
