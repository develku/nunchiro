// V2.5-21 (WP3): who drives this space's browser. The owner's own click or key in the page hands it to him (the app flips it,
// control.rs); the toolbar then offers Hand back (ticket 997 L7), which is window chrome no agent verb can press (threat model A11).
import { useEffect, useState } from 'react';
import type { T } from '../../../i18n';
import { invoke, listen } from './bridge';
import { inApp } from '../view/bridge';
import { BIcon } from '../view/icons';
import './control.css';

export type State = { space: string; user: boolean; reason: string | null };

/** Ticket 264 (A3): the site this space is signed in to, from the profile's jar. A line of its own: beside the control chip it
 *  leaves a narrow pane no room for the address bar. */
export function SignedInChip({ space, tab = 1, url, loading, t }: { space: string; tab?: number; url: string; loading: boolean; t: T }) {
  const [site, setSite] = useState<string | null>(null);
  useEffect(() => {
    if (loading) return; // read when a page has landed: its sign-in cookies are set by then
    let on = true;
    void invoke<string | null>('browser_signed_in', tab > 1 ? { space, tab } : { space })
      .then((s) => on && setSite(s ?? null))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [space, tab, url, loading]);
  return site ? (
    <div className="bsigned">
      <span className="bctl" title={t('bprofiles.signedInTip')}>
        {t('bprofiles.signedIn', { site })}
      </span>
    </div>
  ) : null;
}

/** Who drives `space`'s browser, as the app says (`browser-control`), read once subscribed so a flip between the two is not missed. */
export function useControl(space: string): State {
  const [state, setState] = useState<State>({ space, user: false, reason: null });
  useEffect(() => {
    if (!inApp()) return; // outside the app nobody drives, and the Tauri bridge must not load
    let on = true;
    const off = listen<State>('browser-control', (s) => s.space === space && setState(s)).catch(() => () => {});
    void off
      .then(() => invoke<State>('browser_control', { space }))
      .then((s) => on && s && setState(s))
      .catch(() => {});
    return () => {
      on = false;
      void off.then((f) => f()).catch(() => {});
    };
  }, [space]);
  return state;
}

/** Ticket 997 L7: while the owner has the space, one orange "You have control · Hand back" button in the toolbar row (the words
 *  drop at widget width, browser-view.css). `back` runs after the app has the space back (the pane's own width returns). */
export function HandBack({ space, state, back, t }: { space: string; state: State; back: () => void; t: T }) {
  if (!state.user) return null;
  const said = state.reason ? t('browserPane.youControlWhy', { reason: state.reason }) : t('browserPane.youControl');
  const handBack = () => void invoke('browser_hand_back', { space }).then(back, () => {});
  return (
    <button type="button" className="bhb" aria-label={`${said} · ${t('browserPane.handBack')}`} data-tip={`${said}. ${t('browserPane.handBackTip')}`} onClick={handBack}>
      <span className="bhb-said">
        <i className="bsdot you" />
        <span>{said}</span>
        <i className="bhb-sep" />
      </span>
      <BIcon name="handBack" />
      <span className="bhb-word">{t('browserPane.handBack')}</span>
    </button>
  );
}
