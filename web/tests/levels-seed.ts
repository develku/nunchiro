// Ticket 994: what the level specs share (levels-994, levels-shots-994): a fake Codex, an approved fake ACP agent whose
// models and thinking levels are on record, and the level table written as Settings writes it.
import fs from 'node:fs';
import path from 'node:path';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { type Core, expect } from './fixtures';

/** A Codex that answers `--version` and then idles at a prompt, as the fake Claude does. */
export const fakeCodex = (core: Core) => fs.writeFileSync(path.join(core.home, 'bin', 'codex'), "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.161.0'; exit; fi\nprintf '\\342\\200\\272 \\n'\nexec cat\n", { mode: 0o700 });

/** An approved ACP agent `name` (the core's fake: models Fast and Smart, thinking levels Low and High). It runs once in
 *  a project of its own and is closed, so the core has its lists on record, as after a user's first session with it. */
export async function acpAgent(core: Core, name: string) {
  fs.appendFileSync(agentsToml(core), tomlEntry(name, fakeAcp(core, name, `${name} 0.9.1`)));
  ownerOk(core, { op: 'acp_agent_grant', name, hash: ownerOk(core, { op: 'acp_agent_status', name }).view.hash });
  const id = ownerOk(core, { op: 'start', session: { kind: 'acp', project: core.project(`${name}-first-run`), args: [name], model: null, effort: null, resume: null } }).session.id as string;
  const reported = () => (ownerOk(core, { op: 'acp_agents' }).acp as { name: string; models?: unknown[] }[]).find((r) => r.name === name)?.models?.length ?? 0;
  await expect.poll(reported, { timeout: 15_000 }).toBe(2);
  ownerOk(core, { op: 'close', id });
}
/** What the fake ACP agent `name` was asked to set, in order. */
export const acpSets = (core: Core, name: string) =>
  fs
    .readFileSync(path.join(core.home, `${name}.log`), 'utf8')
    .split('\n')
    .filter((l) => l.includes('session/set_config_option'))
    .map((l) => JSON.parse(l).params as { configId: string; value: string })
    .map((p) => `${p.configId}=${p.value}`);

/** The level table, stored as Settings > Team > Levels stores it. */
export const setLevels = (core: Core, table: Record<string, unknown> | null) => ownerOk(core, { op: 'quit_settings', patch: { features: { 'team.levels': table } } });
