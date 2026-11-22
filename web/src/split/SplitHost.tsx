// SPLITS: the session view with its splits around it (frame-ko-e `.tsplit` / `#tmp`): left splits, then a column of the
// splits above, the view itself and the splits below, then right splits. A split's header has its icon, name, the
// Temporary chip, 📌 (widgets only) and ✕, each icon-only with a label and tooltip (NODUP).
import { useRef, useState, type ReactNode } from 'react';
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import { SideChat } from '../chat/SideChat';
import { WIDGET_LABEL } from '../layout/bars';
import { Icon } from '../layout/icons';
import { kindOf } from '../layout/model';
import { sessionName } from '../Sidebar';
import type { Session } from '../types';
import { Chooser, type Choice } from './Chooser';
import { CHOOSER, SIDE_START, RATIO, ratioOf, sessionOf, setRatio, useRatios, useSplits, type Split } from './store';
import './split.css';

interface Props {
  t: T;
  session: Session | null;
  all: Session[];
  children: ReactNode;
  widget: (item: string) => ReactNode;
  term: (id: string) => ReactNode;
  chat: (s: Session) => ReactNode;
  /** The window's composer bound to a split's agent session (its own send path, unchanged). */
  composer: (s: Session) => ReactNode;
  core: CoreClient;
  onPick: (split: Split, c: Choice) => void;
  onPin: (split: Split) => void;
  onClose: (split: Split) => void;
}

/** The gutter between a split and the chat: drag, arrows (2 %, Shift 10 %), Home/End, double-click resets. The value is the split's share. */
function Gutter({ split, t }: { split: Split; t: T }) {
  useRatios();
  const row = split.side === 'left' || split.side === 'right';
  // Moving the gutter toward the chat grows the split: left split grows to the right, a right split to the left.
  const grow = split.side === 'left' || split.side === 'up' ? 1 : -1;
  const v = ratioOf(split.id);
  const drag = useRef<{ start: number; from: number; size: number } | null>(null);
  const axis = (el: HTMLElement) => {
    const box = el.closest(row ? '[data-split-host]' : '.scol')?.getBoundingClientRect();
    return box ? (row ? box.width : box.height) : 0;
  };
  return (
    <div
      className="sgutter"
      data-split-gutter={split.id}
      data-axis={row ? 'x' : 'y'}
      role="separator"
      tabIndex={0}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={t('rest.st.resize')}
      aria-valuenow={v}
      aria-valuemin={RATIO.min}
      aria-valuemax={RATIO.max}
      onDoubleClick={() => setRatio(split.id, RATIO.dflt)}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: row ? e.clientX : e.clientY, from: v, size: axis(e.currentTarget) };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d && d.size > 0) setRatio(split.id, d.from + (grow * ((row ? e.clientX : e.clientY) - d.start) * 100) / d.size);
      }}
      onPointerUp={() => (drag.current = null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 10 : 2;
        const dir = row ? { ArrowLeft: -1, ArrowRight: 1 }[e.key] : { ArrowUp: -1, ArrowDown: 1 }[e.key];
        if (e.key === 'Home') setRatio(split.id, RATIO.min);
        else if (e.key === 'End') setRatio(split.id, RATIO.max);
        else if (dir !== undefined) setRatio(split.id, v + grow * dir * step);
        else return;
        e.preventDefault();
      }}
    />
  );
}

