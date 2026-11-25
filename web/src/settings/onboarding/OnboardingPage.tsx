// Ticket 305 (needs 222), ticket 391 part 2 (docs/design/providers-391/final.html scene d): the setup checklist, in the
// structure of Orca's onboarding (steps on the left, the chosen step on the right). Done is computed from real state; the
// one exception is state.ts ONBOARDING_MARKS (a page seen, the project step skipped), the only ticked state on this page.
import { useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { accountName, type Account, type AccountAgent, type AcpRow } from '../../api';
import { saveAssistant } from '../../features/assistants';
import { ErrorLine, rawError } from '../../errors';
import { NunchiroSwitches } from '../../features/extensions';
import { probe, VOLUMES, type Status } from '../../features/macos-perms';
import { registeredPage, type PageContext } from '../../features/registry';
import { addedFromOnboarding, watchAdd } from '../../firstrun/added';
import { ImportStep } from '../../firstrun/ImportStep';
import { LANGUAGES, type Key } from '../../i18n';
import { Icon } from '../../icons/Icon';
import { askPermission, readPermission, type Level, type Permission } from '../../queue/notify';
import { leadOf, openSeat, useTeam } from '../../lead/lead';
import { askAddProject, askNew, quickStart } from '../../NewSession';
import { holdText } from '../../chat/held';
import { elapsed } from '../../board/watch';
import { pickFolder } from '../../pickFolder';
import { PLAIN } from '../../plainText';
import { openExternal } from '../../sandbox/link';
import { Chip, Mark } from '../accounts/providers';
import { ProviderHead } from '../accounts/head';
import { shownSigned, UseSwitch } from '../accounts/sections';
import { checkOnOpen, checkOwn, ownLogin, useOwnChecks, withOwnChecks } from '../accounts/ownCheck';
import type { Session } from '../../types';
import { basename, openSession, TREE_SET } from '../../tree';
import { openAgents } from '../agents/open';
import { DEFAULT_HINT_KEYS } from '../../hintLabels';
import { DEFAULT_BINDINGS, label, merge } from '../../keys';
import { DEFAULTS, heights } from '../../settings';
import { Reset, Row, Select, tilde } from '../shell/Row';
import { PageSummary } from '../shell/PageActions';
import { WorktreeRoot } from '../git/GitPage';
import { useCoreFeature, useFeatureSetting } from '../useFeatureSetting';
import { KeysStep } from './KeysStep';
import { folderRows, startedSession, DEFAULT_AGENT, INSTALL, ONBOARDING_MARKS, type FolderRow, type Mark as Done } from './state';
import '../accounts/accounts.css';
import './onboarding.css';

type Found = { agent: AccountAgent; found: boolean; version: string | null };
type StepId = 'look' | 'providers' | 'notify' | 'keys' | 'project' | 'macos' | 'skills' | 'assistant' | 'session';
/** `page`: the Settings page the step opens and names; the project step adds a project instead. */
type Step = { id: StepId; page?: string; done: boolean; skipped?: boolean };
const NAMES: Record<AccountAgent, string> = { claude: 'Claude', codex: 'Codex' };
/** Settings > 알림's notify levels (AlertsPage LEVELS): the same choices on the same stored value. */
const LEVELS: [Level, Key][] = [
  ['all', 'settingsA.levelAll'],
  ['waiting', 'settingsA.levelWaiting'],
  ['muted', 'settingsA.levelMuted'],
];
const TITLE: Record<StepId, [Key, Key]> = {
  look: ['onboarding.look.title', 'onboarding.look.body'],
  providers: ['onboarding.providers.title', 'onboarding.providers.body'],
  notify: ['onboarding.notify.title', 'onboarding.notify.body'],
  keys: ['onboarding.keys.title', 'onboarding.keys.body'],
  project: ['onboarding.project.title', 'onboarding.project.body'],
  macos: ['onboarding.macos.title', 'onboarding.macos.body'],
  skills: ['onboarding.base.title', 'onboarding.base.body'],
  assistant: ['onboarding.assistant.title', 'onboarding.assistant.body'],
  session: ['onboarding.session.title', 'onboarding.session.body'],
};
const versionOf = (v: string | null | undefined) => v?.match(/\d+(\.\d+)+/)?.[0] ?? '';

export function OnboardingPage({ core, t, settings, commands, update, hasProject, project, projects, closeSettings, sessions: live }: PageContext) {
  const [marks, setMarks] = useFeatureSetting(ONBOARDING_MARKS);
  const mark = (m: Done) => void (marks.includes(m) || setMarks([...marks, m]));
  const [found, setFound] = useState<Found[]>([]);
  const [git, setGit] = useState(true); // Q7 point 18: until the core says otherwise, no git line
  const [acp, setAcp] = useState<AcpRow[]>([]);
  const [listed, setListed] = useState<Account[]>([]);
  const [polled, setSessions] = useState<Session[]>([]);
  const sessions = live ?? polled; // q67 look (new 1): the window's own, as Providers reads them
  // Accounts probe 11-10: the window's "Your own" checks, the ones Providers reads (ownCheck.ts): an `unknown` after one
  // came back is "Couldn't check", while one runs "Checking…", before it "Not checked".
  const checks = useOwnChecks();
  const accounts = withOwnChecks(listed, checks);
  // Until the opening check starts, a state no check answered yet reads "Checking…" too.
  const [opening, setOpening] = useState(true);
  const [notify, setNotify] = useState<Permission>('unknown');
  const [asking, setAsking] = useState(false);
  const [picked, setPicked] = useState<StepId | null>(null);
  // The Permissions probe exists only in the app; `null` until it answers, `'error'` when it fails (every row then reads unknown).
  const [perm, setPerm] = useState<Status | 'error' | null>(null);

  // Install, sign-in and the OS permission change outside the window: everything is read again when the user comes back.
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      const first = core.firstRun();
      const agents = first.then((r) => r.agents, () => [] as Found[]);
      void agents.then(setFound);
      first.then((r) => setGit(r.git !== false), () => setGit(true));
      // Ticket 391 follow-up K: agents only. OpenRouter, GLM and Kimi are API-key services run through another agent.
      core.acpAgents().then((r) => setAcp(r.acp.filter((x) => x.acp && x.found_path && x.source !== 'service')), () => setAcp([]));
      core.request({ op: 'snapshot' }).then((r) => setSessions((r as { sessions: Session[] }).sessions), () => setSessions([]));
      // The list leaves "Your own" unprobed, so each found CLI's is checked too, unless the window checked it in the last minute.
      void Promise.all([agents, core.accounts().then((r) => r.accounts, () => [] as Account[])]).then(([cli, list]) => {
        setListed(list);
        // Round 2 (security review): a listing that lands after the page was left starts no probe.
        if (!cancelled) checkOnOpen(core, cli.filter((f) => f.found).map((f) => f.agent));
        setOpening(false);
      });
      void readPermission().then(setNotify);
      if (registeredPage('permissions')) probe().then(setPerm, () => setPerm('error'));
    };
    read();
    window.addEventListener('focus', read);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', read);
    };
  }, [core]);

  // Ticket 391 follow-up A: Providers' three words. A running session of the agent is proof one of its accounts is signed in;
  // "Needs sign-in" only when every account's own status said no; no answer is "Not checked" or "Couldn't check".
  const signState = (agent: AccountAgent) => {
    const mine = accounts.filter((a) => a.agent === agent);
    if (mine.some((a) => shownSigned(sessions, a) === 'yes')) return 'yes';
    if (mine.length && mine.every((a) => a.signed_in === 'no')) return 'no';
    return 'unknown';
  };
  const signedIn = (agent: AccountAgent) => signState(agent) === 'yes';
  // Ticket 370 item 6, Orca's last onboarding action. Settings is gone first (flushSync): the modal gives focus back as it
  // closes, and the chooser reads the focus it returns to while it renders.
  // Ticket 991 (A8): `go` (Quick setup) starts that agent in the added project, as its card says.
  const addProject = (go = false) => {
    flushSync(closeSettings);
    askAddProject();
    watchAdd(core, lead, go); // ticket 472: the step names this add; 479: after its own ADD_EVENT
  };
  // Ticket 470: the end of onboarding is a running session. The same event New session's "+" sends (no new start path).
  // Ticket 472: with the signed-in agent first (else the found one), so Enter starts an agent, not a terminal.
  // Ticket 991 (A8): the button names that agent and starts it; with none found it opens New tab to pick one.
  const startSession = (path: string) => {
    flushSync(closeSettings);
    askNew(path, lead, undefined, !!lead);
  };
  const skipped = !hasProject && marks.includes('project_skipped');
  // Ticket 1034 (mockup docs/design/bot-statusbar-1121/index.html part 3): the main assistant is Home's lead. Naming it
  // saves the teammate and starts nothing; its seat is a Claude seat in v1, so with no Claude the step only offers Skip.
  const team = useTeam(core, true);
  const assistant = leadOf(team, '');
  const noClaude = found.some((f) => f.agent === 'claude' && !f.found);
  // A seat starts with the account new Claude sessions use.
  const claudeAccount = accounts.find((a) => a.agent === 'claude' && a.session_default) ?? accounts.find((a) => a.agent === 'claude' && a.default);
  const [chief, setChief] = useState(() => t('assistants.defaultName'));
  const [chiefError, setChiefError] = useState<unknown>('');
  const [naming, setNaming] = useState(false);
  const nameChief = () => {
    if (naming || !chief.trim()) return;
    setNaming(true);
    setChiefError('');
    setPicked('assistant'); // the saved step stays shown, with its result
    void saveAssistant(core, t, chief.trim(), null).catch(setChiefError).finally(() => setNaming(false));
  };
  const openChief = (id: string) => void openSeat(core, id).then(({ session }) => (flushSync(closeSettings), openSession(session.id)), setChiefError);
  // Ticket 472: "Added X" only for the project this step's Add project added; otherwise the step starts in the list's
  // first project and names none.
  // Ticket 479: and only while that project is still in the tree. 485: the window's live project list, so a removal made
  // while Settings stays open counts at once (the page's own tree read missed it).
  const fromStep = hasProject ? addedFromOnboarding() : null;
  const added = fromStep && projects.includes(fromStep.path) ? fromStep : null;
  const startIn = added ?? project;
  // The step's rule (ticket 391 part 2), and the line under its cards names what met it: the pill and the text never disagree.
  const signedAgent = found.find((f) => f.found && signedIn(f.agent));
  const approvedAgent = acp.find((r) => r.state === 'approved');
  const doneBy = signedAgent ? t('onboarding.providers.doneSigned', { name: NAMES[signedAgent.agent] }) : approvedAgent ? t('onboarding.providers.doneApproved', { name: approvedAgent.label }) : null;
  // Ticket 470: not done, the line says what the look found and what to press, never only the rule.
  const firstFound = found.find((f) => f.found);
  const lead = (signedAgent ?? firstFound)?.agent;
  const startWord = lead ? t('onboarding.agent.start', { name: NAMES[lead] }) : t('onboarding.project.start');
  // Ticket 472: no verdict before the first check came back. Ticket 479: the card's own word, so the two never disagree.
  const checkWord = (agent: AccountAgent) => (checks[agent]?.running || (opening && !checks[agent]?.done) ? 'checking' : checks[agent]?.done ? 'failed' : 'unchecked');
  const LINE = { checking: 'onboarding.providers.checking', failed: 'onboarding.providers.unconfirmed', unchecked: 'onboarding.providers.unchecked' } as const;
  const notDoneLine = opening
    ? t('onboarding.providers.rule')
    : firstFound
      ? t(signState(firstFound.agent) === 'no' ? 'onboarding.providers.notSigned' : LINE[checkWord(firstFound.agent)], { name: NAMES[firstFound.agent] })
      : acp.length
        ? t('onboarding.providers.rule')
        : t('onboarding.providers.noneFound');
  // Ticket 582: the last step. The `session` mark is stored by `useFirstSessionMark` in App.tsx (a closed session leaves the snapshot).
  const started = startedSession(sessions, projects);
  const prefix = merge(settings.bindings).prefix ?? [];
  const hintLetters = settings.hintKeys.alphabet.join('');
  const steps: Step[] = [
    // A window that already picked a look before the mark existed keeps the step done.
    { id: 'look', page: 'appearance', done: marks.includes('appearance') || settings.densityPicked || settings.language !== 'system' || settings.themeMode !== 'system' },
    { id: 'providers', page: 'providers', done: !!doneBy },
    { id: 'notify', page: 'alerts', done: notify === 'granted' && settings.notifyDefault !== 'muted' },
    // Owner 2026-11-16: the prefix and the hint letters; done once the panel was shown (the defaults are a choice) or either was changed.
    { id: 'keys', page: 'keys', done: marks.includes('keys') || prefix.join() !== DEFAULT_BINDINGS.prefix.join() || hintLetters !== DEFAULT_HINT_KEYS.alphabet.join('') },
    { id: 'project', done: hasProject || skipped, skipped },
    // The 권한 page exists only in the app (features/macos-perms.tsx); a browser window lists five steps.
    ...(registeredPage('permissions') ? [{ id: 'macos' as const, page: 'permissions', done: marks.includes('permissions') }] : []),
    { id: 'skills', page: 'extensions', done: marks.includes('skills') },
    { id: 'assistant', page: 'assistants', done: !!assistant || marks.includes('assistant_skipped'), skipped: !assistant && marks.includes('assistant_skipped') },
    { id: 'session', done: !!started || marks.includes('session') },
  ];
  const shown = steps.find((s) => s.id === picked) ?? steps.find((s) => !s.done) ?? steps[0];
  // The keys and skills steps are done once their panel was shown; the panel stays chosen, so the mark does not move the page to step 1.
  useEffect(() => {
    if ((shown.id !== 'skills' && shown.id !== 'keys') || marks.includes(shown.id)) return;
    setPicked(shown.id);
    setMarks([...marks, shown.id]);
  }, [shown.id, marks, setMarks]);
  const pageName = (page: string) => (page === 'assistants' ? t('assistants.title') : t(`settings.page.${page}` as Key));
  // Owner 11-15: one button for a new user. The recommended values are the defaults already in force, so the button only
  // accepts them (the look, keys and skills steps count as seen), keeps the found agent as the default, asks macOS for
  // notifications once, and goes on to the one thing only the user can give: a project folder.
  const [defaultAgent, setDefaultAgent] = useFeatureSetting(DEFAULT_AGENT);
  const [, setAutoPull] = useCoreFeature<boolean>('git.auto_pull', false);
  const accept = async () => {
    setMarks([...new Set<Done>([...marks, 'appearance', 'keys', 'skills'])]);
    const agent = (signedAgent ?? firstFound)?.agent;
    if (!defaultAgent && agent) setDefaultAgent(agent);
    // Owner 2026-11-16: the two Git helpers are off for an existing setup and on for one that takes the recommended settings.
    void setAutoPull(true);
    void core.request({ op: 'quit_settings', patch: { auto_clean_worktrees: true } }).catch(() => {});
    if (notify === 'default') await askPermission().then(readPermission).then(setNotify, () => {});
  };
  const quick = async () => (await accept(), addProject(lead === undefined));
  // Ticket 1123 T1 (mockup docs/design/first-use-1123, owner 11-25 Q1): the folders Claude and Codex worked in on this
  // Mac (the import listing, read-only), newest first; "Choose folder…" is the last entry. A typed prompt is the first message.
  // Ticket 1130 C7: `null` until the listing answers; with no history the row starts on Assistants (folderRows).
  const [recent, setRecent] = useState<FolderRow[] | null>(null);
  const [chosenFolder, setFolder] = useState('');
  const rows = folderRows(recent, team.home);
  const folder = chosenFolder || (rows[0]?.path ?? '');
  const inHome = !!team.home && folder === team.home;
  const folderName = (path: string) => (team.home && path === team.home ? t('assistants.title') : basename(path));
  const [prompt, setPrompt] = useState('');
  const [going, setGoing] = useState(false);
  const [goError, setGoError] = useState<unknown>('');
  const [opened, setOpened] = useState<{ id: string; text: string } | null>(null);
  // Only while Quick setup shows (no project yet): the listing reads the head of every conversation file.
  useEffect(() => {
    if (hasProject) return;
    // Folders only: the full listing carries each conversation's first words as its title, which this row never shows.
    void (core.request({ op: 'import_list', folders_only: true }) as Promise<{ folders: { project: string; agent: string; modified_ms: number; gone: boolean }[] }>).then((r) => {
      setRecent(r.folders.filter((d) => !d.gone).slice(0, 8).map((d) => ({ path: d.project, agent: d.agent, at: d.modified_ms })));
    }, () => setRecent([]));
  }, [core, hasProject]);
  const choose = () =>
    void pickFolder().then(
      (p) => p && (setRecent((r) => [{ path: p, agent: '', at: 0 }, ...(r ?? []).filter((x) => x.path !== p)]), setFolder(p)),
      setGoError,
    );
  const go = async () => {
    if (!folder) return choose();
    if (going || !lead) return;
    setGoing(true);
    setGoError('');
    try {
      await accept();
      // Assistants' folder is no project: it stays out of the tree's project list (its group shows the session).
      if (!inHome) window.dispatchEvent(new CustomEvent(TREE_SET, { detail: await core.treeEdit({ op: 'add', project: folder, added: true }) }));
      const s = await quickStart(core, sessions, null, lead, folder);
      if (s) setOpened({ id: s.id, text: prompt.trim() });
      else setGoing(false);
    } catch (e) {
      setGoError(e);
      setGoing(false);
    }
  };
  // held.ts gives a held message back to the box while its session is not in the window's list yet, so the prompt is
  // held, and Settings closed, only once the window lists the new session.
  useEffect(() => {
    if (!opened || !sessions.some((s) => s.id === opened.id)) return;
    if (opened.text) holdText(opened.id, opened.text);
    flushSync(closeSettings);
    openSession(opened.id);
  }, [opened, sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = rows.find((r) => r.path === folder);
  const since = chosen && elapsed(Date.now() - chosen.at);
  // The one choice on the card (owner 11-16): what a new Claude or Codex session may do without asking. The value shown is
  // Claude's; a pick sets both. Any other stored value (auto, accept edits) shows as it is in Providers, not here.
  const [mode, setMode] = useState('');
  const readMode = () => (core.request({ op: 'agent_permission_get' }) as Promise<{ claude: string }>).then((r) => setMode(['ask', 'own'].includes(r.claude) ? r.claude : 'full-access'), () => {});
  useEffect(() => void readMode(), [core]); // eslint-disable-line react-hooks/exhaustive-deps
  const setPermission = (choice: string) => {
    setMode(choice);
    // A refused pick must not stay on screen as if it held: read what the core has.
    void Promise.all(['claude', 'codex'].map((agent) => core.request({ op: 'agent_permission_set', agent, choice }))).catch(readMode);
  };
  const keysLine = t('onboarding.quick.keysValue', { prefix: prefix.map((b) => label(b)).join(` ${t('settings.kbd.or')} `), letters: hintLetters });
  // Ticket 991 (A19): Quick setup says what the keys do; the keys step keeps the names it sets (prefix, hint keys).
  const hintsKey = merge(settings.bindings)['hints.show']?.[0];
  const quickRows = (): [Key, ReactNode][] => [
    [
      'onboarding.quick.agent',
      // Ticket 991 (A8): the action the line names is drawn next to it (the cards are on the Connect your agents step).
      <>
        {doneBy ?? notDoneLine}
        {!doneBy && firstFound && <> {agentAction(firstFound)}</>}
      </>,
    ],
    ['onboarding.quick.look', settings.language !== 'system' || settings.themeMode !== 'system' ? `${settings.themeMode === 'fixed' ? settings.themeFixed.name : t('settings.theme.follow')} · ${settings.language === 'system' ? t('language.system') : (LANGUAGES.find((l) => l.id === settings.language)?.name ?? settings.language)}` : t('onboarding.quick.lookValue')],
    ['onboarding.quick.notify', settings.notifyDefault === DEFAULTS.notifyDefault ? t('onboarding.quick.notifyValue') : t(LEVELS.find(([v]) => v === settings.notifyDefault)![1])],
    ['onboarding.quick.keys', hintsKey ? t('onboarding.quick.keysPlain', { keys: label(hintsKey, settings.bindings) }) : keysLine],
    ['onboarding.quick.where', t('onboarding.quick.whereValue')],
    ['onboarding.quick.git', t('onboarding.quick.gitValue')],
  ];
  const status = shown.skipped ? t('onboarding.skipped') : t(shown.done ? 'onboarding.done' : 'onboarding.notDone');
  const open = (page: string, primary = true) => (
    <button type="button" className={primary ? 'btn p' : 'btn'} data-go={page} onClick={() => update({ settingsPage: page })}>
      {t('onboarding.open', { page: pageName(page) })}
    </button>
  );
  const recheck = <p className="ob-recheck">{t('onboarding.recheck')}</p>;
  // Ticket 582 follow-up (F1): a done step names its result, not only "Done".
  const lookLine = t('onboarding.look.done', {
    theme: settings.themeMode === 'fixed' ? settings.themeFixed.name : t('settings.theme.follow'),
    row: heights(settings).row,
    language: settings.language === 'system' ? t('language.system') : (LANGUAGES.find((l) => l.id === settings.language)?.name ?? settings.language),
  });
  const known = perm && perm !== 'error' ? perm : null;
  const permWord = (v: boolean | null) => t(v === true ? 'perms.granted' : v === false ? 'perms.notGranted' : 'perms.unknown');
  const macosLine =
    perm &&
    t('onboarding.macos.done', {
      disk: t('perms.fullDisk'),
      diskState: permWord(known?.full_disk ?? null),
      volumes: t('perms.volumes'),
      volumesState: known?.volumes === 'not_needed' ? t('perms.notNeeded') : permWord(known ? VOLUMES[known.volumes] : null),
    });

  // One card per agent found, drawn with Providers' card head; every button but 설치, and the card itself, open its card there.
  const card = (id: string, name: string, mark: React.ReactNode, sub: string, chip: React.ReactNode, action: React.ReactNode, toggle?: React.ReactNode) => (
    <div key={id} className="acct-agent" data-agent={id}>
      <ProviderHead id={id} label={name} mark={mark} name={name} sub={sub} mid={<span className="prv-act">{action}</span>} chips={chip} toggle={toggle} onToggle={() => openAgents(id)} />
    </div>
  );
  const goTo = (id: string, word: string) => (
    <button type="button" className="btn" onClick={() => openAgents(id)}>
      {word}
    </button>
  );
  // Ticket 991 (peers item 7): Sign in runs Providers' own login (ownLogin) here, then checks again; with no "Your own"
  // listed, or a login that could not start, it opens the agent on Providers as before.
  const own = (agent: AccountAgent) => accounts.find((a) => a.agent === agent && a.default);
  const signIn = (agent: AccountAgent) => {
    const a = own(agent);
    if (!a) return openAgents(agent);
    void ownLogin(core, a).then(
      () => checkOwn(core, agent, true).catch(() => {}),
      () => openAgents(agent),
    );
  };
  const signInButton = (agent: AccountAgent) => (
    <button type="button" className="btn" onClick={() => signIn(agent)}>
      {t('settings.accounts.signIn')}
    </button>
  );
  const agentAction = (f: Found) => {
    const state = signState(f.agent);
    if (!f.found) return <button type="button" className="btn" onClick={() => void openExternal(INSTALL[f.agent])}>{t('providers.install')}</button>;
    if (state === 'yes') return null;
    // Ticket 470: "Couldn't check" is no dead end: once a check came back with no answer, the action is the sign-in.
    if (state === 'no' || (checks[f.agent]?.done && !checks[f.agent]?.running)) return signInButton(f.agent);
    return (
      <button type="button" className="btn" aria-label={t('settings.accounts.checkOwn', { name: NAMES[f.agent], label: accountName(t, own(f.agent) ?? { default: true, label: 'Default' }) })} disabled={!!checks[f.agent]?.running} aria-busy={!!checks[f.agent]?.running} onClick={() => void checkOwn(core, f.agent, true).catch(() => {})}>
        {t('settings.accounts.check')}
      </button>
    );
  };
  const cards = [
    ...found.map((f) => {
      const name = NAMES[f.agent];
      const state = signState(f.agent);
      const chip = !f.found ? (
        <Chip word={t('agents.page.stMissing')} tone="bad" />
      ) : state === 'yes' ? (
        <Chip word={t('settings.accounts.signedIn')} tone="ok" />
      ) : state === 'no' ? (
        <Chip word={t('providers.needsLogin')} tone="warn" />
      ) : (
        <Chip word={t(({ checking: 'agents.page.checking', failed: 'providers.couldNotCheck', unchecked: 'providers.unchecked' } as const)[checkWord(f.agent)])} />
      );
      const action = agentAction(f);
      return card(f.agent, name, <Mark name={f.agent} />, f.found ? versionOf(f.version) || t('firstrun.foundUnknown') : f.agent, chip, action, <UseSwitch t={t} agent={f.agent} name={name} onOff={() => {}} />);
    }),
    ...acp.map((r) =>
      r.state === 'approved'
        ? card(r.name, r.label, <Mark name={r.name} />, `${r.name} · ACP`, <Chip word={t('providers.approved')} tone="ok" />, null)
        : // Look 1117 v10 C-N10: Providers' word for the same row: not in agents.toml yet is "Installed" (its Add tile), an entry is "Needs approval".
          card(r.name, r.label, <Mark name={r.name} />, `${r.name} · ACP`, <Chip word={t(r.state == null ? 'providers.installed' : 'providers.needsApproval')} />, goTo(r.name, t('onboarding.agent.setUp'))),
    ),
  ];
  // Ticket 582: "press the button" only where the button is drawn (permission `default`); `unknown` has none (no Notification API).
  const permNote = notify === 'granted' ? t('settingsA.allowed') : notify === 'denied' ? t('settingsA.denied') : notify === 'unknown' ? t('onboarding.notify.unavailable') : t('onboarding.notify.ask');
  const agentName = (s: Session) => (s.kind === 'acp' ? (acp.find((r) => r.name === s.acp_agent)?.label ?? s.acp_agent ?? 'ACP') : NAMES[s.kind as AccountAgent] ?? s.kind);

  // Ticket 991 (peers item 18, Orca's preflight): what the core's first-run look found missing, before a start fails:
  // the agents, and git (Q7 point 18).
  const noAgent = !opening && found.length > 0 && !firstFound && acp.length === 0;
  const noGit = !opening && !git;
  return (
    <>
      <PageSummary parts={[[t('summary.setup'), t('summary.stepsDone', { done: steps.filter((s) => s.done).length, all: steps.length })]]} />
      {(noAgent || noGit) && (
        <section className="ob-quick ob-preflight" role="alert" aria-labelledby="ob-preflight-title">
          <h3 id="ob-preflight-title">{t(noAgent ? 'onboarding.preflight.title' : 'onboarding.preflight.gitTitle')}</h3>
          {noAgent && <p>{t('onboarding.preflight.body')}</p>}
          {noGit && <p data-missing="git">{t('onboarding.preflight.git')}</p>}
          {noAgent && (
            <div className="ob-acts">
              {found.map((f) => (
                <button key={f.agent} type="button" className="btn" onClick={() => void openExternal(INSTALL[f.agent])}>
                  {t('onboarding.preflight.install', { name: NAMES[f.agent] })}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      {/* Real-app look 11-16: only until the first project is in; after that the checklist is the guide. */}
      {!hasProject && !steps[steps.length - 1].done && (
        <section className="ob-quick" aria-labelledby="ob-quick-title">
          <h3 id="ob-quick-title">{t('onboarding.quick.title')}</h3>
          <p>{lead ? t('firstUse.quick.body', { name: NAMES[lead] }) : t('onboarding.quick.bodyNoAgent')}</p>
          {lead && (
            <form className="ob-start" onSubmit={(e) => (e.preventDefault(), void go())}>
              <div className="ob-fld">
                <span>{t('firstUse.folder')}</span>
                <div>
                  {rows.length ? (
                    // The mockup's box: the name in bold, the path muted, when it was last used on the right. The native
                    // select lies over it, transparent, so the list, the keys and the name a screen reader reads stay its own.
                    <span className="ob-sel field-box">
                      <span aria-hidden>
                        <b>{folderName(folder)}</b> <small>{tilde(folder)}</small>
                      </span>
                      <small aria-hidden>
                        {chosen?.agent && since ? t('firstUse.lastUsed', { agent: NAMES[chosen.agent as AccountAgent] ?? chosen.agent, when: t(`firstUse.ago.${since.unit}${since.unit === 'now' ? '' : since.n === 1 ? '.one' : '.other'}` as Key, { n: since.n }) }) : null}
                        <Icon name="chevron-down" size={12} />
                      </small>
                      <select aria-label={t('firstUse.folder')} value={folder} onChange={(e) => (e.target.value ? setFolder(e.target.value) : choose())}>
                        {rows.map((r) => (
                          <option key={r.path} value={r.path}>
                            {`${folderName(r.path)} (${tilde(r.path)})`}
                          </option>
                        ))}
                        <option value="">{t('firstUse.choose')}</option>
                      </select>
                    </span>
                  ) : (
                    <button type="button" className="btn" data-go="choose" onClick={choose}>
                      {t('firstUse.choose')}
                    </button>
                  )}
                  {/* Ticket 1130 C7: says where a folderless first session runs; "Choose folder…" stays one click. */}
                  {inHome && (
                    <small className="ob-home-line" data-field="home-line">
                      {t('firstUse1130.homeLine')}{' '}
                      <button type="button" className="ob-link" data-go="choose" onClick={choose}>
                        {t('firstUse.choose')}
                      </button>{' '}
                      {t('firstUse1130.homeLineEnd')}
                    </small>
                  )}
                </div>
              </div>
              <label className="ob-fld">
                <span>{t('firstUse.prompt')}</span>
                <input {...PLAIN} className="sinp" aria-label={t('firstUse.prompt')} placeholder={t('firstUse.promptHint', { name: NAMES[lead] })} autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              </label>
              <ErrorLine t={t} error={goError ? rawError(goError) : ''} />
              <div className="ob-fld">
                <span />
                <div className="ob-acts">
                <button type="submit" className="btn p" data-go="start" disabled={going} aria-busy={going || undefined}>
                  {t('firstUse.start', { name: NAMES[lead] })} <span aria-hidden>⏎</span>
                </button>
                <button type="button" className="btn" data-go="quick" onClick={() => void quick()}>
                  {t('firstUse.addOnly')}
                </button>
                </div>
              </div>
            </form>
          )}
          <dl>
            {quickRows().map(([k, v]) => (
              <div key={k}>
                <dt>{t(k)}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            <div>
              <dt>{t('onboarding.quick.perm')}</dt>
              <dd>
                {mode && (
                  <Select label={t('onboarding.quick.perm')} value={mode} onChange={setPermission}>
                    <option value="full-access">{t('onboarding.quick.permFull')}</option>
                    <option value="ask">{t('agents.new.permAsk')}</option>
                    <option value="own">{t('agents.new.permOwn')}</option>
                  </Select>
                )}
                <small>{t('onboarding.quick.permValue')}</small>
              </dd>
            </div>
          </dl>
          {!lead && (
            <div className="ob-acts">
              <button type="button" className="btn p" data-go="quick" onClick={() => void quick()}>
                {t('onboarding.quick.go')}
              </button>
            </div>
          )}
        </section>
      )}
      <div className="ob" data-setting="onboarding">
        <div className="ob-list">
          <div className="ob-sec">
            <span>{t('onboarding.setup')}</span>
            {/* Ledger v4f-C-S3-5: nothing said what ticks a step. */}
            <span data-ob-count data-tip={t('look8.onboarding.countTip')}>
              {steps.filter((s) => s.done).length}/{steps.length}
            </span>
          </div>
          <ol>
            {steps.map((s, i) => (
              <li key={s.id}>
                <button type="button" className="ob-step" data-step={s.id} data-done={s.done} aria-current={s.id === shown.id ? 'step' : undefined} onClick={() => setPicked(s.id)}>
                  <span className="ob-n" aria-hidden>
                    {s.done ? <Icon name="check" size={12} /> : i + 1}
                  </span>
                  <span className="ob-lbl">
                    {t(TITLE[s.id][0])}
                    {s.skipped && <span className="ob-skp">{t('onboarding.skipped')}</span>}
                    <small>{s.page ? pageName(s.page) : t('tree.projectsTitle')}</small>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
        <section className="ob-panel" data-panel={shown.id}>
          <div className="ob-head">
            <div>
              <h3>{t(TITLE[shown.id][0])}</h3>
              <p>{t(TITLE[shown.id][1])}</p>
            </div>
            <span className="ob-pill" data-done={shown.done}>
              {status}
            </span>
          </div>
          {shown.id === 'providers' && (
            <>
              {cards.length > 0 && <div className="scard prv-card ob-cards">{cards}</div>}
              <p className="ob-why" role="status">
                {doneBy ?? notDoneLine}
              </p>
              <div className="ob-acts">{open('providers')}</div>
              {recheck}
            </>
          )}
          {shown.id === 'notify' && (
            <>
              <div className="scard ob-rows">
                <Row
                  label={t('onboarding.notify.os')}
                  desc={<span role="status">{permNote}</span>}
                  control={
                    notify === 'default' ? (
                      <button type="button" className="btn p" disabled={asking} onClick={() => (setAsking(true), void askPermission().then(readPermission).then(setNotify).finally(() => setAsking(false)))}>
                        {t('onboarding.notify.askNow')}
                      </button>
                    ) : undefined
                  }
                />
                <Row
                  label={t('onboarding.notify.level')}
                  desc={t('onboarding.notify.levelNote')}
                  reset={<Reset t={t} label={t('onboarding.notify.level')} show={settings.notifyDefault !== DEFAULTS.notifyDefault} run={() => update({ notifyDefault: DEFAULTS.notifyDefault })} />}
                  control={
                    <Select label={t('settingsA.notifyDefault')} value={settings.notifyDefault} onChange={(v) => update({ notifyDefault: v as Level })}>
                      {LEVELS.map(([v, k]) => (
                        <option key={v} value={v}>
                          {t(k)}
                        </option>
                      ))}
                    </Select>
                  }
                />
              </div>
              <div className="ob-acts">{open('alerts', false)}</div>
              {recheck}
            </>
          )}
          {shown.id === 'keys' && (
            <>
              <KeysStep t={t} settings={settings} commands={commands} update={update} />
              {shown.done && (
                <p className="ob-why ob-keys-line" role="status">
                  {keysLine}
                </p>
              )}
            </>
          )}
          {shown.id === 'project' && added && (
            <p className="ob-why" role="status">
              {t('onboarding.project.added', { name: added.name })}
            </p>
          )}
          {shown.id === 'project' && (
            <div className="ob-acts">
              {startIn && (
                <button type="button" className="btn p" data-go="session" onClick={() => startSession(startIn.path)}>
                  {startWord}
                </button>
              )}
              <button type="button" className={startIn ? 'btn' : 'btn p'} data-go="project" onClick={() => addProject()}>
                {t('landing.addProject')}
              </button>
              {!shown.done && (
                <button type="button" className="btn" onClick={() => (setPicked('project'), mark('project_skipped'))}>
                  {t('onboarding.skip')}
                </button>
              )}
            </div>
          )}
          {shown.id === 'session' && (
            <>
              <p className="ob-why" role="status">
                {started
                  ? t('onboarding.session.done', { agent: agentName(started), project: basename(started.project) })
                  : marks.includes('session')
                    ? t('onboarding.session.doneKept')
                    : startIn
                    ? t('onboarding.session.start', { project: startIn.name })
                    : t('onboarding.session.needProject')}
              </p>
              <div className="ob-acts">
                {startIn ? (
                  <button type="button" className={shown.done ? 'btn' : 'btn p'} data-go="session" onClick={() => startSession(startIn.path)}>
                    {startWord}
                  </button>
                ) : (
                  <button type="button" className={shown.done ? 'btn' : 'btn p'} data-go="project" onClick={() => addProject()}>
                    {t('landing.addProject')}
                  </button>
                )}
              </div>
            </>
          )}
          {shown.id === 'look' && shown.done && (
            <p className="ob-why" role="status">
              {lookLine}
            </p>
          )}
          {shown.id === 'macos' && shown.done && macosLine && (
            <p className="ob-why" role="status">
              {macosLine}
            </p>
          )}
          {shown.id === 'skills' && (
            <div className="ob-base">
              <NunchiroSwitches core={core} t={t} />
            </div>
          )}
          {shown.id === 'assistant' && assistant && (
            <>
              <p className="ob-why" role="status">
                {t('onboarding.assistant.done', { name: assistant.name })}
              </p>
              <ErrorLine t={t} error={chiefError ? rawError(chiefError) : ''} />
              <div className="ob-acts">
                <button type="button" className="btn p" data-go="assistant" onClick={() => openChief(assistant.id)}>
                  {t('onboarding.assistant.open', { name: assistant.name })}
                </button>
                {open('assistants', false)}
              </div>
              <p className="ob-recheck">{t('onboarding.assistant.rename')}</p>
            </>
          )}
          {shown.id === 'assistant' && !assistant && (
            <form onSubmit={(e) => (e.preventDefault(), nameChief())}>
              {noClaude ? (
                <p className="ob-why" role="status">
                  {t('onboarding.assistant.noClaude')}
                </p>
              ) : (
                <div className="scard ob-rows">
                  <Row
                    className="ob-name"
                    label={t('team.name')}
                    desc={t('assistants.nameDesc')}
                    extra={<ErrorLine t={t} error={chiefError ? rawError(chiefError) : ''} />}
                    // The default name comes selected, so typing replaces it.
                    control={<input {...PLAIN} className="sinp" data-assistant-name aria-label={t('team.name')} required autoFocus value={chief} maxLength={40} onFocus={(e) => e.currentTarget.select()} onChange={(e) => (setChief(e.target.value), setChiefError(''))} />}
                  />
                  <Row className="ob-name" label={t('onboarding.assistant.runsOn')} desc={t('onboarding.assistant.runsOnDesc')} control={<span className="ob-runs">Claude{claudeAccount ? ` · ${accountName(t, claudeAccount)}` : ''}</span>} />
                </div>
              )}
              <div className="ob-acts">
                {!noClaude && (
                  <button type="submit" className="btn p" data-go="assistant" disabled={naming || !chief.trim()} aria-busy={naming || undefined}>
                    {t('onboarding.assistant.save')}
                  </button>
                )}
                {!shown.done && (
                  <button type="button" className="btn" onClick={() => (setPicked(null), mark('assistant_skipped'))}>
                    {t('onboarding.skip')}
                  </button>
                )}
              </div>
              {!noClaude && <p className="ob-recheck">{t('onboarding.assistant.note')}</p>}
            </form>
          )}
          {shown.page && shown.id !== 'providers' && shown.id !== 'notify' && shown.id !== 'assistant' && <div className="ob-acts">{open(shown.page, shown.id !== 'keys')}</div>}
        </section>
      </div>
      {/* Ticket 378: where new worktrees go, the same setting as Git & Worktrees; optional, so not a counted step. */}
      <section className="ob-import" data-step="worktrees">
        <h3>{t('settings.section.worktrees')}</h3>
        <div className="scard">
          <WorktreeRoot core={core} t={t} />
        </div>
      </section>
      {/* V2.5-12: moved here with the first-run surface; not a counted step (ticket 392 replaces it). */}
      <section className="ob-import" data-step="import">
        <h3>{t('import.step')}</h3>
        <ImportStep core={core} t={t} sessions={sessions} />
      </section>
    </>
  );
}
