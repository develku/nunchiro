// Ticket 375: the editor Open in editor uses (a project row, a worktree or session row, a terminal path). A core value,
// `features` key `editor.app`, read by crates/nunchiro-core/src/projects/mod.rs before the older `editor-app` file. The
// list is the known editors the core finds installed (`editor_apps`), plus the system default. Remembered choice, else
// the default, after T3 Code's editorPreferences.ts (behaviour only; no code taken).
import { useEffect, useState } from 'react';
import type { CoreClient } from '../api';
import { plainError } from '../errors';
import type { T } from '../i18n';
import { Reset, Row, Sec, Select } from '../settings/shell/Row';
import { useCoreFeature } from '../settings/useFeatureSetting';
import { registerSettingsSection } from './registry';

function EditorRow({ core, t }: { core: CoreClient; t: T }) {
  const [app, set, error] = useCoreFeature('editor.app', '');
  const [apps, setApps] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    core.request({ op: 'editor_apps' }).then(
      (r) => live && setApps((r as { apps?: string[] }).apps ?? []),
      () => {},
    );
    return () => void (live = false);
  }, [core]);
  const label = t('field.editorApp');
  // A chosen app that is no longer installed stays listed, so the select shows what is stored.
  const shown = app && !apps.includes(app) ? [...apps, app] : apps;
  return (
    <Sec label={label}>
      <Row
        setting="editorApp"
        label={label}
        desc={error ? <span role="alert" title={error}>{plainError(t, error)}</span> : t('files.editorDesc')}
        reset={<Reset t={t} label={label} show={app !== ''} run={() => void set(null)} />}
        control={
          <Select value={app} label={label} onChange={(v) => void set(v || null)}>
            <option value="">{t('files.editorDefault')}</option>
            {shown.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        }
      />
    </Sec>
  );
}

registerSettingsSection({ page: 'general', id: 'editor.app', order: 20, fields: [{ key: 'editorApp', at: '[data-row="editorApp"] select' }], render: ({ core, t }) => <EditorRow core={core} t={t} /> });
