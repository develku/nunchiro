// Ticket 452: what a skill or hook item holds, read in the app. A custom item's files are edited and saved here (the core
// writes them, owner window only: extensions.rs `item_save`); the shipped skill is read only. Also the "New skill" form.
import { PLAIN } from '../plainText';
import { useEffect, useState } from 'react';
import type { CoreClient } from '../api';
import type { Key, T } from '../i18n';
import { ErrorLine, rawError } from '../errors';
import { leaveTypedField } from '../keepTyped';

/** Mirrors core `extensions::HookLine`: one command a hook runs, and on which event. */
export type HookLine = { event: string; matcher: string; command: string };

const WHEN: Record<string, Key> = {
  SessionStart: 'extView.when.SessionStart',
  UserPromptSubmit: 'extView.when.UserPromptSubmit',
  PreToolUse: 'extView.when.PreToolUse',
  PostToolUse: 'extView.when.PostToolUse',
  PermissionRequest: 'extView.when.PermissionRequest',
  Notification: 'extView.when.Notification',
  Stop: 'extView.when.Stop',
  SubagentStart: 'extView.when.SubagentStart',
  SubagentStop: 'extView.when.SubagentStop',
};

/** Look 1117 v10 C-N5: a command whose program is a long path shows the program's name ("nunchiro hook Stop"); every
 *  row cut to one temp-folder stem said nothing. The whole command stays in the cell's tooltip. */
