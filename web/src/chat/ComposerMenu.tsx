// CHAT-MENUS (needs 121): the composer's `/` (commands and skills) and `@` (files) menus. They are GUI entry points to the
// agent CLI's own features: picking writes `/name ` or `@path ` into the textarea and stops there; the user sends it.
// Reads go through the core's read-only file ops (files_list, files_search) on the session's own folder. Nothing is written.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import { listDir, type Entry } from '../files/api';
import { ChromeIcon } from '../chrome/icons';
import type { Key, T } from '../i18n';
import type { Session } from '../types';
import { promptEntries, stepPromptHistory, type PromptPosition } from './promptHistory';
import './composer-menu.css';

type Item = { label: string; hint: Key | ''; insert: string; keep?: boolean; file?: boolean; description?: string };
type Open = { kind: 'slash' | 'at'; start: number; end: number; q: string };

const b = (name: string, hint: Key): Item => ({ label: `/${name}`, hint, insert: `/${name} ` });

// shortcut: fixed lists of the CLIs' own commands (not read from the CLI), upgrade when the core can ask the agent.
const BUILTIN: Record<string, Item[]> = {
  claude: [
    b('add-dir', 'composer.cmd.claude.add-dir'),
    b('agents', 'composer.cmd.claude.agents'),
    b('btw', 'composer.cmd.claude.btw'),
    b('clear', 'composer.cmd.claude.clear'),
    b('code-review', 'composer.cmd.claude.code-review'),
    b('compact', 'composer.cmd.claude.compact'),
    b('config', 'composer.cmd.claude.config'),
    b('context', 'composer.cmd.claude.context'),
    b('cost', 'composer.cmd.claude.cost'),
    b('doctor', 'composer.cmd.claude.doctor'),
    b('help', 'composer.cmd.claude.help'),
    b('hooks', 'composer.cmd.claude.hooks'),
    b('init', 'composer.cmd.claude.init'),
    b('mcp', 'composer.cmd.claude.mcp'),
    b('memory', 'composer.cmd.claude.memory'),
    b('model', 'composer.cmd.claude.model'),
    b('permissions', 'composer.cmd.claude.permissions'),
    b('resume', 'composer.cmd.claude.resume'),
    b('review', 'composer.cmd.claude.review'),
    b('rewind', 'composer.cmd.claude.rewind'),
    b('security-review', 'composer.cmd.claude.security-review'),
    b('status', 'composer.cmd.claude.status'),
  ],
  codex: [
    b('approvals', 'composer.cmd.codex.approvals'),
    b('compact', 'composer.cmd.codex.compact'),
    b('diff', 'composer.cmd.codex.diff'),
    b('fork', 'composer.cmd.codex.fork'),
    b('init', 'composer.cmd.codex.init'),
    b('mcp', 'composer.cmd.codex.mcp'),
    b('mention', 'composer.cmd.codex.mention'),
    b('model', 'composer.cmd.codex.model'),
    b('new', 'composer.cmd.codex.new'),
    b('review', 'composer.cmd.codex.review'),
    b('status', 'composer.cmd.codex.status'),
    b('undo', 'composer.cmd.codex.undo'),
  ],
};

/** Where the caret sits in a `/…` at the start or an `@…` after a space; null elsewhere. */
export function triggerAt(value: string, caret: number): Open | null {
  const head = value.slice(0, caret);
  const s = /^\/(\S*)$/.exec(head);
  if (s) return { kind: 'slash', start: 0, end: caret, q: s[1] };
  const a = /(?:^|\s)@(\S*)$/.exec(head);
  return a ? { kind: 'at', start: caret - a[1].length - 1, end: caret, q: a[1] } : null;
}

const none = () => [] as Entry[];

