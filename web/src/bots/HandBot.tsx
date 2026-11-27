// "Hand to a bot…" on a worktree's row: the owner picks a bot and may say what to do with the worktree. The core opens
// the bot's chat and hands the worktree over as its next prompt (`bot_hand`); with nothing said, the bot asks. A
// worktree handed to its own project's Lead also joins that Lead's team, as "Hand to the lead" in the Lead's header
// does (the tree and the task list follow). No bot yet: the dialog offers to make one.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine, rawError } from '../errors';
import type { T } from '../i18n';
import { useTeam } from '../lead/lead';
import { basename, type ListedWorktree } from '../tree';
import type { Session } from '../types';
import { askNewBot, eyesOf, onHand, type Bot } from './bots';
import { Face } from './Face';
import { PLAIN } from '../plainText';
import './bots.css';

type Props = { core: CoreClient; t: T; list: ListedWorktree[]; sessions: Session[]; team: (path: string, lead: string) => Promise<unknown>; open: (id: string) => void };

/** Mounted once by the window; shown when a worktree row's menu or the palette asks (`askHand`). */
export function HandBot(props: Props) {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => onHand(setPath), []);
  const worktree = props.list.find((l) => l.path === path);
  return worktree ? <Dialog key={worktree.path} {...props} worktree={worktree} onClose={() => setPath(null)} /> : null;
}

const placeOf = (b: Bot) => (b.seat.kind === 'lead' ? b.seat.project : (b.v1?.project ?? ''));

function Dialog({ core, t, sessions, team: join, open, worktree, onClose }: Props & { worktree: ListedWorktree; onClose: () => void }) {
  const team = useTeam(core, true);
  // The worktree's own project's bots first: they work in that repository already.
  const bots = [...(team.bots ?? [])].sort((a, b) => Number(placeOf(b) === worktree.project) - Number(placeOf(a) === worktree.project));
  const [picked, setPicked] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>('');
  const box = useRef<HTMLFormElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    const prev = back.current;
    return () => (prev as HTMLElement | null)?.focus?.();
  }, []);
  const bot = bots.find((b) => b.id === picked) ?? bots[0];
  const name = worktree.label || worktree.branch || basename(worktree.path);
  const title = t('bots.hand.title', { name });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!bot || busy) return;
    setBusy(true);
    setError('');
    try {
      if (bot.seat.kind === 'lead' && bot.seat.project === worktree.project && worktree.team !== bot.id) await join(worktree.path, bot.id);
      const { session } = (await core.request({ op: 'bot_hand', id: bot.id, worktree: worktree.path, ...(goal.trim() ? { goal: goal.trim() } : {}) })) as { session: Session };
      onClose();
      open(session.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const key = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), onClose());
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return (e.preventDefault(), box.current?.requestSubmit());
  };
  return (
    <div className="rmscrim" onPointerDown={(e) => e.target === e.currentTarget && !goal && onClose()}>
      <form ref={box} className="newbot handbot" data-hand-bot role="dialog" aria-modal="true" aria-label={title} aria-busy={busy || undefined} onSubmit={(e) => void submit(e)} onKeyDown={key}>
        <h2>{title}</h2>
        <p className="nb-note">{t('bots.hand.note')}</p>
        {bots.length === 0 ? (
          <p className="nb-note">{t('bots.hand.none')}</p>
        ) : (
          <>
            <div className="hb-list" role="radiogroup" aria-label={t('bots.hand.who')}>
              {bots.map((b, i) => (
                <label key={b.id} data-hand-to={b.id}>
                  <input type="radio" name="hand-bot" checked={bot?.id === b.id} autoFocus={i === 0} disabled={busy} onChange={() => setPicked(b.id)} />
                  <Face t={t} face={b.face} name={b.name} eyes={eyesOf(sessions, b.id)} size={28} />
                  <span>
                    <b>{b.name}</b>
                    <small>{b.job.split('\n')[0]}</small>
                  </span>
                </label>
              ))}
            </div>
            <textarea {...PLAIN} className="nb-job" aria-label={t('bots.hand.goal')} placeholder={`${t('bots.hand.goal')} ${t('bots.hand.goalPh')}`} value={goal} maxLength={2000} rows={2} disabled={busy} onChange={(e) => setGoal(e.target.value)} />
          </>
        )}
        <ErrorLine t={t} error={error ? rawError(error) : ''} />
        <div className="nb-foot">
          <button type="button" className="nb-btn quiet" onClick={onClose}>
            {t('bots.new.cancel')}
          </button>
          {bots.length === 0 ? (
            <button type="button" className="nb-btn primary" autoFocus onClick={() => (onClose(), askNewBot())}>
              {t('bots.hand.new')}
            </button>
          ) : (
            <button type="submit" className="nb-btn primary" data-hand-go disabled={busy}>
              {t('bots.hand.go')} <kbd>⌘↩</kbd>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