const shortCommand = (c: string) => c.replace(/^'[^']*\/([^'/]+)'/, '$1').replace(/^"[^"]*\/([^"/]+)"/, '$1').replace(/^[^\s'"]*\/(\S+)/, '$1');

/** Ticket 455: what a hook item runs, and when: one line per command. `note` says what the commands are for. */
/** `whole` (ticket 456, the Turn on question): each command as written, wrapped, as the CLI prints it before it asks. */
export function HookLines({ t, lines, label, note, whole }: { t: T; lines: HookLine[]; label: string; note?: string; whole?: boolean }) {
  return (
    <div className={whole ? 'exth whole' : 'exth'} role="group" aria-label={label}>
      <table>
        <thead>
          <tr>
            <th scope="col">{t('extView.hookEvent')}</th>
            <th scope="col">{t('extView.hookWhen')}</th>
            <th scope="col">{t('extView.hookRuns')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="mono">
                {l.event}
                {l.matcher && l.matcher !== '*' && <span className="exth-m"> [{l.matcher}]</span>}
              </td>
              <td>{Object.hasOwn(WHEN, l.event) ? t(WHEN[l.event]) : ''}</td>
              <td className="mono exth-cmd" title={l.command}>
                {whole ? <code className="exth-code">{l.command}</code> : shortCommand(l.command)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {note && <p className="exth-note">{note}</p>}
    </div>
  );
}

type Files = { id: string; editable: boolean; files: { path: string; bytes: number }[]; more: boolean };
type FileText = { text: string };
const message = (e: unknown) => rawError(e);
/** Q9 en-b-J13-3: unsaved edits outlive the editor (the item closed, another opened), each with the text it was made on. */
const kept = new Map<string, { texts: Record<string, string>; drafts: Record<string, string> }>();

/** The files of item `id` beside the text of the chosen one. Edits are kept per file until saved or reverted. */
export function ItemFiles({ core, t, id, name, onSaved, hooks }: { core: CoreClient; t: T; id: string; name: string; onSaved: () => void; hooks?: HookLine[] }) {
  const [list, setList] = useState<Files | null>(null);
  const [path, setPath] = useState('');
  const [texts, setTexts] = useState<Record<string, string>>(() => kept.get(id)?.texts ?? {}); // as stored
  const [drafts, setDrafts] = useState<Record<string, string>>(() => kept.get(id)?.drafts ?? {}); // edited, not saved yet
  useEffect(() => {
    const open = Object.keys(drafts);
    if (open.length) kept.set(id, { drafts, texts: Object.fromEntries(open.map((p) => [p, texts[p]])) });
    else kept.delete(id);
  }, [id, drafts, texts]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    core.request({ op: 'extensions_item_files', id }).then(
      (r) => {
        if (!live) return;
        const l = r as Files;
        setList(l);
        // A skill's own text first, a hook item's hooks.json (ticket 580): it is what the user came to read.
        setPath((l.files.find((f) => f.path.endsWith('SKILL.md')) ?? l.files.find((f) => f.path === 'hooks/hooks.json') ?? l.files[0])?.path ?? '');
      },
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [core, id]);
  useEffect(() => {
    if (!path || path in texts) return;
    let live = true;
    core.request({ op: 'extensions_item_read', id, path }).then(
      (r) => live && setTexts((m) => ({ ...m, [path]: (r as FileText).text })),
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [core, id, path, texts]);

  const dirty = path in drafts;
  const choose = (p: string) => {
    setPath(p);
    setError('');
    setNote('');
  };
  const edit = (text: string) => {
    setNote('');
    setDrafts(({ [path]: _old, ...rest }) => (text === texts[path] ? rest : { ...rest, [path]: text }));
  };
  const revert = () => setDrafts(({ [path]: _old, ...rest }) => rest);
  const save = async () => {
    if (!dirty || saving) return;
    const [at, text, base] = [path, drafts[path], texts[path]];
    setSaving(true);
    setError('');
    try {
      // `base`: the core refuses the save when the file changed on disk since it was read (Q9 en-b-J13-4).
      const r = (await core.request({ op: 'extensions_item_save', id, path: at, text, base })) as FileText;
      setTexts((m) => ({ ...m, [at]: r.text }));
      // Text typed while the save was on its way stays a draft (Q9 en-b-J13-1); no draft left means the box showed `base`.
      setDrafts(({ [at]: now = base, ...rest }) => (now === text ? rest : { ...rest, [at]: now }));
      setNote(t('extView.saved'));
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="extv" role="group" aria-label={t('extView.group', { name })} data-files={id}>
      {/* Ticket 455: a hook item says when it runs what, before its files. */}
      {!!hooks?.length && <HookLines t={t} lines={hooks} label={t('extView.hooksOf', { name })} note={t('extView.hooksOwnNote')} />}
      <ErrorLine t={t} error={error} />
      {!list ? (
        !error && (
          <p className="lede" role="status">
            {t('extView.reading')}
          </p>
        )
      ) : !list.files.length ? (
        <p className="lede">{t('extView.none')}</p>
      ) : (
        <div className="extv-grid">
          <ul className="extv-list" aria-label={t('extView.files')}>
            {list.files.map((f) => {
              const cut = f.path.lastIndexOf('/') + 1;
              return (
                <li key={f.path}>
                  <button type="button" aria-current={f.path === path || undefined} onClick={() => choose(f.path)}>
                    <span className="mono">
                      <span className="extv-dir">{f.path.slice(0, cut)}</span>
                      {f.path.slice(cut)}
                    </span>
                    {f.path in drafts && <span className="extv-dot" role="img" aria-label={t('extView.unsaved')} />}
                  </button>
                </li>
              );
            })}
            {list.more && <li className="extv-more">{t('extView.more')}</li>}
          </ul>
          <div className="extv-pane">
            <textarea {...PLAIN}
              className="mono"
              aria-label={path}
              readOnly={!list.editable || !(path in texts)} // a file not read (too large, not text) is never typed over
              spellCheck={false}
              value={drafts[path] ?? texts[path] ?? ''}
              onChange={(e) => edit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            <div className="extv-foot">
              {list.editable ? (
                <>
                  <button type="button" className="btn p" disabled={!dirty || saving} aria-busy={saving || undefined} data-idle={!dirty || undefined} onClick={() => void save()}>
                    {t('extView.save')}
                  </button>
                  <button type="button" className="btn" disabled={!dirty || saving} aria-busy={saving || undefined} data-idle={!dirty || undefined} onClick={revert}>
                    {t('extView.revert')}
                  </button>
                </>
              ) : (
                <span>{t('extView.readOnly')}</span>
              )}
              <span role="status">{note}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The core's rule for an item's folder name (extensions.rs `valid_name`). */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** "New skill" or (`hook`, ticket 580) "New hook": a name and one line saying what it is for. The core makes the folder
 *  with one starting skill file or hooks.json; the new item stays off. `onMade` gets the new list and the new item's id. */
export function NewSkill<L>({ core, t, hook, onMade, onCancel }: { core: CoreClient; t: T; hook?: boolean; onMade: (list: L, id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  // A check's own line is a string; a refused save is the Error itself (ticket 480: plain words, raw under Details).
  const [problem, setProblem] = useState<unknown>('');
  const [busy, setBusy] = useState(false);
  const make = async () => {
    // The button is never disabled: a press on an empty form says what is missing.
    if (!NAME.test(name.trim())) return setProblem(t('extView.nameRule'));
    if (!about.trim()) return setProblem(t(hook ? 'extView.aboutRuleHook' : 'extView.aboutRule'));
    setBusy(true);
    setProblem('');
    try {
      onMade((await core.request({ op: 'extensions_skill_new', name: name.trim(), description: about.trim(), hook })) as L, `custom:${name.trim()}`);
    } catch (e) {
      setProblem(e instanceof Error ? e : new Error(message(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="srow ext-new"
      aria-label={t(hook ? 'extView.newHook' : 'extView.newSkill')}
      onSubmit={(e) => {
        e.preventDefault();
        void make();
      }}
      onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), leaveTypedField() || onCancel())}
    >
      <input {...PLAIN} className="sinp mono" autoFocus aria-label={t('extView.newName')} placeholder={t('extView.newName')} autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
      <input {...PLAIN} className="sinp" aria-label={t('extView.newAbout')} placeholder={t('extView.newAbout')} autoComplete="off" maxLength={300} value={about} onChange={(e) => setAbout(e.target.value)} />
      <button type="submit" className="btn p" disabled={busy}>
        {t('extView.create')}
      </button>
      <button type="button" className="btn" onClick={onCancel}>
        {t('extView.cancel')}
      </button>
      {typeof problem === 'string' ? (
        problem && (
          <p className="conflict" role="alert">
            {problem}
          </p>
        )
      ) : (
        <ErrorLine t={t} error={problem} />
      )}
    </form>
  );
}
