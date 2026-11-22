// Ticket 990 (H2 ①): "Add a leader to this project…" from the project head's menu and the palette. A small dialog over the
// window (name, agent, model, effort: the Team form's own fields) that saves a teammate leading that project, opens its seat
// through the core's team_open and shows its tab. The dialog kit is the tree's centred sheet (tree/remove.css).
import { PLAIN } from '../plainText';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine, rawError } from '../errors';
import { MatePicks, saveOp } from '../features/team';
import type { Command } from '../keys';
import type { T } from '../i18n';
import { basename, openSession } from '../tree';
import type { ProjectTree } from '../tree/state';
import type { Session } from '../types';
import { leadOf, openSeat, setTeam, type Team } from './lead';
import { teamToTab } from './team';
import './lead.css';

let asked: string | null = null;
const subs = new Set<() => void>();
export const askLeader = (project: string | null) => ((asked = project), subs.forEach((f) => f()));

/** The palette and project-menu command; while the project it would act on has a lead already, the palette's Open as a tab. */
export function leaderCommands(pt: ProjectTree, current: Session | null, team: Team, t: T): Command[] {
  const shown = pt.menuProject ?? current?.project;
  if (!shown) return [];
  // Look 1117 v11-A-S3-1: with a lead, the place's Room is in its Team view; the palette ("room") brings it back as a tab.
  const place = shown === team.home ? '' : shown;
  if (leadOf(team, place)) return [{ id: 'room.open', title: t('lead.team.open'), run: () => teamToTab(place, shown) }];
  if (shown === team.home) return [];
  return [{ id: 'lead.add', title: t('lead.add'), enabledFor: ({ arg }) => !!(arg ?? current?.project), run: (arg) => askLeader(arg ?? current?.project ?? null) }];
}

export function LeaderDialog({ core, t }: { core: CoreClient; t: T }) {
  const project = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => asked,
  );
  return project ? <AddLeader key={project} core={core} t={t} project={project} onClose={() => askLeader(null)} /> : null;
}

function AddLeader({ core, t, project, onClose }: { core: CoreClient; t: T; project: string; onClose: () => void }) {
  const [draft, setDraft] = useState({ name: t('lead.defaultName'), kind: 'claude' as 'claude' | 'codex', model: '', effort: '' });
  const [error, setError] = useState<unknown>('');
  const nameTaken = !!error && /^a teammate named .+ already exists$/.test(rawError(error));
  const nameWhy = useId();
  const [busy, setBusy] = useState(false);
  const back = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    const prev = back.current;
    return () => (prev as HTMLElement | null)?.focus?.();
  }, []);
  const title = t('lead.addTitle', { project: basename(project) });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !draft.name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const list = (await core.request(saveOp({ ...draft, name: draft.name.trim(), job: t('lead.defaultJob'), project, lead: true }))) as Team;
      setTeam(list);
      const mate = leadOf(list, project);
      if (!mate) throw new Error('the core saved no lead for this project');
      const { session } = await openSeat(core, mate.id);
      onClose();
      openSession(session.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <div className="rmscrim">
      <form className="palette wtdlg rmdlg ldlg" role="dialog" aria-modal="true" aria-label={title} aria-busy={busy || undefined} onSubmit={(e) => void submit(e)} onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), onClose())}>
        <h2>{title}</h2>
        <p className="rmmuted">{t('lead.addNote', { project: basename(project) })}</p>
        <label>
          <span>{t('team.name')}</span>
          <input {...PLAIN} aria-label={t('team.name')} aria-invalid={nameTaken || undefined} aria-describedby={nameTaken ? nameWhy : undefined} value={draft.name} maxLength={40} autoFocus autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => (setDraft({ ...draft, name: e.target.value }), nameTaken && setError(''))} />
        </label>
        {/* Home N-A (look 1117 v4f): a name already taken here is said by the name field, in plain words. */}
        {nameTaken && <div id={nameWhy}><ErrorLine t={t} error={rawError(error)} /></div>}
        <div className="ldlg-picks">
          <MatePicks t={t} core={core} draft={draft} setDraft={setDraft} />
        </div>
        {!nameTaken && <ErrorLine t={t} error={error ? rawError(error) : ''} />}
        <div className="ldlg-acts">
          <button type="button" className="btn" onClick={onClose}>
            {t('team.cancel')}
          </button>
          <button type="submit" className="btn p" disabled={busy || !draft.name.trim()}>
            {t('lead.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
