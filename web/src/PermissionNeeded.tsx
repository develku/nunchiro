// v1a-33: the core could not open this session's folder (macOS file access for an app-started core). Like Ghostty
// and iTerm2, Nunchiro does not change the setting: it says why, opens System Settings when asked, and restarts
// the session once access is granted.
import { Fragment, useState, type ReactNode } from 'react';
import type { CoreClient } from './api';
import { useHtmlLangT } from './i18n/lib/useHtmlLangT';
import { basename } from './tree';
import type { Session } from './types';
import { docT, ErrorDetails, ErrorLine } from './errors';

type Blockable = Session & { blocked?: { reason: 'file_access'; path: string }; model?: string | null; effort?: string | null; completion_seq?: number };

/** The only URLs Open Settings opens; app/src-tauri/capabilities/default.json allows exactly these. */
export const SETTINGS_URLS = {
  files: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
} as const;

/** The same agent, folder, model and effort; the conversation resumes only when one exists: Claude gets its id at
 * launch (a never-written one fails `claude --resume`), so it resumes after a finished turn (a resumed run carries
 * the earlier runs' count); Codex reports its id once the conversation exists.
 * shortcut: a Claude conversation with a prompt but no finished turn restarts fresh (its transcript stays on disk);
 * ask the core whether the transcript exists if that case shows up. */
export function restartStart(s: Session) {
  const b = s as Blockable;
  const resume = s.agent_session_id && (s.kind === 'codex' || (b.completion_seq ?? 0) > 0) ? s.agent_session_id : null;
  // V2-2b: a fresh restart stays on the session's account (a resume keeps it in the core).
  // Ticket 991 (A1): a fresh start runs in the session's own folder (a worktree's stays in the worktree); a resume names
  // the project and the core reuses the run's folder.
  return { kind: s.kind, project: resume ? s.project : s.cwd, label: s.label, model: b.model ?? null, effort: b.effort ?? null, resume, ...(s.account ? { account: s.account } : {}) };
}

/** Restart starts again in the session's own folder: a resume (the core reuses the run's folder) or a fresh start in
 * `cwd` (ticket 991: a worktree's session used to be left out, and a shell's came back in the main checkout).
 * A shell's args are not in the snapshot, so a shell starts plain. */
export const canRestart = (s: Session) => !s.side_chat && s.kind !== 'shell';

