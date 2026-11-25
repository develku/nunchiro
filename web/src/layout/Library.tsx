// Widget library (LAYOUT D5b, A15-A22): every built-in and user widget as a card showing where it is now. Drag a card
// onto a bar or into the main area; Enter on a card adds it to the end of the left bar. The area under the cards
// removes a dragged icon from its bar. A user widget that is not approved shows "Needs approval", which opens the
// existing permission sheet; it cannot be placed until it is approved.
import { PLAIN } from '../plainText';
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Key, T } from '../i18n';
import { PermissionSheet } from '../approval/PermissionSheet';
import type { ApprovalCore } from '../approval/types';
import { ASK } from '../widgets/Gallery';
import { useWidgetList, userKind, type Listed } from '../widgets/api';
import { KOREAN, where, type Bars } from './bars';
import { glyph } from './icons';
import { count } from './store';
import { ENTRIES } from './registry';
import type { Kind, Layout } from './model';
import { kindWord, ScriptSwitch } from '../widgets/Gallery';

type Chip = 'all' | 'builtin' | 'mine';
const CHIPS: [Chip, Key][] = [['all', 'rest.layout.chip.all'], ['builtin', 'rest.layout.chip.builtin'], ['mine', 'rest.layout.chip.mine']];
// The registry's notes are English data (Node specs load it); the card shows them through these keys.
const NOTE: Record<string, Key> = { waiting: 'rest.layout.note.waiting', terminal: 'rest.layout.note.follows', diff: 'rest.layout.note.follows', preview: 'rest.layout.note.follows', composer: 'rest.layout.note.composer', files: 'rest.layout.note.focused', search: 'rest.layout.note.focused', board: 'rest.layout.note.board', artifacts: 'rest.layout.note.artifacts', decisions: 'rest.layout.note.decisions', room: 'lead.widgetNote' };
/** A built-in widget's title and note in the window's language: the library card and the split chooser (ticket 625). */
export const widgetText = (t: T, e: (typeof ENTRIES)[number]) => ({ title: t(`shell.widget.${e.kind}`), note: e.kind === 'tree' ? t('shell.tree.card') : NOTE[e.kind] ? t(NOTE[e.kind]) : e.note });

export interface Card {
  kind: string;
  title: string;
  note: string;
  korean: string;
  user?: Listed;
}
/** The approval a card still needs: its widget is not allowed (or changed, or its manifest is invalid). */
export const needsApproval = (c: Card) => !!c.user && c.user.state !== 'approved';

