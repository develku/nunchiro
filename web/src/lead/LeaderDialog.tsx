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
import { leadOf, openFresh, openSeat, setTeam, type Team } from './lead';
import { teamToTab } from './team';
import './lead.css';

let asked: string | null = null;
const subs = new Set<() => void>();
export const askLeader = (project: string | null) => ((asked = project), subs.forEach((f) => f()));

// Ticket 1096: "New Lead conversation" (the palette, the + menu, the project row menu). The core waits while a running old
// Lead writes what is unfinished (up to 5 minutes), so a sheet says so; it can be hidden, and the result still lands.
type Fresh = { id: string; project: string; name: string; phase: 'wait' | 'stuck' | 'lost' | 'failed'; hidden?: boolean; error?: unknown; minutes?: string; handed?: boolean };
let fresh: Fresh | null = null;
const setFresh = (next: Fresh | null) => ((fresh = next), subs.forEach((f) => f()));
// The core's time-limit line (team.rs `fresh_lead`, LATE_WITHDRAWN / LATE_HANDED): its limit, and whether the old Lead still
// has the handover message. new-lead-1096.spec.ts sends both lines as the core words them.
const LATE = /did not finish its turn within (\d+) minutes.*; (the handover message was withdrawn|it already has the handover message)/;
async function runFresh(id: string, project: string, name: string, how: 'handover' | 'close') {
  setFresh({ id, project, name, phase: 'wait' });
  try {
    const { session } = await openFresh(id, how);
    setFresh(null);
    openSession(session.id);
  } catch (error) {
    const late = LATE.exec(rawError(error));
    // A reconnect ends the request, not the core's job: the seat may still open (it shows in the tree when it does).
    if (late) setFresh({ id, project, name, phase: 'stuck', minutes: late[1], handed: !late[2].includes('withdrawn') });
    else setFresh({ id, project, name, phase: rawError(error) === 'core disconnected' ? 'lost' : 'failed', error });
  }
}
/** Starts a fresh Lead conversation for the project's lead; while one is on its way a second ask only shows its sheet. */
export function askFresh(team: Team, project: string) {
  const mate = leadOf(team, project === team.home ? '' : project);
  if (!mate) return;
  if (fresh?.phase === 'wait') return setFresh({ ...fresh, hidden: false });
  void runFresh(mate.id, project, mate.name, 'handover');
}

/** The palette and project-menu command; while the project it would act on has a lead already, the palette's Open as a tab. */
export function leaderCommands(pt: ProjectTree, current: Session | null, team: Team, t: T): Command[] {
  const shown = pt.menuProject ?? current?.project;
  if (!shown) return [];
  // Look 1117 v11-A-S3-1: with a lead, the place's Room is in its Team view; the palette ("room") brings it back as a tab.
  const place = shown === team.home ? '' : shown;
  if (leadOf(team, place))
    return [
      { id: 'room.open', title: t('lead.team.open'), run: () => teamToTab(place, shown) },
      // Ticket 1096: a project row hands its own folder (TAKES_PROJECT); the palette acts on the shown project.
      { id: 'lead.fresh', title: t('lead.fresh'), run: (arg) => askFresh(team, arg ?? shown) },
    ];
  if (shown === team.home) return [];
  return [{ id: 'lead.add', title: t('lead.add'), enabledFor: ({ arg }) => !!(arg ?? current?.project), run: (arg) => askLeader(arg ?? current?.project ?? null) }];
}

export function LeaderDialog({ core, t }: { core: CoreClient; t: T }) {
  const project = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => asked,
  );
  const shown = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => fresh,
  );
  if (project) return <AddLeader key={project} core={core} t={t} project={project} onClose={() => askLeader(null)} />;
  return shown && !shown.hidden ? <FreshSheet t={t} state={shown} /> : null;
}

function FreshSheet({ t, state }: { t: T; state: Fresh }) {
  const close = () => setFresh(state.phase === 'wait' ? { ...state, hidden: true } : null);
  const title = t('lead.freshTitle', { project: basename(state.project) });
  const again = () => void runFresh(state.id, state.project, state.name, 'close');
  return (
    <div className="rmscrim">
      <div className="palette wtdlg rmdlg ldlg" role="dialog" aria-modal="true" aria-label={title} aria-busy={state.phase === 'wait' || undefined} onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), close())}>
        <h2>{title}</h2>
        {state.phase === 'wait' && <p className="rmmuted">{t('lead.freshWait', { name: state.name })}</p>}
        {state.phase === 'stuck' && <p className="rmmuted">{t(state.handed ? 'lead.freshStuckHanded' : 'lead.freshStuck', { name: state.name, minutes: state.minutes ?? '' })}</p>}
        {state.phase === 'lost' && <p className="rmmuted">{t('lead.freshLost')}</p>}
        {state.phase === 'failed' && <ErrorLine t={t} error={rawError(state.error)} />}
        <div className="ldlg-acts">
          <button type="button" className="btn" autoFocus onClick={close}>
            {t(state.phase === 'wait' ? 'lead.freshHide' : state.phase === 'stuck' ? 'lead.freshKeep' : 'team.cancel')}
          </button>
          {state.phase === 'stuck' && (
            <button type="button" className="btn p" onClick={again}>
              {t('lead.freshClose')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
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
