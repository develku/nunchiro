// V2.5-8/9 (needs 132): the PR view the chip opens (summary, timeline, changed code, reviewers, labels), the PRs tab
// sorted by merge readiness, and merge behind a confirm step. Everything comes from the core, which runs the user's
// own gh; titles, bodies and comments are outside text and render as text only.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { CoreClient, type PrItem, type PrView as View } from '../api';
import { tEn, type Key, type T } from '../i18n';
import { openExternal } from '../sandbox/link';
import { byReadiness, tier } from './readiness';
import { STRIP_CREDITS } from '../features/small-rows-values'; // ticket 270 G34
import { buildFixBrokenChecksPrompt } from './fixPrompt'; // ticket 373
import { ErrorLine, rawError } from '../errors';

/** Ticket 373: the session the view was opened from; Fix with agent asks its agent. */
export type PrFrom = { id: string; shell: boolean };

type Core = Pick<CoreClient, 'prView' | 'prList' | 'prMerge' | 'prLive' | 'request'>;
type Method = 'merge' | 'squash' | 'rebase';
const METHODS: Method[] = ['squash', 'merge', 'rebase'];
const OFF = 'off:';

function Off({ core, onOn, t }: { core: Core; onOn: () => void; t: T }) {
  return (
    <p className="pr-off">
      {t('pr.off')}{' '}
      <button className="btn p" onClick={() => void core.prLive({ op: 'pr_live_set', on: true, offered: true }).then(onOn, () => {})}>
        {t('pr.turnOn')}
      </button>
    </p>
  );
}

/** G34 (ticket 270): the PR view's note under the method picker while the setting is on: rebase cannot rewrite commits. */
function RebaseNote({ core, t }: { core: Pick<CoreClient, 'request'>; t: T }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    core.request({ op: 'quit_settings' }).then(
      (r) => live && setOn((r as { settings?: { features?: Record<string, unknown> } }).settings?.features?.[STRIP_CREDITS] === true),
      () => {},
    );
    return () => void (live = false);
  }, [core]);
  // Own line in .pr-merge's wrapping row, under the method picker (pr.css is outside this ticket's files).
  return on ? (
    <p className="pr-rebase-note" style={{ flexBasis: '100%', margin: 0, color: 'var(--muted)', fontSize: 'var(--fs-12)' }}>
      {t('smallRows.rebaseNote')}
    </p>
  ) : null;
}

/** The confirm step: nothing reaches the core until "Merge now", which sends the head commit shown here. */
function Merge({ core, view, onMerged, t }: { core: Core; view: View; onMerged: () => void; t: T }) {
  const [method, setMethod] = useState<Method>('squash');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Ticket 373 (owner 11-10): a PR only found by branch gets no Merge; the core refuses its merge too.
  if (view.state !== 'OPEN' || view.merge === false) return null;
  const go = () => {
    setBusy(true);
    setError('');
    core.prMerge(view.url, method, view.head).then(
      () => {
        setBusy(false);
        setAsking(false);
        onMerged();
      },
      (e: Error) => {
        setBusy(false);
        setError(rawError(e));
      },
    );
  };
  return (
    <div className="pr-merge">
      {!asking ? (
        <>
          <select aria-label={t('pr.methodLabel')} value={method} onChange={(e) => setMethod(e.target.value as Method)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`pr.method.${m}` as Key)}
              </option>
            ))}
          </select>
          <button className="btn p" disabled={view.draft} onClick={() => setAsking(true)}>
            {t('pr.merge')}
          </button>
          <RebaseNote core={core} t={t} />
        </>
      ) : (
        <div className="pr-confirm" role="alertdialog" aria-label={t('pr.merge')}>
          <p>{t('pr.confirmText', { n: view.number, base: view.base_ref, method: t(`pr.method.${method}` as Key), head: view.head.slice(0, 7) })}</p>
          <button className="btn p" disabled={busy} onClick={go}>
            {busy ? t('pr.merging') : t('pr.confirm')}
          </button>{' '}
          <button className="btn" disabled={busy} onClick={() => setAsking(false)}>
            {t('pr.cancel')}
          </button>
        </div>
      )}
      <ErrorLine t={t} error={error} className="" />
    </div>
  );
}

/** Ticket 373: the failing checks by name, each with its link, and Fix with agent, which sends the ported Orca prompt
 * to the session's agent and nothing else; with no session, or a shell, it is off with the reason. */
