// The Diff header's Create PR, run by the app (crates/nunchiro-core/src/git_write.rs `create`): a form under the header
// that is its own confirm, as in Orca, Superset and emdash. Title and description start from the commits (or the
// repository's PR template) and stay editable; Into picks the base; Draft is a tick. The button pushes first when commits
// are ahead (the line under the fields says so), then `gh pr create` runs with the body on stdin. Mockup
// docs/design/git-actions-m2 panel 3. Titles, bodies and branch names are outside text: drawn as text only.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine, rawError } from '../errors';
import type { T } from '../i18n';
import { PLAIN } from '../plainText';
import { openSetting } from '../settings/agents/open';
import type { PushTo } from './gitAction';

/** Mirrors git_write.rs `Draft`. */
export type Draft = { title: string; body: string; template: boolean; commits: number; bases: string[]; head: string; push: PushTo; gh_why: string | null };
export type Created = { type: 'pr_created'; url: string; number: number; pushed: number };
type Text = { title: string; body: string; base: string; draft: boolean };

/** The edited text per session, kept while the window lives (closing the panel or a refusal keeps it; never on disk). */
const KEPT = new Map<string, Text>();

/** `onOpen`: open a PR in the PR view (after a create, or the one that already exists). `writer`: the session's agent
 *  that Write with AI runs (Claude or Codex); none for an ACP agent or a terminal, which get no button. */
export function PrForm({ core, session, writer, writerOff, onCreated, onCancel, onOpen, t }: { core: CoreClient; session: string; writer?: string; writerOff?: boolean; onCreated: (c: Created) => void; onCancel: () => void; onOpen: (url: string) => void; t: T }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState<Text | null>(KEPT.get(session) ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Write with AI: running, and whether the fields now hold the agent's text.
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState(false);
  const [aiError, setAiError] = useState<unknown>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    core.request({ op: 'pr_draft', session }).then(
      (r) => {
        if (!live) return;
        const d = (r as { draft: Draft }).draft;
        setDraft(d);
        // A kept base the list no longer has falls back to the first shown one; with none shown, Create stays off.
        setText((kept) => {
          const base = kept && d.bases.includes(kept.base) ? kept.base : (d.bases[0] ?? '');
          return { ...(kept ?? { title: d.title, body: d.body, draft: false }), base };
        });
      },
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [core, session]);
  useEffect(() => {
    if (draft) first.current?.focus();
  }, [draft]);
  const edit = (patch: Partial<Text>) =>
    setText((x) => {
      const next = { ...(x ?? { title: '', body: '', base: '', draft: false }), ...patch };
      KEPT.set(session, next);
      return next;
    });
  const write = () => {
    if (writing || busy) return;
    setWriting(true);
    setAiError(null);
    core.request({ op: 'pr_write', session }).then(
      (r) => {
        const w = r as { title: string; body: string };
        setWriting(false);
        setWritten(true);
        edit({ title: w.title, body: w.body });
      },
      (e: unknown) => (setWriting(false), /: cancelled$/.test(rawError(e)) || setAiError(e)),
    );
  };
  const stop = () => void core.request({ op: 'pr_write_cancel', session }).catch(() => {});
  const n = draft?.push.ahead ?? 0;
  const off = !draft || !text || busy || writing || !!draft.gh_why || !text.title.trim() || !draft.bases.includes(text.base);
  const go = () => {
    if (off || !draft || !text) return;
    setBusy(true);
    setError(null);
    core.request({ op: 'pr_create', session, head: draft.head, remote: draft.push.remote, branch: draft.push.branch, ahead: draft.push.ahead, key: draft.push.key, title: text.title, body: text.body, base: text.base, draft: text.draft }).then(
      (r) => {
        KEPT.delete(session);
        setBusy(false);
        onCreated(r as Created);
      },
      (e: unknown) => (setBusy(false), setError(e)),
    );
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing || busy) return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };
  // A refusal that names a PR (it already exists) gets its Open; a gh sign-in refusal gets Settings › Git.
  const raw = error ? rawError(error) : '';
  const existing = /already exists: #\d+ (?<url>\S+)/.exec(raw)?.groups?.url;
  const ghOff = draft?.gh_why ?? (/gh is not logged in|gh was not found/.test(raw) ? raw : null);
  return (
    <div className="dprform" role="form" aria-label={t('gitActions.label.createPr')} onKeyDown={onKey}>
      {text && draft && (
        <>
          <label className="dfld">
            {t('gitActions.pr.title')}
            <input {...PLAIN} ref={first} value={text.title} maxLength={256} disabled={busy || writing} onChange={(e) => edit({ title: e.target.value })} />
          </label>
          <label className="dfld">
            {t('gitActions.pr.body')}
            <textarea {...PLAIN} value={text.body} maxLength={60000} rows={6} disabled={busy || writing} onChange={(e) => edit({ body: e.target.value })} />
          </label>
          <div className="drow">
            <label className="dfld inline">
              {t('gitActions.pr.base')}
              <select value={text.base} disabled={busy} onChange={(e) => edit({ base: e.target.value })}>
                {draft.bases.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="dcheck">
              <input type="checkbox" checked={text.draft} disabled={busy} onChange={(e) => edit({ draft: e.target.checked })} /> {t('gitActions.pr.draft')}
            </label>
          </div>
          {writer && (
            <div className="drow">
              <button type="button" className="btn sm" disabled={writing || busy} onClick={write}>
                {writing ? t('gitActions.ai.writing') : t(written ? 'gitActions.ai.again' : 'gitActions.ai.write')}
              </button>
              {writing && (
                <button type="button" className="btn q sm" onClick={stop}>
                  {t('gitActions.ai.stop')}
                </button>
              )}
              {written && !writing && <span className="dfact">{t('gitActions.ai.written', { agent: writer })}</span>}
            </div>
          )}
          {writerOff && <p className="dfact">{t('gitActions.ai.claudeOnly')}</p>}
          <ErrorLine t={t} error={aiError} className="dpush-err" />
          <p className="dfact">
            {t(draft.template ? 'gitActions.pr.fromTemplate' : 'gitActions.pr.filled', { n: draft.commits })}
            {n > 0 && <> {t(n === 1 ? 'gitActions.pr.pushFirst.one' : 'gitActions.pr.pushFirst.other', { n, remote: draft.push.remote, branch: draft.push.branch, head: draft.head.slice(0, 7) })}</>}
          </p>
        </>
      )}
      <div className="drow dbtns">
        <button type="button" className="btn p sm" aria-disabled={off || undefined} data-tip={draft?.gh_why ? t('gitActions.pr.needsGh') : undefined} onClick={go}>
          {busy ? t('gitActions.pr.creating') : t(n > 0 ? 'gitActions.label.pushCreatePr' : 'gitActions.label.createPr')}
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={onCancel}>
          {t('gitActions.push.cancel')}
        </button>
      </div>
      {draft?.gh_why && !error && (
        <p className="dpush-err" role="note">
          {t('gitActions.pr.needsGh')}
        </p>
      )}
      <ErrorLine t={t} error={error} className="dpush-err" />
      {(existing || ghOff) && (
        <div className="drow">
          {existing && (
            <button type="button" className="btn q sm" onClick={() => onOpen(existing)}>
              {t('gitActions.pr.open')}
            </button>
          )}
          {ghOff && (
            <button type="button" className="btn q sm" onClick={() => openSetting('git', 'services')}>
              {t('gitActions.pr.openGit')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The line after a create, at the panel's foot. */
export const createdText = (t: T, c: Created) => t('gitActions.pr.created', { pr: c.number });
