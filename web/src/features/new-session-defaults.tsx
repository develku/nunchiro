// Ticket 223 (final.html F.newSession) and ticket 391: the New session defaults now live on Settings > Providers
// (settings/accounts/defaults.tsx draws them). Default permissions (ticket 382) is the core's per-agent `agents.permission`
// (ticket 362), the one setting a launch reads, for every project; the card's 권한 row shows it.
import { useEffect, useState } from 'react';
import { registerSettingsSection, type PageContext } from './registry';
import { docT, ErrorLine } from '../errors';
import { currentFeature, useFeatureSetting } from '../settings/useFeatureSetting';
import { legacyChoice, mayMove, NEW_DEFAULTS, PERMISSION_BACKUP, permissionBackup, withoutPermission, type AgentChoice, type AgentCli } from '../settings/agents/newDefaults';

/** Ticket 382: each agent's permission as the core holds it. Nothing shows until the core answers: a guess here is the bug. */
function DefaultPermissions({ core }: Pick<PageContext, 'core'>) {
  const [stored, setStored] = useFeatureSetting(NEW_DEFAULTS);
  const [backup, setBackup] = useFeatureSetting(PERMISSION_BACKUP);
  const [, setNow] = useState<Record<AgentCli, AgentChoice> | null>(null);
  const [error, setError] = useState<unknown>('');
  const legacy = legacyChoice(stored);
  const request = (r: { op: string; [k: string]: unknown }) => core.request(r) as Promise<Record<AgentCli, AgentChoice>>;
  const fail = setError;
  // Moving an old value is one step per pass, each stored before the next runs, so a move cut short resumes and never repeats:
  // back it up, tighten the core if allowed, mark that done, clear the old value. The row waits: until then the old flag launches.
  useEffect(() => {
    let live = true;
    const step = async () => {
      const at = await request({ op: 'agent_permission_get' });
      if (!live) return;
      if (!legacy) return setNow(at);
      if (!backup) return setBackup(permissionBackup(stored, at.claude, legacy));
      if (backup.moved) return setStored(withoutPermission(currentFeature(NEW_DEFAULTS)));
      if (mayMove(backup, at.claude)) await request({ op: 'agent_permission_set', agent: 'claude', choice: backup.to });
      if (live) setBackup({ ...backup, moved: true });
    };
    step().catch(fail);
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a pass per step of the move
  }, [core, legacy, !!backup, backup?.moved]);
  // Ticket 391: the card's 권한 (accounts/sections.tsx PermissionRow) shows the core's value; only the move and its error stay here.
  return <ErrorLine t={docT()} error={error} />;
}

// Ticket 391: the rows are drawn by the Providers page (accounts/defaults.tsx; 권한 is the card's PermissionRow); this
// section keeps their search fields and runs the legacy permission move whenever the page opens.
registerSettingsSection({
  page: 'providers',
  id: 'agents.new_session',
  order: 10,
  fields: [
    { key: 'newDefaultAgent', at: '[data-row="newDefaultAgent"] select' },
    { key: 'newDefaultModel', at: '[data-row="newDefaultModel"] select' },
    { key: 'newDefaultPermissions', at: '[data-field="permission"] select' },
  ],
  render: (ctx) => <DefaultPermissions core={ctx.core} />,
});
