// Ticket 472: the project onboarding's "Add project" added, so its step names that one and not the list's first (an
// existing user reopening Onboarding has older projects). Every way the Add project chooser adds a folder (Browse,
// Create, Clone) sends the tree after the add (TREE_SET); the project in its `added` list and not in the one read as the
// chooser opened is the one added. For the window's life only: a reload starts with none, and the step names no project.
// Ticket 479: the watch is one flow, from onboarding's press to the next Add project or New tab opened elsewhere. A
// cancelled chooser leaves it armed, so any other start of an add (another Add project, a New tab that is not the
// chooser's own Browse) ends it; the add made there is not onboarding's. The flow also carries the agent onboarding found,
// so the New tab the chooser opens after the add leads with it, as onboarding's Start a session does.
import type { CoreClient } from '../api';
import { ADD_EVENT, askNew, NEW_EVENT } from '../NewSession';
import { projectName, TREE_SET } from '../tree';
import type { AgentKind, TreeState } from '../types';

let added: { path: string; name: string } | null = null;
let flow: { agent?: AgentKind; go?: boolean; end: () => void } | null = null;

/** Called right after onboarding's Add project opened the chooser (its own ADD_EVENT must not end this flow). `go`
 *  (Quick setup, ticket 991 A8): the New tab after the add starts the agent instead of only leading with it. */
export function watchAdd(core: CoreClient, agent?: AgentKind, go = false) {
  flow?.end();
  // Read before the chooser can add anything (a pick waits for the user); a failed read names nothing.
  const before = core.tree().then(
    (t) => new Set(t.added ?? []),
    () => null,
  );
  const onTree = (e: Event) => {
    const tree = (e as CustomEvent<TreeState>).detail;
    void before.then((had) => {
      const path = had && tree.added?.findLast((p) => !had.has(p));
      if (!path) return;
      added = { path, name: projectName(tree, path) };
      window.removeEventListener(TREE_SET, onTree);
    });
  };
  // The chooser's Browse opens the New tab with project '' (its folder panel adds); any other New tab or Add project ends it.
  const onOther = (e: Event) => void ((e.type === ADD_EVENT || (e as CustomEvent<{ project?: string }>).detail?.project !== '') && me.end());
  const me = {
    agent,
    go,
    end: () => {
      for (const [name, fn] of [[TREE_SET, onTree], [ADD_EVENT, onOther], [NEW_EVENT, onOther]] as const) window.removeEventListener(name, fn);
      if (flow === me) flow = null;
    },
  };
  for (const [name, fn] of [[TREE_SET, onTree], [ADD_EVENT, onOther], [NEW_EVENT, onOther]] as const) window.addEventListener(name, fn);
  flow = me;
}

/** The project onboarding's Add project added in this window, or null. */
export const addedFromOnboarding = () => added;

/** The New tab after an add: it leads with onboarding's found agent while its Add project flow is open, and starts it
 *  when that flow is Quick setup's. */
export const askNewAfterAdd = (path: string) => askNew(path, flow?.agent, undefined, flow?.go);
