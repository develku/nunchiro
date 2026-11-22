// Ticket 253 (G22; needs 197), ticket 1040: Settings › Projects › a project › Worktrees. Per project: the paths a new worktree gets
// from the project root, each Link (the default: a secret then has one copy) or Copy, and an optional sparse checkout
// preset. Values are the core's (`features` key `worktree.shared`: project path -> { files, sparse }), checked when saved
// and applied at create by crates/nunchiro-core/src/worktree_shared.rs.
// Rows after Orca's WorktreeSymlinksSection.tsx (a path list with add and remove) and SparsePresetSettingsSection.tsx
// (folders per preset), MIT License, Copyright (c) 2026 Lovecast Inc.; shape only, no code fit (theirs are Radix
// popovers and a preset library).
import { PLAIN } from '../plainText';
import { useState } from 'react';
import { ErrorLine } from '../errors';
import type { T } from '../i18n';
import { Reset, Row, Seg } from '../settings/shell/Row';
import { useCoreFeature } from '../settings/useFeatureSetting';
import './wt-files.css';

export type Mode = 'link' | 'copy';
export type Shared = { files: { path: string; mode: Mode }[]; sparse: string[] };
export const KEY = 'worktree.shared';
const MAX = 32; // the core's per-project limit

/** Ticket 1040: the rows of the open project's page (features/projects.tsx); the project select of ticket 253 is gone. */
export function SharedFiles({ t, project }: { t: T; project: string }) {
  const [map, set, error, retry] = useCoreFeature<Record<string, Partial<Shared>>>(KEY, {});
  const [draft, setDraft] = useState('');
  const [sparse, setSparse] = useState<string | null>(null);
  const v: Shared = { files: map[project]?.files ?? [], sparse: map[project]?.sparse ?? [] };
  const save = (next: Shared) => {
    const rest = { ...map };
    if (!next.files.length && !next.sparse.length) delete rest[project];
    else rest[project] = next;
    return set(Object.keys(rest).length ? rest : null);
  };
  const add = () => {
    const path = draft.trim();
    if (!path || v.files.some((f) => f.path === path)) return setDraft('');
    void save({ ...v, files: [...v.files, { path, mode: 'link' }] }).then((ok) => ok && setDraft(''));
  };
  const sparseText = v.sparse.join('\n');
  return (
    <>
      <Row
        top
        setting="worktree.shared.files"
        label={t('field.sharedFiles')}
        desc={t('wtFiles.filesDesc')}
        reset={<Reset t={t} label={t('field.sharedFiles')} show={v.files.length > 0} run={() => void save({ ...v, files: [] })} />}
        extra={
          <>
            <ErrorLine t={t} error={error} retry={retry} className="err" />
            {!v.files.length && <p className="dim">{t('wtFiles.none')}</p>}
            <ul className="wtfiles" aria-label={t('field.sharedFiles')}>
              {v.files.map((f) => (
                <li key={f.path} data-path={f.path}>
                  <span className="mono">{f.path}</span>
                  <Seg
                    name={`shared-mode-${f.path}`}
                    label={t('wtFiles.mode', { path: f.path })}
                    value={f.mode}
                    onChange={(mode) => void save({ ...v, files: v.files.map((x) => (x.path === f.path ? { ...x, mode } : x)) })}
                    options={[
                      ['link', t('wtFiles.link')],
                      ['copy', t('wtFiles.copy')],
                    ]}
                  />
                  <button type="button" className="btn" aria-label={t('wtFiles.remove', { path: f.path })} onClick={() => void save({ ...v, files: v.files.filter((x) => x.path !== f.path) })}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
            {v.files.length < MAX && (
              <form
                className="wtfiles-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
              >
                <input {...PLAIN} className="search mono" aria-label={t('wtFiles.addLabel')} placeholder=".env" spellCheck={false} autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} />
                <button type="submit" className="btn" disabled={!draft.trim()} data-idle={!draft.trim() || undefined}>
                  {t('wtFiles.add')}
                </button>
              </form>
            )}
          </>
        }
      />
      <Row
        top
        setting="worktree.shared.sparse"
        label={t('field.sparsePreset')}
        desc={t('wtFiles.sparseDesc')}
        reset={<Reset t={t} label={t('field.sparsePreset')} show={v.sparse.length > 0} run={() => void save({ ...v, sparse: [] })} />}
        extra={
          // Saved when it loses focus, so each keystroke is not a core write.
          <textarea
            {...PLAIN}
            key={`sp-${project}`}
            className="search mono"
            rows={2}
            spellCheck={false}
            autoComplete="off"
            aria-label={t('field.sparsePreset')}
            value={sparse ?? sparseText}
            onChange={(e) => setSparse(e.target.value)}
            onBlur={() => {
              const folders = (sparse ?? sparseText).split('\n').map((l) => l.trim()).filter(Boolean);
              if (sparse !== null && folders.join('\n') !== sparseText) void save({ ...v, sparse: folders });
              setSparse(null);
            }}
          />
        }
      />
    </>
  );
}
