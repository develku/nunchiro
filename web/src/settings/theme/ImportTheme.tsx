// Import a Ghostty-format theme into the app (needs 55 owner correction): pick or paste a file; the app keeps the
// parsed colours in its own settings and never reads another app's folder.
import { PLAIN } from '../../plainText';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Key } from '../../i18n';
import { FILE_CAP } from '../../themes/ghostty';
import { importTheme } from '../../themes/import';
import type { ThemePick } from '../../themes/nunchiro';
import { IMPORTS_CAP } from '../../settings';
import { Icon } from '../../icons/Icon';
import { Row } from '../shell/Row';

type T = (key: Key, args?: Record<string, string | number>) => string;

export function ImportTheme({ t, taken, onAdd }: { t: T; taken: string[]; onAdd: (p: ThemePick) => void }) {
  // A list past the cap is refused whole on the next load (settings.ts), so the 201st is never added.
  const full = taken.length >= IMPORTS_CAP;
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const add = () => {
    if (full) return setError(t('settings.theme.importFull', { cap: IMPORTS_CAP }));
    const r = importTheme({ name, text, source: source.trim() }, taken, t);
    if ('error' in r) return setError(r.error);
    onAdd(r.pick);
    setName('');
    setText('');
    setSource('');
    setError('');
  };
  // Enter in the name or URL field submits the form; the text area keeps its newline, and an IME's Enter (keyCode 229 covers
  // browsers that clear isComposing first) never submits (needs 171, 172).
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add();
  };
  const holdIme = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
  };
  const open = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > FILE_CAP) return setError(t('settings.theme.tooLarge', { kib: FILE_CAP / 1024 }));
    try {
      setText(await file.text());
      if (!name.trim()) setName(file.name.replace(/\.[^.]*$/, ''));
      setError('');
    } catch {
      setError(t('settings.theme.unreadable'));
    }
  };
  return (
    <details className="timport">
      {/* The whole row is the disclosure: the draft's row with a button-looking span (a button may not nest in a summary). */}
      <summary data-setting="themeImport">
        <Row
          label={t('field.themeImport')}
          desc={t('settings.theme.importDesc')}
          control={
            <span className="btn">
              <Icon name="plus" size={12} /> {t('settings.theme.importAdd')}
            </span>
          }
        />
      </summary>
      <div className="timport-body">
      <p className="lede">{t('settings.theme.importFormat')}</p>
      <form onSubmit={submit} onKeyDown={holdIme}>
      <label className="tfield">
        {t('settings.theme.importName')}
        <input {...PLAIN} className="search" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {/* The placeholders below are sample Ghostty text and a URL shape, not window text. */}
      <label className="tfield">
        {t('settings.theme.importText')}
        <textarea {...PLAIN} className="search" rows={6} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={'background = #1e1e2e\nforeground = #cdd6f4\npalette = 0=#45475a'} />
      </label>
      <label className="tfield">
        {t('settings.theme.importSource')}
        <input {...PLAIN} className="search" type="url" placeholder={'https://…'} value={source} onChange={(e) => setSource(e.target.value)} />
      </label>
      <label className="tfield">
        {t('settings.theme.importOpen')}
        <input type="file" onChange={(e) => void open(e.target.files?.[0])} />
      </label>
      {error && (
        <p className="conflict" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn p">
        {t('settings.theme.importAdd')}
      </button>
      </form>
      </div>
    </details>
  );
}