/** The project's own commands and skills (Claude): `.claude/commands/*.md` and `.claude/skills/*`. */
async function projectItems(core: CoreClient, id: string): Promise<Item[]> {
  const [cmds, skills] = await Promise.all([listDir(core, id, '.claude/commands').catch(none), listDir(core, id, '.claude/skills').catch(none)]);
  return [
    ...cmds.filter((e) => e.kind === 'file' && e.name.endsWith('.md')).map((e) => b(e.name.slice(0, -3), 'composer.hint.projectCommand')),
    ...skills.filter((e) => e.kind === 'dir').map((e) => b(e.name, 'composer.hint.projectSkill')),
  ];
}

/** The user's own commands, skills and prompts (read only by the core); an error leaves the menu as it was. */
async function userItems(core: CoreClient, kind: 'claude' | 'codex'): Promise<Item[]> {
  const hint = { command: 'composer.hint.userCommand', skill: 'composer.hint.userSkill', prompt: 'composer.hint.userPrompt' } as const;
  const reply = await core.userCommands(kind).catch(() => ({ rows: [] }));
  return reply.rows.map((r) => ({ ...b(r.name, hint[r.source] ?? 'composer.hint.userCommand'), description: r.description }));
}

const MAX = 8;

/** Files for `@q`: the folder part of `q` is listed, and the core's search adds files that mention it. */
async function fileItems(core: CoreClient, id: string, q: string): Promise<Item[]> {
  const cut = q.lastIndexOf('/') + 1;
  const dir = q.slice(0, cut);
  const name = q.slice(cut).toLowerCase();
  const entries = await listDir(core, id, dir.replace(/\/$/, '')).catch(none);
  const listed: Item[] = entries
    .filter((e) => !e.ignored && e.name.toLowerCase().startsWith(name))
    .sort((x, y) => Number(y.kind === 'dir') - Number(x.kind === 'dir') || x.name.localeCompare(y.name))
    .map((e) => (e.kind === 'dir' ? { label: `${dir}${e.name}/`, hint: 'composer.hint.folder', insert: `@${dir}${e.name}/`, keep: true } : { label: `${dir}${e.name}`, hint: ({ M: 'composer.hint.modified', A: 'composer.hint.new', '?': 'composer.hint.new' } as Record<string, Key>)[e.git ?? ''] ?? '', insert: `@${dir}${e.name} `, file: true }));
  if (!q || dir) return listed.slice(0, MAX);
  const found = (await core.request({ op: 'files_search', root: id, query: q, path: '' }).catch(() => ({ matches: [] }))) as { matches?: { path: string }[] };
  const seen = new Set(listed.map((i) => i.label));
  const searched = [...new Set((found.matches ?? []).map((m) => m.path))].filter((p) => !seen.has(p)).map((p): Item => ({ label: p, hint: '', insert: `@${p} `, file: true }));
  return [...listed, ...searched].slice(0, MAX);
}

