// V2-14h: mounts one surface with a test-only catalogue table, so a page test can prove the window's `t` reaches it.
// The surfaces import their CSS, which the spec runner cannot parse: a real browser is the seam. Test-only.
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EN, makeT, type Key } from '../src/i18n';
import { renderWidget, type WindowCtx } from '../src/layout/windows';
import { Tree } from '../src/Sidebar';
import { Board } from '../src/board/Board';
import { ProjectDialogs } from '../src/tree/Dialogs';
import { RenameField, WorktreeLayer } from '../src/tree/worktrees';
import type { ProjectTree } from '../src/tree/state';

const noop = () => {};
/** A fake language `xx`: every key shows `XX-<key>`, so a surface that got the table is unmistakable. */
const xx = makeT('xx' as never, 'en', { en: EN, xx: Object.fromEntries(Object.keys(EN).map((k) => [k, `XX-${k}`])) as Record<Key, string> } as never);

const projects: ProjectTree = {
  core: null as never,
  tree: { groups: [], folded: [] } as never,
  unread: new Set<string>(),
  unreadSessions: new Set<string>(),
  edit: async () => null,
  notice: null,
  reload: noop,
  dismiss: noop,
  ask: null,
  setAsk: noop,
  menuProject: null,
  setMenuProject: noop,
  picking: false,
  setPicking: noop,
};

const ctx = (): WindowCtx => ({
  boot: {} as never,
  core: { request: async () => ({ board: { cards: [], columns: [], revision: 'r' } }) } as never,
  sessions: [],
  current: null,
  pinned: () => null,
  owner: [],
  decide: () => {},
  open: noop,
  diff: { n: 0 },
  filesSession: null,
  tree: () => null,
  strip: () => null,
  terminal: () => null,
  composer: () => null,
  files: () => null,
  search: () => null,
  decisions: () => null,
  t: xx,
});

const SURFACES: Record<string, () => ReactElement> = {
  // App's `windowCtx().tree()` mounts Tree with the window's `t`; this is that mount with the table injected.
  tree: () => <Tree t={xx} sessions={[]} order={[]} current={null} collapsed={[]} onToggle={noop} onOpen={noop} onAction={noop} projects={projects} />,
  // The registry path App renders for the board tab: renderWidget with the window's context.
  board: () => <>{renderWidget('board', true, ctx())}</>,
  // The window context itself carries `t`: Board placed anywhere reads it from here.
  board_ctx: () => <Board core={ctx().core} sessions={[]} onOpen={noop} t={ctx().t} />,
  rename: () => <RenameField initial="v1a-62" onSave={async () => null} onClose={noop} t={xx} />,
  dialog: () => <ProjectDialogs core={ctx().core} pt={{ ...projects, ask: { kind: 'create', project: '/p' } }} wt={{ remove: noop }} projects={[]} onOpen={noop} t={xx} />,
  worktree: () => <WorktreeLayer wt={{ ask: { kind: 'create', project: '/p' }, setAsk: noop, core: { request: () => Promise.reject(new Error('no core')) }, /* 5a16c639: the default agent via useFeatureSetting */ list: [], facts: new Map(), sessions: [], toast: null } as never} t={xx} />,
};

const which = new URLSearchParams(location.search).get('surface') ?? 'tree';
createRoot(document.getElementById('root')!).render(SURFACES[which]());
