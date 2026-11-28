// Ticket 990 (H2 ①): "Add a leader to this project…" from the project head's menu and the palette. A small dialog over the
// window (name, agent, model, effort: the Team form's own fields) that saves a teammate leading that project, opens its seat
// through the core's team_open and shows its tab. The dialog kit is the tree's centred sheet (tree/remove.css).
import { PLAIN } from '../plainText';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { CoreClient } from '../api';
import { getDraft, setDraft } from '../composer-drafts';
import { ErrorLine, docT, rawError } from '../errors';
import { MatePicks, saveOp } from '../features/team';
import type { Command } from '../keys';
import type { T } from '../i18n';
import { basename, openSession } from '../tree';
import type { ProjectTree } from '../tree/state';
import type { Session } from '../types';
import { UNDO_MS, pause, push, resume, run, useUndo } from '../undo/store';
import { freshSeats, leadOf, liveSeat, openFresh, openSeat, setTeam, undoFresh, type Team, type Teammate } from './lead';
import { teamToTab } from './team';
import './lead.css';

let asked: string | null = null;
const subs = new Set<() => void>();
export const askLeader = (project: string | null) => ((asked = project), subs.forEach((f) => f()));

// Ticket 1096: "New Lead conversation" (the palette, the + menu, the project row menu). The core waits while a running old
// Lead writes what is unfinished (up to 5 minutes), so a sheet says so; it can be hidden, and the result still lands.
// Ticket 1130 B-L3 (C5, owner 11-25 option A; mockup docs/design/first-use-b-1130/mockup.html): the same action for every
// seat, from its header too. One press: a running turn is stopped and the new conversation opens at once (`quick`: no
// sheet, nothing waits); only a Lead between turns still hands over first, behind the sheet. The old conversation is in
// History, and a toast offers Undo for 10 s.
type Fresh = { mate: Teammate; project: string; phase: 'wait' | 'stuck' | 'lost' | 'failed'; hidden?: boolean; quick?: boolean; error?: unknown; minutes?: string; handed?: boolean };
let fresh: Fresh | null = null;
const setFresh = (next: Fresh | null) => ((fresh = next), subs.forEach((f) => f()));
// The core's time-limit line (team.rs `fresh_lead`, LATE_WITHDRAWN / LATE_HANDED): its limit, and whether the old Lead still
// has the handover message. new-lead-1096.spec.ts sends both lines as the core words them.
const LATE = /did not finish its turn within (\d+) minutes.*; (the handover message was withdrawn|it already has the handover message)/;
/** The conversation that opens ready to type in: its composer takes focus once the session shows (CentreView, ticket 1145). */
const show = openSession;
/** Round 3: the old conversation's unsent words come back with it. A resume gives the seat a new id and the draft is kept
 *  by id, so it moves as the window's own resume moves it (chrome/useTabs.ts `resume`). Round 4: never over newer words.
 *  The resumed session can show before the reply comes, and be typed into: with a draft saved under its id, or words in
 *  its box, nothing is written. */
function carryDraft(from: string, to: string) {
  const text = getDraft(from);
  const box = document.getElementById('composer') as HTMLTextAreaElement | null;
  const shown = box?.dataset.draftFor === to ? box : null;
  if (!text || getDraft(to) || shown?.value) return;
  setDraft(to, text);
  if (!shown) return;
  shown.value = text;
  shown.dispatchEvent(new Event('input', { bubbles: true }));
}
/** As the core's `hands_over`: only a project's lead gets a handover turn (the Home lead's new conversation starts
 *  clean), so only its button says it writes what is unfinished. */
export const handsOver = (mate: Teammate) => !!mate.lead && !!mate.project;
/** As the core's `seat_busy` (team.rs `Fresh::Now`): a turn runs or waits at a question, so the press stops it. */
export const seatBusy = (s: Session | null) => !!s && (s.attention.working || s.attention.waiting);
/** Round 6: the agent can continue this seat's conversation later (it has a conversation id; an ACP agent without
 *  `loadSession` never has one). Only then is the one-press offered: without it the press would lose the conversation,
 *  and the core refuses `now` for the same reason. No live seat: nothing to lose. */
