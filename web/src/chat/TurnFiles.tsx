// Ticket 222 (B19b): one calm row after a finished turn that wrote files; "Open diff" opens Diff on the Latest turn
// scope. The paths come from the core (chat/turn_files.rs) and are page text: shown in the title, never followed.
// Own code: no local T3 Code checkout to port ChangedFilesTree from. Ticket 374: the row passes its own files, so an
// older turn's row opens Diff on that turn's files, not the latest turn's.
import { useContext } from 'react';
import { openDiff } from '../diff/Diff';
import { Tr } from '../i18n';
import { plain } from './pending';
import './turn-files.css';

/** Paths named in the button's title; the rest are counted. */
const NAMED = 5;

export function TurnFiles({ files }: { files: string[] }) {
  const t = useContext(Tr);
  const more = files.length - NAMED;
  const title = [...files.slice(0, NAMED).map(plain), ...(more > 0 ? [t('diff.turnRow.more', { n: more })] : [])].join('\n');
  return (
    <div className="turnfiles">
      <span>{t(files.length === 1 ? 'diff.turnRow.one' : 'diff.turnRow.other', { n: files.length })}</span>
      <button type="button" className="btn" title={title} onClick={() => openDiff(undefined, 'turn', files)}>
        {t('diff.turnRow.open')}
      </button>
    </div>
  );
}
