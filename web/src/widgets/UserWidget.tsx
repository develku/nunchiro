// A placed user widget (`widget:<name>`, ticket v1b-19): asks for permission on first use, then runs while visible at
// its interval (the core enforces the floor and shares one run between placements) and shows text, JSON or a table.
import { useEffect, useId, useRef, useState } from 'react';
import { PermissionSheet } from '../approval/PermissionSheet';
import type { ApprovalCore } from '../approval/types';
import type { Session } from '../types';
import { actWidget, runWidget, timeLocale, useWidgetList, type Listed, type Output, type Run, type WidgetList } from './api';
import { clean, MAX_COLUMNS, MAX_ROWS, statusLine, table } from './output';
import { WebWidget } from '../webwidgets/WebWidget'; // v1b-22
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import { kindWord, ScriptSwitch } from './Gallery';
import './widgets.css';
import { docT, ErrorLine, tipError, rawError } from '../errors';

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString(timeLocale(document.documentElement.lang, navigator.language));

/** Widgets whose sheet already opened by itself in this window: first use asks once, the button asks again. */
const asked = new Set<string>();

export function UserWidget({ core, name, session }: { core: ApprovalCore; name: string; session: Session | null }) {
  const { list, refresh } = useWidgetList(core);
  const t = useHtmlLangT(); // ticket 508
  const entry = list?.widgets.find((w) => w.name === name);
  const [sheet, setSheet] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [refused, setRefused] = useState('');
  // v1b-20: one act at a time; `note` is the last act's outcome, shown on the widget.
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const acting = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  // v1b-22: a web widget follows its own setting and needs no script sandbox.
  const web = entry?.kind === 'web';
  const on = !!list && (web ? list.web_enabled : list.enabled && !list.unavailable);
  const ready = on && entry?.state === 'approved' && (entry.kind === 'script' || web);
  const sessionId = session?.id ?? null;

  useEffect(() => {
    // v1b-22: a web widget asks again once after a change (its frame is gone until the user reviews it).
    const key = web ? `${name}:${entry?.state}` : name;
    if (!on || !entry || entry.state === 'approved' || entry.error || asked.has(key)) return; // v1b-22: on, key
    // Not while the layout is being edited (the sheet would cover Done); the next list poll opens it after.
    if (!root.current?.getClientRects().length || root.current.closest('[data-editing="true"]')) return;
    asked.add(key);
    setSheet(true);
  }, [on, web, entry, name]);

  // One tick a second: run when visible and due. Hidden placements (other tab, folded zone) never call.
  useEffect(() => {
    if (!ready || web) return; // v1b-22: a web widget does not run
    let next = 0;
    let busy = false;
    let live = true;
    const tick = () => {
      if (busy || Date.now() < next || !root.current?.getClientRects().length) return;
      busy = true;
      runWidget(core, name, sessionId)
        .then((r) => {
          if (!live) return;
          setRun(r);
          setRefused('');
          // A run still in progress (ours or another window's) is asked again shortly; its cached output stays shown.
          next = Date.now() + (r.running ? 1000 : r.interval_secs * 1000);
        })
        .catch((e: Error) => {
          if (!live) return;
          setRefused(rawError(e));
          next = Date.now() + 5000;
        })
        .finally(() => (busy = false));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => ((live = false), clearInterval(t));
  }, [ready, web, core, name, sessionId]);

  // v1b-20: a row click is the user's own send; nothing else in the window calls widget_act.
  const act = entry?.act ?? null;
  // Ticket 513: the act lines come whole from the catalogue (the target and the time in the window's language).
  const status = statusLine(note ? note.text : act ? t('rest.widgets.user.actHint', { target: act.session ? t('rest.widgets.user.targetSession', { name: act.session }) : t('rest.widgets.user.targetNew', { agent: act.start ?? '' }) }) : '');
  const onRow =
    act && run && run.output?.format === 'json'
      ? (row: number) => {
          if (acting.current) return;
          acting.current = true;
          actWidget(core, name, sessionId, row, run.ran_at_ms)
            .then((r) =>
              setNote({
                text: t(r.send.status === 'queued' ? 'rest.widgets.user.queued' : 'rest.widgets.user.sent', {
                  target: act.session ? t('rest.widgets.user.noteSession', { name: act.session }) : t('rest.widgets.user.noteNew', { agent: act.start ?? '' }),
                  time: timeOf(Date.now()),
                }),
                error: false,
              }),
            )
            .catch((e: Error) => setNote({ text: tipError(docT(), e), error: true }))
            .finally(() => (acting.current = false));
        }
      : undefined;

  return (
    <div ref={root} className="uw" data-user-widget={name} aria-label={t('rest.widgets.user.aria', { name })}>
      <div className="uw-h">
        <b>{name}</b>
        <span className="dim">{run?.project ?? (session ? session.project.split('/').pop() : t('rest.widgets.user.noProject'))}</span>
        {run?.ran_at_ms ? <span className="dim">{t('rest.widgets.user.updated', { time: timeOf(run.ran_at_ms) })}</span> : null}
        <span className="sp" />
        {entry && entry.state !== 'approved' && !entry.error && (
          <button className="btn" onClick={() => setSheet(true)}>
            {t('rest.widgets.user.review')}
          </button>
        )}
      </div>
      {/* v1b-20 */}
      {onRow && act && (
        // Ticket 203: the line is truncated, so the whole cleaned text (at most 2000 characters) is its title, and a key
        // can reach it. At most 200 characters are drawn (settings5).
        <p className="uw-act" role="status" tabIndex={0} title={status.title} data-act-note={note ? (note.error ? 'error' : 'ok') : 'hint'}>
          {note ? <span className={note.error ? 'uw-err' : ''}>{status.text}</span> : status.text}
        </p>
      )}
      {/* v1b-22: no frame (and no page request) until the web widget is approved with its setting on */}
      {ready && web ? <WebWidget core={core} name={name} session={sessionId} /> : <Body list={list} entry={entry} name={name} run={run} refused={refused} onRow={onRow} />}
      {sheet && <PermissionSheet core={core} name={name} onClose={() => setSheet(false)} onGranted={() => (setSheet(false), refresh())} />}
    </div>
  );
}

function Body({ list, entry, name, run, refused, onRow }: { list: WidgetList | null; entry: Listed | undefined; name: string; run: Run | null; refused: string; onRow?: (row: number) => void }) {
  const t = useHtmlLangT(); // ticket 508
  const rawId = useId();
  if (!list) return <p className="uw-note dim">{t('rest.widgets.loading')}</p>;
  if (!entry)
    return (
      <p className="uw-note" role="status">
        {t('rest.widgets.user.notFound', { name })} <span className="mono">~/.nunchiro/widgets/{name}/</span>
      </p>
    );
  if (entry.error) return <ErrorLine t={docT()} error={clean(entry.error)} className="uw-note uw-err" />;
  if (entry.kind === 'web' && !list.web_enabled) return <p className="uw-note" role="status">{t('rest.widgets.user.webOff', { off: t('rest.widgets.webOffNote') })}</p>; // v1b-22
  // v1b-22: web kinds, and the script setting and sandbox only for script widgets
  if (entry.kind !== 'script' && entry.kind !== 'web') return <p className="uw-note">{t('rest.widgets.user.later', { kind: kindWord(t, entry.kind) })}</p>;
  if (entry.kind === 'script' && !list.enabled)
    return (
      <p className="uw-note" role="status">
        {t('rest.widgets.user.scriptOff', { off: t('rest.widgets.scriptOffNote') })} <ScriptSwitch t={t} />
      </p>
    );
  // Ticket 553: the raw reason is the line's accessible description, not only its tooltip.
  if (entry.kind === 'script' && list.unavailable)
    return (
      <p className="uw-note uw-err" role="alert" title={list.unavailable} aria-describedby={rawId}>
        {t('rest.widgets.unavailable')}
        <span hidden id={rawId}>
          {list.unavailable}
        </span>
      </p>
    );
  if (entry.state === 'unapproved') return <p className="uw-note" role="status">{t('rest.widgets.user.unapproved')}</p>;
  if (entry.state === 'changed') return <p className="uw-note" role="status">{t('rest.widgets.user.changed')}</p>;
  if (refused) return <ErrorLine t={docT()} error={clean(refused)} className="uw-note uw-err" />;
  if (!run || (run.running && !run.output && !run.error)) return <p className="uw-note dim">{t('rest.widgets.user.running')}</p>;
  if (run.error) return <p className="uw-note uw-err" role="alert">{clean(run.error)}</p>;
  return run.output ? <OutputView output={run.output} onRow={onRow} /> : null;
}

export function OutputView({ output, onRow }: { output: Output; onRow?: (row: number) => void }) {
  const words = useHtmlLangT(); // ticket 508 (`t` here is the table)
  if (output.format === 'text') return <pre className="uw-text">{clean(output.text)}</pre>;
  let value: unknown;
  try {
    value = JSON.parse(output.text);
  } catch {
    return <pre className="uw-text">{clean(output.text)}</pre>;
  }
  if (!Array.isArray(value)) return <pre className="uw-text">{clean(JSON.stringify(value, null, 2))}</pre>;
  const t = table(value);
  return (
    <div className="uw-table">
      <table>
        <thead>
          <tr>
            {t.columns.map((c) => (
              <th key={c} scope="col">
                {clean(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r, i) => (
            <tr
              key={i}
              {...(onRow && {
                // v1b-20: rows act only with a current act grant; table semantics stay, Enter and Space click.
                className: 'uw-act-row',
                tabIndex: 0,
                'data-act-row': i,
                onClick: () => onRow(i),
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), onRow(i));
                },
              })}
            >
              {r.map((v, j) => (
                <td key={j}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {t.dropped > 0 && (
        <p className="uw-note dim" role="status">
          {words('rest.widgets.user.columns', { shown: MAX_COLUMNS, total: MAX_COLUMNS + t.dropped })}
        </p>
      )}
      {t.total > MAX_ROWS && (
        <p className="uw-note dim" role="status">
          {words('rest.widgets.user.rows', { shown: MAX_ROWS, total: t.total })}
        </p>
      )}
    </div>
  );
}
