// The Diff header's Push, run by the app (crates/nunchiro-core/src/git_write.rs): a confirm strip under the header that
// names the commits, the remote branch and the head commit, as the PR view's Merge strip does (pr/PrView.tsx). Push sends
// that head back; the core checks the branch again and refuses when it moved. Mockup docs/design/git-actions-m2 panel 3.
// The menu beside the button picks between the app and asking the agent; the last pick is kept (gitAction.ts `storedWay`).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CoreClient } from '../api';
import { ErrorLine } from '../errors';
import { Icon } from '../icons/Icon';
import type { Key, T } from '../i18n';
import type { GitFacts, Way } from './gitAction';

export type PushReply = { type: 'git_pushed'; pushed: number; remote: string; branch: string; note?: string };

/** `pr`: the number of the open PR the app knows for this branch, which the pushed commits join. */
export function PushStrip({ core, session, git, pr, onPushed, onCancel, t }: { core: CoreClient; session: string; git: GitFacts; pr: number | null; onPushed: (r: PushReply) => void; onCancel: () => void; t: T }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  // What the strip shows is kept from when it opened: a list refresh never re-arms it, and the core checks the push
  // against exactly these values.
  const [{ to, head }] = useState(() => ({ to: git.push_to!, head: git.head! }));
  const go = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    core.request({ op: 'git_push', session, head, remote: to.remote, branch: to.branch, ahead: to.ahead, key: to.key }).then(
      (r) => (setBusy(false), onPushed(r as PushReply)),
      (e: unknown) => (setBusy(false), setError(e)),
    );
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing || busy) return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };
  const n = to.ahead;
  return (
    <div className="dpush" role="alertdialog" aria-label={t('gitActions.push.go')} onKeyDown={onKey}>
      <p>
        {t(n === 1 ? 'gitActions.push.confirm.one' : 'gitActions.push.confirm.other', { n, remote: to.remote, branch: to.branch, head: head.slice(0, 7) })}
        {pr !== null && <> {t('gitActions.push.prGets', { pr })}</>}
      </p>
      <button type="button" className="btn p" disabled={busy} onClick={go}>
        {busy ? t('gitActions.push.going') : t('gitActions.push.go')}
      </button>{' '}
      <button type="button" className="btn" ref={cancel} disabled={busy} onClick={onCancel}>
        {t('gitActions.push.cancel')}
      </button>
      <ErrorLine t={t} error={error} className="dpush-err" />
    </div>
  );
}

/** The menu beside the button: the app's Push or asking the agent. `agentWhy`: why the agent cannot be asked now. */
export function WayMenu({ way, appLabel, agentLabel, agentWhy, onPick, t }: { way: Way; appLabel: string; agentLabel: string; agentWhy?: Key; onPick: (w: Way) => void; t: T }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const rows: { w: Way; label: string; off?: boolean }[] = [
    { w: 'app', label: appLabel },
    { w: 'agent', label: agentLabel, off: !!agentWhy },
  ];
  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      box.current?.querySelector<HTMLElement>('.dway')?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  return (
    <span className="dd dway-box" ref={box} onKeyDown={onKey}>
      <button type="button" className="btn dway" aria-label={t('gitActions.choices')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="triangle-down" size={12} />
      </button>
      {open && (
        <span className="menu glass dway-menu" role="menu" aria-label={t('gitActions.choices')}>
          {rows.map((r) => (
            <button
              key={r.w}
              type="button"
              role="menuitemradio"
              aria-checked={way === r.w}
              aria-disabled={r.off || undefined}
              data-tip={r.off && agentWhy ? t(agentWhy) : r.w === 'app' ? t('gitActions.choice.appTip') : undefined}
              onClick={() => {
                if (r.off) return;
                setOpen(false);
                onPick(r.w);
              }}
            >
              <span className="ck">{way === r.w && <Icon name="check" size={12} />}</span>
              {r.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** The line after a push, at the panel's foot. */
export const pushedText = (t: T, r: PushReply) =>
  t(r.pushed === 1 ? 'gitActions.push.done.one' : 'gitActions.push.done.other', { n: r.pushed, remote: r.remote, branch: r.branch }) + (r.note ? ` ${t('gitActions.push.noUpstream')}` : '');