export function SplitHost(p: Props) {
  const all = useSplits();
  useRatios();
  const [maxId, setMaxId] = useState<string | null>(null);
  const mine = p.session ? (all[p.session.id] ?? []) : [];
  // A closed split, or another session's, is not maximised any more (the id is never reused).
  const maxed = mine.find((s) => s.id === maxId) ?? null;
  const on = (side: Split['side']) =>
    mine
      .filter((s) => s.side === side)
      .flatMap((s) => (s.side === 'left' || s.side === 'up' ? [pane(s), <Gutter key={`g${s.id}`} split={s} t={p.t} />] : [<Gutter key={`g${s.id}`} split={s} t={p.t} />, pane(s)]));

  function pane(s: Split) {
    const sid = sessionOf(s.what);
    const started = sid ? p.all.find((x) => x.id === sid) : undefined;
    const kind = kindOf(s.what);
    const name = s.what === SIDE_START ? p.t('chat.side.title') : s.what === CHOOSER ? p.t('rest.st.newSplit') : started ? sessionName(started) : sid ? p.t('rest.st.ended') : `${WIDGET_LABEL(s.what)}${p.session ? ` · ${sessionName(p.session)}` : ''}`;
    const icon = s.what === SIDE_START ? 'agents' : s.what === CHOOSER ? 'layout' : started ? (started.kind === 'shell' ? 'terminal' : 'agents') : sid ? '' : kind;
    const body =
      s.what === SIDE_START ? <><SideChat id={s.id} t={p.t} /><div className="empty">{p.t('chat.side.starting')}</div></> : s.what === CHOOSER ? (
        <Chooser t={p.t} core={p.core} onPick={(c) => p.onPick(s, c)} onClose={() => p.onClose(s)} />
      ) : sid ? (
        started?.state === 'running' ? (started.kind === 'shell' ? (
          p.term(started.id)
        ) : (
          <div className="schat">
            <div className="schatv">{p.chat(started)}</div>
            {p.composer(started)}
          </div>
        )) : <div className="empty">{started ? p.t('rest.st.isState', { name, state: started.state }) : p.t('rest.st.gone')}</div>
      ) : kind === 'terminal' && p.session ? (
        p.term(p.session.id)
      ) : (
        p.widget(s.what)
      );
    return (
      <section
        key={s.id}
        className="split"
        data-split-id={s.id}
        data-side={s.side}
        data-maxed={maxed?.id === s.id ? '' : undefined}
        style={maxed ? undefined : { flex: `0 0 ${ratioOf(s.id)}%` }}
        tabIndex={-1}
        aria-label={p.t('rest.st.splitLabel', { name })}
        onKeyDown={(e) => e.key === 'Escape' && maxed?.id === s.id && !e.defaultPrevented && (setMaxId(null), e.stopPropagation())}
      >
        <div className="sph" onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && setMaxId(maxed?.id === s.id ? null : s.id)}>
          <Icon kind={icon} size={14} />
          <b data-tip-clip="" data-tip={name}>{name}</b>
          <span className="chipt" data-tip={p.t('rest.st.temporaryTip')}>{p.t('rest.st.temporary')}</span>
          <span className="sp" />
          {/* The session's own terminal is the centre zone already: it has nothing to pin. */}
          {!sid && s.what !== CHOOSER && s.what !== SIDE_START && kind !== 'terminal' && (
            <button className="lx" aria-label={p.t('rest.st.keep')} data-tip={p.t('rest.st.keepTip')} onClick={() => p.onPin(s)}>
              📌
            </button>
          )}
          <button className="lx" aria-label={p.t(maxed?.id === s.id ? 'rest.st.restore' : 'rest.st.maximise')} aria-pressed={maxed?.id === s.id} data-tip={p.t(maxed?.id === s.id ? 'rest.st.restore' : 'rest.st.maximise')} onClick={() => setMaxId(maxed?.id === s.id ? null : s.id)}>
            {maxed?.id === s.id ? '❐' : '⛶'}
          </button>
          <button className="lx" aria-label={p.t('rest.st.closeSplit')} data-tip={p.t('rest.st.closeSplit')} onClick={() => p.onClose(s)}>
            ✕
          </button>
        </div>
        <div className="spb">{body}</div>
      </section>
    );
  }

  return (
    <div className="shost" data-split-host data-session={p.session?.id} data-maxed={maxed ? maxed.side : undefined}>
      {on('left')}
      <div className="scol">
        {on('up')}
        {p.children}
        {on('down')}
      </div>
      {on('right')}
    </div>
  );
}
