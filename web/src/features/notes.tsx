// Ticket 990 slice h (team-j.html view ④, top card): Settings > Notes, every note in one list. A note is a lesson the
// user kept on a merge card or wrote here; agents never add one. The core keeps them (crates/nunchiro-core/src/notes.rs)
// and flags a note whose cited file is gone.
import { PLAIN } from '../plainText';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorLine, rawError } from '../errors';
import { Icon } from '../icons/Icon';
import { TABLES } from '../i18n';
import { noteOp, scopeWords, sourceWords, type Note, type Scope, type ScopeKind } from '../notes/notes';
import '../notes/notes.css';
import { Row, Sec, Seg, Select } from '../settings/shell/Row';
import { PageSummary } from '../settings/shell/PageActions';
import { basename } from '../tree';
import { registerSettingsPage, type PageContext } from './registry';

const PAGE = 'notes';
const ORDER: ScopeKind[] = ['project', 'role', 'me'];
type Draft = { id?: string; text: string; kind: ScopeKind; project: string; area: string | null; role: string };
const draftOf = (n: Note): Draft => ({
  id: n.id,
  text: n.text,
  kind: n.scope.kind,
  project: n.scope.kind === 'project' ? n.scope.project : '',
  area: n.scope.kind === 'project' ? (n.scope.area ?? null) : null,
  role: n.scope.kind === 'role' ? n.scope.role : '',
});
const scopeOf = (d: Draft): Scope => (d.kind === 'me' ? { kind: 'me' } : d.kind === 'role' ? { kind: 'role', role: d.role.trim() } : { kind: 'project', project: d.project, area: d.area });

// v12-C-V2: the open form outlives the page (closing Settings or changing page unmounts it); Save or Cancel clears it.
let keptDraft: Draft | null = null;