export function Library({ t, core, bars, layout, onGrab, onAdd, onNest, refused }: { /** The window's language (the library sits outside the chat's Tr provider). */ t: T; core: ApprovalCore; bars: Bars; layout: Layout; onGrab: (e: ReactPointerEvent, kind: string, blocked?: string) => void; onAdd: (kind: string) => void; /** Alt+Enter on a card, then a project row: nest it there (D5b lane B, B08). */ onNest: (kind: string, project: string) => void; refused: (kind: string, why: string) => void }) {
  const { list, error, refresh } = useWidgetList(core);
  const [chip, setChip] = useState<Chip>('all');
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState<string | null>(null);
  const [asked, setAsked] = useState('');
  // B08: Alt+Enter on a card arms nesting; the arrow keys then move among the tree's project rows and Enter nests there.
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const rows = () => [...document.querySelectorAll<HTMLElement>('[data-project-path]')];
    const key = (e: KeyboardEvent) => {
      const cur = document.activeElement?.closest<HTMLElement>('[data-project-path]');
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setArmed(null);
        document.querySelector<HTMLElement>(`.lcard[data-card="${CSS.escape(armed)}"]`)?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = rows();
        if (!list.length) return;
        e.preventDefault();
        const i = cur ? list.indexOf(cur) + (e.key === 'ArrowDown' ? 1 : -1) : e.key === 'ArrowDown' ? 0 : list.length - 1;
        list[Math.min(list.length - 1, Math.max(0, i))].querySelector<HTMLElement>('button.n')?.focus();
      } else if (e.key === 'Enter' && cur) {
        e.preventDefault();
        e.stopPropagation();
        setArmed(null);
        onNest(armed, cur.dataset.projectPath!);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [armed, onNest]);
  // The agent makes the widget: the card fills the focused session's composer (Enter sends it), as the gallery's card did.
  const ask = () => {
    const el = document.getElementById('composer') as HTMLTextAreaElement | null;
    if (!el || el.disabled) return setAsked(t('rest.layout.noSession'));
    setAsked('');
    el.value = ASK + '\nCreate it with `nunchiro widget new <name>`, edit its widget.sh (the Widgets section of the nunchiro skill), and tell me when it is ready so I can allow it.';
    el.focus();
    el.setSelectionRange(ASK.length, ASK.length);
  };
  // The Tree card says what the approved placement design says (needs 157 (2)); the rest keep their registry notes.
  const builtin: Card[] = ENTRIES.map((e) => ({ kind: e.kind, ...widgetText(t, e), korean: KOREAN[e.kind] ?? '' }));
  const mine: Card[] = (list?.widgets ?? []).map((w) => ({ kind: userKind(w.name), title: w.name, note: w.error ? t('rest.layout.user.invalid') : `${kindWord(t, w.kind ?? 'script')} · ${t(w.state === 'approved' ? 'rest.layout.user.allowed' : w.state === 'changed' ? 'rest.layout.user.changed' : 'rest.layout.user.notAllowed')}${(w.kind === 'web' ? !list?.web_enabled : !list?.enabled) ? t('rest.layout.user.off') : ''}`, korean: '', user: w }));
  const pending = mine.filter((c) => needsApproval(c) && !c.user?.error).length; // ticket 870: a broken one waits on a fix, not an approval
  const q = query.trim().toLowerCase();
  const shown = [...(chip === 'mine' ? [] : builtin), ...(chip === 'builtin' ? [] : mine)].filter((c) => !q || [c.title, c.kind, c.korean].some((t) => t.toLowerCase().includes(q)));
  const place = (c: Card) => {
    const side = where(bars, c.kind);
    return side ? t(side === 'left' ? 'rest.layout.place.left' : 'rest.layout.place.right') : count(layout, c.kind as Kind) > 0 ? t('rest.layout.place.in') : '';
  };
  return (
    // Busy until the first widget list arrives: its note and user cards then push the built-in cards down, so a press
    // aimed at a card before then can land on its neighbour.
    <aside className="lib" aria-label={t('settings.extensions.library')} aria-busy={!list && !error ? true : undefined}>
      <div className="lh">{t('settings.extensions.library')}</div>
      <input {...PLAIN} className="lq" type="search" aria-label={t('rest.layout.searchWidgets')} placeholder={t('rest.layout.searchWidgets')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="lc" role="group" aria-label={t('rest.layout.show')}>
        {CHIPS.map(([k, label]) => (
          <button key={k} className="chip" aria-pressed={chip === k} onClick={() => setChip(k)}>
            {t(label)}
            {k === 'mine' && pending > 0 ? t('rest.layout.toApprove', { n: pending }) : ''}
          </button>
        ))}
      </div>
      {list && (!list.enabled || (list.widgets.some((w) => w.kind === 'web') && !list.web_enabled) || list.unavailable) && (
        <p className="lnote dim" role="note">
          {!list.enabled && (
            <>
              {t('rest.layout.scriptOff', { state: t('rest.layout.off.script') })}
              <ScriptSwitch t={t} />{' '}
            </>
          )}
          {list.widgets.some((w) => w.kind === 'web') && !list.web_enabled && t('rest.layout.webOff', { state: t('rest.layout.off.web') })}
          {list.unavailable}
        </p>
      )}
      <div className="ll">
        {shown.map((c) => {
          const approval = needsApproval(c);
          // Ticket 870: a broken widget.toml cannot be approved; its card says to fix the file, and a drop is refused with that line.
          const why = c.user?.error ? c.note : t('rest.layout.needsApproval', { name: c.title });
          return (
            <div
              key={c.kind}
              className="lcard"
              data-card={c.kind}
              data-state={approval ? 'unapproved' : ''}
              tabIndex={0}
              role="group"
              aria-label={t('rest.layout.cardLabel', { name: c.title })}
              onPointerDown={(e) => {
                if ((e.target as Element).closest('button') || e.button !== 0) return;
                e.preventDefault();
                onGrab(e, c.kind, approval ? why : undefined); // an unapproved widget drags too; its drop is refused with the reason
              }}
              data-armed={armed === c.kind ? '' : undefined}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || (e.target as Element).closest('button')) return;
                e.preventDefault();
                if (e.altKey) return approval ? refused(c.kind, why) : document.querySelector('[data-project-path]') ? setArmed(c.kind) : refused(c.kind, t('rest.layout.openTree'));
                approval ? refused(c.kind, why) : onAdd(c.kind);
              }}
            >
              <span className="ic" aria-hidden>
                {glyph(c.kind)}
              </span>
              <span className="tx">
                <b>{c.title}</b>
                <small>{c.note}</small>
              </span>
              {approval && !c.user?.error ? (
                <button className="lneed" onClick={() => setSheet(c.user!.name)}>
                  {t('providers.needsApproval')}
                </button>
              ) : (
                place(c) && <span className="lpl">{place(c)}</span>
              )}
            </div>
          );
        })}
        {chip !== 'builtin' && !q && (
          <button className="lcard ask" onClick={ask}>
            <span className="ic" aria-hidden>
              ✦
            </span>
            <span className="tx">
              <b>{t('rest.layout.ask')}</b>
              <small>{t('rest.layout.askNote')}</small>
            </span>
          </button>
        )}
        {asked && (
          <p className="dim lempty" role="status">
            {asked}
          </p>
        )}
        {!shown.length && (
          <p className="dim lempty" role="status">
            {t('rest.layout.noMatch', { query })}
          </p>
        )}
      </div>
      <div className="trash" data-remove-area>
        {t('rest.layout.dropRemove')}
      </div>
      <p className="sr" role="status">
        {armed ? t('rest.layout.nestHint') : ''}
      </p>
      <div className="lf">{t('rest.layout.footer')}</div>
      {sheet && <PermissionSheet core={core} name={sheet} onClose={() => setSheet(null)} onGranted={() => (setSheet(null), refresh())} />}
    </aside>
  );
}
