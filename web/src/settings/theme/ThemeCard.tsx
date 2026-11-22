// One gallery card (V1A-62): a mini Nunchiro window in the theme's colours (C8, ticket 217: a title bar with three dots
// and an accent chip; sidebar with two project rows and a signal dot, a tab, a terminal with a prompt, two code lines and a
// diff + and - line). Colours are validated #rrggbb only,
// through deriveTokens for the window and the palette as is for the terminal. An online card not fetched yet is a
// neutral skeleton with its name. The mini window's words are sample code, not window text, so they stay literal.
import { useMemo, useRef, useState } from 'react';
import type { Key } from '../../i18n';
import { deriveTokens } from '../../themes/derive';
import type { ThemeColors } from '../../themes/ghostty';
import type { ThemePick } from '../../themes/nunchiro';
import { Why, WhyFix } from '../shell/Row';

type T = (key: Key, args?: Record<string, string | number>) => string;

// A card that lands under a pointer resting since a press (Show all, a filter chip moves the grid) is not hovered: no
// preview the user did not point at. Capture, so a move clears it before the card's own pointermove runs.
let still = false;
addEventListener('pointerdown', () => (still = true), true);
addEventListener('pointermove', () => (still = false), true);

export type Kind = 'builtin' | 'imported' | 'online';
export type Item = { name: string; kind: Kind; pick?: ThemePick; state: 'ok' | 'loading' | 'error'; error?: string };

function Mini({ c }: { c: ThemeColors }) {
  const t = useMemo(() => deriveTokens(c), [c]);
  const p = c.palette;
  return (
    <span className="tw twin" aria-hidden style={{ background: t['--panel'], borderColor: t['--line'] }}>
      <span className="ttitle" style={{ background: t['--page'], borderColor: t['--line'] }}>
        <i style={{ background: t['--bad'] }} />
        <i style={{ background: t['--you'] }} />
        <i style={{ background: t['--ok'] }} />
        <span className="tchip" style={{ background: t['--run'] }} />
      </span>
      <span className="twbody">
        <span className="tside" style={{ background: t['--page'], borderColor: t['--line'] }}>
          <span style={{ color: t['--text'] }}>
            <i style={{ background: t['--you'] }} />
            {'api'}
          </span>
          <span style={{ color: t['--muted'] }}>{'web'}</span>
        </span>
        <span className="tmain">
          <span className="ttab" style={{ background: t['--hover'], color: t['--text'], borderColor: t['--line'] }}>
            {'session'}
          </span>
          <span className="tterm" style={{ background: c.background, color: c.foreground }}>
            <span>
              <b style={{ color: p[4] }}>~/api</b> $ git diff
            </span>
            <span>
              <b style={{ color: p[5] }}>{'fn'}</b> <b style={{ color: p[6] }}>{'main'}</b>() {'{'}
            </span>
            <span>
              {'  '}
              <b style={{ color: p[3] }}>"ready"</b>
            </span>
            <span style={{ color: p[2] }}>+ let ok = 1;</span>
            <span style={{ color: p[1] }}>- let ok = 0;</span>
          </span>
        </span>
      </span>
    </span>
  );
}

function Menu({ t, name, items }: { t: T; name: string; items: [string, () => void][] }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  return (
    <span
      className="tmenu"
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button ref={toggle} className="btn tmore" aria-label={t('settings.theme.options', { name })} aria-expanded={open} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <span className="tmenu-list" role="group" aria-label={t('settings.theme.options', { name })}>
          {items.map(([label, act]) => (
            <button
              key={label}
              className="btn"
              onClick={() => {
                close();
                act();
              }}
            >
              {label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function ThemeCard({
  t,
  item,
  idx,
  applied,
  trial,
  onPreview,
  onApply,
  onRemove,
  onHide,
  onRetry,
}: {
  t: T;
  item: Item;
  idx: number;
  applied: boolean;
  /** Shown in the window now (hover or arrow preview), not picked. */
  trial: boolean;
  onPreview: (p: ThemePick) => void;
  onApply: (p: ThemePick, slot?: 'light' | 'dark') => void;
  onRemove: (p: ThemePick) => void;
  onHide: (p: ThemePick) => void;
  onRetry: (name: string) => void;
}) {
  const { pick, kind } = item;
  const items: [string, () => void][] = pick
    ? [
        [t('settings.theme.useLight'), () => onApply(pick, 'light')],
        [t('settings.theme.useDark'), () => onApply(pick, 'dark')],
        ...(kind === 'imported' ? [[t('settings.theme.remove'), () => onRemove(pick)] as [string, () => void]] : []),
        ...(kind === 'builtin' ? [[t('settings.theme.hide'), () => onHide(pick)] as [string, () => void]] : []),
      ]
    : [];
  return (
    <div className="tcard" role="listitem" aria-label={item.name} data-theme-id={kind === 'online' ? undefined : pick?.id}>
      <button
        className="tpick"
        data-idx={idx}
        data-state={item.state}
        disabled={!pick}
        aria-busy={item.state === 'loading' || undefined}
        aria-describedby={item.state === 'error' ? `why-theme-${idx}` : undefined}
        aria-pressed={applied}
        data-trial={trial || undefined}
        // Over, not Enter: React drops an enter when the element the pointer came from was removed mid-hover (a skeleton
        // card replaced as its file loads), so the preview never started (ticket 599, theme-as-written flake).
        // Move too: a pointer that rested since a press only previews once it moves (see `still`).
        onPointerOver={() => pick && !still && onPreview(pick)}
        onPointerMove={() => pick && !still && !trial && onPreview(pick)}
        onClick={() => pick && onApply(pick)}
      >
        {/* Ticket 991 C18: the preview needs the theme file from the network; until it is here the card says so, never blank. */}
        {pick ? (
          <Mini c={pick.colors} />
        ) : (
          <span className="tw tskel" aria-hidden>
            <b>{item.name}</b>
            {t(item.state === 'error' ? 'settings.theme.previewNotLoaded' : 'settings.theme.previewLoading')}
          </span>
        )}
        <span className="tname">{item.name}</span>
      </button>
      <span className="tbar">
        {applied && <span className="tinuse">{t('settings.theme.inUse')}</span>}
        {kind === 'online' && (
          <span className="ticon" role="img" aria-label={t('settings.theme.notInstalled')}>
            ↓
          </span>
        )}
        {kind === 'imported' && (
          <span className="ticon" role="img" aria-label={t('settings.theme.installed')}>
            ✓
          </span>
        )}
        {item.state === 'error' && (
          <span className="terr" title={item.error}>
            {/* Ticket 475: the card cannot be applied until its file loads; Retry is the fix. */}
            <Why id={`why-theme-${idx}`} reason={t('settings.theme.didNotLoad')} fix={<WhyFix label={t('settings.theme.retry')} run={() => onRetry(item.name)} />} />
          </span>
        )}
        {pick && <Menu t={t} name={item.name} items={items} />}
      </span>
    </div>
  );
}
