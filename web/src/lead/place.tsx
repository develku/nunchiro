// Ticket 1099 (owner 11-24, mockup docs/design/cohesion-1099 panels 1-3): how a project's lead works (way of working, what
// its seats may do, auto-advance, live seats) is a setting, so it lives in Settings > Team as one section per project.
// The Team view's gear and the day-one card's "Change" open that section on their project. The core still refuses these
// place ops from a session (ledger.rs `op @ ("way" | "grant" | "auto" | "cap" | ...)`): only this page, the user, sets them.
import { useEffect, useState } from 'react';
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import { Icon } from '../icons/Icon';
import { openSetting } from '../settings/agents/open';
import { Reset, Row, Sec, Seg, Select, Switch } from '../settings/shell/Row';
import { basename } from '../tree';
import type { Session } from '../types';
import { setPlace, useTasks, type Place } from './tasks';

const WAYS = ['solo', 'team', 'strict'] as const;
const SEATS = ['ask', 'edits'] as const;
const CAPS = ['2', '4', '6', '8'] as const; // ledger.rs CAPS
/** The section's field key: the palette's settings.team.place and the deep link's target. */
export const PLACE_FIELD = 'place';
const PLACE_EVENT = 'nunchiro:place';
// The project the last gear or Change asked for: the section starts on it when Settings draws it after the event.
let asked: string | null = null;

/** Opens Settings > Team > How this place works on `project`. */
export function openPlace(project: string) {
  asked = project;
  window.dispatchEvent(new CustomEvent(PLACE_EVENT, { detail: project }));
  openSetting('team', PLACE_FIELD);
}

/** The day-one card's one sentence for the place's way (mockup panel 3). */
export const daySentence = (t: T, way: Place['way']) => t(`lead.day.${way}`);

/** The Team view head's gear (mockup panel 2): opens this project's section. */
export function PlaceGear({ t, project }: { t: T; project: string }) {
  const label = t('lead.place.title');
  return (
    <button type="button" className="teamv-gear" aria-label={label} data-tip={label} data-place-gear onClick={() => openPlace(project)}>
      <Icon name="gear" size={14} />
    </button>
  );
}

/** Settings > Team's first section (mockup panel 1). */
export function PlaceSection({ core, t, projects, sessions, onSummary }: { core: CoreClient; t: T; projects: string[]; sessions: Session[]; onSummary?: (s: { project: string; place: Place } | null) => void }) {
  const [project, setProject] = useState<string>(() => (asked && projects.includes(asked) ? asked : (projects[0] ?? '')));
  useEffect(() => {
    const on = (e: Event) => setProject((e as CustomEvent<string>).detail);
    window.addEventListener(PLACE_EVENT, on);
    return () => window.removeEventListener(PLACE_EVENT, on);
  }, []);
  // A project the list no longer has (removed from the tree) falls back to the first.
  const shown = projects.includes(project) ? project : (projects[0] ?? '');
  const { place } = useTasks(core, shown || null, true, sessions);
  const [err, setErr] = useState<false | 'account' | 'other'>(false); // the row whose change failed
  // Ticket 1120: the registered accounts' labels (never the "Your own" rows); with none, the row is not drawn.
  const [labels, setLabels] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void core.accounts(true).then((r) => live && setLabels([...new Set(r.accounts.filter((a) => !a.default).map((a) => a.label))]), () => {});
    return () => {
      live = false;
    };
  }, [core]);
  // The page summary (mockup panel 1: "nunchiro Build + review · Live seats 4") says the shown project's way.
  useEffect(() => onSummary?.(shown && place ? { project: shown, place } : null), [shown, place, onSummary]);
  if (!shown) return null;
  const set = (operation: 'way' | 'grant' | 'auto' | 'cap' | 'account' | 'merge-ask', text: string) => (setErr(false), void setPlace(core, shown, operation, text).catch(() => setErr(operation === 'account' ? 'account' : 'other')));
  const cap = String(place?.cap ?? 4);
  // Ticket 1122 (ticket 543's rule): each row shows a reset while it differs from the core's default (ledger.rs Place).
  const reset = (label: string, changed: boolean, operation: 'way' | 'grant' | 'auto' | 'cap' | 'merge-ask', text: string) => <Reset t={t} label={label} show={!!place && changed} run={() => set(operation, text)} />;
  return (
    <Sec
      id="h-place"
      className="place-sec"
      title={t('lead.place.title')}
      right={
        <Select value={shown} onChange={(p) => ((asked = p), setProject(p))} label={t('lead.place.project')} setting={PLACE_FIELD}>
          {projects.map((p) => (
            <option key={p} value={p}>
              {basename(p)}
            </option>
          ))}
        </Select>
      }
    >
      <Row
        label={t('lead.way.group')}
        desc={place && t(`lead.way.${place.way}Note`)}
        reset={reset(t('lead.way.group'), place?.way !== 'team', 'way', 'team')}
        control={<Seg name="place-way" value={place?.way ?? null} label={t('lead.way.group')} onChange={(v) => set('way', v)} options={WAYS.map((w) => [w, t(`lead.way.${w}`)])} />}
      />
      <Row
        label={t('lead.seats.group')}
        desc={place && t(place.seats === 'edits' ? 'lead.place.seatsEdits' : 'lead.place.seatsAsk')}
        reset={reset(t('lead.seats.group'), place?.seats !== 'ask', 'grant', 'ask')}
        control={<Seg name="place-seats" value={place?.seats ?? null} label={t('lead.seats.group')} onChange={(v) => set('grant', v)} options={SEATS.map((s) => [s, t(`lead.seats.${s}Short`)])} />}
      />
      <Row label={t('lead.auto.group')} desc={t('lead.place.autoNote')} reset={reset(t('lead.auto.group'), place?.auto === false, 'auto', 'on')} control={<Switch checked={place?.auto !== false} label={t('lead.auto.group')} disabled={!place} onChange={(on) => set('auto', on ? 'on' : 'off')} />} />
      <Row label={t('lead.mergeAsk.group')} desc={t('lead.mergeAsk.note')} reset={reset(t('lead.mergeAsk.group'), place?.ask_merge === true, 'merge-ask', 'off')} control={<Switch checked={place?.ask_merge === true} label={t('lead.mergeAsk.group')} disabled={!place} onChange={(on) => set('merge-ask', on ? 'on' : 'off')} />} />
      <Row
        label={t('lead.cap.group')}
        desc={t('lead.cap.note', { n: cap })}
        reset={reset(t('lead.cap.group'), cap !== '4', 'cap', '4')}
        control={<Seg name="place-cap" value={place ? cap : null} label={t('lead.cap.group')} onChange={(v) => set('cap', v)} options={CAPS.map((n) => [n, n])} />}
        why={err === 'other' && <p className="place-err" role="status">{t('lead.way.failed')}</p>}
      />
      {labels.length > 0 && (
        <Row
          label={t('lead.account.group')}
          desc={t('lead.account.note')}
          why={err === 'account' && <p className="place-err" role="status">{t('lead.way.failed')}</p>}
          control={
            <Select value={place?.account ?? ''} onChange={(v) => set('account', v || 'own')} label={t('lead.account.group')} disabled={!place}>
              <option value="">{t('lead.account.own')}</option>
              {labels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          }
        />
      )}
      <p className="place-quiet">{t('lead.place.quiet')}</p>
    </Sec>
  );
}