async function openSettings(url: string) {
  if (!('__TAURI_INTERNALS__' in window)) return;
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/** A translated sentence with `{name}` slots filled by elements (bold setting names, a code path), so word order follows the language. */
const rich = (text: string, parts: Record<string, ReactNode>) => text.split(/\{(\w+)\}/).map((x, i) => (i % 2 ? <Fragment key={i}>{parts[x] ?? `{${x}}`}</Fragment> : x));

/** F15: the core's refusal of a start whose folder the agent could not enter (crates/nunchiro-core/src/sessions.rs). */
export const FILE_ACCESS = 'file_access:';
/** F15 r2: the folder's owner or mode refuses (EACCES): System Settings cannot fix it, so no Settings buttons. */
const FILE_MODE = 'file_access: no permission to read';

/** F15: a refused start in a folder Nunchiro cannot read, said where the start was asked (New session, first run), with
 * the same two System Settings panes as Permission needed; a start after the grant is the same click again. */
export function FolderAccess({ reason }: { reason: string }) {
  const t = useHtmlLangT();
  // The core says `file_access: no permission to read <folder>: <os error>` or `file_access: cannot read <folder>: <os error>`
  // (sessions.rs `refused_start`); the sentence is the window's, the core's own text stays under Details (ticket 565). A reason
  // in another shape gets the plain `own.file.unknown` and its text under Details too (ticket 601).
  const m = /^file_access: (no permission to read|cannot read) (.*?): [^:]*$/s.exec(reason);
  const said = m ? t(m[1] === 'cannot read' ? 'own.file.cannot' : 'own.file.mode', { folder: m[2] }) : t('own.file.unknown');
  const [error, setError] = useState<unknown>('');
  const open = (url: string) => (setError(''), void openSettings(url).catch(setError));
  if (reason.startsWith(FILE_MODE))
    return (
      <div className="conflict perm-needed" role="alert">
        <p>{t('rest.shell.perm.notStarted', { reason: said })}</p>
        <p>{t('rest.shell.perm.checkOwner')}</p>
        <ErrorDetails t={t} details={reason.slice(FILE_ACCESS.length).trim()} />
      </div>
    );
  return (
    <div className="conflict perm-needed" role="alert">
      <p>{t('rest.shell.perm.notStarted', { reason: said })}</p>
      <p>{rich(t('rest.shell.perm.mayNotAllow'), { volumes: <b>{t('rest.shell.perm.volumes')}</b>, fullDisk: <b>{t('rest.shell.perm.fullDisk')}</b> })}</p>
      <button className="btn p" onClick={() => open(SETTINGS_URLS.files)}>
        {t('rest.shell.perm.openSettings')}
      </button>{' '}
      <button className="btn" onClick={() => open(SETTINGS_URLS.fullDisk)}>
        {t('rest.shell.perm.openFullDisk')}
      </button>
      <ErrorLine t={docT()} error={error} className="" />
      <ErrorDetails t={t} details={reason.slice(FILE_ACCESS.length).trim()} />
    </div>
  );
}

export function PermissionNeeded({ core, session, onReplaced }: { core: CoreClient; session: Session; onReplaced: (old: string, next: Session) => void }) {
  const t = useHtmlLangT();
  const [error, setError] = useState<unknown>('');
  const [busy, setBusy] = useState(false);
  const blocked = (session as Blockable).blocked;
  if (!blocked || session.state !== 'running') return null;
  const run = async (f: () => Promise<void>) => {
    setError('');
    try {
      await f();
    } catch (e) {
      setError(e);
    }
  };
  const restart = () =>
    run(async () => {
      setBusy(true);
      try {
        // Close first: a resumed conversation cannot start while its old run is live.
        await core.request({ op: 'close', id: session.id });
        const reply = (await core.request({ op: 'start', session: restartStart(session) })) as { session?: Session };
        if (reply.session) onReplaced(session.id, reply.session);
      } finally {
        setBusy(false);
      }
    });
  return (
    <section className="perm-needed glass light-you light-edge" role="region" aria-label={t('rest.shell.perm.title')}>
      <b>{t('rest.shell.perm.title')}</b>
      <p>{rich(t('rest.shell.perm.notAllowed'), { path: <code>{blocked.path}</code> })}</p>
      <ol>
        <li>
          {rich(t('rest.shell.perm.step1'), { volumes: <b>{t('rest.shell.perm.volumes')}</b> })}{' '}
          <button className="btn p" onClick={() => void run(() => openSettings(SETTINGS_URLS.files))}>
            {t('rest.shell.perm.openSettings')}
          </button>
        </li>
        <li>
          {rich(t('rest.shell.perm.step2'), { fullDisk: <b>{t('rest.shell.perm.fullDisk')}</b> })}{' '}
          <button className="btn" onClick={() => void run(() => openSettings(SETTINGS_URLS.fullDisk))}>
            {t('rest.shell.perm.openFullDisk')}
          </button>
        </li>
        {canRestart(session) ? (
          <li>
            {t('rest.shell.perm.step3')}{' '}
            <button className="btn" disabled={busy} onClick={() => void restart()}>
              {t('shell.chrome.restartSession')}
            </button>
          </li>
        ) : (
          <li>
            {rich(t('rest.shell.perm.closeStart'), { folder: <code title={session.cwd}>{basename(session.cwd)}</code> })}
          </li>
        )}
      </ol>
      <ErrorLine t={docT()} error={error} />
    </section>
  );
}
