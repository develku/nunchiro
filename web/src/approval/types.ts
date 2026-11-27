// Mirrors crates/nunchiro-core/src/approval/mod.rs (serde shapes of Reply::ApprovalStatus).
export type Level = 'read' | 'act';
export type ApprovalState = 'unapproved' | 'approved' | 'changed';

export interface Manifest {
  kind: 'script' | 'web' | 'integration' | 'plugin';
  author: string;
  command: string[];
  entry: string;
  interval_secs: number | null;
  permissions: Level[];
  network: string[];
  /** v1b-33: folders it reads beyond its project and cache, as written in widget.toml. */
  read: string[];
}

export interface ApprovalView {
  name: string;
  state: ApprovalState;
  level: Level | null;
  hash: string;
  manifest: Manifest;
  manifest_text: string;
  cli: string;
  /** v1b-33: a `read` entry covers the whole home (computed by the core). */
  read_home_wide: boolean;
  /** v1b-34: why act cannot be granted (a web widget naming a script CDN host); absent when it can. */
  act_refused?: string;
  /** A plugin's panels and commands with exactly what each runs (`plugin:<id>`; its manifest's command is empty). */
  parts?: { name: string; title: string; kind: 'panel' | 'command'; runs: string[] }[];
}

/** Ticket 259: crates/nunchiro-core/src/approval/mod.rs `SetupView`, a repo's worktree setup script (`orca.yaml`). */
export interface SetupView {
  project: string;
  path: string;
  state: ApprovalState;
  hash: string;
  script: string;
}
/** `worktree_setup::Status`: the sheet (absent with no repo script) and what start-an-agent does now. */
export interface SetupStatus {
  view?: SetupView;
  agent: 'start' | 'wait' | 'user';
}

/** The slice of CoreClient the sheet needs, so a gallery or a test can supply its own. */
export interface ApprovalCore {
  request(request: { op: string; [k: string]: unknown }): Promise<unknown>;
}
