// Diff (±) widget (spec B3 Diff, ticket v1b-11): the focused session's changes against the commit that was HEAD
// when it started, plus untracked files. Read only. Other widgets open it at a path with `openDiff(path)`.
// Ticket 222 (B19a): a "Latest turn / Changes" scope; Latest turn lists only the files the last finished turn wrote.
// Ticket 374: the list keeps itself current (window focus, a finished turn, every 30 s), an old turn row opens with
// only its files, a Branch scope compares with where the branch left origin's default branch, and an SSH session's
// diff goes over the owner's Remote path. Refresh shape from artifacts-widget/Artifacts.tsx useChanges; behaviour
// reference t3code apps/web/src/components/DiffPanel.tsx:500-504 and :678-700 (MIT).
// Ticket 373: one header button (gitAction.ts) asks the session's agent to commit, push or open a PR, only when pressed.
import { Icon } from '../icons/Icon';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { waitForBoot, type CoreClient } from '../api';
import { chatFeed, type ChatEvent } from '../chat/feed';
import { mergeEvents } from '../chat/model';
import type { Key, T } from '../i18n';
import { COLOURS, HIDE_LIST } from '../features/diff-options';
import { useFeatureSetting } from '../settings/useFeatureSetting';
import type { Session } from '../types';
import { gitAction, promptKey, type GitFacts } from './gitAction';
import { finishedTurnAt, keepScope, latestTurn, latestTurnPartial, scoped, storedScope, type Scope } from './scope';
import { listState, truncatedNote } from './state';
import { ErrorDetails, lineError, rawError } from '../errors';
import { askNew } from '../NewSession';
import { Stack } from './Stack';
import './diff.css';

// Mirrors crates/nunchiro-core/src/diff/mod.rs (serde shapes).
export type Base = { kind: 'commit'; sha: string } | { kind: 'no_commits' } | { kind: 'not_git' };
export type Change = {
  path: string;
  status: string;
  old_path: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** The file's stat as a number; changes with each write. Absent from an older core. */
  stamp?: number | null;
};
/** Ticket 374: whether the Branch scope can compare; `default` is a remote branch name such as `origin/main`. */
export type Branch = { kind: 'ready'; default: string } | { kind: 'no_origin' } | { kind: 'on_default' };
export type DiffList = { type: 'diff'; base: Base | null; base_missing?: boolean; files: Change[]; truncated: boolean; branch?: Branch; git?: GitFacts };
export type Patch = { type: 'diff_file'; path: string; status: string; old_path: string | null; binary: boolean; too_large: boolean; patch: string | null };

/** `diff.open <path>`: the window opens Diff for the focused session, at `path` when given, in `scope` when given
 *  (ticket 222; kept first, so a Diff that mounts on this event opens in it). */
export const DIFF_OPEN = 'nunchiro:diff.open';
export function openDiff(path?: string, scope?: Scope, files?: string[]) {
  if (scope) keepScope(scope);
  // Ticket 374: `files` (a turn row's own) narrow the turn scope to that turn instead of the latest one.
  window.dispatchEvent(new CustomEvent(DIFF_OPEN, { detail: { path, scope, files } }));
}

/** Ticket 374: a diff request for a session on another machine goes over the owner's Remote path (server.rs). */
export function diffRequest(machine: string | undefined, request: { op: string; [k: string]: unknown }) {
  return machine ? { op: 'remote', machine, request } : request;
}
/** Ticket 373: how long after a press a refresh tick keeps the button waiting when the agent has not shown working. */
const SENT_WAIT_MS = 5_000;
/** Re-read so the list and the status bar count agree mid-turn (chrome/SessionFacts.tsx reads as often). */
export const REFRESH_MS = 30_000;

const SCOPES: Scope[] = ['turn', 'changes', 'branch'];
const SCOPE_KEYS = { turn: 'diff.scope.turn', changes: 'diff.scope.changes', branch: 'diff.scope.branch' } as const;
const STATUS = new Set(['M', 'A', 'D', 'R', 'C', 'T', 'U', '?']);
/** A git status letter in the window's language (ticket 492); an unknown letter shows as itself. */
const statusWord = (t: T, s: string) => (STATUS.has(s) ? t(`mw.diff.st.${s}` as Key) : s);
export const ext = (p: string) => (/\.([^./]+)$/.exec(p)?.[1] ?? '').slice(0, 4).toLowerCase() || '·';
export const counts = (c: Change) => (c.binary ? 'binary' : c.additions === null ? '' : `+${c.additions} −${c.deletions ?? 0}`);
export { listState, truncatedNote } from './state';

