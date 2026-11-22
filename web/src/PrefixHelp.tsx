// Prefix help (V1A-57; needs 64): a which-key style list of the keys after the prefix, shown while the prefix is armed
// once `delay` ms pass with no next key, or at once (`now`, from `?`). Render-only: aria-hidden, nothing focusable, no
// key handler. App.tsx's keydown keeps every key and the focus on the key sink, and unmounting this ends it.
import { useEffect, useState } from 'react';
import { AREAS, areaOf, bare, JUMPS, type Bindings, type Command } from './keys';
import { useHtmlLangT } from './i18n/lib/useHtmlLangT';
import { commandTitle, has } from './i18n/lib/commandTitle';
import type { Key } from './i18n';

export function PrefixHelp({ bindings, commands, delay, now }: { bindings: Bindings; commands: Command[]; delay: number; now: boolean }) {
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
  const jumps = JUMPS.map((id) => bindings[id]?.find((b) => b.startsWith('prefix ')));
  // The nine tab jumps read as one `1-9` line when they are still prefix 1..9.
  const oneJump = jumps.every((b, i) => b === `prefix Digit${i + 1}`);
  const rows = Object.entries(bindings).flatMap(([id, bs]) =>
    id === 'prefix' || commands.find((c) => c.id === id)?.enabled === false || (oneJump && JUMPS.includes(id) && id !== JUMPS[0])
      ? []
      : bs.filter((b) => b.startsWith('prefix ')).map((b) => ({ id, key: oneJump && id === JUMPS[0] ? '1-9' : bare(b), title: oneJump && id === JUMPS[0] ? (commands.find((c) => c.id === id)?.group ?? title(id)) : title(id) })),
  );
  return (
    <div className="prefix-help" aria-hidden="true">
      {AREAS.map((area) => {
        const here = rows.filter((r) => areaOf(r.id) === area);
        return (
          here.length > 0 && (
            <div key={area} className="ph-area">
              <b>{areaName(area)}</b>
              {here.map((r) => (
                <div key={r.id + r.key} className="ph-row" data-command={r.id}>
                  <span className="kbd">{r.key}</span> {r.title}
                </div>
              ))}
            </div>
          )
        );
      })}
      <div className="ph-foot">{tr('rest.shell.prefixHelp.escCloses')}</div>
    </div>
  );
}