export const canContinue = (s: Session | null) => !s || !!s.agent_session_id;
async function runFresh(mate: Teammate, project: string, how: 'now' | 'handover' | 'close') {
  const old = liveSeat(mate.id);
  const quick = how === 'close' || (how === 'now' && !(handsOver(mate) && old && !seatBusy(old)));
  setFresh({ mate, project, phase: 'wait', quick, hidden: quick });
  try {
    const { session } = await openFresh(mate.id, how);
    setFresh(null);
    freshSeats.add(session.id);
    show(session.id);
    // Undo: the old conversation is the seat again in place of this new one, which stays in History, closed.
    const undo = async () => {
      const back = (await undoFresh(mate.id, old!.id, session.id)).session.id;
      carryDraft(old!.id, back);
      show(back);
    };
    if (old && canContinue(old)) push({ label: docT()('lead.newConvOld'), toast: true, undo });
  } catch (error) {
    const late = LATE.exec(rawError(error));
    // A reconnect ends the request, not the core's job: the seat may still open (it shows in the tree when it does).
    if (late) setFresh({ mate, project, phase: 'stuck', minutes: late[1], handed: !late[2].includes('withdrawn') });
    else setFresh({ mate, project, phase: rawError(error) === 'core disconnected' ? 'lost' : 'failed', error });
  }
}
/** A new conversation as this teammate's seat; while one is on its way a second ask only shows its sheet (a handover's). */
export function newConversation(mate: Teammate, project: string, how: 'now' | 'handover' = 'now') {
  if (fresh?.phase === 'wait') return void (fresh.quick || setFresh({ ...fresh, hidden: false }));
  void runFresh(mate, project, how);
}
/** The same for the project's lead (the palette, the + menu, the project row menu). A Lead whose seat gets no one-press
 *  (`canContinue`) keeps ticket 1096's handover there, as before this ticket. */
export function askFresh(team: Team, project: string) {
  const mate = leadOf(team, project === team.home ? '' : project);
  if (mate) newConversation(mate, project, canContinue(liveSeat(mate.id)) ? 'now' : 'handover');
}

/** The header's button, on the seat of any teammate (a Lead, an assistant, a teammate). `live`: the seat while it runs. */
export function FreshButton({ t, mate, seat, live }: { t: T; mate: Teammate; seat: Session; live: Session | null }) {
  // Round 6: shown but not offered where the press would lose the conversation; the tooltip says why.
  const lost = !canContinue(live);
  const tip = lost ? 'lead.newConvNoContinue' : seatBusy(live) ? 'lead.newConvStops' : handsOver(mate) && live ? 'lead.newConvHands' : 'lead.newConvOpens';
  return (
    <button className="hbtn fresh-seat" aria-disabled={lost || undefined} data-tip={t(tip, { name: mate.name })} onClick={() => lost || newConversation(mate, seat.project)}>
      {t('lead.newConv')}
    </button>
  );
}

/** "The old conversation is in History. Undo 10 s": the window's one pending Undo (undo/store.ts), drawn as the mockup's
 *  toast over the session view. Hover or focus holds the countdown, ⌘Z outside a text field runs it too, and a refusal is
 *  said in the status line. */
export function FreshToast({ t }: { t: T }) {
  const { entry } = useUndo();
  if (!entry?.toast) return null;
  return (
    <div className="fresh-toast-at">
      <div className="fresh-toast" role="status" onPointerEnter={pause} onPointerLeave={resume} onFocus={pause} onBlur={resume}>
        <span>{entry.label}</span>
        <button className="btn" onClick={() => void run()}>
          {t('mw.undo')}
        </button>
        <span className="dim">{t('lead.newConvSecs', { n: UNDO_MS / 1000 })}</span>
      </div>
    </div>
  );
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
  const name = state.mate.name;
  const title = state.mate.lead ? t('lead.freshTitle', { project: basename(state.project) }) : t('lead.newConvWith', { name });
  const again = () => void runFresh(state.mate, state.project, 'close');
  return (
    <div className="rmscrim">
      <div className="palette wtdlg rmdlg ldlg" role="dialog" aria-modal="true" aria-label={title} aria-busy={state.phase === 'wait' || undefined} onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), close())}>
        <h2>{title}</h2>
        {state.phase === 'wait' && <p className="rmmuted">{t('lead.freshWait', { name })}</p>}
        {state.phase === 'stuck' && <p className="rmmuted">{t(state.handed ? 'lead.freshStuckHanded' : 'lead.freshStuck', { name, minutes: state.minutes ?? '' })}</p>}
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
