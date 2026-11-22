// Ticket 204 (needs 171 IMPORTOPEN A, needs 137): one imported conversation, read-only, in a centre tab. The core's
// `import_read` returns chat events; the chat's own `buildRows` and `RowView` draw them (text through the Markdown
// renderer, no raw HTML, links only on a click). There is no composer: a note takes its place, and the tab sends no
// request but `import_read`.
import { useContext, useEffect, useMemo, useState } from 'react';
import type { CoreClient } from '../api';
import { buildRows } from '../chat/model';
import { RowView, Open } from '../chat/Rows';
import type { ChatEvent } from '../chat/feed';
import { Tr } from '../i18n';
import '../files/files.css'; // .fview, .fv-bar, .fv-body, .fv-scroll: the read-only tab's frame (it also hides the composer)
import { rememberTitle, importedTitle } from './imported';
import { ErrorDetails, plainError, rawError } from '../errors';
import { basename } from '../tree';

interface Read {
  id: string;
  agent: string;
  project: string;
  title: string;
  entries: ChatEvent[];
  truncated: boolean;
  left_out: number;
}

// ponytail: every entry (at most the core's 5 000) is rendered, not windowed; virtualize if long transcripts feel slow.
export function ImportedChat({ core, id, visible }: { core: CoreClient; id: string; visible: boolean }) {
  const t = useContext(Tr);
  const [read, setRead] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const openCtx = useMemo(
    () => ({
      has: (k: string) => open.has(k),
      toggle: (k: string) =>
        setOpen((o) => {
          const n = new Set(o);
          if (!n.delete(k)) n.add(k);
          return n;
        }),
    }),
    [open],
  );
  // Read once, the first time the tab is shown (it stays mounted afterwards, scroll kept).
  useEffect(() => {
    if (!visible || started) return;
    setStarted(true);
    core.request({ op: 'import_read', id }).then(
      (r) => {
        const got = r as unknown as Read;
        rememberTitle(id, got.title);
        setRead(got);
      },
      (e) => setError(rawError(e)),
    );
  }, [visible, started, core, id]);
  const rows = useMemo(() => (read ? buildRows(read.entries) : []), [read]);
  // The id is `<agent>:<file stem>`, never shown: the title is the remembered one, else "Untitled".
  const name = read?.title || importedTitle(id) || t('import.untitled');

  return (
    <div className="fview" hidden={!visible} data-imported={id} data-view={read ? 'chat' : error ? 'error' : 'loading'}>
      <div className="fv-bar fv-head">
        <span className="fv-path" title={read?.project}>
          {read ? `${read.agent} · ${read.project ? basename(read.project) : '—'} · ${name}` : name}
        </span>
      </div>
      <div className="fv-body">
        {error ? (
          <div className="empty fv-error" role="alert">
            {t('import.readFailed', { error: plainError(t, error) })}
            <ErrorDetails t={t} details={error} />
          </div>
        ) : !read ? (
          <div className="empty" role="status" aria-busy="true">
            {t('import.reading')}
          </div>
        ) : (
          <div className="fv-scroll" role="feed" aria-label={name}>
            <Open.Provider value={openCtx}>
              {rows.map((row) => (
                <div key={row.key} className="cin" role="article" style={{ paddingBottom: 10 }}>
                  <RowView row={row} session="" />
                </div>
              ))}
            </Open.Provider>
          </div>
        )}
      </div>
      {read?.truncated && (
        <div className="fv-bar fv-foot" role="status">
          {t('import.truncated', { n: read.entries.length, left: read.left_out })}
        </div>
      )}
      <div className="fv-bar fv-foot" role="note">
        {t('import.readOnlyNote')}
      </div>
    </div>
  );
}
