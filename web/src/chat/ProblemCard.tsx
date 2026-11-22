// V2-5b: the problem card (needs 68, 69; screen 04 B). One line at the top of the session's tab: the cause, one fix
// button and "Details"; a flex row above the pane, so it covers no chat or terminal (needs 26), and it waits while the
// pointer is over the pane so nothing moves under it (needs 49). Never a decision queue item. Folder access (v1a-33)
// and a holder after an update (V2-1b) keep their own lines in the pane; the core still marks those rows red.
import { useEffect, useState } from 'react';
import type { CoreClient } from '../api';
import type { Key } from '../i18n';
import { ErrorLine } from '../errors';
import { INSTALL } from '../settings/onboarding/state';
import { openExternal } from '../sandbox/link';
import { openAgents } from '../settings/agents/open'; // V2-4b
import type { Problem, Session } from '../types';
import { handOff } from './conversation';
import { causeText } from './problemCause';
import './problem.css';

const NAMES = { claude: 'Claude', codex: 'Codex' } as const;
type T = (key: Key, args?: Record<string, string | number>) => string;
/** How long the window waits for the core before the card says it cannot reach it. */
export const UNREACHABLE_MS = 5000;

type Fix = { label: string; run: () => Promise<void> } | null;

export function ProblemCard({ t, core, session, connected, onReplaced, onOpen }: { t: T; core: CoreClient; session: Session | null; connected: boolean; onReplaced: (old: string, next: Session) => void; onOpen: (s: Session) => void }) {
  const [error, setError] = useState<unknown>('');
  const [busy, setBusy] = useState(false);
  const [coreProblem, setCoreProblem] = useState<Problem | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [machine, setMachine] = useState('');
  // V2-4b: an ACP agent's install page comes from the bundled known list (a custom entry has none).
  const [acpUrl, setAcpUrl] = useState<string | null>(null);
  // Ticket 604: its display name, as the core wrote it in the cause; until the list arrives the entry's name stands in.
  const [acpLabel, setAcpLabel] = useState<string | null>(null);
  const acp = session?.kind === 'acp' ? (session.acp_agent ?? null) : null;
  const acpMissing = !!acp && session?.problem?.case === 'not_installed';
  const hasProblem = !!session?.problem;
  useEffect(() => {
    setAcpUrl(null);
    setAcpLabel(null);
    // The list runs each agent's --version (up to 3 s each): ask only when there is a card to write.
    if (!acp || !hasProblem) return;
    let live = true;
    core.acpAgents().then(
      (r) => {
        const row = r.acp.find((x) => x.name === acp);
        if (live) (setAcpUrl(acpMissing ? (row?.install_url ?? null) : null), setAcpLabel(row?.label ?? null));
      },
      () => {},
    );
    return () => void (live = false);
  }, [core, acp, acpMissing, hasProblem]);
  // The core's own problems (a set-aside state file) are decided once at its start: read on each connect.
  useEffect(() => {
    if (!connected) return;
    core.request({ op: 'snapshot' }).then(
      (r) => setCoreProblem((r as { problem?: Problem }).problem ?? null),
      () => {},
    );
  }, [core, connected]);
  useEffect(() => {
    if (connected) return setUnreachable(false);
    const timer = setTimeout(() => setUnreachable(true), UNREACHABLE_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  const own = session && session.state !== 'closed' && session.problem && !['folder_permission', 'holder_restart'].includes(session.problem.case) ? session.problem : null;
  const now: Problem | null = unreachable ? { case: 'core_unreachable', cause: t('problem.unreachable') } : (own ?? coreProblem);
  const nowHookless = !now && session?.state === 'running' && !!session.without_hooks;
  const key = now ? `${now.case}:${now.cause}` : nowHookless ? 'hookless' : '';
  const { problem, hookless } = useSettled({ problem: now, hookless: nowHookless }, key, session?.id ?? '');
  useEffect(() => (setError(''), setMachine('')), [key]);
  if (hookless)
    return (
      <div className="problem-band note" role="status" data-problem="hookless">
        <span className="cause">{t('problem.startedHookless')} {t('problem.hookless')}</span>
      </div>
    );
  if (!problem) return null;

  const act = (f: () => Promise<void>) => async () => {
    setBusy(true);
    setError('');
    try {
      await f();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const fix = (kind: 'restart' | 'start_without_hooks') => async () => {
    const r = (await core.request({ op: 'problem_fix', id: session!.id, fix: kind })) as { session?: Session };
    if (r.session) onReplaced(session!.id, r.session);
  };
  const agent = session && session.kind !== 'shell' && session.kind !== 'acp' ? session.kind : null;
  const fixes: Record<Problem['case'], Fix> = {
    not_installed: agent ? { label: t('problem.openInstall'), run: () => openExternal(INSTALL[agent]) } : acpUrl ? { label: t('problem.install'), run: () => openExternal(acpUrl) } : null,
    logged_out: agent
      ? {
          label: t('problem.login'),
          run: async () => onOpen((await core.addAccount(agent, `${NAMES[agent]} login`)).session),
        }
      : acp && session
        ? // V2-4b: the agent's own login, from its approved entry, in a visible tab; nothing is stored.
          { label: t('problem.login'), run: async () => onOpen((await core.acpLogin(acp, session.project)).session) }
        : null,
    // Switch agent only: never another account (Anthropic terms, V2-2).
    usage_limit: session && { label: t('problem.switchAgent'), run: async () => void handOff(session.id, session.kind === 'codex' ? 'claude' : 'codex') },
    hook_trust: session?.side_chat ? null : { label: t('problem.startWithout'), run: fix('start_without_hooks') },
    machine_unreachable: session?.machine ? { label: t('problem.retry'), run: () => showMachine(session.machine!) } : null,
    version_mismatch: session?.machine ? { label: t('problem.machineStatus'), run: () => showMachine(session.machine!) } : null,
    // V2-4b: no ACP answer opens the Agents sheet for that entry; a refused Claude entry has no fix, only its reason.
    acp_no_answer: acp ? { label: t('problem.fixCommand'), run: async () => openAgents(acp) } : null,
    acp_refused: null,
    folder_permission: null,
    holder_restart: null,
    set_aside: null,
    // A shell is started again by hand: a login tab's account folder is not on its row.
    unexpected: agent && !session?.side_chat ? { label: t('problem.restart'), run: fix('restart') } : null,
    // The app's page load starts the core again when it is not running (ensure_core) and reads a fresh window token.
    core_unreachable: { label: t('problem.restartCore'), run: async () => window.location.reload() },
  };
  async function showMachine(label: string) {
    const r = (await core.request({ op: 'machine_status', label })) as { machines?: { status: string; error: string | null }[] };
    const m = r.machines?.[0];
    setMachine(m ? `${label}: ${m.status}${m.error ? ` · ${m.error}` : ''}` : t('problem.machineUnknown', { label }));
  }
  const f = fixes[problem.case];
  // Ticket 604: the cause in the window's language; the core's English sentence moves under Details when it differs.
  const cause = causeText(t, problem, { name: agent ? NAMES[agent] : acp ? (acpLabel ?? acp) : null, program: agent, machine: session?.machine });
  const details = [cause === problem.cause ? '' : problem.cause, problem.details, machine].filter(Boolean).join('\n');
  return (
    <div className="problem-band light-bad light-edge" role="alert" data-problem={problem.case}>
      <b aria-hidden="true">!</b>
      <span className="cause">{cause}</span>
      {f && (
        <button className="btn p" disabled={busy} onClick={() => void act(f.run)()}>
          {f.label}
        </button>
      )}
      {problem.case === 'hook_trust' && <span className="loss">{t('problem.hookless')}</span>}
      {details && (
        <details>
          <summary>{t('problem.details')}</summary>
          <pre>{details}</pre>
        </details>
      )}
      <ErrorLine t={t} error={error} className="err" />
    </div>
  );
}

/** The band appears, changes or goes only while the pointer is outside the pane, so the pane never moves under it;
 * until then the last settled band stays. Another session's tab shows its own band at once. */
function useSettled<T>(value: T, key: string, id: string): T {
  const [settled, setSettled] = useState({ value, key, id });
  const latest = { value, key, id };
  useEffect(() => {
    if (key === settled.key && id === settled.id) return;
    const pane = document.querySelector('.pane');
    if (id !== settled.id || !pane?.matches(':hover')) return setSettled(latest);
    const leave = () => setSettled(latest);
    pane.addEventListener('pointerleave', leave, { once: true });
    return () => pane.removeEventListener('pointerleave', leave);
  });
  return id === settled.id ? settled.value : value;
}
