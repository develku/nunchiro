// Prefix help (V1A-57; needs 64): a which-key style list of the keys after the prefix, shown while the prefix is armed
// once `delay` ms pass with no next key, or at once (`now`, from `?`). Render-only: aria-hidden, nothing focusable, no
// key handler. App.tsx's keydown keeps every key and the focus on the key sink, and unmounting this ends it.
// Ticket 1099 (mockup docs/design/cohesion-1099 panel 5): ⌘/ (keys.sheet, `all`) is the whole sheet, every bound command with
// its ⌘ chord when it has one, else its ◆ key; ◆ ? and the armed wait stay the short list of prefix keys.
import { useEffect, useState } from 'react';
import { AREAS, areaOf, bare, JUMPS, label, prefixLabel, PROJECT_JUMPS, SETTINGS_ONLY, type Binding, type Bindings, type Command } from './keys';
import { useHtmlLangT } from './i18n/lib/useHtmlLangT';
import { commandTitle, has } from './i18n/lib/commandTitle';
import type { Key } from './i18n';

export function PrefixHelp({ bindings, commands, delay, now, all = false }: { bindings: Bindings; commands: Command[]; delay: number; now: boolean; all?: boolean }) {
  const tr = useHtmlLangT(); // `t` here is the timer below
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (delay <= 0) return;
    const t = setTimeout(() => setLate(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  if (!now && !late) return null;
  // Ticket 625: the Keys page's words (its area names and command titles), so a Korean window's sheet is not English.
  const title = (id: string) => commandTitle(tr, id, commands.find((c) => c.id === id)?.title ?? id);
  const areaName = (area: string, slug = area.replace(/\W+/g, '-').toLowerCase()) => (has(`settings.kbd.area.${slug}`) ? tr(`settings.kbd.area.${slug}` as Key) : area);
  // The one binding a row shows: the prefix key in the short list; in the whole sheet the ⌘ chord, else the prefix key, else the first.
  // A direct key (F2 for Rename) beats a prefix key in the whole sheet: one press instead of two.
  const pick = (bs: Binding[]) => (all ? (bs.find((b) => b.includes('Meta+')) ?? bs.find((b) => !b.startsWith('prefix ')) ?? bs[0]) : bs.find((b) => b.startsWith('prefix ')));
  const show = (b: Binding) => (all ? label(b) : bare(b));
  // The nine jumps of a list read as one `1-9` line when they are still one key with the digits 1..9.
  const one = (ids: string[]) => {
    const got = ids.map((id) => (bindings[id] ? pick(bindings[id]) : undefined));
    return got[0]?.endsWith('Digit1') && got.every((b, i) => b === got[0]!.replace(/Digit1$/, `Digit${i + 1}`)) ? got[0] : null;
  };
  const lists = [JUMPS, PROJECT_JUMPS].map((ids) => ({ ids, first: one(ids) }));
  const rows = Object.entries(bindings).flatMap(([id, bs]) => {
    const jump = lists.find((l) => l.first && l.ids.includes(id));
    // A bound command this window does not list now (the side chat with no agent) has no row: it would do nothing.
    const c = commands.find((x) => x.id === id);
    // The prefix list drops a command that is off now (its key does nothing); the whole sheet is a reference and keeps it, dimmed.
    if (id === 'prefix' || SETTINGS_ONLY.includes(id) || !c || (c.enabled === false && !all) || (jump && id !== jump.ids[0])) return [];
    const off = c.enabled === false;
    if (jump) return [{ id, off, key: show(jump.first!).replace(/1$/, '1-9'), title: c.group ?? title(id) }];
    const b = pick(bs);
    return b ? [{ id, off, key: show(b), title: title(id) }] : [];
  });
  return (
    <div className="prefix-help" aria-hidden="true" data-all={all || undefined}>
      {AREAS.map((area) => {
        const here = rows.filter((r) => areaOf(r.id) === area);
        return (
          here.length > 0 && (
            <div key={area} className="ph-area">
              <b>{areaName(area)}</b>
              {here.map((r) => (
                <div key={r.id + r.key} className="ph-row" data-command={r.id} data-off={r.off || undefined}>
                  <span className="kbd">{r.key}</span> {r.title}
                </div>
              ))}
            </div>
          )
        );
      })}
      <div className="ph-foot">
        {all && <span>{tr('rest.shell.prefixHelp.prefixIs', { keys: prefixLabel(bindings) })}</span>}
        {all && <span>{tr('rest.shell.prefixHelp.change')}</span>}
        <span>{tr('rest.shell.prefixHelp.escCloses')}</span>
      </div>
    </div>
  );
}
