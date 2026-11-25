// Settings › Git & Worktrees (UXFIX (e); v25f F7): the final draft's Connected services, Repository and Worktrees cards
// (docs/design/settings-1103/final.html F.providers, F.prRow, F.repoNew, F.wtRows), in its row order.
// Folder + Browse after Orca WorkspaceDirectorySetting.tsx, prefix after Orca GitPane.tsx (MIT; idea only, no code taken).
import { PLAIN } from '../../plainText';
import { useEffect, useState } from 'react';
import type { CoreClient } from '../../api';
import { around, type T } from '../../i18n';
import { KeyChip } from '../../KeyChip';
import { merge, type Bindings } from '../../keys';
import { pickFolder } from '../../pickFolder';
import { openExternal } from '../../sandbox/link';
import { LivePrStatus } from '../lifetime/LivePrStatus';
import { PageActions, PageSummary } from '../shell/PageActions';
import { Reset, Row, Sec, Switch } from '../shell/Row';
import { ErrorLine, rawError } from '../../errors';
import { useCoreFeature } from '../useFeatureSetting';
import { RefreshIcon } from './logos';
import { installUrl, Providers, useProviders, type Verb } from './Providers';

type Reply = { settings: { auto_clean_worktrees?: boolean; worktrees_dir?: string | null } };

export function GitPage({ core, t, bindings }: { core: CoreClient; t: T; bindings: Bindings }) {
  const key = merge(bindings)['worktree.create']?.[0];
  const { rows, error, setError, scanning, scan } = useProviders(core);
  const [ask, setAsk] = useState<Verb | null>(null); // a sign-in or sign-out press waits for its yes (Providers)
  // Ticket 475: Live PR status reads PRs through gh, so the Connected services probe is its reason and fix.
  const gh = rows?.find((r) => r.id === 'github');
  const ghWhy = gh && gh.state !== 'signed_in' ? { state: gh.state, install: () => void openExternal(installUrl('github')!), signIn: () => setAsk({ login: 'github' }) } : null;
  return (
    <>
      <PageActions>
        <button type="button" className="btn withicon" disabled={scanning} onClick={() => void scan()}>
          <RefreshIcon />
          {t('git.rescan')}
        </button>
      </PageActions>
      <PageSummary parts={[[t('summary.services'), rows && t('summary.of', { n: rows.filter((r) => r.state === 'signed_in').length, all: rows.length })]]} />
      <Providers core={core} t={t} rows={rows} error={error} setError={setError} retry={() => void scan()} ask={ask} setAsk={setAsk} />
      <Sec id="h-git" title={t('settings.section.repo')} className="git-block">
        <LivePrStatus t={t} core={core} gh={ghWhy} />
        <AutoPull t={t} />
        <BranchPrefix t={t} />
      </Sec>
      <Sec id="h-worktrees" title={t('settings.section.worktrees')}>
        <AutoClean core={core} t={t} />
        <WorktreeRoot core={core} t={t} />
        <Row label={t('git.newWt')} desc={t('git.newWtDesc')} control={<span className="keys">{key ? <KeyChip binding={key} bindings={bindings} /> : t('git.noKey')}</span>} />
      </Sec>
    </>
  );
}

const Err = ({ t, error, retry }: { t: T; error: string; retry?: () => void }) => <ErrorLine t={t} error={error} retry={retry} className="err" />;

/** V2-8a: off by default; stored in the core's settings.json (the core removes, not this window). */
function AutoClean({ core, t }: { core: CoreClient; t: T }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const take = (r: unknown) => setOn(!!(r as Reply).settings.auto_clean_worktrees);
  const load = () => void core.request({ op: 'quit_settings' }).then((r) => (take(r), setError('')), (e: Error) => setError(rawError(e)));
  useEffect(load, [core]);
  const set = (v: boolean) => core.request({ op: 'quit_settings', patch: { auto_clean_worktrees: v } }).then((r) => (take(r), setError('')), (e: Error) => setError(rawError(e)));
  return (
    <Row
      className="autoclean"
      label={t('settings.row.autoClean')}
      desc={t('settings.row.autoCleanDesc')}
      reset={<Reset t={t} label={t('settings.row.autoClean')} show={on === true} run={() => void set(false)} />}
      extra={<Err t={t} error={error} retry={on === null ? load : undefined} />}
      // Drawn once the core answered, so the settings search focuses a live box.
      control={on !== null ? <Switch setting="autoCleanWorktrees" label={t('settings.row.autoClean')} checked={on} onChange={(v) => void set(v)} /> : null}
    />
  );
}

