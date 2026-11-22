// G2 (owner 11-08, 11-21): the update item of a build that updates itself, an RC or an official release
// (app/src-tauri/src/rc_update.rs does the work). The shell says `rcUpdates` at boot only in such a build, so in any
// other this calls nothing and shows nothing.
import { useEffect, useState } from 'react';
import { defineSetting, useFeatureSetting } from '../settings/useFeatureSetting';
import { rawError } from '../errors';

export const rcUpdates = () => window.__NUNCHIRO__?.rcUpdates === true;

async function call<R>(command: 'rc_update_check' | 'rc_update_install'): Promise<R> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<R>(command);
}

/** The version ready to install, or null. Rejects on a failure, which the shell has already logged. */
export const checkForUpdate = () => call<string | null>('rc_update_check');

const message = (e: unknown) => (rawError(e));

// The window's update item, set by useRcUpdate: a version a check the user started found shows even if Later hid it.
let showAgain: (version: string) => void = () => {};

/** A check the user started: the newer version, or null. A found version shows in the status bar again; a failure rejects
 *  with the shell's error text, for the caller to show. */
export const checkNow = () => checkForUpdate().then((v) => (v && showAgain(v), v), (e) => Promise.reject(message(e)));

// Ticket 377: Later stores the version it hid, per window; a newer version differs, so the item comes back for it.
const LATER = defineSetting('updates.later_version', '', (v) => (typeof v === 'string' ? v : undefined));

/** The verified version waiting for a restart (null once Later hid it), the click that installs it, the last install
 *  error and Later. */
export function useRcUpdate() {
  const [version, setVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const [later, setLater] = useFeatureSetting(LATER);
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
  const install = () => {
    setInstalling(true);
    setError('');
    // On success this window is replaced; a failure keeps its text so the same button reads as a retry.
    call('rc_update_install').catch((e) => (setInstalling(false), setError(message(e))));
  };
  return { version: version === later ? null : version, installing, error, install, later: () => version && setLater(version) };
}
