// Edit bar (needs 37, 39; LAYOUT D5b A07): under the title bar while editing. Done, Cancel, Default, Undo, the presets
// menu and Split session. The vim-style ":" command line and its drag echo are gone (needs 153); the
// same words still drive `nunchiro layout` (command.ts).
import { PLAIN } from '../plainText';
import { useEffect, useRef, useState } from 'react';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import { BUILT_IN } from './presets';

export interface PresetMenu {
  names: string[];
  current: string;
  dirty: boolean;
  onLoad: (name: string) => void;
  onSave: () => void;
  onSaveAs: (name: string) => boolean;
}

interface Props {
  message: { text: string; error: boolean } | null;
  undo: number;
  outside: boolean;
  /** The strip's own buttons: `reset` and `undo`. */
  run: (line: 'reset' | 'undo') => void;
  onDone: () => void;
  onCancel: () => void;
  presets: PresetMenu;
  /** Placement item 3: split the focused session (Layout closes and the new half shows the split chooser); absent
   *  when no session is open. */
  onSplit?: (side: 'left' | 'right' | 'down') => void;
}

function Presets({ m }: { m: PresetMenu }) {
  const t = useHtmlLangT();
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: Event) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open]);
  const close = () => (setOpen(false), setNaming(false), setError(''));
  // A built-in preset's name is its stored id; only the label is translated.
  const shown = (n: string) => ((BUILT_IN as readonly string[]).includes(n) ? t(`rest.layout.preset.${n as (typeof BUILT_IN)[number]}`) : n);
  return (
    <div className="epre" ref={root} onKeyDown={(e) => e.key === 'Escape' && open && (e.stopPropagation(), close())}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {t('rest.layout.presets', { name: shown(m.current) })}
        {m.dirty && <span className="dirty" role="img" aria-label={t('rest.layout.changed')}> ●</span>}
      </button>
      {open && (
        <div className="emenu" role="menu" aria-label={t('rest.layout.presetsMenu')}>
          <div className="mh">{t('rest.layout.load')}</div>
          {m.names.map((n) => (
            <button key={n} role="menuitemradio" aria-checked={n === m.current} onClick={() => (m.onLoad(n), close())}>
              <span aria-hidden>{n === m.current ? '✓' : ''}</span>
              {shown(n)}
            </button>
          ))}
          <hr />
          <button role="menuitem" disabled={!m.dirty} onClick={() => (m.onSave(), close())}>
            {t('rest.layout.save')}
          </button>
          {naming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (m.onSaveAs(name)) close();
                else setError(t('rest.layout.needName'));
              }}
            >
              <input {...PLAIN} autoFocus aria-label={t('rest.layout.presetName')} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              <button className="btn p" type="submit">
                {t('rest.layout.save')}
              </button>
              {error && <span role="alert">{error}</span>}
            </form>
          ) : (
            <button role="menuitem" onClick={() => setNaming(true)}>
              {t('rest.layout.saveAs')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function EditStrip(p: Props) {
  const t = useHtmlLangT();
  return (
    <div className="estrip" role="toolbar" aria-label={t('rest.layout.editBar')}>
      <b className="etitle">
        ●<span className="lbl"> {t('rest.layout.editing')}</span>
      </b>
      <button className="btn p" onClick={p.onDone}>
        {t('shell.layout.done')}
      </button>
      <button className="btn" onClick={p.onCancel}>
        {t('providers.cancel')}
      </button>
      {/* At narrow widths these show only their icon; the accessible name and tooltip stay. */}
      <button className="btn" onClick={() => p.run('reset')} aria-label={t('rest.layout.default')} title={t('rest.layout.defaultTitle')}>
        ↺<span className="lbl"> {t('rest.layout.default')}</span>
      </button>
      <Presets m={p.presets} />
      <button className="btn" onClick={() => p.run('undo')} disabled={p.undo === 0} aria-label={t('rest.layout.undoSteps', { n: p.undo })} title={t('rest.layout.undoSteps', { n: p.undo })}>
        ↶<span className="lbl"> {t('rest.layout.undo', { n: p.undo })}</span>
      </button>
      {p.onSplit && (
        <div className="esplit" role="group" aria-label={t('rest.layout.split')}>
          <span className="lbl">{t('rest.layout.splitLabel')}</span>
          {(['left', 'right', 'down'] as const).map((d) => (
            <button key={d} className="btn" onClick={() => p.onSplit!(d)} title={t(`rest.layout.splitTitle.${d}`)}>
              {t(`rest.layout.side.${d}`)}
            </button>
          ))}
        </div>
      )}
      <span className="emsg" role="status" data-error={p.message?.error ?? false}>
        {p.outside ? t('rest.layout.outside') : ''}
        {p.message?.text ?? ''}
      </span>
      <span className="dim epath">~/.nunchiro/layout.toml</span>
    </div>
  );
}
