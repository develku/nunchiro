// Settings · Artifact libraries (V2-10c, needs 91): every pinned library with Remove, and the per-library auto-allow
// switch for cdnjs libraries (the only host the manifest covers); the shipped default set (ticket 366) is marked and
// turned off by its switch. Remove and the switch are window-only core ops sent from these clicks alone; an agent
// cannot reach them. Names come from page bytes and render as text.
import { useEffect, useRef, useState } from 'react';
import { Reset, Row, Switch } from '../shell/Row';
import { PageSummary } from '../shell/PageActions';
import { ErrorLine, rawError } from '../../errors';
import type { Key } from '../../i18n';
import type { CoreClient, LibEntry, LibsList, LibsOp } from '../../api';
import { CDNJS, UNVERIFIED_HOVER, cleanList } from '../../sandbox/libs';
import '../accounts/accounts.css';
import '../git/providers.css'; // the status chip and the borderless button
import './libs.css';

type T = (key: Key, args?: Record<string, string | number>) => string;
const day = (secs: number) => {
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const urlOf = (e: LibEntry) => `https://${e.host}${e.path}`;
// final.html's short names; the full host stays on hover.
const HOST_NAME: Record<string, string> = { 'cdnjs.cloudflare.com': 'cdnjs', 'cdn.jsdelivr.net': 'jsdelivr', 'unpkg.com': 'unpkg', 'cdn.tailwindcss.com': 'tailwindcss', 'code.jquery.com': 'jquery' };

export function LibsPage({ t, core }: { t: T; core: CoreClient }) {
  const [list, setList] = useState<LibsList | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const load = () => {
    setError('');
    core.libs({ op: 'libs_list' }).then(
      (l) => live.current && setList(cleanList(l)),
      (e: Error) => live.current && setError(rawError(e)),
    );
  };
  useEffect(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
    };
  }, [core]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (op: LibsOp) => {
    setBusy(true);
    setError('');
    try {
      setList(cleanList(await core.libs(op)));
    } catch (e) {
      setError(rawError(e));
    } finally {
      setBusy(false);
    }
  };
  const entries = list?.entries ?? [];
  const libsOf = (l: { host: string; library: string }[] = []) => l.filter((a) => a.host === CDNJS).map((a) => a.library);
  // Ticket 366: a default library keeps its row once turned off, so the owner can turn it on again.
  const defaults = new Set(libsOf(list?.defaults));
  const cdnjs = [...new Set([...entries.filter((e) => e.host === CDNJS).map((e) => e.library), ...libsOf(list?.auto_allow), ...defaults])].sort();
  const auto = (library: string) => !!list?.auto_allow.some((a) => a.host === CDNJS && a.library === library);

  // Owner 2026-11-16: a row says what the library is for and which versions this Mac holds; the rule for the switch is said once above the card.
  const about = (library: string) => {
    const versions = entries.filter((e) => e.host === CDNJS && e.library === library).map((e) => e.version);
    const have = versions.length ? t('libsFor.have', { versions: versions.join(', ') }) : t('libsFor.none');
    return defaults.has(library) ? `${t(`libsFor.${library}` as Key)} · ${have}` : `${t('settings.libraries.autoNote')} · ${have}`;
  };
  // Ticket 250 r3: the final draft's two cards: the cdnjs auto-allow rows, then the allowed libraries' table.
  return (
    <div className="ssec-group">
      <PageSummary parts={list ? [[t('summary.libraries'), cdnjs.length], [t('summary.itemsOn'), cdnjs.filter(auto).length]] : []} />
      <section id="s-libs" aria-labelledby="h-libs" className="ssec">
        {/* Ticket 991 C19: the page header already says it; the heading stays for the page's structure and the search. */}
        <h2 id="h-libs" className="sr" tabIndex={-1} data-setting="artifactLibs">
          {t('settings.libraries.title')}
        </h2>
        <p className="lede">{t('settings.libraries.lede')}</p>
        {cdnjs.some((l) => defaults.has(l)) && <p className="lede">{t('libsDefault.note')}</p>}
        {cdnjs.length > 0 && (
          <div className="scard">
            {cdnjs.map((library) => (
              <Row
                key={library}
                label={<span className="mono">{library}</span>}
                chip={defaults.has(library) && <span className="chip libs-default">{t('libsDefault.chip')}</span>}
                // A shipped default library starts on, any other starts off.
                reset={<Reset t={t} label={library} show={auto(library) !== defaults.has(library)} run={() => void act({ op: 'libs_auto_allow', host: CDNJS, library, on: defaults.has(library) })} />}
                desc={about(library)}
                control={<Switch label={`${t('settings.libraries.auto')}: ${library}`} checked={auto(library)} disabled={busy} onChange={(on) => void act({ op: 'libs_auto_allow', host: CDNJS, library, on })} />}
              />
            ))}
          </div>
        )}
      </section>
      <section className="ssec" aria-labelledby="h-libs-list">
        <h2 id="h-libs-list">{t('settings.row.libsAllowed')}</h2>
        {list && !list.saved && (
          <p className="conflict" role="alert">
            {t('settings.libraries.broken')}
          </p>
        )}
        <ErrorLine t={t} error={error} retry={list ? undefined : load} />
        <div className="scard">
          {!entries.length && (
            <p className="empty" role="status">
              {!list && !error ? t('settings.libraries.reading') : list ? t('settings.libraries.none') : ''}
            </p>
          )}
          {entries.length > 0 && (
            <div className="acct-scroll">
              <table className="acct-table libs-table" aria-labelledby="h-libs">
                <thead>
                  <tr>
                    <th scope="col">{t('settings.libraries.colLibrary')}</th>
                    <th scope="col">{t('settings.libraries.colHost')}</th>
                    <th scope="col">{t('settings.libraries.colBadge')}</th>
                    <th scope="col">{t('settings.libraries.colAsked')}</th>
                    <th scope="col">
                      <span className="sr">{t('settings.libraries.colActions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={urlOf(e)} data-lib={urlOf(e)}>
                      <td className="mono" title={`${e.file} · ${day(e.fetched_at)}`}>
                        {e.library}@{e.version}
                      </td>
                      <td title={e.host}>{HOST_NAME[e.host] ?? e.host}</td>
                      <td>
                        <span className={`chip ${e.badge === 'verified' ? 'ok' : 'warn'}`} title={e.badge === 'verified' ? undefined : UNVERIFIED_HOVER}>
                          {t(e.badge === 'verified' ? 'settings.libraries.matches' : 'settings.libraries.unverified')}
                        </span>
                      </td>
                      <td title={e.first_requester}>{e.first_requester || '—'}</td>
                      <td>
                        <button className="btn flat" disabled={busy} aria-busy={busy || undefined} aria-label={t('settings.libraries.removeOne', { name: `${e.library} ${e.version}` })} onClick={() => void act({ op: 'libs_remove', url: urlOf(e) })}>
                          {t('settings.libraries.remove')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
