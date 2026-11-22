// Settings · Keyboard (needs 54, 166): every action is a command, bound to a direct chord or a key after the prefix.
// Page A (owner 2026-11-01): one scrollable list with the prefix row first, area headers that stick, press-to-record in the
// row, second bindings as "or", a search with a Record toggle and four filter chips. Ticket 250 (final draft, needs 192):
// hints are one shortcut's options, so they are the page's last part, reached from the Options link on that row.
import { PLAIN } from '../../plainText';
import { useEffect, useRef, useState } from 'react';
import { KeyChip, PrefixChip } from '../../KeyChip';
import type { Key } from '../../i18n';
import { apart, AREAS, areaOf, captureKeys, DEFAULT_BINDINGS, JUMPS, PROJECT_JUMPS, chordOf, composing, isModifier, label, merge, PREFIX_SYMBOL, RESET_CHORD, type Bindings, type Command } from '../../keys';
import { DEFAULTS, fieldCommand, HELP_DELAY_MAX, isHelpDelay, type Settings } from '../../settings';
import { Icon } from '../../icons/Icon';
import type { IconName } from '../../icons/Icon';
import { push as pushUndo } from '../../undo/store';
import { commandTitle, has } from '../../i18n/lib/commandTitle';
import { PageActions, PageSummary } from '../shell/PageActions';
import { StrokeIcon } from '../shell/NavIcon';
import { Reset, Row as SRow, Sec, Stepper } from '../shell/Row';
import { HintsSection } from './HintsSection';
import { resetClash, withBindings, withDefaults, withSlot } from './apply';
import { Caps, RecordingCells, ResetAsk } from './Recorder';
import './keys-list.css';

type T = (key: Key, args?: Record<string, string | number>) => string;

/** The key table's old key-map click asks the list to scroll to a command's row (detail: the command id); kept for the pins. */
const JUMP_EVENT = 'nunchiro:keys.jump';
/** The hints part's heading: the Options link on the hints row lands here. */
const HINTS_ID = 'keys-hints';
const toHints = () => {
  const h = document.getElementById(HINTS_ID);
  // Only the settings body scrolls: scrollIntoView also moved the window's own panels when the part sat near the end.
  const body = h?.closest<HTMLElement>('.sbody');
  if (h && body) body.scrollTop += h.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
  h?.focus({ preventScroll: true });
};
const FILTERS = ['all', 'changed', 'conflicts', 'none'] as const;
type Filter = (typeof FILTERS)[number];

export function KeysPage({ t, settings, commands, update }: { t: T; settings: Settings; commands: Command[]; update: (patch: Partial<Settings>) => void }) {
  const hintsShow = merge(settings.bindings)['hints.show']?.[0] ?? '';
  const [ofBefore, ofAfter] = t('settings.keys.optionsOf', { keys: '\u0001' }).split('\u0001');
  return (
    <div className="keys-page">
      {/* The page title is the h1; this keeps the area headings (h3) one level below a heading. */}
      <h2 className="sr">{t('settings.kbd.shortcuts')}</h2>
      <Shortcuts t={t} settings={settings} commands={commands} update={update} />
      <h2 className="part" id={HINTS_ID} tabIndex={-1}>
        <Icon name="search" size={14} /> {t('settings.hints')} {hintsShow && <span>{ofBefore}<Chord binding={hintsShow} bindings={settings.bindings} />{ofAfter}</span>}
      </h2>
      <HintsSection t={t} settings={settings} update={update} />
    </div>
  );
}

/** Ticket 250 r3: a binding as key caps (the prefix chip, ›, the next key), not the words of `label`. */
export function Chord({ binding, bindings }: { binding: string; bindings: Bindings }) {
  if (!binding.startsWith('prefix ')) return <KeyChip binding={binding} bindings={bindings} />;
  return (
    // Ticket 991 C19: one unit, so a line never breaks between the prefix and its key (a lone "?" on the next line).
    <span className="kchord">
      <PrefixChip bindings={merge(bindings)} /> <KeyChip binding={binding.slice(7)} bindings={bindings} />
    </span>
  );
}