function Failing({ core, view, from, onSent, t }: { core: Core; view: View; from?: PrFrom; onSent: () => void; t: T }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const failed = view.failed ?? [];
  if (view.state !== 'OPEN' || !failed.length) return null;
  const can = !!from && !from.shell;
  const fix = () => {
    if (!from || from.shell || busy) return;
    setBusy(true);
    setError('');
    const text = buildFixBrokenChecksPrompt({ number: view.number, title: view.title, url: view.url, failed });
    core.request({ op: 'agent_prompt', id: from.id, text }).then(
      () => (setBusy(false), onSent()),
      (e: Error) => (setBusy(false), setError(rawError(e))),
    );
  };
  return (
    <div className="pr-failed" aria-label={t('prChecks.failed', { n: failed.length })} style={{ margin: '10px 0' }}>
      <p style={{ fontSize: 'var(--fs-12)', fontWeight: 600, margin: 0 }}>{t('prChecks.failed', { n: failed.length })}</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
        {failed.map((c, i) => (
          <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', fontSize: 'var(--fs-13)' }}>
            <span className="bad" aria-hidden>
              ×
            </span>
            <span>{c.name}</span>
            {c.url && (
              <a href={c.url} style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)', color: 'var(--link-text)' }} onClick={(e) => (e.preventDefault(), void openExternal(c.url))}>
                {t('prChecks.details')}
              </a>
            )}
          </li>
        ))}
      </ul>
      <button className={can ? 'btn p' : 'btn'} aria-disabled={can && !busy ? undefined : 'true'} data-tip={can ? undefined : t('prChecks.needSession')} onClick={fix}>
        {t('prChecks.fix')}
      </button>
      <ErrorLine t={t} error={error} className="" />
    </div>
  );
}

