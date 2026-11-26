// Composer chips for the session's model and effort (ticket 10; W35 mockup 2, docs/design/model-picker-1120: `Opus 5.5 ↯ ▾`,
// `xHigh · ultracode ▾`). Opening, browsing and closing a menu sends nothing; choosing an item is the click that sends one
// switch_model. Claude's Fast mode (model menu) and Ultracode (effort menu) are toggles on the same request.
import { docT, ErrorDetails, isLowMemory, plainError, rawError, startOp } from '../errors';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKey, type ReactNode } from 'react';
import type { AcpRow, CoreClient } from '../api';
import type { Session } from '../types';
import { blocked } from './blocked';
import { CLAUDE_ORDER, effortLabel, efforts, fastModel, modelLabel, modelText, models, reportedLabel, type Option, type Pick } from './catalog';
import { claudeDefault, familyOf, refreshSeen } from './seenModels';
import { AGENTS, agentName, HANDOFF_EVENT, handOff, lastOf } from '../chat/conversation'; // v2-3b
import { AGENTS_OFF, isOff, modelChoices, MODELS_OFF, useCustomModels, type AgentCli } from '../settings/agents/newDefaults';
import { useFeatureSetting } from '../settings/useFeatureSetting';
import { noteControl } from '../chat/commandRecord';
import { resetTime } from '../chat/LimitBand';
import { seenAt } from '../chat/stopped';
import './picker.css';
import { Icon } from '../icons/Icon';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import { useReported } from '../chat/ContextRing';
import { openSession } from '../tree';

/** Ticket 358: one ACP listing shared by every chip, since a listing runs each approved agent's `--version`. Read on first use,
 *  then only when `again`; a failed read is dropped so the next use reads again. */
let listing: { core: CoreClient; rows: Promise<AcpRow[]> } | undefined;
let listed: AcpRow[] = [];
export function acpRows(core: CoreClient, again: boolean): Promise<AcpRow[]> {
  if (again || listing?.core !== core) {
    const rows = core.acpAgents().then((r) => (listed = r.acp.filter((x) => x.acp && x.state === 'approved')));
    rows.catch(() => listing?.rows === rows && (listing = undefined));
    listing = { core, rows };
  }
  return listing!.rows;
}

type Menu = 'model' | 'effort';
type Row = { id: string; status: string };
/** The core reports a Claude switch as one send row; this is what the window sees of it. */
export type WithLog = Session & { model?: Pick; effort?: Pick; send_log?: Row[] };