export function ComposerMenu({ core, session, t }: { core: CoreClient; session: Session | null; t: T }) {
  const kind = session?.kind;
  const live = !!session && session.state === 'running' && (kind === 'claude' || kind === 'codex');
  const root = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [sel, setSel] = useState(0);
  // Tagged with the session they were read from: this component outlives a tab switch (a keyed remount leaves its old DOM behind).
  const [project, setProject] = useState<{ id: string; items: Item[] } | null>(null);
  const [user, setUser] = useState<{ id: string; items: Item[] } | null>(null);
  const [files, setFiles] = useState<{ id: string; items: Item[] } | null>(null);
  const composing = useRef(false);

  const opening = open?.kind === 'slash';
  useEffect(() => {
    if (!opening || kind !== 'claude' || !session) return;
    let stale = false;
    void projectItems(core, session.id).then((items) => !stale && setProject({ id: session.id, items }));
    return () => void (stale = true);
  }, [opening, kind, session?.id, core]);

  useEffect(() => {
    if (!opening || (kind !== 'claude' && kind !== 'codex') || !session) return;
    let stale = false;
    void userItems(core, kind).then((items) => !stale && setUser({ id: session.id, items }));
    return () => void (stale = true);
  }, [opening, kind, session?.id, core]);

  const q = open?.kind === 'at' ? open.q : null;
  useEffect(() => {
    if (q === null || !session) return;
    let stale = false;
    const t = setTimeout(() => void fileItems(core, session.id, q).then((items) => !stale && setFiles({ id: session.id, items })), 120);
    return () => (clearTimeout(t), void (stale = true));
  }, [q, session?.id, core]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    if (open.kind === 'at') return files && files.id === session?.id ? files.items : [];
    const want = open.q.toLowerCase();
    const all: Item[] = [];
    for (const i of [...(BUILTIN[kind ?? ''] ?? []), ...(project && project.id === session?.id ? project.items : []), ...(user && user.id === session?.id ? user.items : [])]) if (!all.some((x) => x.label === i.label)) all.push(i); // built-in wins, then project, then user
    // Name from its start, name anywhere, then description (ticket 371); 3 is no match.
    const rank = (i: Item) => {
      const at = i.label.slice(1).toLowerCase().indexOf(want);
      return at === 0 ? 0 : at > 0 ? 1 : i.description?.toLowerCase().includes(want) ? 2 : 3;
    };
    return all.filter((i) => rank(i) < 3).sort((x, y) => rank(x) - rank(y));
  }, [open, files, project, user, kind, session?.id]);
  useEffect(() => setSel(0), [items]);

  const box = () => root.current?.closest('.cbox');
  const area = () => box()?.querySelector<HTMLTextAreaElement>('textarea:not(.hoff-edit)') ?? null;

  /** Latest values for the textarea listeners, which are attached once per session. */
  const live2 = useRef({ open, items, sel });
  live2.current = { open, items, sel };

  const pick = (item: Item) => {
    const el = area();
    const o = live2.current.open;
    if (!el || !o) return;
    el.value = el.value.slice(0, o.start) + item.insert + el.value.slice(o.end);
    const caret = o.start + item.insert.length;
    el.setSelectionRange(caret, caret);
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true })); // the composer's own grow and draft handling, and our refresh
    if (!item.keep) setOpen(null);
  };

  useEffect(() => {
    const el = area();
    if (!live || !el) return;
    const refresh = () => !composing.current && setOpen(triggerAt(el.value, el.selectionStart));
    let position: PromptPosition | null = null;
    let recalling = false; // a recalled `/x` or `@x` is a past prompt, not a trigger: the next Up stays recall's
    const input = (e: Event) => !(e as InputEvent).isComposing && !recalling && refresh();
    const start = () => (composing.current = true);
    const end = () => ((composing.current = false), refresh());
    /** Ticket 371: Up and Down over the session's sent prompts; the guards are T3 Code's (useComposerCommandKey.ts). */
    const recall = (e: KeyboardEvent) => {
      const up = e.key === 'ArrowUp';
      if ((!up && e.key !== 'ArrowDown') || e.defaultPrevented || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
      if (box()?.querySelector('.ichip')) return;
      if ((up ? el.value.slice(0, el.selectionStart) : el.value.slice(el.selectionEnd)).includes('\n')) return;
      const step = stepPromptHistory({ direction: up ? 'backward' : 'forward', entries: promptEntries(session!.id), position, currentPrompt: el.value });
      if (!step) return;
      e.preventDefault();
      position = step.position;
      setOpen(null);
      el.value = step.prompt;
      el.setSelectionRange(step.prompt.length, step.prompt.length);
      recalling = true;
      el.dispatchEvent(new Event('input', { bubbles: true })); // the composer's own grow and draft handling
      recalling = false;
    };
    const key = (e: KeyboardEvent) => {
      const { open: o, items: list, sel: at } = live2.current;
      // Hangul and other IME input: Enter, Tab and arrows belong to the composition, never to the menu or recall.
      if (composing.current || e.isComposing || e.keyCode === 229) return;
      if (o) {
        const stop = () => (e.preventDefault(), e.stopPropagation());
        if (e.key === 'Escape') return (stop(), setOpen(null));
        if (list.length) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return (stop(), setSel((at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length));
          if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') return (stop(), pick(list[at]));
        }
      }
      recall(e);
    };
    const blur = () => setOpen(null);
    el.addEventListener('input', input);
    el.addEventListener('compositionstart', start);
    el.addEventListener('compositionend', end);
    el.addEventListener('keydown', key);
    el.addEventListener('blur', blur);
    return () => {
      el.removeEventListener('input', input);
      el.removeEventListener('compositionstart', start);
      el.removeEventListener('compositionend', end);
      el.removeEventListener('keydown', key);
      el.removeEventListener('blur', blur);
      setOpen(null);
    };
  }, [live, session?.id]);

  // The textarea keeps focus, so it carries the combobox state a screen reader reads (as Palette.tsx does for its input).
  const listId = `cmenu-${session?.id}`;
  const shown = open && items.length ? `${listId}-${sel}` : null;
  useEffect(() => {
    const el = area();
    if (!live || !el) return;
    el.setAttribute('role', 'combobox');
    el.setAttribute('aria-haspopup', 'listbox');
    el.setAttribute('aria-expanded', String(!!open));
    if (open) el.setAttribute('aria-controls', listId);
    else el.removeAttribute('aria-controls');
    if (shown) el.setAttribute('aria-activedescendant', shown);
    else el.removeAttribute('aria-activedescendant');
  }, [live, open, shown, listId]);
  useEffect(() => {
    const el = area();
    return () => ['role', 'aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-activedescendant'].forEach((a) => el?.removeAttribute(a));
  }, [live, session?.id]);

  /** The bottom-row buttons: put the trigger in the text so the same menu opens. */
  const press = (k: 'slash' | 'at') => {
    const el = area();
    if (!el) return;
    el.focus();
    if (k === 'slash') {
      if (el.value.startsWith('/')) return el.setSelectionRange(el.value.search(/\s|$/), el.value.search(/\s|$/));
      if (!el.value) {
        el.value = '/';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else setOpen({ kind: 'slash', start: 0, end: 0, q: '' }); // text already there: the pick goes in front of it
      return;
    }
    const at = el.selectionStart;
    const lead = at > 0 && !/\s/.test(el.value[at - 1]) ? ' ' : '';
    el.value = `${el.value.slice(0, at)}${lead}@${el.value.slice(at)}`;
    el.setSelectionRange(at + lead.length + 1, at + lead.length + 1);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  if (!session || (kind !== 'claude' && kind !== 'codex')) return null;
  const label = open?.kind === 'at' ? t('composer.files') : t('composer.commands');
  return (
    <span className="cmenus" ref={root}>
      <button className="cib" aria-label={t('composer.commands')} title={t('composer.commands')} disabled={!live} onClick={() => press('slash')}>
        /
      </button>
      <button className="cib" aria-label={t('composer.mention')} title={t('composer.mention')} disabled={!live} onClick={() => press('at')}>
        @
      </button>
      {open && (
        <div className="composer-menu" id={listId} role="listbox" aria-label={label} onMouseDown={(e) => e.preventDefault()}>
          <div className="gh" aria-hidden="true">
            {label}
          </div>
          {items.map((it, i) => (
            <div key={it.label} id={`${listId}-${i}`} role="option" className="i" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => pick(it)}>
              {it.file && <ChromeIcon name="file" size={14} />}
              {it.label}
              {it.description ? (
                // basis 0: the description takes what the name leaves and is cut there; 120 characters on one line would widen the menu
                <span className="d" title={it.description} style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right' }}>
                  {it.description}
                </span>
              ) : (
                it.hint && <span className="d">{t(it.hint)}</span>
              )}
            </div>
          ))}
          {!items.length && <div className="none">{t('composer.none')}</div>}
        </div>
      )}
    </span>
  );
}