/** The files of the session's last finished turn, from its chat events; null before one finished (or for a session
 *  without a transcript). shortcut: reads the newest chat page and live pages only, so a finished turn more than 200
 *  events back is not seen; page back with `older` if long turns make the scope show disabled after a finished turn. */
function useLatestTurn(session: string | null): { files: string[] | null; at: number | null; partial?: boolean } {
  const [got, setGot] = useState<{ session: string | null; files: string[] | null; at: number | null; partial?: boolean }>({ session: null, files: null, at: null });
  useEffect(() => {
    if (!session) return;
    let live = true;
    let stop: (() => void) | undefined;
    let events: ChatEvent[] = [];
    let generation: number | null = null;
    void waitForBoot().then((boot) => {
      if (!live) return;
      stop = chatFeed(boot).open(session, {
        page: (p, kind) => {
          if (p.schema_version !== 1) return;
          events = kind === 'reset' || p.generation !== generation ? p.events : mergeEvents(events, p.events);
          generation = p.generation;
          setGot({ session, files: latestTurn(events), at: finishedTurnAt(events), partial: latestTurnPartial(events) });
        },
        error: () => {},
      });
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [session]);
  return got.session === session ? got : { files: null, at: null, partial: false };
}

/** Ticket 373: the session has an open PR the app knows of (its agent's own `gh` calls, from the transcript). shortcut:
 *  a PR opened outside the app, or merged since, is not seen; the ladder then offers a PR and the agent finds it. */
const OPEN_PR = new Set(['draft', 'open', 'checks_pass', 'checks_fail', 'approved']);
function useOpenPr(session: string | null, tick: number): boolean {
  const [got, setGot] = useState<{ session: string | null; open: boolean }>({ session: null, open: false });
  useEffect(() => {
    if (!session) return;
    let live = true;
    void waitForBoot()
      .then((boot) => chatFeed(boot).prChip(session))
      .then((c) => live && setGot({ session, open: !!c && OPEN_PR.has(c.state) }), () => {});
    return () => {
      live = false;
    };
  }, [session, tick]);
  return got.session === session && got.open;
}

/** Beside the right icon bar (±) with `onClose`; inside a layout zone (07b gallery widget) without it. `t` is the
 *  window's catalogue: no Tr provider sits above a layout zone, so the context alone read English (ticket 222). */
/** Ticket 374: `machine` is an SSH session's machine; `browser` is a paired browser, which may not use Remote. */
export function DiffDock({ core, session, label, owner, focus, onClose, t, machine, browser, quote }: { core: CoreClient; session: string | null; label: string; owner?: Session | null; focus: { path?: string; files?: string[]; n: number }; onClose?: () => void; t: T; machine?: string; browser?: boolean; quote?: (text: string) => void }) {
  // The list and the patch are kept with what they were read for: a refresh shows the old one until the new arrives.
  const [got, setGot] = useState<{ session: string | null; ask: 'session' | 'branch'; list: DiffList | null; error: string }>({ session: null, ask: 'session', list: null, error: '' });
  const [selected, setSelected] = useState<string | null>(null);
  const [jump, setJump] = useState(0); // ticket 374: a choice in the list (or openDiff) scrolls the stack to that file
  const [force, setForce] = useState(0); // the refresh button re-reads the patches too (diff/Stack.tsx)
  const fresh = useRef(true); // ticket 463: Diff opened or Refresh pressed: the core reads git now, not its kept list
  const [pinned, setPinned] = useState<{ session: string | null; files: string[] } | null>(null); // an old turn row's files
  const [reached, setReached] = useState<string | null>(null); // the file the arrow keys last reached: the list's one tab stop
  const [tick, setTick] = useState(0);
  const [scope, setScope] = useState<Scope>(storedScope);
  const latest = useLatestTurn(session);
  const turn = pinned && pinned.session === session ? pinned.files : latest.files;
  // shortcut: an old turn row passes only its files, so its own `files_partial` is not seen; pass it through openDiff if needed.
  const partial = !(pinned && pinned.session === session) && !!latest.partial;
  const remoteOff = !!machine && !!browser; // web access refuses Remote (http/browser.rs), so a plain state
  // Ticket 261: the view options (Settings > Appearance > Diff); the stack reads its own (diff/Stack.tsx).
  const [hideList] = useFeatureSetting(HIDE_LIST);
  const [colours] = useFeatureSetting(COLOURS);
  const ask = scope === 'branch' ? 'branch' : 'session';
  const mine = got.session === session;
  const now = mine && got.ask === ask ? got : null; // the list read for this session and scope
  const list = now?.list ?? null;
  const error = now?.error ?? '';
  const branch = mine ? got.list?.branch : undefined; // any list of this session says whether Branch can compare
  // Latest turn needs a finished turn and Branch a branch to compare; until then the list stays on Changes.
  const shown: Scope = scope === 'turn' && turn ? 'turn' : scope === 'branch' && branch?.kind === 'ready' ? 'branch' : 'changes';
  const off = (s: Scope) => (s === 'turn' ? !turn : s === 'branch' ? branch?.kind !== 'ready' : false);
  const offTip = (s: Scope) => (s === 'turn' ? t('diff.scope.noTurn') : t(branch?.kind === 'on_default' ? 'diff.branch.onDefault' : 'diff.branch.noOrigin'));
  const pick = (s: Scope) => {
    setScope(s);
    keepScope(s);
    setPinned(null);
  };
  // Ticket 373: after a press the button waits ('' = sent) until the turn ends, which re-reads the list, or a refresh;
  // a send that failed keeps its reason here. One press can never queue a second request behind the first.
  const openPr = useOpenPr(session, tick);
  const [sent, setSent] = useState<string | null>(null);
  const working = !!owner?.attention.working;
  const wasWorking = useRef(working);
  // A refresh tick (focus, 30 s, a finished turn) may come before the agent shows working: it ends the wait only once
  // the working flag was seen or SENT_WAIT_MS passed.
  const wait = useRef({ at: 0, seen: false });
  useEffect(() => {
    if (working && sent === '') wait.current.seen = true;
    if (wasWorking.current && !working && sent === '') setTick((n) => n + 1);
    wasWorking.current = working;
  }, [working, sent]);
  useEffect(() => setSent(null), [session]);
  useEffect(() => {
    const w = wait.current;
    setSent((s) => (s !== '' || w.seen || Date.now() - w.at > SENT_WAIT_MS ? null : s));
  }, [tick]);
  // Only a local agent session can be asked: the facts are read for it alone (a few git calls per list).
  const wantGit = !!owner && owner.kind !== 'shell' && !machine;

  useEffect(() => setPinned(null), [session]);
  useEffect(() => {
    setSelected(focus.path ?? null);
    setJump((n) => n + 1);
    setPinned(focus.files ? { session, files: focus.files } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a turn row's files belong to the session focused when it was clicked
  }, [focus]);
  // Window focus and every 30 s re-read the list, so edits made outside the app show without Refresh.
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener('focus', on);
    const timer = setInterval(on, REFRESH_MS);
    return () => {
      window.removeEventListener('focus', on);
      clearInterval(timer);
    };
  }, []);
  // `openDiff(path, scope)` (the chat's per-turn row): switch scope and re-read the list, which the turn just changed.
  useEffect(() => {
    const on = (e: Event) => {
      const s = (e as CustomEvent<{ scope?: Scope }>).detail?.scope;
      if (s !== 'turn' && s !== 'changes' && s !== 'branch') return;
      setScope(s);
      setTick((n) => n + 1);
    };
    window.addEventListener(DIFF_OPEN, on);
    return () => window.removeEventListener(DIFF_OPEN, on);
  }, []);
  // A finished turn is keyed by its event, not the files array, which is new on every chat page.
  useEffect(() => {
    if (!session || remoteOff) return;
    let live = true;
    const asked = fresh.current ? { fresh: true } : {};
    fresh.current = false;
    core
      .request(diffRequest(machine, { op: 'diff_list', session, ...(ask === 'branch' ? { scope: 'branch' } : {}), ...(wantGit ? { git: true } : {}), ...asked }))
      .then((r) => {
        if (!live) return;
        const next = r as DiffList;
        setGot({ session, ask, list: next, error: '' });
        // A refresh keeps the file being read; the first list opens at the asked path, else the first file.
        setSelected((path) => (next.files.some((f) => f.path === path) ? path : focus.path ?? next.files[0]?.path ?? null));
      })
      .catch((e: Error) => live && setGot({ session, ask, list: null, error: rawError(e) }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus.path is read once per list, never a reason to re-read
  }, [core, session, machine, remoteOff, ask, tick, latest.at, wantGit]);
  const files = useMemo(() => (list && shown === 'turn' && turn ? scoped(list.files, turn) : list?.files ?? []), [list, shown, turn]);
  // The file shown in the view: the selected one while the scope lists it.
  const current = selected && files.some((f) => f.path === selected) ? selected : null;
  const base = list?.base;
  // An SSH session (`machine`) has no button: its prompt would go to this Mac's core, which does not have it.
  const act = !machine && owner && owner.id === session && list && base?.kind !== 'not_git' ? gitAction(owner, list.git ?? null, openPr) : null;
  const gitTip = sent ? t('gitActions.sendFailed', { error: lineError(t, sent) }) : sent === '' ? t('gitActions.why.working') : act?.why ? t(act.why, { branch: list?.git?.branch ?? '' }) : undefined;
  const gitAsk = sent === '' ? null : act?.ask ?? null;
  // The list may be stale (a branch switched since): the facts are read again at the press, and a changed state
  // sends nothing and shows its own label and reason.
  const press = async () => {
    if (!gitAsk || !session || !owner) return;
    setSent('');
    wait.current = { at: Date.now(), seen: false };
    try {
      const fresh = (await core.request(diffRequest(machine, { op: 'diff_list', session, ...(ask === 'branch' ? { scope: 'branch' } : {}), git: true, fresh: true }))) as DiffList;
      if (gitAction(owner, fresh.git ?? null, openPr).ask !== gitAsk) {
        setGot({ session, ask, list: fresh, error: '' });
        setSent(null);
        return;
      }
      await core.request({ op: 'agent_prompt', id: session, text: t(promptKey(gitAsk)) });
    } catch (e) {
      setSent(rawError(e) || 'refused');
    }
  };
  // The base sits where the language puts it ("vs abc1234", "abc1234 기준"); the sha keeps its mono span.
  const vs = t('diff.head.vs', { base: '\u0000' }).split('\u0000');
  const state = remoteOff
    ? t('diff.ssh.unavailable')
    : shown === 'branch' && list && !files.length
      ? t('diff.branch.empty')
      : listState(session, list, error, t) ?? (files.length ? null : t(partial ? 'diff.scope.turnUnknown' : 'diff.scope.turnEmpty'));
  // Real-app 11-10 defect 3: a turn that ran commands and lists no file may still have changed some; Changes is one press
  // away. A list with files adds nothing (coordinator, round 2: nearly every real turn runs a command).
  const showAll = shown === 'turn' && partial && !files.length && !!list?.files.length && (
    // The button leaves with the press: focus goes to the Changes radio it chose, not to the page.
    <button type="button" className="btn" onClick={(e) => (e.currentTarget.closest('aside')?.querySelector<HTMLElement>('[data-scope="changes"]')?.focus(), pick('changes'))}>
      {t('diff.scope.showChanges')}
    </button>
  );
  const stacked = !!(session && list && !state);
  // needs 172: the list is one tab stop (the file reached, else the selected one, else the first) and Up, Down, Home and End
  // move through it, as the Files tree does (files/FilesTree.tsx); Enter or Space on a file opens its diff, as any button.
  const stop = [reached, current].find((p) => p && files.some((f) => f.path === p)) ?? files[0]?.path;
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const paths = files.map((f) => f.path);
    const at = paths.indexOf((e.target as HTMLElement).closest<HTMLElement>('[data-path]')?.dataset.path ?? '');
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: paths.length - 1 }[e.key];
    if (at < 0 || to === undefined || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.currentTarget.querySelectorAll<HTMLElement>('[data-path]')[Math.max(0, Math.min(paths.length - 1, to))]?.focus();
  };
  // needs 172: a radio group is one tab stop; the arrows move to the other scope and choose it (a disabled one is skipped).
  const onScopeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const on = SCOPES.filter((s) => !off(s));
    const next = on[(on.indexOf(shown) + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + on.length) % on.length];
    if (!next || next === shown) return;
    pick(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-scope="${next}"]`)?.focus();
  };

  return (
    <aside className={`${onClose ? 'dock r' : 'dock zone'} diff${stacked ? ' wide' : ''}`} aria-label={t('mw.diff.title')} data-colours={colours}>
      <div className="ph">
        <span className="grip" aria-hidden>
          ⋮⋮
        </span>
        <span className="pt">
          <Icon name="diff" size={14} /> {t('mw.diff.title')}
        </span>
        <span className="r">{session ? (machine ? `${label} · ${machine}` : label) : ''}</span>
        {/* Ticket 373: aria-disabled keeps the reason reachable by focus (the app tooltip shows for the focused element). */}
        {act && (
          <button type="button" className="btn dgit" aria-disabled={gitAsk ? undefined : 'true'} data-tip={gitTip ?? t(act.label)} data-tip-clip={gitTip ? undefined : ''} onClick={() => void press()}>
            {t(act.label)}
          </button>
        )}
        <button
          className="dbtn"
          aria-label={t('mw.diff.refresh')}
          title={t('mw.diff.refreshTip')}
          onClick={() => {
            fresh.current = true;
            setTick((t) => t + 1);
            setForce((n) => n + 1);
            setSent(null); // ticket 373: the person's own Refresh ends the wait after a press; automatic ticks do not
          }}
          disabled={!session || remoteOff}
        >
          ↻
        </button>
        {onClose && (
          <button className="dbtn" aria-label={t('mw.diff.closeDiff')} data-tip={t('mw.close')} onClick={onClose}>
            ×
          </button>
        )}
      </div>
      {session && !remoteOff && (
        <div className="dscope" role="radiogroup" aria-label={t('diff.scope.label')} onKeyDown={onScopeKey}>
          {SCOPES.map((s) => {
            const no = off(s);
            return (
              <button key={s} type="button" role="radio" data-scope={s} aria-checked={shown === s} aria-disabled={no ? 'true' : undefined} title={no ? offTip(s) : undefined} tabIndex={shown === s ? 0 : -1} onClick={() => !no && pick(s)}>
                {t(SCOPE_KEYS[s])}
              </button>
            );
          })}
        </div>
      )}
      {base && base.kind !== 'not_git' && !list?.base_missing && (
        <div className="dbase" title={base.kind === 'commit' ? base.sha : undefined}>
          {vs[0]}
          {base.kind === 'commit' ? <span className="mono">{base.sha.slice(0, 7)}</span> : t('diff.head.emptyRepo')}
          {vs[1]} · {shown === 'branch' && branch?.kind === 'ready' ? t('diff.branch.base', { branch: branch.default }) : t(shown === 'turn' ? 'diff.scope.turnBase' : 'diff.head.checkoutStart')} · {t(files.length === 1 ? 'diff.head.files.one' : 'diff.head.files.other', { n: files.length })}
        </div>
      )}
      {state ? (
        <div className="empty dstate" role="status">
          <span>
            {state} {showAll}
            {!session && (
              <button type="button" className="btn" onClick={() => askNew()}>
                {t('empty.startSession')}
              </button>
            )}
          </span>
          <ErrorDetails t={t} details={error} />
        </div>
      ) : (
        <>
          {!(hideList && stacked) && (
            <ul className="dfiles" aria-label={t('mw.diff.changedFiles')} onKeyDown={onListKey} onFocus={(e) => setReached((e.target as HTMLElement).dataset.path ?? null)}>
              {files.map((f) => (
                <li key={f.path}>
                  <button className="it" aria-pressed={selected === f.path} data-path={f.path} tabIndex={f.path === stop ? 0 : -1} onClick={() => (setSelected(f.path), setJump((n) => n + 1))}>
                    <span className="ic" aria-hidden>
                      {ext(f.path)}
                    </span>
                    <span className="dname">
                      <span className="mono" data-tip={f.path} data-tip-clip="">{f.path}</span>
                      <span className="m">
                        <span className="dst" data-s={f.status} title={statusWord(t, f.status)}>
                          {statusWord(t, f.status)}
                        </span>
                        {f.old_path && <> · {t('mw.diff.from', { path: f.old_path })}</>} {counts(f) && <> · {counts(f)}</>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list!.truncated && (
            <div className="dnote" role="note">
              {truncatedNote(list!.files.length, t)}
            </div>
          )}
        </>
      )}
      {stacked && <Stack key={`${session}\u0000${shown === 'branch'}`} core={core} session={session!} machine={machine} branch={shown === 'branch'} force={force} files={files} at={current} jump={jump} t={t} quote={quote} />}
    </aside>
  );
}

