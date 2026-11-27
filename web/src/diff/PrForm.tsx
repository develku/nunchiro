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

/** `onOpen`: open a PR in the PR view (after a create, or the one that already exists). */
export function PrForm({ core, session, onCreated, onCancel, onOpen, t }: { core: CoreClient; session: string; onCreated: (c: Created) => void; onCancel: () => void; onOpen: (url: string) => void; t: T }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState<Text | null>(KEPT.get(session) ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    core.request({ op: 'pr_draft', session }).then(
      (r) => {
        if (!live) return;
        const d = (r as { draft: Draft }).draft;
        setDraft(d);
        setText((kept) => kept ?? { title: d.title, body: d.body, base: d.bases[0] ?? 'main', draft: false });
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
      const next = { ...(x ?? { title: '', body: '', base: 'main', draft: false }), ...patch };
      KEPT.set(session, next);
      return next;
    });
  const n = draft?.push.ahead ?? 0;
  const off = !draft || !text || busy || !!draft.gh_why || !text.title.trim();
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
            <input {...PLAIN} ref={first} value={text.title} maxLength={256} disabled={busy} onChange={(e) => edit({ title: e.target.value })} />
          </label>
          <label className="dfld">
            {t('gitActions.pr.body')}
            <textarea {...PLAIN} value={text.body} maxLength={60000} rows={6} disabled={busy} onChange={(e) => edit({ body: e.target.value })} />
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
          <p className="dfact">
            {t(draft.template ? 'gitActions.pr.fromTemplate' : 'gitActions.pr.filled', { n: draft.commits })}
            {n > 0 && <> {t(n === 1 ? 'gitActions.pr.pushFirst.one' : 'gitActions.pr.pushFirst.other', { n, remote: draft.push.remote, branch: draft.push.branch, head: draft.head.slice(0, 7) })}</>}
          </p>
        </>
      )}
      <div className="drow">
        <button type="button" className="btn p" aria-disabled={off || undefined} data-tip={draft?.gh_why ? t('gitActions.pr.needsGh') : undefined} onClick={go}>
          {busy ? t('gitActions.pr.creating') : t(n > 0 ? 'gitActions.label.pushCreatePr' : 'gitActions.label.createPr')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
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
