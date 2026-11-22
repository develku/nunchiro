// "User widgets" in the widget gallery (R8 frame 5, ticket v1b-19): one card per folder under ~/.nunchiro/widgets/
// (hot-reloaded), then the dashed "Ask an agent to make one" card, which only fills the focused session's composer;
// Enter in the composer sends it, as with anything typed there. Ticket 513: every line comes from the catalogue.
import { useId, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ApprovalCore } from '../approval/types';
import { useWidgetList, userKind, type Listed } from './api';
import { clean } from './output';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import type { T } from '../i18n';
import { openSetting } from '../settings/agents/open';
import './widgets.css';

export const ASK = 'Make me a Nunchiro script widget that shows: ';
const ASK_REST =
  '\nCreate it with `nunchiro widget new <name>`, edit its widget.sh (the Widgets section of the nunchiro skill), and tell me when it is ready so I can allow it.';

/** A widget kind in the window's language: script and web are words; any other kind is the manifest's id. */
export const kindWord = (t: T, kind: string | null) => (kind === 'script' ? t('rest.widgets.kind.script') : kind === 'web' ? t('rest.widgets.kind.web') : (kind ?? ''));
/** Ticket 872: the script-widgets-off note's action: Settings › Layout, focused on the Script widgets switch. */
export const ScriptSwitch = ({ t }: { t: T }) => (
  <button type="button" className="btn wsw" onClick={() => openSetting('layout', 'scriptWidgets')}>
    {t('rest.widgets.openSetting')}
  </button>
);
const note = (t: T, w: Listed) =>
  w.error
    ? t('rest.widgets.gallery.invalid')
    : w.kind !== 'script' && w.kind !== 'web' /* v1b-22 */
      ? t('rest.widgets.gallery.later', { kind: kindWord(t, w.kind) })
      : w.state === 'approved'
        ? t('rest.widgets.gallery.allowed', { kind: kindWord(t, w.kind) })
        : w.state === 'changed'
          ? t('rest.widgets.gallery.changed')
          : t('rest.widgets.gallery.notAllowed');

export function UserWidgets({ core, onGrab, onPick }: { core: ApprovalCore; onGrab: (e: ReactPointerEvent, kind: string) => void; onPick: (kind: string) => void }) {
  const { list } = useWidgetList(core);
  const t = useHtmlLangT(); // ticket 508
  const rawId = useId();
  const [message, setMessage] = useState('');
  const ask = () => {
    const el = document.getElementById('composer') as HTMLTextAreaElement | null;
    if (!el || el.disabled) return setMessage(t('rest.widgets.gallery.noSession'));
    setMessage('');
    el.value = ASK + ASK_REST;
    el.focus();
    el.setSelectionRange(ASK.length, ASK.length);
  };
  const off = list && !list.enabled;
  // v1b-22: web widgets have their own setting.
  const webOff = !!list && !list.web_enabled && list.widgets.some((w) => w.kind === 'web');
  const offFor = (w: Listed) => (w.kind === 'web' ? !list?.web_enabled : off);
  const offNote = t('rest.widgets.scriptOffNote');
  const webOffNote = t('rest.widgets.webOffNote');
  return (
    <div className="ugal" role="group" aria-label={t('rest.widgets.gallery.title')}>
      <span className="gsl">
        {t('rest.widgets.gallery.title')} <span>· ~/.nunchiro/widgets/</span>
        {off && <span className="ugal-off"> · {offNote}</span>}
        {webOff && <span className="ugal-off"> · {t('rest.widgets.gallery.webOff', { off: webOffNote })}</span>}
        {list?.unavailable && (
          // Ticket 553: the raw reason is the line's accessible description, not only its tooltip.
          <span className="ugal-off" title={list.unavailable} aria-describedby={rawId}>
            {' '}
            · {t('rest.widgets.unavailable')}
            <span hidden id={rawId}>
              {list.unavailable}
            </span>
          </span>
        )}
        {message && (
          <span className="ugal-off" role="status">
            {' '}
            · {message}
          </span>
        )}
      </span>
      <div className="ugal-cards">
        {list?.widgets.map((w) => {
          const kind = userKind(w.name);
          const wOff = offFor(w); // v1b-22
          const status = wOff ? t('rest.widgets.gallery.off', { status: note(t, w) }) : note(t, w);
          return (
            <button
              key={w.name}
              className="wcard"
              data-card={kind}
              data-state={w.error ? 'error' : (w.state ?? '')}
              onPointerDown={(e) => onGrab(e, kind)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onPick(kind))}
              aria-label={`${t('rest.widgets.gallery.cardAria', { name: w.name, status })}${wOff ? `, ${w.kind === 'web' ? webOffNote : offNote}` : ''}`} // v1b-22: per kind
              title={w.error ? clean(w.error) : t('rest.widgets.gallery.madeBy', { name: w.name, author: w.author ?? t('rest.widgets.gallery.unknown') })}
            >
              <span className="pv" aria-hidden>
                <span className="txt">{w.state === 'approved' && !wOff /* v1b-22 */ ? t('rest.widgets.gallery.ready') : t('rest.widgets.gallery.notRun')}</span>
              </span>
              <b>
                <i aria-hidden>⟳</i>
                {w.name}
              </b>
              <span className="dim">{status}</span>
            </button>
          );
        })}
        <button className="wcard ask" data-card="ask" onClick={ask} aria-label={t('rest.widgets.gallery.askAria')}>
          <span className="pv" aria-hidden>
            <span className="txt">{t('rest.widgets.gallery.newWidget')}</span>
          </span>
          <b>
            <i aria-hidden>✦</i>
            {t('rest.widgets.gallery.askTitle')}
          </b>
          <span className="dim wrap">{t('rest.widgets.gallery.askSub')}</span>
        </button>
      </div>
    </div>
  );
}
