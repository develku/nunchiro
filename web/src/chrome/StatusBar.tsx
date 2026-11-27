// Shell: the status bar (split out of App.tsx, needs 183).
import { useEffect, useMemo, useRef } from 'react';
import { FailedNote, plainError, type Note } from '../errors';
import type { CoreClient } from '../api';
import type { LayoutStore } from '../layout/store';
import { UndoLine } from '../undo/UndoLine';
import { AccountSwitch } from './AccountSwitch';
import { UsageBlock } from './UsageBlock';
import { MemoryWait } from './MemoryWait';
import { noteWorking, useRcUpdate } from './rcUpdate';
import { status, type Session } from '../types';
import type { T } from '../i18n';
import type { useFold } from '../layout/fold';

type Props = {
  current: Session | null;
  t: T;
  core: CoreClient;
  sessions: Session[];
  ordered: Session[];
  open: (id: string) => void;
  store: LayoutStore;
  editing: boolean;
  moved1: string;
  pane: string | null;
  paneNote: Note;
  setPaneNote: (note: Note) => void;
  fold: ReturnType<typeof useFold>;
  foldName: (k: string) => string[];
  connected: boolean;
  /** Ticket 451: opens Settings > Providers from the account switch. */
  manageAccounts: () => void;
  /** A tab in the strip and the tree without switching to it (a start that waited for memory). */
  addTab: (id: string) => void;
};

/** The window's status bar (ticket 1031): the usage block, the account switch, and what shows only when something is off: the stale count,
 *  layout file errors and notes, Undo, pane mode and fold notes, an update, a lost core connection. The session's state,
 *  branch and changes are in its header and the tree. */
export function StatusBar({ current, t, core, sessions, ordered, open, store, editing, moved1, pane, paneNote, setPaneNote, fold, foldName, connected, manageAccounts, addTab }: Props) {
  const staleCount = useMemo(() => sessions.filter((s) => status(s) === 'stale').length, [sessions]);
  const update = useRcUpdate();
  noteWorking(sessions.filter((s) => s.state === 'running' && s.attention.working).length); // ticket 1082: asked before an install
  // A note is words in the language of its moment: it goes when the language changes (q67 look: "Chat not copied…"
  // stayed English in the es, fr and ko windows).
  const lang = useRef(t);
  useEffect(() => {
    if (lang.current !== t) setPaneNote('');
    lang.current = t;
  }, [t]); // eslint-disable-line react-hooks/exhaustive-deps
  // v9-Home-S3-5: a failure about one session does not follow into another session's tab.
  useEffect(() => {
    if (typeof paneNote !== 'string' && paneNote.session && paneNote.session !== current?.id) setPaneNote('');
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <footer className="status">
      <UsageBlock t={t} core={core} connected={connected} onManage={manageAccounts} />
      {staleCount > 0 && (
        // needs 171: the count opens what it counts: the first stale session, then the next on each click (wrapping), so one control reaches them all.
        <button className="it stalebtn" data-hint-skip data-tip={t('shell.status.staleTip')} onClick={() => {
          const list = ordered.filter((s) => status(s) === 'stale'); // the tree's order
          const at = list.findIndex((s) => s.id === current?.id);
          open(list[(at + 1) % list.length].id);
        }}>
          {t('chrome.stale', { n: staleCount })}
        </button>
      )}
      {store.fileError && (
        <span className="lerr" role="alert" title={store.fileError}>
          {plainError(t, store.fileError)} {t('chrome.lastGood')}
        </span>
      )}
      {!store.fileError && store.saveError && !editing && (
        <span className="lerr" role="alert" title={store.saveError}>
          {t('chrome.notSaved', { error: plainError(t, store.saveError) })}
        </span>
      )}
      {store.notice && <span className="lnote">{store.notice}</span>}
      <MemoryWait t={t} core={core} addTab={addTab} open={open} setNote={setPaneNote} />
      <UndoLine />
      {moved1 && <span className="lnote" role="status">{moved1}</span>}
      <span className="pane-status" role="status" aria-live="polite">
        {typeof paneNote === 'string' ? paneNote || (pane ? t('chrome.paneMode') : '') : <FailedNote t={t} note={paneNote} onDismiss={() => setPaneNote('')} />}
      </span>
      {/* v1a-60 */}
      <span className="foldnote" role="status" aria-live="polite">
        {fold.folded.length > 0 && t('chrome.folded', { names: fold.folded.flatMap(foldName).join(t('chrome.listSep')) })}
      </span>
      {/* ticket 294 item 5: the permanent "answer strip removed: signals only (Layout)" notice is gone; removing the strip says so once, when it happens (App runOp). */}
      <span className="sp" />
      <AccountSwitch t={t} core={core} connected={connected} onManage={manageAccounts} current={current} onOpen={open} />
      {update.version && (
        <>
          {/* Ticket 377: one button, as T3 Code's update item; a failed install relabels it as the retry. Ticket 1082: with
              sessions working it asks once, in place: they keep running, Install or Later. */}
          {update.ask > 0 && <span className="it" role="status">{t(update.ask === 1 ? 'selfUpdate.workingOne' : 'selfUpdate.working', { n: update.ask })}</span>}
          {update.installing && update.waiting > 0 && <span className="it" role="status">{t('selfUpdate.waiting', { n: update.waiting })}</span>}
          <button className="it rcupdate" disabled={update.installing} data-version={update.version} data-tip={update.error || t('rc.update.tip')} onClick={() => update.install(update.ask > 0)}>
            {update.ask > 0 ? t('selfUpdate.yes') : update.error ? t('rc.update.failed') : t('selfUpdate.item', { version: update.version })}
          </button>
          <button className="it rclater" onClick={update.later}>
            {t('rc.update.later')}
          </button>
          <span className="sr" role="status">
            {update.error && t('rc.update.failed')}
          </span>
        </>
      )}
      {/* Connected is the normal state, so it is words for a screen reader only; a lost connection shows until it is back. */}
      <span role="status" className={connected ? 'sr' : 'it fcore'}>
        {!connected && <i className="cdot off" />}
        {t(connected ? 'chrome.connected' : 'chrome.disconnected')}
      </span>
    </footer>
  );
}
