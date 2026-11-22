// V2.5-15: what a paired browser shows: watch and answer (the owner option A). Sessions and their output, the questions
// agents are waiting on, and a reply box. No control starts, closes or configures anything; the core refuses those
// for the browser role anyway (crates/nunchiro-core/src/http/browser.rs `allowed`).
import { PLAIN } from '../plainText';
import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { CoreRefusal, type CoreClient } from '../api';
import { answerOnce, plan, summary, whoOf } from '../queue/answer';
import { setNameScope } from '../sessionNames';
import { basename } from '../tree';
import type { Decision, Session } from '../types';
import { applyBrowserLanguage, forgetToken } from './boot';
import { docT, ErrorLine, tipError } from '../errors';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import './pairing.css';

/** Read-only output: no key or terminal-query reply is ever sent from here. */
function Output({ core, id }: { core: CoreClient; id: string }) {
  const t = useHtmlLangT();
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const size = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs-13'));
    const term = new XTerm({ disableStdin: true, scrollback: 5000, ...(size ? { fontSize: size } : {}) });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el.current!);
    fit.fit();
    const resize = () => fit.fit();
    window.addEventListener('resize', resize);
    const off = core.watch(id, (o, parsed) => term.write(o.data, parsed));
    return () => {
      window.removeEventListener('resize', resize);
      off();
      term.dispose();
    };
  }, [core, id]);
  return <div className="browser-output" ref={el} aria-label={t('rest.pf.browser.output')} />;
}

function Waiting({ core, d, s }: { core: CoreClient; d: Decision; s: Session }) {
  const t = useHtmlLangT();
  const [error, setError] = useState<unknown>('');
  const p = plan(d, s, t);
  return (
    <article className="browser-card" aria-label={t('rest.pf.browser.isWaiting', { name: whoOf(s) })}>
      <b>{whoOf(s)}</b>
      <p className="browser-q">{summary(d)}</p>
      <div className="browser-acts">
        {p.acts.map((a) => (
          <button key={a.label} className="pair-btn" onClick={() => void answerOnce(d.id, () => core.answer(d.id, a.answer))?.catch(setError)}>
            {a.label}
          </button>
        ))}
      </div>
      {p.terminal.length > 0 && <p className="dim">{t('rest.pf.browser.inTerminal', { list: p.terminal.join(' · ') })}</p>}
      {p.note && <p className="dim">{p.note}</p>}
      <ErrorLine t={docT()} error={error} className="" />
    </article>
  );
}

function Reply({ core, s }: { core: CoreClient; s: Session }) {
  const t = useHtmlLangT();
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const send = async () => {
    const seen = s.pending.map((d) => d.id);
    try {
      // Text and its Enter in one write: the browser role has no raw keys (docs/design/v25-web-access.md section 5).
      await core.sendText(s.id, `${text}\r`, seen, true);
      setText('');
      setNote(t('rest.pf.browser.sent'));
    } catch (e) {
      setNote(e instanceof CoreRefusal ? t('rest.pf.browser.notSent', { reason: tipError(t, e) }) : t('rest.pf.browser.notSentOffline'));
    }
  };
  return (
    <form className="browser-reply" onSubmit={(e) => (e.preventDefault(), void send())}>
      <label>
        {t('rest.pf.browser.replyTo', { name: whoOf(s) })} <textarea {...PLAIN} value={text} rows={2} onChange={(e) => setText(e.target.value)} />
      </label>
      <button className="pair-btn primary" disabled={!text.trim()}>
        {t('rest.pf.browser.send')}
      </button>
      {note && <p role="status">{note}</p>}
    </form>
  );
}

export function BrowserApp({ core }: { core: CoreClient }) {
  useState(applyBrowserLanguage); // ticket 528: before useHtmlLangT reads <html lang>
  const t = useHtmlLangT();
  const [connected, setConnected] = useState(false);
  const [ever, setEver] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    core.onStatus = (on) => (setConnected(on), on && setEver(true));
    core.onSnapshot = (s) => setSessions(s);
    core.connect();
    return () => core.close();
  }, [core]);
  const live = sessions.filter((s) => s.state === 'running');
  setNameScope(live); // ticket 506 r3: same-name sessions are numbered here too, before a card names one
  const waiting = live.flatMap((s) => s.pending.map((d) => ({ d, s })));
  const shown = live.find((s) => s.id === open) ?? null;
  return (
    <main className="browser-app">
      <header className="browser-head">
        <b>Nunchiro</b>
        <span role="status">{t(connected ? 'rest.pf.browser.connected' : 'rest.pf.browser.reconnecting')}</span>
      </header>
      {!connected && !ever && (
        <p className="dim">
          {t('rest.pf.browser.notConnected')}{' '}
          <button className="pair-link" onClick={() => (forgetToken(), location.reload())}>
            {t('rest.pf.browser.pairAgain')}
          </button>
          {t('rest.pf.browser.notConnectedEnd')}
        </p>
      )}
      <section aria-labelledby="h-waiting">
        <h2 id="h-waiting">{t('rest.pf.browser.waitingTitle')}</h2>
        {waiting.length === 0 && <p className="dim">{t('rest.pf.browser.noneWaiting')}</p>}
        {waiting.map(({ d, s }) => (
          <Waiting key={d.id} core={core} d={d} s={s} />
        ))}
      </section>
      <section aria-labelledby="h-sessions">
        <h2 id="h-sessions">{t('rest.pf.browser.sessions')}</h2>
        {live.length === 0 && <p className="dim">{t('rest.pf.browser.noSessions')}</p>}
        <ul className="browser-sessions">
          {live.map((s) => (
            <li key={s.id}>
              <button className="browser-row" aria-pressed={s.id === open} onClick={() => setOpen(s.id === open ? null : s.id)}>
                {whoOf(s)} <span className="dim">{basename(s.project)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {shown && (
        <section aria-label={t('rest.pf.browser.session', { name: whoOf(shown) })}>
          <Output key={shown.id} core={core} id={shown.id} />
          <Reply core={core} s={shown} />
        </section>
      )}
    </main>
  );
}