/** A list row: one command, or the nine tab jumps, which move together (V1A-56). */
type Row = { id: string; title: string; ids: string[] };
// The row's title is the first jump's `group` (rowsOf); rows are told apart by id.
// Ticket 570: the project jumps are a second row of the same kind.
const JUMP_ROWS = [
  { id: 'session.jump', ids: JUMPS },
  { id: 'project.jump', ids: PROJECT_JUMPS },
];
const jumpOf = (id: string) => JUMP_ROWS.find((r) => r.id === id || r.ids.includes(id));
const digit = (b: string, n: number) => b.replace(/Digit[1-9]$/, `Digit${n}`);
/** final.html: the four focus directions are one row while they follow the arrows together; bound apart, they stay four rows. */
const FOCUS_ROW = { id: 'pane.focus', ids: ['left', 'right', 'up', 'down'].map((d) => `pane.focus.${d}`) };
const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const arrow = (b: string, i: number) => b.replace(/Arrow\w+$/, ARROWS[i]);
/** final.html: hand-off is one row while no agent has its own key; Change opens it into a row per agent, which take the key. */
const HANDOFF = 'handoff';
/** One binding as stored for the row's i-th id. */
const spread = (row: Row, b: string, i: number) => (jumpOf(row.id) ? digit(b, i + 1) : row.id === FOCUS_ROW.id ? arrow(b, i) : b);
/** final.html KEYGROUPS: the rows' order; a command the draft does not name follows them in its area. */
const ORDER = 'palette.open settings.open keys.help hints.show window.detach session.new worktree.create session.next session.prev session.last session.jump project.jump waiting.next decision.back tab.rename tab.move.left tab.move.right tab.close tab.close.others handoff composer.steerNow composer.backgroundSend composer.toggle chat.cycleView split.right split.down split.close pane.toggle pane.maximize zone.zoom pane.mode layout.edit focus.tree focus.composer focus.terminal pane.focus sidebar.left.toggle files.show files.quickOpen search.open diff.open artifacts.toggle board.toggle preview.toggle projects.pick project.add terminal.find terminal.copy hints.copy terminal.edit font.bigger font.smaller font.reset'.split(' ');
const rank = (r: Row) => (ORDER.indexOf(r.id) + 1 || ORDER.length + 1);
// Octicons nearest the draft's hand-drawn group icons (the app's icon set is Octicons only).
const AREA_ICONS: IconName[] = ['search', 'person', 'pencil', 'project', 'apps', 'browser', 'terminal', 'code', 'list-unordered']; // in AREAS order

/** Rows of the list; `settings.<page>.<field>` palette entries stay in the palette (V1A-57), and so do the menu-only commands
 *  (`enabled: false` with an `enabledFor` and no default key: they need a right-clicked row's target, so no key could run them;
 *  a command with a default key, like Reopen closed tab, stays listed while it is off, so its key can be rebound). */
function rowsOf(commands: Command[], name: (id: string, title: string) => string): Row[] {
  return commands.flatMap((c) => (JUMP_ROWS.some((r) => r.ids[0] === c.id) ? [{ ...jumpOf(c.id)!, title: name(jumpOf(c.id)!.id, c.group ?? c.title) }] : jumpOf(c.id) || fieldCommand(c.id) || (c.enabledFor && c.enabled === false && !DEFAULT_BINDINGS[c.id]) ? [] : [{ id: c.id, title: name(c.id, c.title), ids: [c.id] }]));
}

/** The latest overrides, for Reset all's Undo: module-level because the Undo can run after this page was left and reopened. */
let liveOverrides: Bindings = {};

