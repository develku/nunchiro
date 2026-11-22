// C7b-2 (V2.5-60): the board's project filter as a searchable picker. A trigger chip opens a popover with a text field
// and a listbox; the field keeps focus and the arrow keys move a highlighted option (aria-activedescendant), as in a
// combobox. Board-local: layout/ProjectPicker.tsx is the system's picker for another job. Own code (no peer checkout
// of T3 Code's project popover was on disk, needs 141).
import { PLAIN } from '../plainText';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '../icons/Icon';
import { composing } from '../keys';
import type { T } from './Board';
import { base } from './tasks';

interface Option {
  value: string | null;
  label: string;
  path: string | null;
}

export function ProjectSelect({ t, projects, value, onChange }: { t: T; projects: string[]; value: string | null; onChange: (project: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const ids = useId();
  const all = useMemo<Option[]>(() => [{ value: null, label: t('board.allProjects'), path: null }, ...projects.map((p) => ({ value: p, label: base(p), path: p }))], [projects, t]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => all.filter((o) => !q || o.label.toLowerCase().includes(q) || !!o.path?.toLowerCase().includes(q)), [all, q]);
  const current = all.find((o) => o.value === value) ?? all[0];

  const show = () => {
    setQuery('');
    setActive(Math.max(0, all.indexOf(current)));
    setOpen(true);
  };
  const close = (focus: boolean) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  const pick = (o: Option | undefined) => {
    if (!o) return;
    onChange(o.value);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    // A press outside closes and leaves focus where the user pressed.
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]);
  useEffect(() => {
    if (open) root.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, shown]);

  const onKey = (e: React.KeyboardEvent) => {
    if (composing(e.nativeEvent)) return;
    const n = shown.length;
    const to = { ArrowDown: n ? (active + 1) % n : 0, ArrowUp: n ? (active - 1 + n) % n : 0, Home: 0, End: Math.max(0, n - 1) }[e.key];
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      setOpen(false); // ticket 219 SHOULD 2: Tab out closes, like Esc; focus moves on as Tab would, nothing is picked
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(shown[active]);
    } else if (to !== undefined) {
      e.preventDefault();
      setActive(to);
    }
  };

  return (
    <span className="bprojw" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="chip bproj"
        aria-label={`${t('board.project')}: ${current.label}`}
        title={current.path ?? undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${ids}-list` : undefined}
        onClick={() => (open ? close(false) : show())}
      >
        <span className="bprojt">{current.label}</span>
        <Icon name="triangle-down" size={12} />
      </button>
      {open && (
        <div className="bpop">
          <input {...PLAIN}
            ref={input}
            type="text"
            aria-label={t('board.project.find')}
            placeholder={t('board.project.find')}
            aria-controls={`${ids}-list`}
            aria-activedescendant={shown[active] ? `${ids}-${active}` : undefined}
            value={query}
            onChange={(e) => (setQuery(e.target.value), setActive(0))}
            onKeyDown={onKey}
          />
          <div id={`${ids}-list`} role="listbox" aria-label={t('board.projectFilter')}>
            {shown.map((o, i) => (
              <div key={o.value ?? ''} id={`${ids}-${i}`} role="option" aria-selected={o.value === value} data-active={i === active} title={o.path ?? undefined} onClick={() => pick(o)} onPointerMove={() => i !== active && setActive(i)}>
                {o.label}
              </div>
            ))}
            {shown.length === 0 && <div className="bpnone">{t('board.project.none')}</div>}
          </div>
        </div>
      )}
    </span>
  );
}
