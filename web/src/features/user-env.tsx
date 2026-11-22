// Ticket 260 (G28; needs 198): Settings › Providers › Shell environment. Core values (`features` keys
// `env.inherit_shell`, on when absent, and `env.names`), read by crates/nunchiro-core/src/user_env.rs at each Claude,
// Codex and shell session start. The core reads the login shell once when it starts; the row shows why it could not.
// Rows after Orca's NativeChatShellEnvironmentSetting.tsx (the switch, the name list, the always-passed set),
// MIT License, Copyright (c) 2026 Lovecast Inc. (shape and text only; theirs are Radix components, the list is one field here).
import { useEffect, useState } from 'react';
import type { CoreClient } from '../api';
import { plainError } from '../errors';
import type { T } from '../i18n';
import { PLAIN } from '../plainText';
import { Reset, Row, Sec, Switch, Why } from '../settings/shell/Row';
import { useCoreFeature } from '../settings/useFeatureSetting';
import { registerSettingsSection } from './registry';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The names in `text` a shell would accept, each once (anything else is dropped, as Orca's list does). */
const names = (text: string) => [...new Set(text.split(/[\s,]+/).filter((n) => NAME.test(n)))];

function ShellEnv({ core, t }: { core: CoreClient; t: T }) {
  const [inherit, setInherit, error] = useCoreFeature('env.inherit_shell', true);
  const [list, setList, listError] = useCoreFeature<string[]>('env.names', []);
  const [draft, setDraft] = useState<string | null>(null);
  // Ticket 1008: agent sessions start without secret-looking names unless kept here.
  const [strip, setStrip, stripError] = useCoreFeature('env.strip_secrets', true);
  const [keep, setKeep, keepError] = useCoreFeature<string[]>('env.keep_secrets', []);
  const [keepDraft, setKeepDraft] = useState<string | null>(null);
  const [failed, setFailed] = useState('');
  const [secrets, setSecrets] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    core.request({ op: 'quit_settings' }).then(
      (r) => {
        if (!live) return;
        const s = (r as { settings: { shell_env_error?: string; secret_env_names?: string[] } }).settings;
        setFailed(s.shell_env_error ?? '');
        setSecrets(s.secret_env_names ?? []);
      },
      () => {},
    );
    return () => void (live = false);
  }, [core]);
  const shown = list.join(' ');
  const keptShown = keep.join(' ');
  const left = secrets.filter((n) => !keep.includes(n));
  return (
    <Sec id="h-shell-env" title={t('userEnv.title')}>
      <Row
        label={t('field.envInheritShell')}
        desc={error ? <span role="alert" title={error}>{plainError(t, error)}</span> : t('userEnv.inheritDesc')}
        reset={<Reset t={t} label={t('field.envInheritShell')} show={!inherit} run={() => void setInherit(null)} />}
        control={<Switch label={t('field.envInheritShell')} setting="envInheritShell" checked={inherit} onChange={(v) => void setInherit(v ? null : false)} />}
      />
      {!inherit && (
        <Row
          top
          label={t('field.envNames')}
          desc={listError ? <span role="alert" title={listError}>{plainError(t, listError)}</span> : t('userEnv.namesDesc')}
          reset={<Reset t={t} label={t('field.envNames')} show={list.length > 0} run={() => void setList(null)} />}
          extra={
            <input
              {...PLAIN}
              className="search mono"
              aria-label={t('field.envNames')}
              data-setting="envNames"
              placeholder="AWS_PROFILE NODE_OPTIONS"
              value={draft ?? shown}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              onBlur={() => {
                const next = names(draft ?? shown);
                if (next.join(' ') !== shown) void setList(next.length ? next : null);
                setDraft(null);
              }}
            />
          }
        />
      )}
      <Row
        label={t('field.envStripSecrets')}
        desc={
          stripError ? (
            <span role="alert" title={stripError}>{plainError(t, stripError)}</span>
          ) : (
            <>
              {t('userEnv.stripDesc')}
              {strip && left.length > 0 && (
                <span className="mono" data-field="secret-env-names">
                  {' '}
                  {t('userEnv.leftOut', { names: left.join(', ') })}
                </span>
              )}
            </>
          )
        }
        reset={<Reset t={t} label={t('field.envStripSecrets')} show={!strip} run={() => void setStrip(null)} />}
        control={<Switch label={t('field.envStripSecrets')} setting="envStripSecrets" checked={strip} onChange={(v) => void setStrip(v ? null : false)} />}
      />
      {/* Ticket 1024 (ledger v27-a-S3-3): off, names kept earlier stay in view, greyed, so Reset can still clear them. */}
      {(strip || keep.length > 0) && (
        <Row
          top
          label={t('field.envKeepSecrets')}
          desc={keepError ? <span role="alert" title={keepError}>{plainError(t, keepError)}</span> : t('userEnv.keepDesc')}
          why={!strip && <Why id="why-env-keep" reason={t('userEnv.keepOff')} />}
          reset={<Reset t={t} label={t('field.envKeepSecrets')} show={keep.length > 0} run={() => void setKeep(null)} />}
          extra={
            <input
              {...PLAIN}
              className="search mono"
              aria-label={t('field.envKeepSecrets')}
              data-setting="envKeepSecrets"
              placeholder="ANTHROPIC_API_KEY"
              disabled={!strip}
              aria-describedby={strip ? undefined : 'why-env-keep'}
              value={keepDraft ?? keptShown}
              onChange={(e) => setKeepDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              onBlur={() => {
                const next = names(keepDraft ?? keptShown);
                if (next.join(' ') !== keptShown) void setKeep(next.length ? next : null);
                setKeepDraft(null);
              }}
            />
          }
        />
      )}
      {failed && (
        <p className="conflict" role="alert" data-field="shell-env-error">
          {t('userEnv.failed', { error: failed })}
        </p>
      )}
    </Sec>
  );
}

registerSettingsSection({
  page: 'providers',
  id: 'agents.shell-env',
  order: 20,
  // The name list shows only while the switch is off, so the switch is the one searchable field.
  fields: [
    { key: 'envInheritShell', at: '[data-setting="envInheritShell"]' },
    { key: 'envStripSecrets', at: '[data-setting="envStripSecrets"]' },
  ],
  render: ({ core, t }) => <ShellEnv core={core} t={t} />,
});
