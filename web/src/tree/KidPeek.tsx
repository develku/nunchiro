// needs 169: one sub-agent's own output, read only, in a panel at the window's right edge so the parent's chat stays
// visible and usable beside it. The rows are the chat's own (buildRows, viewRows, RowView, Open) fed with the child's
// events from the core's window-only `subagents` read. There is no composer, no answer or allow control and no send
// path here: the Pending context is empty, so a diff row draws no Accept/Reject and a path or file stays plain text.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CoreClient } from '../api';
import { Open, RowView } from '../chat/Rows';
import { Pending } from '../chat/pending';
import { buildRows, viewRows } from '../chat/model';
import type { ChatEvent } from '../chat/feed';
import { Tr } from '../i18n';
import { ErrorLine } from '../errors';
import { jumpTo } from '../search/jump';
import { openSession } from '../tree';
import { REFRESH_MS, wordOf, type Nest } from './kids';
import type { T } from './state';
import './kidpeek.css';

export interface Peek {
  /** The parent session, whose transcript the child's launch call sits in. */
  session: string;
  kid: Nest;
}

interface Opened {
  source: 'child' | 'parent';
  events: ChatEvent[];
  truncated: boolean;
  cursor?: number;
}

const NOTHING = { session: null, boot: null, matched: new Map() };
/** Pixels from the end that still count as "at the bottom": the panel then follows new rows. */
const BOTTOM = 8;

/** Back to the row the panel was opened from (or the `↳ N` that holds it, when the row is folded away). */
function restoreFocus({ session, kid }: Peek) {
  setTimeout(() => {
    const row = document.querySelector<HTMLElement>(`.row.kid[data-kid="${CSS.escape(kid.id)}"]`);
    (row ?? document.querySelector<HTMLElement>(`.kidcount[data-kids~="${CSS.escape(session)}"]`))?.focus();
  }, 0);
}

/**
 * `onParent(note)`: the child keeps no file of its own (ACP, an older agent, not written yet): the parent's tab opens at the
 * launch call and no panel is drawn; `note` is the status line text when the call is older than the loaded chat.
 */
export function KidPeek({ core, peek, kid, onClose, onParent, t }: { core: CoreClient; peek: Peek; kid: Nest; onClose: () => void; onParent: (note: string) => void; t: T }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<unknown>('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [now] = useState(() => Date.now());
  const { session } = peek;
  const id = peek.kid.id;
  // One read on open, then at the tree's own pace; a newer panel (another child) replaces this effect, never stacks.
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const read = () =>
      core.request({ op: 'subagents', id: session, open: id }).then(
        (r) => {
          const o = (r as { opened?: Opened }).opened;
          if (!live || !o) return;
          if (o.source === 'parent') {
            window.clearInterval(timer);
            openSession(session);
            if (o.cursor !== undefined) jumpTo(session, o.cursor);
            return onParent(o.cursor === undefined ? t('tree.subagents.callOlder') : '');
          }
          setError('');
          setOpened(o);
        },
        (e: Error) => live && setError(e),
      );
    void read();
    timer = window.setInterval(() => void read(), REFRESH_MS);
    return () => ((live = false), window.clearInterval(timer));
  }, [core, session, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => viewRows(buildRows(opened?.events ?? []), 'normal'), [opened]);
  const openCtx = useMemo(() => ({ has: (k: string) => expanded.has(k), toggle: (k: string) => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; }) }), [expanded]);
  // First rows: focus the panel (so Esc and Tab work from the keyboard that opened it); later rows: follow only at the end.
  const shown = !!opened || !!error;
  useLayoutEffect(() => {
    if (shown) root.current?.focus({ preventScroll: true });
  }, [shown]);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [rows]);
  const close = useCallback(() => (onClose(), restoreFocus(peek)), [onClose, peek]);
  if (!shown) return null;
  return createPortal(
    <aside
      ref={root}
      className="kidpeek glass"
      data-kidpeek={id}
      role="complementary"
      aria-label={kid.label}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) (e.preventDefault(), e.stopPropagation(), close());
      }}
    >
      <header>
        <b className="kp-name">{kid.label}</b>
        {wordOf(kid, now, t) && <span className="kp-state">{wordOf(kid, now, t)}</span>}
        <button type="button" className="btn kp-close" onClick={close}>
          {t('tree.subagents.close')}
        </button>
      </header>
      <p className="kp-note">{t('tree.subagents.readOnly')}</p>
      <div
        ref={body}
        className="kp-body"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM;
        }}
      >
        <ErrorLine t={t} error={error} className="err" />
        {opened && rows.length === 0 && <p className="kp-empty">{t('tree.subagents.empty')}</p>}
        <Tr.Provider value={t}>
          <Open.Provider value={openCtx}>
            <Pending.Provider value={NOTHING}>
              {rows.map((row) => (
                <div key={row.key} className="kp-row">
                  <RowView row={row} session={session} />
                </div>
              ))}
            </Pending.Provider>
          </Open.Provider>
        </Tr.Provider>
      </div>
    </aside>,
    document.body,
  );
}
