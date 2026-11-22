// D5b lane B (B02): a widget dropped on the Tree icon asks which project it nests under. Esc and a click outside cancel
// with no step. Styles live in tree/subviews.css.
import { useEffect, useRef } from 'react';
import { Icon } from '../icons/Icon';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';

export function ProjectPicker({ title, projects, onPick, onCancel }: { title: string; projects: { path: string; name: string }[]; onPick: (path: string) => void; onCancel: () => void }) {
  const t = useHtmlLangT();
  const box = useRef<HTMLDivElement>(null);
  // Beside the Tree icon, where the drop happened.
  const at = document.querySelector('[data-icon="tree"]')?.getBoundingClientRect();
  // The window re-renders often and hands a fresh onCancel each time: the effect below must run once (focus, click-away).
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector('button')?.focus();
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && cancel.current();
    window.addEventListener('pointerdown', away, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      if (document.activeElement === document.body || box.current?.contains(document.activeElement)) before?.focus?.();
    };
  }, []);
  return (
    <div
      className="pick"
      ref={box}
      role="dialog"
      aria-label={t('rest.layout.pickFor', { name: title })}
      style={{ left: (at?.right ?? 60) + 8, top: at?.top ?? 60 }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') return e.stopPropagation(), onCancel();
        const b = [...(box.current?.querySelectorAll('button') ?? [])];
        const i = b.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') (e.preventDefault(), b[(i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length]?.focus());
      }}
    >
      <div className="hd">{t('rest.layout.pickFor', { name: title })}</div>
      {projects.map((p) => (
        <button key={p.path} onClick={() => onPick(p.path)}>
          <Icon name="project" size={14} /> {p.name}
        </button>
      ))}
      <button className="cancel" onClick={onCancel}>
        {t('providers.cancel')}
      </button>
    </div>
  );
}
