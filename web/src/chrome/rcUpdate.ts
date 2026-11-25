// Ticket 1082 (owner 11-23): the update item of the installed app, which updates itself from the update folder set in
// Settings > About (and the official release also from its signed feed). app/src-tauri/src/rc_update.rs does the work.
// The shell says `rcUpdates` at boot only in such a build, so in any other (the isolated test build, a dev build) this calls
// nothing and shows nothing.
import { useEffect, useState } from 'react';
import { defineSetting, useFeatureSetting } from '../settings/useFeatureSetting';
import { rawError } from '../errors';

export const rcUpdates = () => window.__NUNCHIRO__?.rcUpdates === true;

async function call<R>(command: 'rc_update_check' | 'rc_update_install' | 'update_source', args?: Record<string, unknown>): Promise<R> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<R>(command, args);
}

/** The version or commit ready to install, or null. Rejects on a failure, which the shell has already logged. */
export const checkForUpdate = () => call<string | null>('rc_update_check');

/** The update folder now set; a string sets it first (empty turns the folder off). */
export const updateSource = (folder?: string) => call<string>('update_source', { folder: folder ?? null });

const message = (e: unknown) => (rawError(e));

// The window's update item, set by useRcUpdate: a version a check the user started found shows even if Later hid it.
let showAgain: (version: string) => void = () => {};

/** A check the user started: the newer version, or null. A found version shows in the status bar again; a failure rejects
 *  with the shell's error text, for the caller to show. */
export const checkNow = () => checkForUpdate().then((v) => (v && showAgain(v), v), (e) => Promise.reject(message(e)));

// Sessions working now, kept by the status bar, for the one question before an install.
let working = 0;
export const noteWorking = (n: number) => void (working = n);

/** Install and restart. With sessions working it first asks once (`ask` is their count); `install(true)` is the answer.
 *  On success this window is replaced; a failure keeps its text so the same button reads as a retry. */
export function useInstall() {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const [ask, setAsk] = useState(0);
  // Ticket 1130 A-D3: chats or jobs the install waits for before it swaps anything (the shell's rc-update-wait).
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!rcUpdates()) return;
    let gone = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const off = await listen<number>('rc-update-wait', (e) => setWaiting(e.payload));
      if (gone) off();
      else unlisten = off;
    });
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);
  const install = (sure = false) => {
    if (!sure && working > 0) return setAsk(working);
    setAsk(0);
    setInstalling(true);
    setError('');
    call('rc_update_install').catch((e) => (setInstalling(false), setError(message(e))));
  };
  return { installing, error, ask, waiting, install, notNow: () => setAsk(0) };
}

// Ticket 377: Later stores the version it hid, per window; a newer version differs, so the item comes back for it.
const LATER = defineSetting('updates.later_version', '', (v) => (typeof v === 'string' ? v : undefined));

/** The verified version waiting for a restart (null once Later hid it), the install and Later. */
export function useRcUpdate() {
  const [version, setVersion] = useState<string | null>(null);
  const [later, setLater] = useFeatureSetting(LATER);
  const install = useInstall();
  useEffect(() => {
    if (!rcUpdates()) return;
    let gone = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const off = await listen<string>('rc-update', (e) => setVersion(e.payload));
      if (gone) off();
      else unlisten = off;
    });
    // A window opened after the last check still has to show what is ready.
    checkForUpdate().then(
      (v) => !gone && v && setVersion(v),
      () => {},
    );
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    showAgain = (v) => (setVersion(v), setLater(''));
    return () => void (showAgain = () => {});
  }, [setLater]);
  return { ...install, version: version === later ? null : version, later: () => (install.notNow(), version && setLater(version)) };
}
