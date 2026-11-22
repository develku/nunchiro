// Ticket 259 (G21; needs 197), ticket 1040: Settings › Projects › a project › Worktrees. Per project: the owner's setup and cleanup
// scripts, what a repo's own `orca.yaml` setup script does (Ask / Run when approved / Skip) and whether start-an-agent
// waits for setup. Values are the core's (`features` key `worktree.scripts`: project path -> Scripts), read by
// crates/nunchiro-core/src/worktree_setup.rs, which runs every script in a visible tab of the worktree.
// Rows after Orca's RepositoryHooksSection.tsx and RepositoryHookPolicySettings.tsx (a script box per hook, the setup
// policy as a segmented choice, the agent-startup switch), MIT License, Copyright (c) 2026 Lovecast Inc., and T3 Code's
// ProjectActionsSettings.tsx (per-project commands), MIT License, Copyright (c) 2026 T3 Tools Inc.; shape only, no code
// fit (theirs are Radix and Electron components).
import { PLAIN } from '../plainText';
import { useState } from 'react';
import { ErrorLine } from '../errors';
import type { T } from '../i18n';
import { Reset, Row, Seg, Switch } from '../settings/shell/Row';
import { useCoreFeature } from '../settings/useFeatureSetting';

export type Policy = 'ask' | 'run_when_approved' | 'skip';
export type Scripts = { setup: string; cleanup: string; policy: Policy; wait: boolean };
export const KEY = 'worktree.scripts';
const BLANK: Scripts = { setup: '', cleanup: '', policy: 'ask', wait: false };
const blank = (s: Scripts) => !s.setup.trim() && !s.cleanup.trim() && s.policy === 'ask' && !s.wait;

/** A script box: saved when it loses focus, so each keystroke is not a core write. */
function Script({ setting, label, value, placeholder, onSave }: { setting: string; label: string; value: string; placeholder?: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <textarea {...PLAIN}
      className="search mono"
      rows={2}
      spellCheck={false}
      autoComplete="off"
      aria-label={label}
      placeholder={placeholder}
      data-setting={setting}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onSave(draft);
        setDraft(null);
      }}
    />
  );
}

/** Ticket 1040: the rows of the open project's page (features/projects.tsx); the project select of ticket 259 is gone. */
export function SetupScripts({ t, project }: { t: T; project: string }) {
  const [map, set, error, retry] = useCoreFeature<Record<string, Partial<Scripts>>>(KEY, {});
  const v: Scripts = { ...BLANK, ...(map[project] ?? {}) };
  const save = (patch: Partial<Scripts>) => {
    const next = { ...v, ...patch };
    const rest = { ...map };
    if (blank(next)) delete rest[project];
    else rest[project] = next;
    void set(Object.keys(rest).length ? rest : null);
  };
  return (
    <>
      <Row
        top
        setting="worktree.scripts.setup"
        label={t('field.setupScript')}
        desc={t('setupScripts.setupDesc')}
        reset={<Reset t={t} label={t('field.setupScript')} show={!!v.setup} run={() => save({ setup: '' })} />}
        extra={
          <>
            <ErrorLine t={t} error={error} retry={retry} className="err" />
            <Script key={`s-${project}`} setting="setupScript" label={t('field.setupScript')} value={v.setup} onSave={(setup) => save({ setup })} />
          </>
        }
      />
      <Row
        top
        setting="worktree.scripts.cleanup"
        label={t('field.cleanupScript')}
        desc={t('setupScripts.cleanupDesc')}
        reset={<Reset t={t} label={t('field.cleanupScript')} show={!!v.cleanup} run={() => save({ cleanup: '' })} />}
        extra={<Script key={`c-${project}`} setting="cleanupScript" label={t('field.cleanupScript')} placeholder={t('projectsPage.noCleanup')} value={v.cleanup} onSave={(cleanup) => save({ cleanup })} />}
      />
      <Row
        setting="worktree.scripts.policy"
        label={t('field.setupPolicy')}
        desc={t('setupScripts.policyDesc')}
        reset={<Reset t={t} label={t('field.setupPolicy')} show={v.policy !== 'ask'} run={() => save({ policy: 'ask' })} />}
        control={
          <Seg
            name="setup-policy"
            label={t('field.setupPolicy')}
            setting="setupPolicy"
            value={v.policy}
            onChange={(policy) => save({ policy })}
            options={[
              ['ask', t('setupScripts.ask')],
              ['run_when_approved', t('setupScripts.approved')],
              ['skip', t('setupScripts.skip')],
            ]}
          />
        }
      />
      <Row
        setting="worktree.scripts.wait"
        label={t('field.setupWait')}
        desc={t('setupScripts.waitDesc')}
        reset={<Reset t={t} label={t('field.setupWait')} show={v.wait} run={() => save({ wait: false })} />}
        control={<Switch label={t('field.setupWait')} setting="setupWait" checked={v.wait} onChange={(wait) => save({ wait })} />}
      />
    </>
  );
}
