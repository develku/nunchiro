// Ticket 305: what Settings > Onboarding shares with the rest of the window. The value is a New session row id: `terminal`,
// `claude`, `codex` or `acp:<name>`; empty until the user picks one (nothing is preselected into it).
import { useEffect } from 'react';
import type { AccountAgent } from '../../api';
import type { Session } from '../../types';
import { defineSetting, useFeatureSetting } from '../useFeatureSetting';

export const DEFAULT_AGENT = defineSetting<string>('onboarding.default_agent', '', (v) => (typeof v === 'string' ? v : undefined));

/** Ticket 391 part 2: what the checklist cannot read from real state: a page seen (화면과 테마, 권한, the keys and 스킬·훅 steps) or the
 *  project or the assistant step skipped, or the first agent session started (a closed session leaves the snapshot, ticket 582). The only ticked state of onboarding; an unknown entry is dropped on read. */
export type Mark = 'appearance' | 'permissions' | 'keys' | 'skills' | 'project_skipped' | 'assistant_skipped' | 'session';
const MARKS: readonly Mark[] = ['appearance', 'permissions', 'keys', 'skills', 'project_skipped', 'assistant_skipped', 'session'];
export const ONBOARDING_MARKS = defineSetting<Mark[]>('onboarding.marks', [], (v) => (Array.isArray(v) ? [...new Set(v.filter((m): m is Mark => MARKS.includes(m)))] : undefined));

/** Ticket 582: the first agent session started: an agent (not a terminal, side chat or login tab) in one of the user's projects
 *  that runs or has finished a turn (`completion_seq`, as accounts/sections.tsx reads it). Look 1117 v14 O3: starting it is the
 *  step, so a running agent that has not answered yet counts; a failed start or an imported conversation not resumed does not. */
export const startedSession = (sessions: Session[], projects: string[]) =>
  sessions.find((s) => s.kind !== 'shell' && !s.side_chat && !s.account_tab && (s.state === 'running' || ((s as Session & { completion_seq?: number }).completion_seq ?? 0) > 0) && projects.includes(s.project));

/** Stores the `session` mark the first time an agent session started. Called once in App.tsx, where every snapshot arrives, so the
 *  mark is set whether or not Onboarding is open (a closed session leaves the snapshot after its undo window). */
export function useFirstSessionMark(sessions: Session[], projects: string[]) {
  const [marks, setMarks] = useFeatureSetting(ONBOARDING_MARKS);
  const started = !!startedSession(sessions, projects);
  useEffect(() => void (started && !marks.includes('session') && setMarks([...marks, 'session'])), [started, marks, setMarks]);
}

/** The agents' official install pages; Nunchiro only opens them in the browser. */
export const INSTALL: Record<AccountAgent, string> = {
  claude: 'https://docs.claude.com/en/docs/claude-code/setup',
  codex: 'https://github.com/openai/codex',
};

/** Their docs pages (문서 열기 on a failed row). https only: the test in `acp/mod.rs` reads this file. */
export const DOCS: Record<AccountAgent, string> = {
  claude: 'https://code.claude.com/docs/en/overview',
  codex: 'https://developers.openai.com/codex',
};
