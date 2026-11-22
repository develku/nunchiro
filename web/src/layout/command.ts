// Layout command language: the edit command line (`:split right terminal --pin v1a-03`), drag echoes,
// bindings and `nunchiro layout ...` all go through parse/format here, so GUI and CLI make the same file.
import type { Key } from '../i18n';
import { DIRS, WIDGETS, defaultZone, find, isKind, leaves, type Dir, type Layout, type Op } from './model';

/** A refusal the window says in its own language (`own.cmd.*`, 8 languages); `message` stays English for `nunchiro layout` and tests. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly key: Key,
    readonly args: Record<string, string | number>,
  ) {
    super(message);
  }
}
const unknownWidget = (k: string) => new CommandError(`unknown widget "${k}"; widgets: ${WIDGETS.join(', ')}`, 'own.cmd.widget', { widget: k, list: WIDGETS.join(', ') });

export const COMMANDS: { name: string; hint: string }[] = [
  { name: 'split', hint: 'split <up|down|left|right> <widget> [--pin SESSION] [--zone ZONE]' },
  { name: 'stack', hint: 'stack <widget> as a tab [--pin SESSION] [--zone ZONE]' },
  { name: 'edge', hint: 'edge <up|down|left|right> <widget>: new zone at the window edge' },
  { name: 'add', hint: 'add <widget> at its home (waiting: under the composer)' },
  { name: 'move', hint: 'move <zone> split <dir>|stack|edge <dir> [--zone ZONE] [--tab N]' },
  { name: 'remove', hint: 'remove <widget> | remove --zone ZONE [--tab N]' },
  { name: 'pin', hint: 'pin <session> [--zone ZONE] [--tab N]' },
  { name: 'unpin', hint: 'unpin [--zone ZONE] [--tab N]: follow the focused session' },
  { name: 'resize', hint: 'resize <zone> <px>' },
  { name: 'reset', hint: 'reset to the default layout' },
  { name: 'undo', hint: 'undo (up to 3 steps)' },
];

/** Splits a command line on spaces; double quotes keep spaces in a session name. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  for (const m of line.trim().replace(/^:/, '').matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out;
}

const quote = (s: string) => (/^[^\s"]+$/.test(s) ? s : `"${s}"`);

/** Parses argv-style words (from the command line or the CLI). `selected` fills a missing --zone. */
export function parse(words: string[], selected?: string, layout?: Layout): Op {
  const [name, ...rest] = words;
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${rest[i - 1]} needs a value`);
      flags[rest[i - 1].slice(2)] = v;
    } else pos.push(rest[i]);
  }
  const allowed: Record<string, string[]> = { split: ['pin', 'zone', 'size'], stack: ['pin', 'zone'], edge: ['pin'], add: ['pin'], move: ['zone', 'tab'], remove: ['zone', 'tab'], pin: ['zone', 'tab'], unpin: ['zone', 'tab'] };
  for (const f of Object.keys(flags)) if (!(allowed[name] ?? []).includes(f)) throw new CommandError(`${name} does not take --${f}`, 'own.cmd.flag', { command: name, flag: f });
  const zone = flags.zone ?? selected ?? (layout ? defaultZone(layout) : undefined);
  const num = (v: string | undefined, what: string) => {
    if (v === undefined) return undefined;
    const n = Number(v.replace(/px$/, ''));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} must be a whole number`);
    return n;
  };
  const dir = (d: string | undefined): Dir => {
    if (!DIRS.includes(d as Dir)) throw new Error(`expected a direction: ${DIRS.join(', ')}`);
    return d as Dir;
  };
  const widget = (k: string | undefined) => {
    if (!k) throw new Error(`expected a widget: ${WIDGETS.join(', ')}`);
    if (!isKind(k)) throw unknownWidget(k);
    return flags.pin ? `${k}@${flags.pin}` : k;
  };
  const arity = (n: number) => {
    if (pos.length !== n) throw new Error(`${name}: ${COMMANDS.find((c) => c.name === name)!.hint}`);
  };
  const tab = num(flags.tab, '--tab');
  switch (name) {
    case 'split':
      arity(2);
      return { op: 'split', dir: dir(pos[0]), widget: widget(pos[1]), zone, ...(flags.size ? { size: num(flags.size, '--size') } : {}) };
    case 'stack':
      arity(1);
      return { op: 'stack', widget: widget(pos[0]), zone };
    case 'edge':
      arity(2);
      return { op: 'edge', dir: dir(pos[0]), widget: widget(pos[1]) };
    case 'add':
      arity(1);
      return { op: 'add', widget: widget(pos[0]) };
    case 'move': {
      const [from, how, d] = pos;
      if (!from || !how) throw new Error(`move: ${COMMANDS[4].hint}`);
      const to = how === 'stack' ? { op: 'stack' as const, zone: flags.zone ?? selected } : how === 'split' ? { op: 'split' as const, dir: dir(d), zone: flags.zone ?? selected } : how === 'edge' ? { op: 'edge' as const, dir: dir(d) } : null;
      if (!to) throw new Error('move: expected split, stack or edge');
      if (pos.length !== (how === 'stack' ? 2 : 3)) throw new Error(`move: ${COMMANDS[4].hint}`);
      return { op: 'move', from, ...(tab ? { tab } : {}), to };
    }
    case 'remove':
      if (pos.length > 1) throw new Error(`remove: ${COMMANDS[5].hint}`);
      if (pos[0]) {
        if (!isKind(pos[0])) throw unknownWidget(pos[0]);
        return { op: 'remove', kind: pos[0] };
      }
      return { op: 'remove', zone, ...(tab ? { tab } : {}) };
    case 'pin':
      arity(1);
      return { op: 'pin', session: pos[0], zone, ...(tab ? { tab } : {}) };
    case 'unpin':
      arity(0);
      return { op: 'unpin', zone, ...(tab ? { tab } : {}) };
    case 'resize':
      arity(2);
      return { op: 'resize', zone: pos[0], size: num(pos[1], 'size')! };
    case 'reset':
    case 'undo':
      arity(0);
      return { op: name };
    default: {
      const list = COMMANDS.map((c) => c.name).join(', ');
      throw name ? new CommandError(`unknown layout command "${name}"; commands: ${list}`, 'own.cmd.unknown', { command: name, list }) : new CommandError('type a layout command', 'own.cmd.empty', { list });
    }
  }
}