function Detail({ core, view, from, onMerged, onSent, t }: { core: Core; view: View; from?: PrFrom; onMerged: () => void; onSent: () => void; t: T }) {
  const reviewKey = `pr.review.${view.review}` as Key;
  return (
    <div className="pr-detail">
      <section aria-label={t('pr.summary')}>
        <h3>
          {view.title} <span className="dim">#{view.number}</span>
        </h3>
        <p className="pr-facts">
          <b data-state={view.state}>{view.draft ? t('pr.draft') : t(`pr.state.${view.state}` as Key)}</b>
          <span data-checks={view.checks}>{t(`pr.checks.${view.checks}` as Key)}</span>
          {view.review && <span>{t(reviewKey)}</span>}
          {view.mergeable === 'CONFLICTING' && <span className="bad">{t('pr.conflict')}</span>}
          <span className="mono">
            +{view.additions} −{view.deletions}
          </span>
        </p>
        <p className="dim">{t('pr.by', { who: view.author, head: view.head_ref, base: view.base_ref })}</p>
        {view.body && <pre className="pr-body">{view.body}</pre>}
        <Failing core={core} view={view} from={from} onSent={onSent} t={t} />
        <p>
          <button className="btn" onClick={() => void openExternal(view.url)}>
            {t('pr.github')}
          </button>
        </p>
        <Merge core={core} view={view} onMerged={onMerged} t={t} />
      </section>
      <section aria-label={t('pr.labels')}>
        <h4>{t('pr.labels')}</h4>
        <p>{view.labels.length ? view.labels.map((l) => <span key={l} className="pr-label">{l}</span>) : <span className="dim">{t('pr.none')}</span>}</p>
      </section>
      <section aria-label={t('pr.reviewers')}>
        <h4>{t('pr.reviewers')}</h4>
        {view.reviewers.length ? (
          <ul>
            {view.reviewers.map((r) => (
              <li key={r.who}>
                {r.who} <span className="dim">{r.state === 'requested' ? t('pr.requested') : r.state in { APPROVED: 1, CHANGES_REQUESTED: 1 } ? t(`pr.review.${r.state}` as Key) : r.state.toLowerCase()}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dim">{t('pr.none')}</p>
        )}
      </section>
      <section aria-label={t('pr.timeline')}>
        <h4>{t('pr.timeline')}</h4>
        <ol className="pr-timeline">
          {view.timeline.map((e, i) => (
            <li key={i} data-kind={e.kind}>
              <span className="dim mono">{e.at.slice(0, 16).replace('T', ' ')}</span> <b>{e.who}</b> {t(`pr.ev.${e.kind}` as Key)}
              {e.kind === 'review' && e.state ? ` (${e.state.toLowerCase()})` : ''}
              {e.text && <div className="pr-text">{e.text}</div>}
            </li>
          ))}
        </ol>
      </section>
      <section aria-label={t('pr.changes')}>
        <h4>{t('pr.changes')}</h4>
        <ul className="pr-files mono">
          {view.files.map((f) => (
            <li key={f.path}>
              {f.path} <span className="ok">+{f.additions}</span> <span className="bad">−{f.deletions}</span>
            </li>
          ))}
        </ul>
        <pre className="pr-diff mono">
          {view.diff.split('\n').map((l, i) => (
            <div key={i} data-line={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : undefined}>
              {l || ' '}
            </div>
          ))}
        </pre>
        {view.diff_cut && <p className="dim">{t('pr.diffCut')}</p>}
      </section>
    </div>
  );
}

function List({ core, onOpen, t }: { core: Core; onOpen: (url: string) => void; t: T }) {
  const [rows, setRows] = useState<PrItem[] | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState(''); // the core's hint (gh missing, no remote): its own words, not a failure
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setRows(null);
    core.prList().then(
      (r) => alive && (setRows(byReadiness(r.prs)), setError(''), setHint(r.hint ?? '')),
      (e: Error) => alive && setError(rawError(e)),
    );
    return () => {
      alive = false;
    };
  }, [core, n]);
  if (error.startsWith(OFF)) return <Off core={core} onOn={() => setN(n + 1)} t={t} />;
  return (
    <div className="pr-list">
      {hint && <p role="alert">{hint}</p>}
      <ErrorLine t={t} error={error} className="" />
      {!rows && !error && <p className="dim">{t('pr.loading')}</p>}
      {rows?.length === 0 && <p className="dim">{t('pr.listEmpty')}</p>}
      {rows && rows.length > 0 && (
        <ul>
          {rows.map((p) => (
            <li key={p.url} data-tier={tier(p)}>
              <button className="pr-row" onClick={() => onOpen(p.url)}>
                <span className="pr-tier">{t(`pr.tier.${tier(p)}` as Key)}</span>
                <span className="pr-rtitle">{p.title}</span>
                <span className="dim">
                  {p.repo}#{p.number} · {p.author}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The dialog: `url` is the chip's PR, already checked by `pullUrl`; with none it opens on the list (ticket 373).
 * `from` is the session it was opened from, for Fix with agent. */
export function PrView({ url, from, onClose, core = CoreClient.main ?? undefined, t = tEn }: { url?: string; from?: PrFrom; onClose: () => void; core?: Core; t?: T }) {
  const [tab, setTab] = useState<'this' | 'list'>(url ? 'this' : 'list');
  const [shown, setShown] = useState(url);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!core || !shown) return;
    let alive = true;
    setView(null);
    setError('');
    core.prView(shown).then(
      (v) => alive && setView(v),
      (e: Error) => alive && setError(rawError(e)),
    );
    return () => {
      alive = false;
    };
  }, [core, shown, n]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  if (!core) return null;
  const box = (
    <div className="pr-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pr-view" role="dialog" aria-modal="true" aria-label={t('pr.dialog')}>
        <header>
          <div role="tablist">
            <button role="tab" aria-selected={tab === 'this'} aria-disabled={shown ? undefined : 'true'} onClick={() => shown && setTab('this')}>
              {t('pr.tabThis')}
            </button>
            <button role="tab" aria-selected={tab === 'list'} onClick={() => setTab('list')}>
              {t('pr.tabList')}
            </button>
          </div>
          <button className="btn" aria-label={t('pr.close')} onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="pr-body-scroll">
          {tab === 'list' ? (
            <List core={core} onOpen={(u) => (setShown(u), setTab('this'))} t={t} />
          ) : error.startsWith(OFF) ? (
            <Off core={core} onOn={() => setN(n + 1)} t={t} />
          ) : error ? (
            <ErrorLine t={t} error={error} className="" />
          ) : !view ? (
            <p className="dim">{t('pr.loading')}</p>
          ) : (
            <Detail core={core} view={view} from={from} onMerged={() => setN(n + 1)} onSent={onClose} t={t} />
          )}
        </div>
      </div>
    </div>
  );
  return createPortal(box, document.body);
}

/** Ticket 373: the palette's "Open the PR list": the dialog on its list tab, with no PR and no session. */
export function openPrList(t: T = tEn) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => (root.unmount(), host.remove());
  root.render(<PrView t={t} onClose={close} />);
}