function Shortcuts({ t, settings, commands, update }: { t: T; settings: Settings; commands: Command[]; update: (patch: Partial<Settings>) => void }) {
  const overrides = settings.bindings;
  liveOverrides = overrides;
  const bindings = merge(overrides);
  const onChange = (b: Bindings) => update({ bindings: b });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // V1A-57: a pressed chord filters to the rows bound to it (a key after the prefix matches by that key).
  const [findKey, setFindKey] = useState<string | 'capturing' | null>(null);
  const key = findKey !== 'capturing' ? findKey : null;
  // The row being recorded and where the focus goes back to: its Change button, or the row when Enter started it.
  const [rec, setRec] = useState<{ id: string; slot: number | 'new'; from: 'row' | 'button' } | null>(null);
  // A reset whose default another command took since: asks Replace first, as a recording does.
  const [ask, setAsk] = useState<{ id: string; clash: string[]; taken: string[] } | null>(null);
  const back = useRef<{ id: string; to: 'row' | 'button' } | null>(null);
  const [splitHandoff, setSplitHandoff] = useState(false);
  useEffect(() => {
    if (!back.current) return;
    const { id, to } = back.current;
    const row = document.querySelector<HTMLElement>(`.keys-page [data-command="${id}"]`);
    (to === 'row' ? row : row?.querySelector<HTMLElement>('button.kedit, button.kchange'))?.focus();
    back.current = null;
  });
  const close = (id: string) => {
    back.current = { id, to: rec?.from ?? 'button' };
    setRec(null);
    setAsk(null);
  };

  // The keyboard's old key click (JUMP_EVENT): scroll to the row and mark it; a filter that hides it is cleared, and said.
  const [jump, setJump] = useState<{ id: string; n: number } | null>(null);
  const [cleared, setCleared] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setJump((j) => ({ id: (e as CustomEvent<string>).detail, n: (j?.n ?? 0) + 1 }));
    window.addEventListener(JUMP_EVENT, on);
    return () => window.removeEventListener(JUMP_EVENT, on);
  }, []);
  useEffect(() => {
    if (!jump) return;
    const row = all.find((r) => r.ids.includes(jump.id))?.id ?? jump.id;
    const filtered = !!query || !!key || filter !== 'all';
    setQuery('');
    setFindKey(null);
    setFilter('all');
    setCleared(filtered ? t('settings.keys.cleared', { title: jumpOf(row) ? (commands.find((c) => c.id === jumpOf(row)!.ids[0])?.group ?? row) : (commands.find((c) => c.id === row)?.title ?? row) }) : null);
    const hide = filtered ? setTimeout(() => setCleared(null), 5000) : 0;
    let frame = 0;
    const until = performance.now() + 1000;
    const find = () => {
      const el = document.querySelector<HTMLElement>(`.keys-page [data-command="${row}"]`);
      if (!el) return void (performance.now() < until && (frame = requestAnimationFrame(find)));
      el.scrollIntoView({ block: 'center' });
      el.dataset.jump = 'true';
      setTimeout(() => delete el.dataset.jump, 2500);
    };
    find();
    return () => (cancelAnimationFrame(frame), clearTimeout(hide));
  }, [jump]);
  useEffect(() => {
    if (findKey !== 'capturing') return;
    const end = captureKeys();
    const onKey = (e: KeyboardEvent) => {
      if (composing(e) || isModifier(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      if (chordOf(e) === RESET_CHORD) return;
      setFindKey(e.code === 'Escape' && !e.ctrlKey && !e.metaKey ? null : chordOf(e));
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      end();
      window.removeEventListener('keydown', onKey, true);
    };
  }, [findKey]);

  const name = (id: string, title: string) => commandTitle(t, id, title);
  const titleOf = (id: string) => (id === 'prefix' ? t('settings.kbd.prefixHead') : name(id, commands.find((c) => c.id === id)?.title ?? id));
  const prefixRow: Row = { id: 'prefix', title: t('settings.kbd.prefixTitle'), ids: ['prefix'] };
  const listed = rowsOf(commands, name);
  const leftKeys = bindings[FOCUS_ROW.ids[0]] ?? [];
  const foldFocus = leftKeys.every((b) => /ArrowLeft$/.test(b)) && FOCUS_ROW.ids.every((id, i) => (bindings[id] ?? []).join() === leftKeys.map((b) => arrow(b, i)).join());
  const handoffs = listed.filter((r) => r.id.startsWith('handoff.'));
  const foldHandoff = handoffs.length > 0 && !splitHandoff && !handoffs.some((r) => bindings[r.id]?.length);
  const all = [
    ...listed.filter((r) => !(foldFocus && FOCUS_ROW.ids.includes(r.id)) && !(foldHandoff && handoffs.includes(r))),
    ...(foldFocus ? [{ ...FOCUS_ROW, title: name(FOCUS_ROW.id, FOCUS_ROW.id) }] : []),
    ...(foldHandoff ? [{ id: HANDOFF, title: name(HANDOFF, HANDOFF), ids: handoffs.map((r) => r.id) }] : []),
  ].sort((a, b) => rank(a) - rank(b));
  const slotsOf = (row: Row) => bindings[row.ids[0]] ?? [];
  const changedRow = (r: Row) => r.ids.some((id) => id in overrides);
  const unbound = (r: Row) => !r.ids.some((id) => bindings[id]?.length);
  /** Rows that share a binding with another row (the jump row counts as one row). */
  const held = new Map<string, Set<string>>();
  for (const [id, bs] of Object.entries(bindings)) for (const b of bs) held.set(b, (held.get(b) ?? new Set()).add(jumpOf(id)?.id ?? (foldFocus && FOCUS_ROW.ids.includes(id) ? FOCUS_ROW.id : id)));
  const shares = (r: Row) => r.ids.some((id) => bindings[id]?.some((b) => [...(held.get(b) ?? [])].some((o) => o !== r.id && !apart(o, id))));
  const inFilter = (r: Row, f: Filter) => f === 'all' || (f === 'changed' ? changedRow(r) : f === 'conflicts' ? shares(r) : unbound(r));
  const shown = (r: Row) =>
    (!query || `${r.ids.join(' ')} ${r.title}`.toLowerCase().includes(query.toLowerCase())) &&
    (!key || r.ids.some((id) => bindings[id]?.some((b) => b === key || b === `prefix ${key}`))) &&
    inFilter(r, filter);
  const prefixShown = shown(prefixRow);
  const rows = all.filter(shown);
  // The owner D1 2026-11-06 (ticket 223 B15): each chip counts its rows over every action, whatever the search or key.
  const counts = Object.fromEntries(FILTERS.map((f) => [f, [prefixRow, ...all].filter((r) => inFilter(r, f)).length])) as Record<Filter, number>;
  const filtering = !!query || !!key || filter !== 'all';
  const clearFilters = () => (setQuery(''), setFindKey(null), setFilter('all'));

  // What a row stores for one binding, and how a row's bindings are written back.
  const expand = (row: Row) => (b: string) => row.ids.map((_, i) => spread(row, b, i));
  const stored = (row: Row, list: string[]): Bindings => Object.fromEntries(row.ids.map((id, i) => [id, list.map((b) => spread(row, b, i))]));
  /** Writes a row's bindings; a command that held one of them loses it (Replace). */
  const apply = (row: Row, list: string[], clash: string[]) => {
    onChange(withBindings(overrides, bindings, stored(row, list), clash));
    close(row.id);
  };
  const save = (row: Row, slot: number | 'new', binding: string, clash: string[]) => apply(row, withSlot(slotsOf(row), slot, binding), clash);
  const remove = (row: Row, slot: number) => apply(row, slotsOf(row).filter((_, i) => i !== slot), []);
  /** Reset: the row's own defaults back (every one). One another command took since asks first. */
  const reset = (row: Row) => {
    const { clash, taken } = resetClash(bindings, row.id, row.ids);
    if (clash.length) return setAsk({ id: row.id, clash, taken }), setRec(null);
    doReset(row, [], taken);
  };
  const doReset = (row: Row, clash: string[], taken: string[]) => {
    onChange(withDefaults(overrides, bindings, row.ids, clash, taken));
    close(row.id);
  };
  const start = (row: Row, slot: number | 'new', from: 'row' | 'button') => {
    if (row.id === HANDOFF) return (back.current = { id: row.ids[0], to: from }), setSplitHandoff(true);
    setAsk(null);
    setRec({ id: row.id, slot, from });
  };
  const resetAll = () => {
    const was = overrides;
    setRec(null);
    setAsk(null);
    onChange({});
    // Everything in the overrides now was set after the reset, so it wins over the snapshot.
    pushUndo({ label: t('settings.kbd.resetAllDone'), undo: () => onChange({ ...was, ...liveOverrides }) });
  };

  /** The jump row reads `⌘1-9` only when its nine bindings agree; otherwise the tabs differ and the row says so. */
  const tabsAgree = (row: Row, slots: string[]) => row.ids.every((id, i) => (bindings[id] ?? []).length === slots.length && slots.every((b, k) => bindings[id][k] === digit(b, i + 1)));
  const caps = (row: Row) => {
    const slots = slotsOf(row);
    if (!slots.length) return <span className="dim knokey">{t('settings.keys.none')}</span>;
    const agree = !jumpOf(row.id) || tabsAgree(row, slots);
    return (
      <>
        {slots.map((b, i) => (
          <span key={b + i}>
            {i > 0 && <span className="kor dim"> {t('settings.kbd.or')} </span>}
            <span className="kslot" data-slot={i} role="button" tabIndex={-1} onClick={() => start(row, i, 'button')}>
              <Caps binding={b} bindings={bindings} jump={!!jumpOf(row.id) && agree} arrows={row.id === FOCUS_ROW.id} />
            </span>
          </span>
        ))}
        {!agree && <span className="conflict warn"> {t('settings.keys.tabsDiffer')}</span>}
      </>
    );
  };
  const rowView = (row: Row) => {
    const recording = rec?.id === row.id ? rec : null;
    const slots = slotsOf(row);
    const asking = ask?.id === row.id ? ask : null;
    const isPrefix = row.id === 'prefix';
    const defaultText = isPrefix ? (DEFAULT_BINDINGS.prefix ?? []).map((b) => label(b)).join(` ${t('settings.kbd.or')} `) : '';
    return (
      <tr
        key={row.id}
        data-command={row.id}
        data-recording={recording ? '' : undefined}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget && !recording) start(row, slots.length ? 0 : 'new', 'row');
        }}
      >
        <td title={row.ids.length > 1 ? `${row.ids[0]} .. ${row.ids[row.ids.length - 1]}` : row.id}>
          {/* The prefix row is the legend: its symbol stands before every key that follows the prefix. */}
          {isPrefix && (
            <span className="kbd ksym" aria-hidden>
              {PREFIX_SYMBOL}
            </span>
          )}
          <span className="ktitle">{row.title}</span>
          {row.id === 'hints.show' && (
            <button className="kopts" onClick={toHints}>
              {t('settings.keys.options')}
            </button>
          )}
          {has(`settings.kbd.desc.${row.id}`) && <span className="kds">{t(`settings.kbd.desc.${row.id}` as Key)}</span>}
          {changedRow(row) && <span className="ov">{isPrefix ? t('settings.kbd.changedDefault', { keys: defaultText }) : t('settings.keys.changed')}</span>}
        </td>
        {recording ? (
          <RecordingCells
            t={t}
            row={row}
            bindings={bindings}
            current={recording.slot === 'new' ? null : (slots[recording.slot] ?? null)}
            titleOf={titleOf}
            expand={expand(row)}
            onSave={(b, clash) => save(row, recording.slot, b, clash)}
            onCancel={() => close(row.id)}
            onRemove={typeof recording.slot === 'number' && (!isPrefix || slots.length > 1) ? () => remove(row, recording.slot as number) : null}
            prefixRow={isPrefix}
            jump={!!jumpOf(row.id)}
            arrows={row.id === FOCUS_ROW.id}
          />
        ) : asking ? (
          <>
            <td>
              <ResetAsk t={t} id={row.id} bindings={bindings} ask={asking} titleOf={titleOf} onReplace={() => doReset(row, asking.clash, asking.taken)} onCancel={() => close(row.id)} />
            </td>
            <td className="kact" />
          </>
        ) : (
          <>
            <td className="kcell">
              {/* final.html: the keys end at the pencil, so the row's other actions sit left of them; + shows on hover or focus. */}
              <span className="kmore">
                {changedRow(row) && (
                  <button className="kreset" aria-label={t('settings.kbd.reset', { title: row.title })} onClick={() => reset(row)}>
                    <StrokeIcon name="undo" size={12} />
                  </button>
                )}
                <button className="kadd" aria-label={t('settings.kbd.add', { title: row.title })} onClick={() => start(row, 'new', 'button')}>
                  <Icon name="plus" size={12} />
                </button>
              </span>
              {caps(row)}
            </td>
            <td className="kact">
              <button className="kedit" aria-label={t('settings.kbd.change', { title: row.title })} onClick={() => start(row, slots.length ? 0 : 'new', 'button')}>
                <Icon name="pencil" size={12} />
              </button>
            </td>
          </>
        )}
      </tr>
    );
  };
  const table = (head: string, id: string, list: Row[], icon: IconName) => (
    <section key={id} data-area={id} aria-labelledby={`keys-${id}`} className="karea">
      <h3 id={`keys-${id}`} className="khead">
        <Icon name={icon} size={12} /> {head}
      </h3>
      <div className="scard">
        <table className="klist">
          <colgroup>
            <col className="kc-title" />
            <col />
            <col className="kc-act" />
          </colgroup>
          <tbody>{list.map(rowView)}</tbody>
        </table>
      </div>
    </section>
  );
  const none = !prefixShown && !rows.length;
  const prefixEdit = rec?.id === prefixRow.id || ask?.id === prefixRow.id;
  const example = bindings['session.new']?.find((b) => b.startsWith('prefix '));
  // The palette title ends in an ellipsis; inside this sentence it read as cut-off text before the full stop.
  const [exBefore, exAfter] = t('settings.kbd.prefixExample', { keys: '\u0001', title: titleOf('session.new').replace(/(\.\.\.|…)$/, '') }).split('\u0001');
  return (
    <>
      <PageSummary parts={[[t('summary.shortcuts'), counts.all], [t('summary.changed'), counts.changed], [t('summary.conflicts'), counts.conflicts || null]]} />
      <PageActions>
        <button className="btn" disabled={!Object.keys(overrides).length} data-idle={!Object.keys(overrides).length || undefined} onClick={resetAll}>
          {t('settings.kbd.resetAll')}
        </button>
      </PageActions>
      {(prefixShown || !filtering) && (
        <section data-area="prefix" aria-label={t('settings.kbd.prefixHead')} className="karea ssec">
          <div className="scard">
            {prefixShown &&
              (prefixEdit ? (
                <table className="klist">
                  <colgroup>
                    <col className="kc-title" />
                    <col />
                    <col className="kc-act" />
                  </colgroup>
                  <tbody>{rowView(prefixRow)}</tbody>
                </table>
              ) : (
                <div className="kpfx" data-command={prefixRow.id}>
                  <div className="kcell">{caps(prefixRow)}</div>
                  <div className="kpfx-text">
                    <div className="snm">
                      {t('settings.kbd.prefixHead')}
                      {changedRow(prefixRow) && <span className="ov">{t('settings.kbd.changedDefault', { keys: (DEFAULT_BINDINGS.prefix ?? []).map((b) => label(b)).join(` ${t('settings.kbd.or')} `) })}</span>}
                    </div>
                    <div className="sds">
                      {t('settings.kbd.prefixDesc')}{' '}
                      {example && (
                        <>
                          {exBefore}
                          <Caps binding={example} bindings={bindings} />
                          {exAfter}
                        </>
                      )}
                    </div>
                  </div>
                  <span className="kbtns">
                    <button className="btn kchange" aria-label={t('settings.kbd.change', { title: prefixRow.title })} onClick={() => start(prefixRow, 0, 'button')}>
                      {t('settings.kbd.changeBtn')}
                    </button>
                    {changedRow(prefixRow) && (
                      <button className="kreset" aria-label={t('settings.kbd.reset', { title: prefixRow.title })} onClick={() => reset(prefixRow)}>
                        <StrokeIcon name="undo" size={12} />
                      </button>
                    )}
                  </span>
                </div>
              ))}
            {/* Ticket 250 r3 (final.html): the pause before the next-key list sits with the prefix, in its card. */}
            {!filtering && (
              <SRow
                label={t('settings.row.helpDelay')}
                desc={
                  <>
                    {t('settings.row.helpDelayDesc')} <Chord binding={bindings['keys.help']?.[0] ?? ''} bindings={bindings} />
                  </>
                }
                reset={<Reset t={t} label={t('settings.row.helpDelay')} show={settings.prefixHelpDelay !== DEFAULTS.prefixHelpDelay} run={() => update({ prefixHelpDelay: DEFAULTS.prefixHelpDelay })} />}
                control={<Stepper t={t} setting="prefixHelpDelay" label={t('settings.keys.helpDelay')} min={0} max={HELP_DELAY_MAX} step={1} inc={50} unit="ms" value={settings.prefixHelpDelay} onChange={(n) => isHelpDelay(n) && update({ prefixHelpDelay: n })} />}
              />
            )}
          </div>
        </section>
      )}
      <section aria-label={t('settings.kbd.shortcuts')} className="kshort">
      <div className="kbar">
        <div className="ksearch field-box">
          <Icon name="search" size={12} />
          <input {...PLAIN} type="search" placeholder={t('settings.kbd.searchPh')} aria-label={t('settings.kbd.searchPh')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className="krecord" aria-pressed={findKey === 'capturing'} title={t('settings.kbd.recordTip')} onClick={() => setFindKey(findKey === 'capturing' ? null : 'capturing')}>
          {t('settings.kbd.record')}
        </button>
        <div className="kchips" role="group" aria-label={t('settings.kbd.filters')}>
          {FILTERS.map((f) => (
            <button key={f} className="kchip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {t(f === 'all' ? 'settings.kbd.fAll' : f === 'changed' ? 'settings.kbd.fChanged' : f === 'conflicts' ? 'settings.kbd.fConflicts' : 'settings.kbd.fNone')}{' '}
              <span className={`kcount${f === 'conflicts' && counts[f] ? ' warn' : ''}`}>{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>
      {(findKey === 'capturing' || key || cleared) && (
        <p className="kfind" role="status">
          {findKey === 'capturing' && <span className="kbd capture">{t('settings.keys.pressOne')}</span>}
          {cleared}
          {key && (
            <>
              {t('settings.keys.boundTo')} <span className="kbd">{label(key)}</span>{' '}
              <button className="btn" onClick={() => setFindKey(null)}>
                {t('settings.keys.clearKey')}
              </button>
            </>
          )}
        </p>
      )}
      <div data-keys-list>
        {AREAS.map((area, n) => {
          const here = rows.filter((r) => areaOf(r.ids[0]) === area);
          const slug = area.replace(/\W+/g, '-').toLowerCase();
          return here.length ? table(has(`settings.kbd.area.${slug}`) ? t(`settings.kbd.area.${slug}` as Key) : area, slug, here, AREA_ICONS[n]) : null;
        })}
        {none && (
          <div className="knone" role="status">
            <p>{t('settings.kbd.noMatch')}</p>
            <button className="btn" onClick={clearFilters}>
              {t('settings.kbd.clearFilters')}
            </button>
          </div>
        )}
      </div>
      </section>
      {!filtering && (
        <Sec id="keys-fixed" title={t('settings.kbd.fixedHead')}>
          <SRow
            label={t('settings.kbd.modesTitle')}
            desc={t('settings.kbd.modesDesc')}
            control={
              <span className="kcaps">
                {['←', '→', '↑', '↓', 'Esc'].map((k) => (
                  <span key={k} className="kbd">
                    {k}
                  </span>
                ))}
              </span>
            }
          />
          <SRow label={t('settings.kbd.resetAllTitle')} desc={t('settings.kbd.resetAllDesc')} control={<span className="kbd">⌃⌥⇧Esc</span>} />
        </Sec>
      )}
    </>
  );
}