/** The command line text for an action: what a drag echoes and what the CLI would take. */
export function format(op: Op): string {
  const w = (item: string) => {
    const [k, ...p] = item.split('@');
    return p.length ? `${k} --pin ${quote(p.join('@'))}` : k;
  };
  const z = (zone?: string) => (zone ? ` --zone ${zone}` : '');
  const t = (tab?: number) => (tab ? ` --tab ${tab}` : '');
  switch (op.op) {
    case 'split':
      return `split ${op.dir} ${w(op.widget)}${z(op.zone)}${op.size ? ` --size ${op.size}` : ''}`;
    case 'stack':
      return `stack ${w(op.widget)}${z(op.zone)}`;
    case 'edge':
      return `edge ${op.dir} ${w(op.widget)}`;
    case 'add':
      return `add ${w(op.widget)}`;
    case 'move': {
      const to = op.to.op === 'stack' ? `stack${z(op.to.zone)}` : op.to.op === 'split' ? `split ${op.to.dir}${z(op.to.zone)}` : `edge ${op.to.dir}`;
      return `move ${op.from} ${to}${t(op.tab)}`;
    }
    case 'remove':
      return op.kind ? `remove ${op.kind}` : `remove${z(op.zone)}${t(op.tab)}`;
    case 'pin':
      return `pin ${quote(op.session)}${z(op.zone)}${t(op.tab)}`;
    case 'unpin':
      return `unpin${z(op.zone)}${t(op.tab)}`;
    case 'resize':
      return `resize ${op.zone} ${op.size}`;
    default:
      return op.op;
  }
}

export interface Completion {
  text: string;
  hint: string;
}

/** Completions for the word being typed: commands, then directions, widgets, zones or sessions. */
export function complete(line: string, layout: Layout, sessions: string[]): Completion[] {
  const text = line.replace(/^:/, '');
  const words = text.split(/\s+/);
  const word = words.pop() ?? '';
  const head = words.length ? `${words.join(' ')} ` : '';
  const prev = words.at(-1);
  const zones = (all: boolean) => (all ? [...new Set([...leaves(layout.root).map((z) => z.id), ...collect(layout)])] : leaves(layout.root).map((z) => z.id));
  let options: Completion[];
  if (!words.length) options = COMMANDS.map((c) => ({ text: c.name, hint: c.hint }));
  else if (prev === '--zone') options = zones(false).map((id) => ({ text: id, hint: 'zone' }));
  else if (prev === '--pin') options = sessions.map((s) => ({ text: quote(s), hint: 'session' }));
  else {
    const [cmd] = words;
    const pos = words.slice(1).filter((x, i, a) => !x.startsWith('--') && !a[i - 1]?.startsWith('--'));
    const dirs = DIRS.map((d) => ({ text: d, hint: 'direction' }));
    const widgets = WIDGETS.map((k) => ({ text: k, hint: 'widget' }));
    const flags = (names: string[]) => names.filter((f) => !words.includes(f)).map((f) => ({ text: f, hint: 'option' }));
    const at: Record<string, Completion[][]> = {
      split: [dirs, widgets],
      edge: [dirs, widgets],
      stack: [widgets],
      add: [widgets],
      remove: [widgets],
      pin: [sessions.map((s) => ({ text: quote(s), hint: 'session' }))],
      resize: [zones(true).map((id) => ({ text: id, hint: 'zone' }))],
      move: [zones(false).map((id) => ({ text: id, hint: 'zone' })), ['split', 'stack', 'edge'].map((x) => ({ text: x, hint: 'drop' })), pos[1] === 'stack' ? [] : dirs],
    };
    const more: Record<string, string[]> = { split: ['--pin', '--zone', '--size'], stack: ['--pin', '--zone'], edge: ['--pin'], add: ['--pin'], move: ['--zone', '--tab'], remove: ['--zone', '--tab'], pin: ['--zone', '--tab'], unpin: ['--zone', '--tab'] };
    options = (!word.startsWith('-') && at[cmd]?.[pos.length]) || flags(more[cmd] ?? []);
  }
  return options.filter((o) => o.text.startsWith(word) && o.text !== word).map((o) => ({ text: `${head}${o.text} `, hint: o.hint }));
}

function collect(l: Layout): string[] {
  const out: string[] = [];
  const walk = (n: Layout['root']) => {
    out.push(n.id);
    if ('children' in n) n.children.forEach(walk);
  };
  walk(l.root);
  return out.filter((id) => find(l.root, id) !== l.root);
}
