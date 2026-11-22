// Session header facts of the current session: the PR chip and the diff stat (ticket 1031 moved them out of the status
// bar, which repeated the header's state, branch and +N −M). Everything is read from what the core already has (the
// transcript's PR chip, diff_list); no new network.
import { useEffect, useState } from 'react';
import type { Boot, CoreClient } from '../api';
import { chatFeed } from '../chat/feed';
import { PrChip, type PrChipData } from '../chat/PrChip';
import type { DiffList } from '../diff/Diff';
import type { T } from '../i18n';
import { diffRequest } from '../diff/Diff';
import type { Session } from '../types';

const REFRESH_MS = 30_000;

/** The session's own change counts, from `diff_list`; `null` when nothing changed since it started. */
/** Ticket 374: `machine` (an SSH session's) reads the counts over Remote, as Diff does, so the two agree. */
export function useDiffStat(core: CoreClient, id: string | undefined, machine?: string): { add: number; del: number } | null {
  const [stat, setStat] = useState<{ add: number; del: number } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setStat(null);
    const read = () => {
      core.request(diffRequest(machine, { op: 'diff_list', session: id })).then(
        (r) => {
          const files = (r as DiffList).files;
          if (live) setStat(files.length ? { add: files.reduce((n, f) => n + (f.additions ?? 0), 0), del: files.reduce((n, f) => n + (f.deletions ?? 0), 0) } : null);
        },
        () => {},
      );
    };
    read();
    const t = setInterval(read, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [core, id, machine]);
  return stat;
}

/** The session's PR chip, in its header beside +N −M. */
export function SessionFacts({ core, boot, session, t }: { t: T; core: CoreClient; boot: Boot; session: Session }) {
  const id = session.id;
  const [chip, setChip] = useState<PrChipData | null>(null);
  // The PR chip is read when the session changes, then once a minute (the chat's own chip keeps the 2 s debounce).
  const agent = session.kind !== 'shell'; // a shell has no transcript, so no PR chip (and no chat feed to open)
  const cwd = session.cwd;
  const machine = session.machine;
  useEffect(() => {
    setChip(null); // the old one must not follow the switch
    let live = true;
    // Ticket 373: a shell, or an agent whose transcript made no PR, falls back to its folder branch's own PR (an outside
    // one too; live PR status on, cached per branch in the core).
    // Ticket 419: the folder is matched on its machine as well as its path. `pr_branch` runs gh on this Mac only (window
    // only, never over Remote), so an SSH session's folder has no branch PR here: the same path on this Mac is another folder.
    const branch = () => (machine ? Promise.resolve(null) : core.prBranch(cwd).then((p) => (p ? { state: p.state, url: p.url, at: null } : null), () => null));
    const read = () =>
      (agent ? chatFeed(boot).prChip(id).catch(() => null) : Promise.resolve(null))
        .then((c) => c ?? branch())
        .then((c) => live && setChip(c));
    read();
    const t = setInterval(read, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [boot, core, id, agent, cwd, machine]);
  return chip && <PrChip chip={chip} now={Date.now()} from={{ id, shell: !agent }} t={t} />;
}