function NotesPage({ core, t, projects }: Pick<PageContext, 'core' | 't' | 'projects'>) {
  const [list, setList] = useState<Note[] | null>(null);
  const [error, setError] = useState<unknown>('');
  const [draft, setDraft] = useState<Draft | null>(() => keptDraft);
  useEffect(() => void (keptDraft = draft?.text.trim() ? draft : null), [draft]); // an empty form is not worth keeping
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (op: Record<string, unknown>) => {
    setError('');
    setBusy(true);
    try {
      setList(await noteOp(core, op));
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => void act({ operation: 'list' }), [core]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty: Draft = { text: '', kind: projects.length ? 'project' : 'me', project: projects[0] ?? '', area: null, role: '' };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const op = draft.id ? { operation: 'edit', id: draft.id, text: draft.text, scope: scopeOf(draft) } : { operation: 'keep', text: draft.text, scope: scopeOf(draft) };
    if (await act(op)) setDraft((keptDraft = null)); // cleared here too: Settings closed during the save unmounts the page before the effect
  };
  const date = (ms: number) => new Date(ms).toLocaleDateString(document.documentElement.lang || 'en', { month: 'short', day: 'numeric' });
  // Grouped by scope as the mockup reads (this project, then roles, then you), newest first inside each.
  const sorted = [...(list ?? [])].sort((a, b) => ORDER.indexOf(a.scope.kind) - ORDER.indexOf(b.scope.kind));
  const ready = draft && draft.text.trim() && (draft.kind !== 'project' || draft.project) && (draft.kind !== 'role' || draft.role.trim());

  const form = (d: Draft) => (
    <form className="notes-form" role="group" aria-label={t('notes.form')} onSubmit={(e) => void save(e)}>
      <input {...PLAIN} className="sinp" aria-label={t('notes.words')} placeholder={t('notes.wordsPh')} value={d.text} maxLength={300} autoFocus autoComplete="off" onChange={(e) => setDraft({ ...d, text: e.target.value })} />
      <div className="notes-scope">
        <Seg
          name={`notes-scope-${d.id ?? 'new'}`}
          value={d.kind}
          label={t('notes.scope.label')}
          onChange={(kind) => setDraft({ ...d, kind })}
          options={[
            ['project', t('notes.pill.project')],
            ['role', t('notes.pill.role')],
            ['me', t('notes.scope.me')],
          ]}
        />
        {d.kind === 'project' && (
          <Select label={t('notes.project')} value={d.project} onChange={(project) => setDraft({ ...d, project, area: project === d.project ? d.area : null })}>
            {[...new Set([...projects, ...(d.project ? [d.project] : [])])].map((p) => (
              <option key={p} value={p}>
                {basename(p)}
              </option>
            ))}
          </Select>
        )}
        {d.kind === 'role' && <input {...PLAIN} className="sinp" aria-label={t('notes.role')} placeholder={t('notes.rolePh')} value={d.role} maxLength={40} autoComplete="off" onChange={(e) => setDraft({ ...d, role: e.target.value })} />}
      </div>
      <div className="notes-acts">
        <button type="submit" className="btn p" disabled={busy || !ready}>
          {t('notes.save')}
        </button>
        <button type="button" className="btn" onClick={() => (setDraft(null), setError(''))}>
          {t('notes.cancel')}
        </button>
      </div>
    </form>
  );

  return (
    <div className="ssec-group">
      <PageSummary parts={[[t('summary.notes'), list?.length]]} />
      <ErrorLine t={t} error={error ? rawError(error) : ''} />
      <Sec
        id="h-notes"
        className="notes-list"
        title={t('notes.section')}
        lede={t('notes.lede')}
        action={
          !draft && (
            <button type="button" className="btn withicon" data-setting="notes" onClick={() => setDraft(empty)}>
              <Icon name="plus" size={14} />
              {t('notes.add')}
            </button>
          )
        }
      >
        {list && list.length === 0 && !draft && <p className="sds notes-none">{t('notes.none')}</p>}
        {draft && !draft.id && form(draft)}
        {sorted.map((n) =>
          draft?.id === n.id ? (
            <div key={n.id}>{form(draft)}</div>
          ) : (
            <Row
              key={n.id}
              setting={`note:${n.id}`}
              label={n.text}
              desc={
                <>
                  {scopeWords(t, n.scope, true)} · {sourceWords(t, n.source)}, {date(n.edited ?? n.at)}
                  {n.cites && ` · ${t('notes.cites', { file: n.cites })}`}
                  {n.missing && <span className="notes-missing"> · {t('notes.missing')}</span>}
                </>
              }
              control={
                removing === n.id ? (
                  <span role="group" aria-label={t('notes.removeAsk')}>
                    <span className="sds">{t('notes.removeAsk')}</span>{' '}
                    <button type="button" className="btn danger" disabled={busy} onClick={() => void act({ operation: 'remove', id: n.id }).then(() => setRemoving(null))}>
                      {t('notes.remove')}
                    </button>{' '}
                    <button type="button" className="btn" onClick={() => setRemoving(null)}>
                      {t('notes.cancel')}
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="notes-pill">{t(`notes.pill.${n.scope.kind}`)}</span>
                    <button type="button" className="btn" aria-label={t('notes.editOf', { text: n.text })} onClick={() => setDraft(draftOf(n))}>
                      {t('notes.edit')}
                    </button>
                    <button type="button" className="btn" aria-label={t('notes.removeOf', { text: n.text })} onClick={() => setRemoving(n.id)}>
                      {t('notes.remove')}
                    </button>
                  </>
                )
              }
            />
          ),
        )}
      </Sec>
    </div>
  );
}

const word = (key: 'notes.title' | 'notes.desc') => {
  const lang = document.documentElement.lang as keyof typeof TABLES;
  return TABLES[lang]?.[key] ?? TABLES.en[key] ?? 'Notes';
};
registerSettingsPage({
  id: PAGE,
  get title() {
    return word('notes.title');
  },
  get description() {
    return word('notes.desc');
  },
  group: 'agents',
  order: 6,
  fields: [{ key: 'notes', at: '[data-setting="notes"]' }],
  render: (ctx) => <NotesPage core={ctx.core} t={ctx.t} projects={ctx.projects} />,
});