/** Ticket 335: off by default; the core's auto_pull.rs reads it. */
function AutoPull({ t }: { t: T }) {
  const [on, set, error, retry] = useCoreFeature<boolean>('git.auto_pull', false);
  return <Row label={t('git.autoPull')} desc={t('git.autoPullDesc')} reset={<Reset t={t} label={t('git.autoPull')} show={on} run={() => void set(null)} />} extra={<Err t={t} error={error} retry={retry} />} control={<Switch setting="autoPull" label={t('git.autoPull')} checked={on} onChange={(v) => void set(v || null)} />} />;
}

/** Ticket 378, after Orca's branch-prefix.ts (normalizeBranchPrefix, getBranchPrefixIssue; MIT License, Copyright (c) 2026
 *  Lovecast Inc.; behaviour only, no code taken): slashes at either end are dropped; what `git check-ref-format` refuses
 *  in a branch name is refused here early (the core still checks at create). */
const cleanPrefix = (v: string) => v.replace(/^\/+|\/+$/g, '');
// eslint-disable-next-line no-control-regex
const BAD_REF = /[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|(^|\/)\.|\.lock(\/|$)|\.$/;

/** v25f: the core puts it before a branch it names at create (worktree_clean::from_text); empty adds none. */
function BranchPrefix({ t }: { t: T }) {
  const [prefix, set, error, retry] = useCoreFeature<string>('git.branch_prefix', '');
  // Ticket 378: the line under the row answers while typing. The typed text stays as typed; the example shows what a
  // branch would be (the core drops slashes at either end and joins with one), and a prefix git would refuse is not saved.
  const [draft, setDraft] = useState<string | null>(null);
  const typed = (draft ?? prefix).trim();
  const clean = cleanPrefix(typed);
  const bad = BAD_REF.test(clean);
  // The example branch is a name, the same in every language: shown as code (settings_korean_has_no_english_text).
  const branch = `${clean ? `${clean}/` : ''}add-search`;
  const [before, after] = around(t, 'gitRows.prefixExample', 'branch', branch);
  const example = (
    <>
      {before}
      <code>{branch}</code>
      {after}
    </>
  );
  const save = () => {
    if (!bad && typed !== prefix) void set(typed || null);
    if (!bad) setDraft(null);
  };
  return (
    <Row
      label={t('git.prefix')}
      desc={t('git.prefixDesc')}
      reset={<Reset t={t} label={t('git.prefix')} show={prefix !== ''} run={() => void set(null).then(() => setDraft(null))} />}
      extra={
        <>
          <div className="sds" role={bad ? 'alert' : 'status'} data-field="prefix-example">
            {bad ? t('gitRows.prefixBad') : example}
          </div>
          <Err t={t} error={error} retry={retry} />
        </>
      }
      control={
        <input {...PLAIN}
          className="sinp mono"
          data-setting="branchPrefix"
          aria-label={t('git.prefix')}
          aria-invalid={bad}
          placeholder="nunchiro/"
          spellCheck={false}
          value={draft ?? prefix}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      }
    />
  );
}

/** v25f: `worktrees_dir`, relative to the repository or absolute; the core refuses an odd one and says why. Also on
 *  Onboarding (ticket 378). */
export function WorktreeRoot({ core, t }: { core: CoreClient; t: T }) {
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState('');
  const take = (r: unknown) => setDir((r as Reply).settings.worktrees_dir ?? '');
  const load = () => void core.request({ op: 'quit_settings' }).then((r) => (take(r), setError('')), (e: Error) => setError(rawError(e)));
  useEffect(load, [core]);
  const save = (v: string) =>
    v.trim() === dir
      ? setError('')
      : core.request({ op: 'quit_settings', patch: { worktrees_dir: v.trim() } }).then((r) => (take(r), setError('')), (e: Error) => setError(rawError(e)));
  const browse = () => pickFolder().then((p) => p && save(p), (e: Error) => setError(rawError(e)));
  return (
    <Row
      className="git-root"
      label={t('git.root')}
      desc={t('git.rootDesc')}
      // Empty is the default: ~/nunchiro/worktrees (ticket 1083).
      reset={<Reset t={t} label={t('git.root')} show={!!dir} run={() => void save('')} />}
      extra={<Err t={t} error={error} retry={dir === null ? load : undefined} />}
      control={
        dir !== null && (
          <>
            <input {...PLAIN}
              className="sinp mono"
              data-setting="worktreeRoot"
              aria-label={t('git.root')}
              aria-invalid={!!error}
              title={dir || undefined} // the field cuts a long path; this is all of it
              placeholder="~/nunchiro/worktrees"
              spellCheck={false}
              defaultValue={dir}
              key={dir}
              onBlur={(e) => void save(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            <button type="button" className="btn flat" onClick={() => void browse()}>
              {t('git.browse')}
            </button>
          </>
        )
      }
    />
  );
}
