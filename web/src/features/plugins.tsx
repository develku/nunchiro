// Settings > Plugins (docs/design/extensibility-m6, "설정 화면: Plugins"): each plugin folder with its parts, its approval,
// its on switch and its settings. The core owns all of it (crates/nunchiro-core/src/plugins.rs); Review is the widget
// permission sheet for `plugin:<id>`, and approving turns the plugin on.
import { PLAIN } from '../plainText';
import { useEffect, useState } from 'react';
import { ErrorLine, rawError } from '../errors';
import { PermissionSheet } from '../approval/PermissionSheet';
import { TABLES, type Key } from '../i18n';
import { approvalName, pluginOp, type Listed, type PluginSetting } from '../plugins/api';
import '../plugins/plugins.css';
import { Row, Sec, Select, Switch, Why } from '../settings/shell/Row';
import { PageSummary } from '../settings/shell/PageActions';
import { registerSettingsPage, type PageContext } from './registry';

const PAGE = 'plugins';

function counts(t: PageContext['t'], p: NonNullable<Listed['plugin']>) {
  const n = (count: number, one: Key, other: Key) => (count ? [t(count === 1 ? one : other, { n: count })] : []);
  return [
    ...n(p.panel?.length ?? 0, 'plugins.panels.one', 'plugins.panels.other'),
    ...n(p.command?.length ?? 0, 'plugins.commands.one', 'plugins.commands.other'),
    ...n(p.setting?.length ?? 0, 'plugins.settings.one', 'plugins.settings.other'),
    ...n(p.gate?.length ?? 0, 'plugins.checks.one', 'plugins.checks.other'),
  ].join(' · ');
}

function SettingControl({ s, value, label, save }: { s: PluginSetting; value: unknown; label: string; save: (v: unknown) => void }) {
  const [text, setText] = useState(String(value ?? ''));
  useEffect(() => setText(String(value ?? '')), [value]);
  if (s.type === 'bool') return <Switch checked={value === true} label={label} onChange={save} />;
  if (s.type === 'choice')
    return (
      <Select label={label} value={String(value ?? '')} onChange={save}>
        {(s.choices ?? []).map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
    );
  const commit = () => text !== String(value ?? '') && save(s.type === 'number' ? Number(text) : text);
  return (
    <input
      {...PLAIN}
      className="sinp plg-value"
      aria-label={label}
      type={s.type === 'number' ? 'number' : s.type === 'time' ? 'time' : 'text'}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

function PluginsPage({ core, t }: Pick<PageContext, 'core' | 't'>) {
  const [list, setList] = useState<Listed[] | null>(null);
  const [error, setError] = useState<unknown>('');
  const [review, setReview] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const act = async (action: Record<string, unknown>) => {
    setError('');
    try {
      setList(await pluginOp(core, action));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => void act({ do: 'list' }), [core]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = (p: Listed) =>
    p.error ? t('plugins.state.broken') : p.state === 'approved' ? t('plugins.state.approved') : p.state === 'changed' ? t('plugins.state.changed') : t('plugins.state.unapproved');

  return (
    <div className="ssec-group">
      <PageSummary parts={[[t('plugins.summary'), list?.length]]} />
      <ErrorLine t={t} error={error ? rawError(error) : ''} />
      <Sec id="h-plugins" className="plg-list" title={t('plugins.section')}>
        {list && list.length === 0 && (
          <p className="sds" data-setting="plugins">
            {t('plugins.none')} <code>nunchiro plugin new &lt;id&gt;</code>
          </p>
        )}
        {list?.map((p) => {
          const name = p.plugin?.name ?? p.id;
          return (
            <div key={p.id} className="plg" data-plugin={p.id} data-state={p.error ? 'broken' : p.state}>
              <Row
                setting={`plugin:${p.id}`}
                label={name}
                desc={
                  p.error ?? (
                    <>
                      {p.plugin?.about && <span className="plg-about">{p.plugin.about}</span>}
                      {[p.plugin && counts(t, p.plugin), p.plugin && [p.plugin.version, p.plugin.author].filter(Boolean).join(' · ')].filter(Boolean).join(' · ')}
                    </>
                  )
                }
                why={p.needs && <Why id={`plg-needs-${p.id}`} reason={t(p.needs === 'web_widgets' ? 'plugins.needs.web' : 'plugins.needs.script')} />}
                chip={<span className={`chip${p.state === 'approved' && !p.error ? ' ok' : p.error || p.state === 'changed' ? ' warn' : ''}`}>{state(p)}</span>}
                control={
                  <>
                    {!p.error && p.state !== 'approved' && (
                      <button type="button" className="btn" aria-label={t('plugins.reviewOf', { name })} onClick={() => setReview(p.id)}>
                        {t('plugins.review')}
                      </button>
                    )}
                    <Switch checked={p.on} label={t('plugins.onOf', { name })} disabled={!!p.error} onChange={(on) => void act({ do: 'set', id: p.id, on })} />
                  </>
                }
              />
              {p.plugin?.setting?.map((s) => (
                <Row key={s.key} sub label={s.label} control={<SettingControl s={s} value={p.values?.[s.key]} label={t('plugins.settingOf', { name, label: s.label })} save={(value) => void act({ do: 'setting', id: p.id, key: s.key, value })} />} />
              ))}
              <Row
                sub
                label={t('plugins.folder')}
                desc={<span className="mono">~/.nunchiro/plugins/{p.id}</span>}
                control={
                  removing === p.id ? (
                    <span role="group" aria-label={t('plugins.removeAsk')}>
                      <span className="sds">{t('plugins.removeAsk')}</span>{' '}
                      <button type="button" className="btn danger" onClick={() => void act({ do: 'remove', id: p.id }).then(() => setRemoving(null))}>
                        {t('plugins.remove')}
                      </button>{' '}
                      <button type="button" className="btn" onClick={() => setRemoving(null)}>
                        {t('plugins.cancel')}
                      </button>
                    </span>
                  ) : (
                    <>
                      {p.state === 'approved' && (
                        <button type="button" className="btn" aria-label={t('plugins.reviewOf', { name })} onClick={() => setReview(p.id)}>
                          {t('plugins.reviewAgain')}
                        </button>
                      )}
                      <button type="button" className="btn q danger" aria-label={t('plugins.removeOf', { name })} onClick={() => setRemoving(p.id)}>
                        {t('plugins.remove')}
                      </button>
                    </>
                  )
                }
              />
            </div>
          );
        })}
      </Sec>
      {review && (
        <PermissionSheet
          core={core}
          t={t}
          name={approvalName(review)}
          onClose={() => setReview(null)}
          onGranted={() => {
            const id = review;
            const first = list?.find((p) => p.id === id)?.state === 'unapproved';
            setReview(null);
            // A first approval turns it on, as the mockup's "Approve and turn on"; a review again leaves the switch as it was.
            void act(first ? { do: 'set', id, on: true } : { do: 'list' });
          }}
        />
      )}
    </div>
  );
}

const word = (key: 'plugins.title' | 'plugins.desc') => {
  const lang = document.documentElement.lang as keyof typeof TABLES;
  return TABLES[lang]?.[key] ?? TABLES.en[key] ?? 'Plugins';
};
registerSettingsPage({
  id: PAGE,
  get title() {
    return word('plugins.title');
  },
  get description() {
    return word('plugins.desc');
  },
  group: 'agents',
  order: 11,
  fields: [{ key: 'plugins', at: '[data-setting^="plugin"]' }],
  render: (ctx) => <PluginsPage core={ctx.core} t={ctx.t} />,
});