export function Picker({ core, session, connected, onReplaced, sessions = [], onManage, disabledReason, running, typed }: { typed?: boolean; running?: string; disabledReason?: string; core: CoreClient; session: Session | null; connected: boolean; onReplaced: (old: string, next: Session) => void; sessions?: Session[]; onManage?: () => void }) {
  const s = session as WithLog | null;
  const t = useHtmlLangT(); // ticket 492: the composer's chips follow the window's language
  const [off] = useFeatureSetting(MODELS_OFF); // ticket 380
  const [agentsOff] = useFeatureSetting(AGENTS_OFF); // ticket 358
  const [open, setOpen] = useState<Menu | null>(null);
  const [more, setMore] = useState(false); // the model menu's "More models ›"
  // More models opens to the menu's right (mockup B2) and flips left only when the window has no room there.
  // With room on neither side (a very narrow window) it opens over the menu, above its row.
  const [flip, setFlip] = useState<'' | 'left' | 'over'>('');
  useLayoutEffect(() => {
    if (!more) return setFlip('');
    const sub = root.current?.querySelector<HTMLElement>('[data-menu="more"]')?.getBoundingClientRect();
    const main = root.current?.querySelector<HTMLElement>('[data-menu="model"]')?.getBoundingClientRect();
    if (!sub || !main || flip || sub.right <= document.documentElement.clientWidth - 8) return;
    setFlip(main.left - sub.width - 10 >= 8 ? 'left' : 'over');
  }, [more, flip]);
  const [confirmFast, setConfirmFast] = useState(false); // a fast toggle restarts Claude: asked once in the menu
  useEffect(() => {
    setMore(false);
    setConfirmFast(false);
  }, [open]);
  const custom = useCustomModels(core, open); // ticket 358: read again as a menu opens
  // Ticket 454: the versions beside the Claude aliases, read when the window has a core and again as a menu opens.
  const [, setVersionsRead] = useState(0);
  useEffect(() => {
    if (connected) void refreshSeen(core).then(() => setVersionsRead((n) => n + 1));
  }, [core, connected, open]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; error: boolean; details?: string; anyway?: () => void } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const model = s?.model ?? null;
  const effort = s?.effort ?? null;
  const ranAt = useReported(s?.id, 'effort'); // look v9 S2-6: the effort the agent reported, when none was picked
  const why = disabledReason ?? blocked(t, s, connected, busy !== null);
  // V2-4b: approved ACP agents join the hand-off group (listed when the model menu opens).
  const [acpAgents, setAcpAgents] = useState<AcpRow[]>(listed);
  useEffect(() => {
    if (open !== 'model' && s?.kind !== 'acp') return;
    // The hand-off group lists what is approved as the menu opens; an ACP chip uses the shared listing and reads it again only
    // when a menu opens on a model the listing lacks (ticket 358).
    const mine = listed.find((r) => r.name === s?.acp_agent)?.models;
    const again = open === 'model' && (s?.kind !== 'acp' || !mine?.some((m) => m.value === s?.model));
    let live = true;
    acpRows(core, again).then(
      (rows) => live && setAcpAgents(rows),
      (e) => live && open === 'model' && setMsg({ text: plainError(docT(), e), error: true, details: rawError(e) }),
    );
    return () => void (live = false);
  }, [core, open, s?.kind, s?.acp_agent, s?.model]);

  // A Claude switch ends when its send row is delivered or failed.
  const row = busy && s?.send_log?.find((r) => r.id === busy);
  useEffect(() => {
    if (!row || !['delivered', 'failed'].includes(row.status)) return;
    setBusy(null);
    setMsg(row.status === 'failed' ? { text: docT()('picker.switchFailed'), error: true } : null);
  }, [row]);
  useEffect(() => {
    setOpen(null);
    setMsg(null);
  }, [s?.id]);
  // B8 (ticket 991): a "why not now" hint goes as soon as it no longer applies (the agent went idle); errors stay until the next pick.
  useEffect(() => setMsg((m) => (m && !m.error && m.text !== why ? null : m)), [why]);
  // A hand-off (from this menu, the palette or a chain link) moves on from this session: its stale message goes.
  useEffect(() => {
    const id = s?.id;
    const on = (e: Event) => (e as CustomEvent<{ from?: string }>).detail?.from === id && setMsg(null);
    window.addEventListener(HANDOFF_EVENT, on);
    return () => window.removeEventListener(HANDOFF_EVENT, on);
  }, [s?.id]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(null);
    // A mouse-opened menu leaves focus in the composer, so Esc is heard here too; it closes one level.
    const esc = (e: KeyboardEvent) => e.code === 'Escape' && !e.isComposing && (more ? setMore(false) : setOpen(null));
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open, more]);
  // Fable SHOULD 1: Claude's own refusal of ultracode shows in the popover, as a failed switch does.
  const note = s?.modes?.note;
  useEffect(() => {
    if (note) setMsg({ text: note, error: true });
  }, [note]);
  // Ticket 1010: and its refusal of fast mode for the account (the mockup's "Fast, account refuses").
  const fastNote = s?.modes?.fast_note;
  useEffect(() => {
    if (fastNote) setMsg({ text: fastNote, error: true });
  }, [fastNote]);

  if (!s || s.kind === 'shell') return null;
  const kind = s.kind;
  // Ticket 358: an ACP session offers the models its agent reported (the core sends only those). The chip shows the running
  // model before the listing arrives, or if it fails; an agent with no model has no chip. Its effort stays the agent's.
  const acp = kind === 'acp' ? acpAgents.find((r) => r.name === s.acp_agent) : undefined;
  const reported = acp?.models ?? [];
  if (kind === 'acp' && !model && !reported.length) return null;
  const who = acp?.label ?? agentName(kind, s.acp_agent);
  const choices: Option[] = kind !== 'acp' ? modelChoices(kind, custom) : model && !reported.some((m) => m.value === model) ? [{ value: model, label: model }, ...reported] : reported;
  // Ticket 358: a switch walks Claude's own picker, which lists only its models, so a custom id is shown under More models, dimmed.
  const switchable = (v: Pick) => kind !== 'claude' || models(kind).some((b) => b.value === v);

  const choose = async (next: { model: Pick; effort: Pick; fast?: boolean; ultracode?: boolean }) => {
    setOpen(null);
    if (next.model === model && next.effort === effort && next.fast === undefined && next.ultracode === undefined) return;
    setMsg(null);
    setBusy('pending');
    // Ticket 1019: Claude records the toggle as a typed command; the chat event drawn now marks where its record comes after.
    const after = seenAt(s.id);
    try {
      const reply = (await core.request({ op: 'switch_model', id: s.id, ...next })) as { type: string; send?: Row; session?: Session };
      if (next.ultracode !== undefined && reply.type === 'delivery') noteControl(s.id, `/effort ultracode ${next.ultracode ? 'on' : 'off'}`, after);
      if (reply.type === 'started' && reply.session) {
        setBusy(null);
        onReplaced(s.id, reply.session);
      } else setBusy(reply.send?.id ?? null);
    } catch (e) {
      setBusy(null);
      setMsg({ text: plainError(docT(), e), error: true, details: rawError(e) });
    }
  };
  const pickModel = (m: Pick) => choose({ model: m, effort: efforts(kind, m).some((e) => e.value === effort) ? effort : null });
  const pickEffort = (e: Pick) => choose({ model, effort: e });
  // Ticket 358: a custom id Claude's picker cannot switch to starts a new Claude session in this folder on it.
  // A low-memory hold offers Start anyway, the same start past it.
  const startOn = async (m: Pick, anyway = false) => {
    setOpen(null);
    setMsg(null);
    try {
      const reply = (await core.request(startOp({ op: 'start', session: { kind, project: s.cwd, model: m, effort: null, resume: null, ...(s.account ? { account: s.account } : {}) } }, anyway))) as { session?: Session };
      if (reply.session) openSession(reply.session.id);
    } catch (e) {
      const held = isLowMemory(e);
      setMsg({ text: held ? docT()('err.lowMemory.agent', { agent: agentName(kind) }) : plainError(docT(), e), error: true, details: rawError(e), anyway: held ? () => void startOn(m, true) : undefined });
    }
  };
  const modes = s.modes ?? {};
  const fastOk = fastModel(model, running);
  const fastOn = modes.fast === true;
  // Ticket 1010: on but paused, as Claude's faint ↯ and its notice say; a paused mark never reads as on.
  const cooldown = fastOn ? modes.fast_cooldown : undefined;
  const fastWord = t(cooldown ? 'pk.fastCooling' : 'pk.fastOn');
  const firstReply = kind === 'claude' && !s.completion_seq;

  // `at`: where the word that gives way ends ("Claude · " of "Claude · Opus", "effort " of "effort high"). Mockup 2: that
  // word is never drawn (picker.css), the chip shows the model or the level; the tooltip and accessible name keep it.
  // `also`: what `after` draws, in words, for the tooltip and the accessible name (Fable SHOULD 4).
  const chip = (menu: Menu, text: string, label: string, at: number, after?: ReactNode, also = '') => (
    <button
      type="button"
      className="chip pk-chip"
      aria-haspopup="menu"
      aria-expanded={open === menu}
      disabled={!!disabledReason}
      aria-disabled={why !== null}
      aria-label={why ? t('rest.shell.picker.ariaWhy', { label, text: text + also, why }) : t('rest.shell.picker.aria', { label, text: text + also })}
      title={why ?? t('mw.picker.onlyThis', { text: text + also, label })} // a refusal reads as itself (cf5-side-chat pin); aria-label keeps the full text
      data-picker={menu}
      // Keeps a Hangul composition in the composer intact: a mouse open does not take focus from it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        if (why) return setMsg({ text: why, error: false });
        setOpen(open === menu ? null : menu);
        if (e.detail === 0) focusLater(menu); // keyboard activation moves focus into the menu
      }}
      onKeyDown={(e) => {
        if (e.code !== 'ArrowDown' && e.code !== 'ArrowUp') return;
        e.preventDefault();
        if (why) return setMsg({ text: why, error: false });
        setOpen(menu);
        focusLater(menu);
      }}
    >
      {/* Look 1117 v6r (C S3-2): the name is drawn second in line order, so it never shares a cut with the word before it. */}
      <span className="pk-text">
        {at > 0 && <span className="pk-agent">{text.slice(0, at)}</span>}
        <span className="pk-name">{text.slice(at)}</span>
      </span>
      {after}{' '}
      <Icon name="triangle-down" size={12} />
    </button>
  );
  const ITEMS = '[role="menuitemradio"], [role="menuitem"], [role="menuitemcheckbox"]';
  const focusLater = (menu: Menu | 'more', pick = '[role="menuitemradio"][aria-checked="true"]') => // never a switch row (SHOULD 5)
    setTimeout(() => {
      const q = (sel: string) => root.current?.querySelector<HTMLElement>(`[data-menu="${menu}"] > :is(${sel})`);
      (q(pick) ?? q(ITEMS))?.focus();
    }, 0);
  const closeTo = (menu: Menu) => {
    setOpen(null);
    root.current?.querySelector<HTMLElement>(`[data-picker="${menu}"]`)?.focus();
  };
  // ↑ ↓ Home End move (wrapping); a digit picks its row at once (physical keys, so a Korean input source changes nothing);
  // Esc closes one level, Tab all; → opens More models, ← closes it.
  const keys = (menu: Menu | 'more') => (e: ReactKey<HTMLUListElement>) => {
    if (menu === 'more') e.stopPropagation(); // Fable MUST 3: the model menu around it must not hear More's keys
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(`:scope > :is(${ITEMS})`)];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.code];
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (to !== undefined) {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    } else if (digit) {
      e.preventDefault();
      e.currentTarget.querySelector<HTMLElement>(`:scope > [data-digit="${digit}"]`)?.click();
    } else if (menu === 'more' && (e.code === 'ArrowLeft' || e.code === 'Escape')) {
      e.preventDefault();
      e.stopPropagation();
      setMore(false);
      root.current?.querySelector<HTMLElement>('[data-item="more"]')?.focus();
    } else if (e.code === 'ArrowRight' && document.activeElement?.getAttribute('data-item') === 'more') {
      e.preventDefault();
      setMore(true);
      focusLater('more', '[role="menuitemradio"], [role="menuitem"]');
    } else if (e.code === 'Escape' || e.code === 'Tab') {
      if (e.code === 'Escape') e.preventDefault();
      closeTo(menu === 'more' ? 'model' : menu);
    }
  };
  const act = (run: () => void) => ({
    tabIndex: -1,
    onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClick: run,
    onKeyDown: (e: ReactKey<HTMLLIElement>) => {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Space') return;
      e.preventDefault();
      run();
    },
  });
  /** A choice row: name, Default pill, tick, digit. */
  const radio = (o: Option, n: number, current: Pick, pick: (v: Pick) => void, extra?: { pill?: ReactNode; value?: string }) => (
    <li key={o.value ?? 'default'} role="menuitemradio" aria-checked={o.value === current} data-digit={n <= 9 ? n : undefined} {...act(() => pick(o.value))}>
      <span className="pk-lab">{o.value === null ? t('mw.picker.defaultRow') : o.label}</span>
      {extra?.value && <span className="pk-val">{extra.value}</span>}
      {extra?.pill}
      <span className="pk-tick" aria-hidden>
        {o.value === current ? '✓' : ''}
      </span>
      {n <= 9 && (
        <span className="pk-key" aria-hidden>
          {n}
        </span>
      )}
    </li>
  );
  const item = (key: string, text: string, run: () => void) => (
    <li key={key} role="menuitem" data-item={key} {...act(run)}>
      <span className="pk-lab">{text}</span>
    </li>
  );
  /** A switch row (Fast mode, Ultracode): on, off, or not read yet (dashed). */
  const toggle = (key: string, text: string, on: boolean | undefined, off: boolean, run: () => void, pill?: ReactNode) => (
    <li key={key} role="menuitemcheckbox" aria-checked={on === undefined ? 'mixed' : on} aria-disabled={off || undefined} data-toggle={key} className={off ? 'pk-dim' : undefined} {...act(() => !off && run())}>
      <span className="pk-lab">{text}</span>
      {pill}
      {on === undefined && <span className="pk-val">{t('pk.notRead')}</span>}
      <span className={`pk-tg${on ? ' on' : ''}${on === undefined ? ' unk' : ''}${off ? ' dis' : ''}`} aria-hidden />
    </li>
  );
  const sep = (key: string) => <li key={key} role="separator" className="pk-sep" />;
  const group = (key: string, text: string) => (
    <li key={key} role="presentation" className="pk-group">
      {text}
    </li>
  );
  /** A note in a menu; `why`: the sentence of the row above it (the mockup's `.why`), set right under that row. */
  const help = (key: string, text: string, why = false) => (
    <li key={key} role="presentation" className={why ? 'pk-help pk-why' : 'pk-help'}>
      {text}
    </li>
  );
  const pill = (text: string, amber = false) => <span className={amber ? 'pk-pill amber' : 'pk-pill'}>{text}</span>;

  // Model menu (frames B, D): Claude lists its four aliases (custom ids under More models, dimmed: Claude's /model walk cannot
  // take them, ticket 358) with the Default pill on the alias a Default session runs as; Codex and ACP list Default and every model.
  // Ticket 380: a model turned off leaves this list, except the one this session runs on.
  const shown = choices.filter((o) => o.value === model || (!isOff(off, kind, o.value, s.acp_agent) && (kind !== 'claude' || o.value !== null)));
  const main = kind === 'claude' ? CLAUDE_ORDER.flatMap((a) => shown.filter((o) => o.value === a)) : shown;
  const yours = kind === 'claude' ? shown.filter((o) => !switchable(o.value)) : [];
  // W35-picker2 S3: the Default pill sits on the model the user's own settings name; the tick on the model this session
  // runs (its reported one when it was started on Default).
  const defaultAlias = kind === 'claude' ? claudeDefault() : '';
  const current = kind === 'claude' && model === null ? (running && familyOf(running)) || null : model;
  const handoffs = kind === 'acp' ? [] : AGENTS.filter((k) => k !== kind && !agentsOff.includes(k as AgentCli));
  const modelMenu = (
    <ul className="pk-menu" role="menu" data-menu="model" aria-label={t('mw.picker.modelMenu')} onKeyDown={keys('model')}>
      {group('who', t('mw.picker.modelGroup', { who }))}
      {main.map((o, i) =>
        radio(o, i + 1, current, (v) => (kind === 'claude' && model === null && v === current ? setOpen(null) : pickModel(v)), {
          pill: (kind === 'claude' ? o.value === defaultAlias : false) && pill(t('mw.picker.defaultRow')),
          value: kind === 'codex' && o.value === null && model === null && running ? reportedLabel(kind, running) : undefined,
        }),
      )}
      {(yours.length > 0 || kind !== 'acp') && (
        <>
          {sep('s1')}
          <li role="menuitem" data-item="more" aria-haspopup="menu" aria-expanded={more} className="pk-more" {...act(() => (setMore(!more), focusLater('more', '[role="menuitemradio"], [role="menuitem"]')))}>
            <span className="pk-lab">{t('pk.more')}</span>
            <span className="pk-chev" aria-hidden>
              ›
            </span>
            {more && (
              <ul className={`pk-menu pk-sub ${flip}`} role="menu" data-menu="more" aria-label={t('pk.more')} onKeyDown={keys('more')} onClick={(e) => e.stopPropagation()}>
                {yours.length > 0 && group('yours', t('pk.yourModels', { who }))}
                {/* Ticket 358: Claude's own picker cannot take an id it does not list, so one starts a new Claude session. */}
                {yours.map((o, i) => radio(o, 10 + i, model, (v) => (v === model ? setOpen(null) : void startOn(v))))}
                {yours.length > 0 && handoffs.length + acpAgents.length > 0 && sep('s2')}
                {/* v2-3b: the hand-off group: choosing one starts nothing (Enter does). */}
                {kind !== 'acp' && group('handoff', t('mw.picker.handoff'))}
                {handoffs.map((k) => {
                  const last = lastOf(k, sessions);
                  // B21 (ticket 991): no model named leaves the model out ("Codex · Default · Default" read as two defaults).
                  const named = modelLabel(k, last?.model ?? null, modelChoices(k, custom));
                  return item(`handoff-${k}`, [agentName(k), named, last?.account ?? t('usage.own')].filter(Boolean).join(' · '), () => {
                    setOpen(null);
                    handOff(s.id, k);
                  });
                })}
                {/* V2-4b: an approved ACP agent; the core starts it (the start checks the approval again) on Enter. */}
                {kind !== 'acp' &&
                  acpAgents.map((r) =>
                    item(`handoff-acp:${r.name}`, `${r.label} · ACP`, () => {
                      setOpen(null);
                      handOff(s.id, 'acp', r.name);
                    }),
                  )}
                {kind !== 'acp' && item('manage', 'Add or manage agents…', () => (setOpen(null), onManage?.()))}
              </ul>
            )}
          </li>
        </>
      )}
      {/* Fast mode, Claude only, per session: a toggle restarts Claude into this conversation (its /fast would save the
          user's default for every session), after one confirm here. Off a fast model it is disabled with the reason. */}
      {kind === 'claude' && (
        <>
          {sep('s3')}
          {group('fast', t('pk.fastGroup'))}
          {toggle('fast', t('pk.fastEnable'), fastOn, (!fastOk && !fastOn) || firstReply, () => (typed ? (setConfirmFast(true), focusLater('model', '[data-item="fast-restart"]')) : void choose({ model, effort, fast: !fastOn })), fastOn && pill(t('pk.credits'), true))}
          {/* Ticket 1010: Claude's own words under the switch: why it turned fast mode off, or the pause and its end. */}
          {!fastOn && modes.fast_note && help('fast-note', modes.fast_note, true)}
          {cooldown && help('fast-cooldown', !cooldown.text ? t('pk.fastCooldown') : cooldown.until ? t('pk.fastCooldownUntil', { why: cooldown.text, time: resetTime(cooldown.until) }) : cooldown.text, true)}
          {/* Codex round-6 MUST: before the first reply there is no conversation to resume (the core refuses too). */}
          {!fastOk && !fastOn ? help('fast-why', t('pk.fastWrongModel'), true) : firstReply ? help('fast-first', t('pk.fastFirstReply')) : help('fast-restart-why', t('pk.fastRestart'))}
          {/* A draft in the window's box: one confirm first, as the restart replaces this session's tab. */}
          {confirmFast && help('fast-draft', t('pk.fastDraft'))}
          {confirmFast && item('fast-restart', t('pk.fastRestartGo'), () => void choose({ model, effort, fast: !fastOn }))}
        </>
      )}
    </ul>
  );

  // Effort menu (frames C, D): Claude's levels with the Ultracode toggle; Codex's per-model reasoning levels ("ultra" is a
  // level); an ACP agent's listed thought levels only (ticket 994).
  const acpEfforts = acp?.efforts ?? [];
  const levels: Option[] = kind === 'acp' ? acpEfforts : efforts(kind, model).filter((o) => kind !== 'claude' || o.value !== null);
  const fastest = kind === 'claude' ? 'max' : 'ultra';
  const effortMenu = (
    <ul className="pk-menu pk-effort" role="menu" data-menu="effort" aria-label={t('mw.picker.effortMenu')} onKeyDown={keys('effort')}>
      {kind === 'claude' && help('help', t('pk.effortHelp'))}
      {kind === 'codex' && group('reasoning', t('pk.reasoning'))}
      {kind === 'codex' && help('help', t('pk.codexHelp'))}
      {kind === 'acp' && group('thinking', t('pk.thinking'))}
      {levels.map((o, i) => radio(o, i + 1, effort ?? (ranAt || null), pickEffort, /* S3: the reported level ticks too */ { pill: kind !== 'acp' && o.value === fastest && pill(`⚠ ${t('pk.fastest')}`, true) }))}
      {kind === 'claude' && (
        <>
          {sep('s1')}
          {toggle('ultracode', 'Ultracode', modes.ultracode, false, () => void choose({ model, effort, ultracode: modes.ultracode !== true }))}
          {modes.ultracode === true && help('ultra-why', t('pk.ultracodeOn'))}
          {modes.note && help('ultra-note', modes.note)}
        </>
      )}
    </ul>
  );

  const effortWord = effort ? effortLabel(kind, model, effort) : kind === 'acp' ? '' : ranAt || t('mw.picker.default');
  const acpWord = kind === 'acp' ? (acpEfforts.find((e) => e.value === effort)?.label ?? effort ?? '') : '';
  const word = kind === 'acp' ? acpWord : effortWord;
  const effortText = t('mw.picker.effortChip', { level: word });
  const hasEffort = kind !== 'acp' || (acpEfforts.length > 0 && !!word);
  return (
    <div className="pk" ref={root}>
      {msg && (
        <span className="pk-msg" role="status" data-error={msg.error || undefined}>
          <span className="pk-msg-t">{msg.text}</span>
          {msg.anyway && (
            <button type="button" className="btn" data-tip={docT()('err.startAnyway.tip')} onClick={msg.anyway}>
              {docT()('err.startAnyway')}
            </button>
          )}
          <ErrorDetails t={docT()} details={msg.details} />
        </span>
      )}
      {busy && (
        <span className="pk-msg" role="status">
          {t('mw.picker.switching')}
        </span>
      )}
      <span className="pk-anchor">
        {(() => {
          const text = modelText(who, kind, model, choices, running);
          return chip('model', text, t('mw.picker.model'), text.includes(' · ') ? text.indexOf(' · ') + 3 : 0, fastOn && kind === 'claude' && (
            <span className={cooldown ? 'pk-fast cooling' : 'pk-fast'} title={fastWord} aria-label={fastWord}>
              ↯
            </span>
          ), fastOn && kind === 'claude' ? ` · ${fastWord}` : '');
        })()}
        {open === 'model' && modelMenu}
      </span>
      {hasEffort && (
        <span className="pk-anchor">
          {chip('effort', effortText, t('mw.picker.effort'), Math.max(0, effortText.lastIndexOf(word)), modes.ultracode === true && kind === 'claude' && <span className="pk-ultra"> · ultracode</span>, modes.ultracode === true && kind === 'claude' ? ' · ultracode' : '')}
          {open === 'effort' && effortMenu}
        </span>
      )}
    </div>
  );
}
