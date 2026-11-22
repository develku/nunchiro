// A command's title in the window's language (ticket 250 r3; ticket 492 for the palette): the Keys page and the palette
// both read `settings.kbd.cmd.<id>`, or the key another area's catalogue holds; a command without one (a feature's own,
// added later) keeps the title its file gives.
import { EN, type Key, type T } from '../index';

export const has = (key: string) => key in (EN as Record<string, string>);
/** Commands whose title another area's catalogue already holds; their files build them in English for the palette. */
const ELSEWHERE: Record<string, string> = {
  'group.move': 'tree.group.move',
  'group.create': 'tree.group.new',
  'project.pin': 'tree.pin',
  'group.remove': 'tree.group.remove',
  'group.rename': 'tree.group.rename',
  'group.dissolve': 'tree.group.dissolve',
  'tree.expand-all': 'tree.expandAllCmd',
  'projects.pick': 'tree.picker.title',
  'project.add': 'landing.addProject',
};

export function commandTitle(t: T, id: string, title: string): string {
  if (has(`settings.kbd.cmd.${id}`)) return t(`settings.kbd.cmd.${id}` as Key);
  return ELSEWHERE[id] && has(ELSEWHERE[id]) ? t(ELSEWHERE[id] as Key) : title;
}

/** Ticket 577: the words a command answers to besides its title, in the window's language, split by "|" (catalogue key
 *  `palette.kw.<id>`, areas/palette-words.ts). A command with none is found by its title alone. Ticket 608: a Settings row
 *  (`settings.<page>.<field>`) also answers to its field's search words (`searchWords.<field>`, the words Settings search
 *  finds it by), so "mute" or "알림 끄기" reaches the palette too, not only the Settings search. */
export function commandWords(t: T, id: string): string {
  const own = has(`palette.kw.${id}`) ? t(`palette.kw.${id}` as Key) : '';
  const field = /^settings\.[^.]+\.(.+)$/.exec(id)?.[1];
  const search = field && has(`searchWords.${field}`) ? t(`searchWords.${field}` as Key).split(',').map((w) => w.trim()).filter(Boolean).join('|') : '';
  return own && search ? `${own}|${search}` : own || search;
}

/** Ticket 579: a Settings row (`settings.<page>.<field>`) also answers to its page's name, so "notifications" finds the
 *  Notifications page's rows although no row's label says it. The palette lets this word match but never raises the row's
 *  rank by it: every row of the page would tie with the row the word names (palette-names ko "테마"). */
export function pageWord(t: T, id: string): string {
  const m = /^settings\.([^.]+)\./.exec(id);
  return m && has(`settings.page.${m[1]}`) ? t(`settings.page.${m[1]}` as Key) : '';
}
