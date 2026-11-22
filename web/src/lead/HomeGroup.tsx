// Ticket 990 slice d (H2 ③): Home in the tree. While a Home teammate exists, a "Home" group sits above the projects: one
// row per Home teammate (the lead first, with its Lead tag), its seat's state when it runs and a quiet "not running" when
// not; a press opens the seat. The Home folder's other sessions sit under the seat that started them, never as a project
// named "home" with a "main" row (survey C13).
// Ticket 1032 (owner 11-21, mockup docs/design/bot-statusbar-1121/index.html 3-5): with no Home teammate the group still
// shows, with one quiet row that opens the set-up ("Name your assistant"); folding the group hides it.
// Home view change 3 (11-17): with a Home lead, the lead's row always shows (first); an assistant's row only while it runs,
// waits for the user or failed (or has sessions under it, or is the one in front); the others fold into one "N resting"
// line a press unfolds.
import { useState } from 'react';
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import { Icon } from '../icons/Icon';
import { sessionName } from '../sessionNames';
import { rowState, type RowState } from '../tree';
import { status } from '../types';
import { WtRow } from '../tree/RowIcon';
import type { Session } from '../types';
import { nameAssistant } from '../settings/agents/open';
import { openSeat, restKey, seatOf, type Team } from './lead';
import './lead.css';

export const homeMates = (team: Team) => team.teammates.filter((m) => !m.project).sort((a, b) => Number(!!b.lead) - Number(!!a.lead));

// The Sidebar draws the group in one of two places (before or under "this Mac"), so it mounts again when the machine
// list arrives: what the user unfolded is kept here, not in the instance.
const kept = { folded: false, rest: false };

export function HomeGroup({ t, core, team, sessions, current, onOpen }: { t: T; core: CoreClient; team: Team; sessions: Session[]; current: string | null; onOpen: (id: string) => void }) {
  const [folded, fold] = useState(kept.folded);
  const [rest, unfold] = useState(kept.rest);
  const setFolded = (v: boolean) => fold((kept.folded = v));
  const setRest = (v: boolean) => unfold((kept.rest = v));
  const mates = homeMates(team);
  const here = sessions.filter((s) => s.project === team.home && s.state !== 'closed' && !s.account_tab && !s.side_chat);
  const seats = mates.map((m) => seatOf(sessions, m.id));
  // Each other session of the Home folder under the seat that started it; one with no seat to sit under goes under the first row.
  // A session with no parent matched no seat (an absent seat's id and an absent parent were both undefined, so it sat under every row).
  const under = (i: number) => here.filter((s) => !mates.some((m) => m.id === s.teammate) && (seats.some((x) => !!x && x.id === s.parent) ? !!seats[i] && s.parent === seats[i]!.id : i === 0));
  const stateOf = (list: Session[]): RowState => rowState({ path: '', name: '', sessions: list }, list, undefined, Date.now(), undefined, t);
  const quiet = (id: string): RowState => ({ kind: 'new', tone: 'idle', tip: [t(restKey(sessions, id))] });
  const name = t('assistants.title');
  const hasLead = mates.some((m) => m.lead);
  // A seat that failed is no live seat, but it is still what the user must see.
  const failed = (id: string) => sessions.some((s) => s.teammate === id && s.state !== 'closed' && status(s) === 'failed');
  const active = (i: number) => {
    const s = seats[i];
    // The seat in front stays too: its row is where the user is.
    return !hasLead || !!mates[i].lead || (!!s && (s.id === current || ['working', 'waiting', 'limited', 'failed'].includes(status(s)))) || failed(mates[i].id) || under(i).length > 0;
  };
  const resting = mates.filter((_, i) => !active(i)).length;
  return (
    // Ticket 1032: before set-up the group is a rare control, so its head and row take no one-key hint label (quiet).
    <div className="grp home-grp" data-home data-hint-quiet={!mates.length || undefined} role="group" aria-label={name}>
      <div className="row head">
        <button className="chev" data-hint-quiet aria-expanded={!folded} aria-label={t(folded ? 'tree.expand' : 'tree.collapse', { name })} onClick={() => setFolded(!folded)}>
          <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={10} />
        </button>
        <button className="n" onClick={() => setFolded(!folded)}>
          <b>{name}</b>
        </button>
      </div>
      {!folded &&
        mates.map((m, i) => {
          if (!rest && !active(i)) return null;
          const seat = seats[i];
          const kids = under(i);
          return (
            <div key={m.id} className="home-mate" data-mate={m.id}>
              <span className="wtwrap">
                <WtRow
                  name={m.name}
                  tag={m.lead ? t('lead.tag') : undefined}
                  note={seat ? undefined : t(restKey(sessions, m.id))}
                  seat={seat ?? undefined}
                  cacheIds={seat ? [seat.id] : undefined}
                  state={seat ? stateOf([seat]) : quiet(m.id)}
                  sessionId={seat?.id}
                  selected={!!seat && seat.id === current}
                  onOpen={() => (seat ? onOpen(seat.id) : void openSeat(core, m.id).then(({ session }) => onOpen(session.id), () => {}))}
                  t={t}
                />
              </span>
              {kids.map((s) => (
                <span className="wtwrap home-kid" key={s.id}>
                  <WtRow name={sessionName(s)} state={stateOf([s])} sessionId={s.id} selected={s.id === current} onOpen={() => onOpen(s.id)} seat={s} cacheIds={[s.id]} t={t} />
                </span>
              ))}
            </div>
          );
        })}
      {!folded && !mates.length && (
        <span className="wtwrap home-setup">
          <button className="row wt2 idle" data-home-setup onClick={nameAssistant}>
            <span className="n">
              <span className="nm">{t('assistants.defaultName')}</span>
            </span>
            <span className="tm">{t('assistants.setUp')}</span>
            <span className="ic">
              <Icon name="person" size={14} />
            </span>
          </button>
        </span>
      )}
      {!folded && resting > 0 && !rest && (
        <span className="wtwrap home-rest">
          {/* Not a session row: no branch icon and no "not running" in its name (look 1117 v3), only what a press does. */}
          <button className="row wt2 idle" aria-expanded={false} onClick={() => setRest(true)}>
            <span className="n">
              <span className="nm">{t('home.tree.resting', { n: resting })}</span>
            </span>
            <span className="ic">
              <Icon name="people" size={14} />
            </span>
          </button>
        </span>
      )}
    </div>
  );
}
