// V2.5-12: the first-run step that imports the conversations claude and codex already keep (read only, needs 137).
// The core lists and scans them; nothing here writes into ~/.claude or ~/.codex.
import { PLAIN } from '../plainText';
import { useState } from 'react';
import type { CoreClient } from '../api';
import type { Key } from '../i18n';
import type { Session } from '../types';
import { plural } from '../tree/state';
import { openImported } from './imported';
import { ErrorDetails, plainError, rawError } from '../errors';
import './firstrun.css';

type Item = { id: string; agent: 'claude' | 'codex'; project: string; title: string; modified_ms: number; imported: boolean };
type Hit = { n: number; text: string };
type Found = { session: string; status: string; hits: Hit[] };
type T = (key: Key, args?: Record<string, string | number>) => string;
const message = (e: unknown) => rawError(e);

/** The title as a button: opens that imported conversation read-only (ticket 204). Search only hits imported ones. */
function OpenButton({ t, id, title }: { t: T; id: string; title: string }) {
  const name = title || t('import.untitled');
  return (
    <button type="button" className="btn" data-tip={t('import.openHit')} onClick={() => openImported(id, title)}>
      {name}
    </button>
  );
}

/** The folder's own name; the full path stays as secondary text. */
const folderName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

export function ImportStep({ core, t, sessions = [] }: { core: CoreClient; t: T; sessions?: Session[] }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [importing, setImporting] = useState(false);
  const [details, setDetails] = useState(''); // ticket 476: a failure's raw reason, under Details
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Found[] | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setNote('');
    setDetails('');
    try {
      await work();
    } catch (e) {
      setNote(t('import.failed', { error: plainError(t, e) }));
      setDetails(message(e));
    } finally {
      setBusy(false);
      setImporting(false);
    }
  };
  const load = () => run(async () => setItems(((await core.request({ op: 'import_list' })) as { items: Item[] }).items));
  const add = () =>
    run(async () => {
      setImporting(true);
      const { total } = (await core.request({ op: 'import_add', ids: picked })) as { total: number };
      setNote(plural(t, 'import.done', total));
      setPicked([]);
      setItems(((await core.request({ op: 'import_list' })) as { items: Item[] }).items);
    });
  const search = () =>
    run(async () => setResults(((await core.request({ op: 'import_search', query })) as { results: Found[] }).results));

  // A running session's own transcript is still being written: importing it would copy a half-made conversation.
  const running = new Set(sessions.filter((s) => s.state === 'running' && s.agent_session_id).map((s) => `${s.kind}:${s.agent_session_id}`));
  const shown = (items ?? []).filter((i) => !running.has(i.id));
  const fresh = shown.filter((i) => !i.imported);
  const byId = new Map(shown.map((i) => [i.id, i]));
  const projects = [...new Set(shown.map((i) => i.project))];
  const listed = !!items && shown.length > 0;
  const status = importing ? (
    <div role="status">{t('import.importing')}</div>
  ) : (
    note && (
      <div role="status">
        {note}
        <ErrorDetails t={t} details={details} />
      </div>
    )
  );
  return (
    <>
      <p className="fr-hint">{t('import.hint')}</p>
      <button className="btn" disabled={busy} onClick={() => void load()}>
        {busy && !items ? t('import.looking') : t(items ? 'firstrun.again' : 'import.look')}
      </button>
      {items && shown.length === 0 && <p>{t('import.empty')}</p>}
      {listed && (
        <>
          {/* Ticket 378: what Import did shows beside it, where the user just pressed. */}
          <div className="fr-import-acts">
            {fresh.length > 0 && (
              <button className="btn" onClick={() => setPicked(fresh.map((i) => i.id))}>
                {t('import.selectAll')}
              </button>
            )}
            <button className="btn p" disabled={busy || picked.length === 0} onClick={() => void add()}>
              {t('import.run', { n: picked.length })}
            </button>
            {status}
          </div>
          <div className="fr-import" role="group" aria-label={t('import.step')}>
            {projects.map((p) => (
              <div key={p} data-project={p}>
                <b>{p ? folderName(p) : '—'}</b>
                {p && (
                  <>
                    {' '}
                    <span className="fr-path" title={p}>
                      {p}
                    </span>
                  </>
                )}
                {shown
                  .filter((i) => i.project === p)
                  .map((i) => (
                    i.imported ? (
                      // Ticket 204: an imported conversation opens read-only in its tab; the box stays as the mark.
                      <div key={i.id} data-imported="true">
                        <input type="checkbox" disabled checked aria-label={i.title || t('import.untitled')} />{' '}
                        <OpenButton t={t} id={i.id} title={i.title} />
                        <span className="tag">{t('import.imported')}</span>
                      </div>
                    ) : (
                      <label key={i.id} data-imported={false}>
                        <input
                          type="checkbox"
                          checked={picked.includes(i.id)}
                          onChange={(e) => setPicked((l) => (e.target.checked ? [...l, i.id] : l.filter((x) => x !== i.id)))}
                        />{' '}
                        {i.title || t('import.untitled')}
                      </label>
                    )
                  ))}
              </div>
            ))}
          </div>
        </>
      )}
      {!listed && status}
      {items?.some((i) => i.imported) && (
        <div className="fr-import-search">
          <input {...PLAIN}
            aria-label={t('import.searchLabel')}
            placeholder={t('import.searchLabel')}
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && query.trim() && !busy) void search();
            }}
          />
          <button className="btn" disabled={busy || !query.trim()} onClick={() => void search()}>
            {t('import.searchGo')}
          </button>
          {results && results.length === 0 && <p>{t('import.noHits')}</p>}
          {results?.map((r) => (
            <div key={r.session} data-hit={r.session}>
              <b>
                {byId.get(r.session)?.imported ? <OpenButton t={t} id={r.session} title={byId.get(r.session)?.title ?? ''} /> : byId.get(r.session)?.title || r.session}
              </b>
              {r.hits.slice(0, 3).map((h) => (
                <p key={h.n} className="fr-hint">
                  {h.text}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
