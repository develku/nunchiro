//! What the core answers: `Reply`, one variant per kind of answer, and `Response`.
use super::*;

/// V2.5-61 B8: a zero count is left out of the reply, like a false flag.
fn is_zero(v: &usize) -> bool {
    *v == 0
}
/// V2-CF5: a false flag is left out of the reply, so a snapshot's legacy bytes do not change.
fn is_false(v: &bool) -> bool {
    !*v
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    SessionContext {
        used: u64,
        window: u64,
        // B15 (ticket 991): the model the agent last reported in its transcript; omitted when none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        // Ticket 994: the effort that model's last request ran at, as the agent wrote it; omitted when none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
        // Ticket 1059: the newest /context table the transcript holds since the last /clear or compact; omitted when none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        breakdown: Option<Breakdown>,
    },
    /// B15: the transcript names its model but not a context window this core can trust.
    SessionModel {
        model: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
    },
    Unknown,
    // v1a-06
    MachineDetails {
        machines: Vec<crate::machines::discovery::Details>,
    },
    // v25f
    MachineAliases {
        aliases: Vec<crate::machines::aliases::Alias>,
    },
    MachineProbe {
        error: Option<String>,
    },
    // Ticket 1050
    MachineShare {
        remote_login: bool,
        shares: Vec<crate::machines::share::Share>,
    },
    MachineTrust {
        live: String,
        trusted: bool,
        error: Option<String>,
    },
    Machines {
        machines: Vec<crate::machines::Status>,
    },
    // v1b-02
    ChatPage {
        session: String,
        page: crate::chat::Page,
    },
    // v2-2a: "Your own" first for each agent.
    Accounts {
        accounts: Vec<crate::accounts::Account>,
    },
    // v2-2c
    AccountUsage {
        rows: Vec<crate::usage::Row>,
    },
    // Needs 225: a read's count and earliest expiry (Unix seconds), held for this reply only.
    CodexResets {
        account: String,
        available: u64,
        next_expires_at: Option<i64>,
    },
    // Needs 225: a use's outcome word, and the owner's read again after it.
    CodexResetUsed {
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<crate::codex_reset::Summary>,
    },
    CodexResetLog {
        entries: Vec<crate::codex_reset::Entry>,
        // Round 3: a log that cannot be read, or one moved aside this week.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        problem: Option<crate::codex_reset::LogProblem>,
    },
    UsageDetail {
        detail: crate::usage::Detail,
        /// W35-picker2 S3: the model the user's own Claude settings name (`model` in settings.json), what a Default
        /// session starts on; absent when they name none (Claude then picks by plan, which Nunchiro does not know).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        claude_default: Option<String>,
    },
    // Ticket 1100
    AgentModels {
        codex: Vec<crate::agent_models::Model>,
    },
    // ticket-98
    UserCommands {
        rows: Vec<crate::user_commands::Row>,
    },
    // v2-5a
    FirstRun {
        agents: Vec<crate::firstrun::Found>,
        /// Q7 point 18: `git --version` answers on the core's PATH.
        git: bool,
    },
    AccountChecked {
        account: crate::accounts::Account,
    },
    AccountAdded {
        account: crate::accounts::Account,
        session: Session,
    },
    // v2-2d
    AccountRemoveCheck {
        sessions: usize,
    },
    AccountLogout {
        session: Session,
    },
    // Logout exited non-zero (`code`) or never ran (none): the move waits for the owner to confirm the leftovers.
    AccountLeftovers {
        code: Option<i32>,
    },
    AccountRemoved {
        trash: PathBuf,
    },
    // Ticket 178 finding 20: the attempt's id; its link and outcome come from AccountSignInState.
    AccountSignInStarted {
        attempt: String,
    },
    AccountSignInState {
        state: crate::account_signin::State,
    },
    // Ticket 358: an ACP agent's sign-in, from its start and from every poll.
    AcpSignIn {
        state: crate::acp::add::SignIn,
    },
    // Ticket 358: every table tool found on the PATH; `checked` is false until the first background read has finished.
    AgentUpdates {
        rows: Vec<crate::agent_update::Row>,
        checked: bool,
    },
    // v2-3a
    Handoff {
        text: String,
        prompts: usize,
        files: usize,
        bytes: usize,
    },
    // v2-3b: the session the handoff went to and its send row.
    Switched {
        session: Session,
        send: crate::delivery::Send,
    },
    // v2-8b
    PrChip {
        chip: Option<crate::chat::pr::PrChip>,
    },
    // V2-CF4: what the tree shows under the session row; empty for a kind that reports no child.
    Subagents {
        session: String,
        kids: Vec<crate::chat::kids::Kid>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opened: Option<crate::chat::kids::Opened>,
    },
    // v2-8c: `watched` and `live` are about the op's `url`; `hint` says why there is no live status.
    PrLive {
        on: bool,
        offered: bool,
        watched: bool,
        live: Option<crate::pr_live::Live>,
        hint: Option<String>,
    },
    // V2.5-8
    PrView {
        view: crate::pr::View,
    },
    // V2.5-9: unsorted (the window sorts by merge readiness); `hint` is the last repository's error.
    PrList {
        prs: Vec<crate::pr::Item>,
        hint: Option<String>,
    },
    PrMerged {
        url: String,
    },
    // `git_push`: how many commits went to which remote branch.
    GitPushed {
        pushed: u64,
        remote: String,
        branch: String,
    },
    PrDraft {
        draft: crate::git_write::Draft,
    },
    // `pr_write`: the agent's text for the form, and which agent wrote it.
    PrWritten {
        title: String,
        body: String,
        agent: String,
    },
    // `pr_create`: the new PR, and how many commits were pushed first.
    PrCreated {
        url: String,
        number: u64,
        pushed: u64,
    },
    // Ticket 373: `None` when the branch has no PR of its own (or none is looked up: the default branch, no upstream).
    PrBranch {
        pr: Option<crate::pr::BranchPr>,
    },
    Worktrees {
        worktrees: Vec<Worktree>,
        /// V2-8a: a remove refused for unsaved work; nothing was removed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        loss: Option<WorktreeLoss>,
        /// V2-8a: the auto-clean removals this core made recently (memory only), one toast each.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        cleaned: Vec<WorktreeCleaned>,
        /// V2.5-61 B8: the `branches` op's refs (local first, then remote); every other op leaves these out.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        branches: Vec<BranchRef>,
        /// Listed names left out as unsafe to show (an option-like, overlong, control or hidden-character name).
        #[serde(default, skip_serializing_if = "is_zero")]
        branches_dropped: usize,
        /// More refs than the 500 listed.
        #[serde(default, skip_serializing_if = "is_false")]
        branches_truncated: bool,
        /// Ticket 374: with `branches`, what a new worktree with no base starts from (`origin/main`); none means HEAD.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_base: Option<String>,
    },
    Agent {
        session: Session,
    },
    /// Ticket 573 slice 2: `latest` is the cursor for the next read; `gap`: events after `since` were dropped.
    Events {
        events: Vec<crate::events::Event>,
        latest: u64,
        gap: bool,
    },
    Text {
        text: String,
    },
    Delivery {
        send: crate::delivery::Send,
    },
    // Ticket 571
    Room {
        messages: Vec<crate::room::Message>,
    },
    /// Ticket 571c: the owner's room read. `log` names the log (the time of its first message, 0 when empty).
    RoomRead {
        messages: Vec<crate::room::Message>,
        reset: bool,
        log: u64,
        /// Ticket 593: the pinned message ids of this log, in pin order.
        #[serde(default)]
        pins: Vec<String>,
        /// Look 1117 v13 Home S3-1: names of seats whose rows are gone, by session id (`room::Log::names`).
        #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
        names: std::collections::BTreeMap<String, String>,
        /// Ticket 1089: for each of the newest lines sent to a seat (by message id), when it reached the seat (null:
        /// it waits there).
        #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
        delivery: std::collections::BTreeMap<String, Option<u64>>,
    },
    /// Ticket 593: the pins after a `RoomPin`.
    RoomPins {
        pins: Vec<String>,
    },
    // v1b-15
    BoardSnapshot {
        board: crate::board::Snapshot,
    },
    // v2-9a
    Tree {
        tree: crate::tree::Tree,
    },
    /// Ticket 1040
    ProjectFolders {
        folders: std::collections::BTreeMap<String, crate::tree::FolderState>,
    },
    /// Ticket 1040: `project` is the new folder as it is stored (canonical).
    ProjectLocated {
        project: String,
        tree: crate::tree::Tree,
    },
    Started {
        session: Session,
    },
    Snapshot {
        sessions: Vec<Session>,
        // V2-CF5: whether the no-idle-sleep assertion is held now (the menu bar's cup). Omitted while false, like the
        // two fields below, so the legacy snapshot bytes stay identical; a reader treats absent as not held.
        #[serde(default, skip_serializing_if = "is_false")]
        keep_awake_held: bool,
        // v1b-18: omitted when empty, so the legacy snapshot bytes are unchanged.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        board_decisions: Vec<crate::board::Decision>,
        // v1a-23: what sessions asked the owner to do (widget approval, verified yes); omitted when empty.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        owner_decisions: Vec<crate::queue::Decision>,
        // v2-5b: a problem of the core, not of one session (a set-aside state file); omitted when none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        problem: Option<crate::problems::Problem>,
    },
    // v1a-23: a human action asked from inside a session became this waiting item for the owner.
    Waiting {
        item: String,
    },
    // v1a-23
    PermissionAnswers {
        project: PathBuf,
        on: bool,
    },
    // Ticket 362
    AgentPermission {
        claude: PermissionChoice,
        codex: PermissionChoice,
        // Ticket 358: Claude's own settings turn Bypass permissions off, so Settings says why it cannot be used.
        #[serde(default)]
        claude_bypass_disabled: bool,
    },
    // v1b-18
    BoardDecisions {
        board_decisions: Vec<crate::board::Decision>,
    },
    /// Bytes are lossless (PTY output need not be UTF-8). Offsets count bytes, not characters.
    Output {
        data: Vec<u8>,
        start: u64,
        end: u64,
        truncated: bool,
    },
    HookDecision {
        decision: Option<serde_json::Value>,
    },
    Ack,
    // Ticket 1130 A-D3: `exit_blockers`
    ExitBlockers {
        count: usize,
    },
    // V2.5-20
    Browser {
        result: serde_json::Value,
    },
    BrowserJob {
        job: Option<crate::browser::Job>,
    },
    // v1b-08
    Files {
        entries: Vec<crate::files::FileEntry>,
    },
    File(crate::files::FileContent),
    Matches {
        matches: Vec<crate::files::Match>,
        truncated: bool,
        /// Ignore files too large to apply (their rules were not used).
        #[serde(default)]
        skipped_ignore_files: Vec<String>,
    },
    // v1b-14
    ApprovalStatus {
        view: crate::approval::View,
    },
    QuitSettings {
        settings: LifetimeSettings,
    },
    GitProviders {
        providers: Vec<crate::git_providers::Provider>,
    },
    // V2-4a
    AcpAgent {
        view: crate::approval::AgentView,
    },
    // V2-4b
    AcpAgents {
        terminal: Vec<crate::firstrun::Found>,
        acp: Vec<crate::acp::AcpRow>,
        /// The absolute path of `agents.toml` (the window reveals it, or shows it to copy).
        file: std::path::PathBuf,
    },
    AcpCheck(crate::acp::probe::Check),
    // Ticket 358
    AgentCommand {
        view: crate::approval::CommandView,
    },
    // Ticket 259
    SetupStatus {
        status: crate::worktree_setup::Status,
    },
    CommandCheck {
        check: crate::approval::CommandCheck,
    },
    // v1b-11: `base` null means the start commit is unknown (a session recorded before v1b-11).
    Diff {
        base: Option<crate::diff::Base>,
        /// The start commit was recorded but no longer exists (garbage-collected or history rewritten).
        #[serde(default)]
        base_missing: bool,
        files: Vec<crate::diff::Change>,
        truncated: bool,
        /// Ticket 374: whether the Branch scope can compare here (absent for a folder outside git).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<crate::diff::Branch>,
        /// Ticket 373: the folder's git state for the Diff header's one button; absent when it cannot be read.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        git: Option<crate::diff::GitFacts>,
    },
    DiffFile(crate::diff::Patch),
    // v1b-19
    Widgets {
        list: crate::widgets::List,
    },
    WidgetRun {
        run: crate::widgets::Run,
    },
    // v1b-22
    WidgetPage {
        page: crate::widgets::web::Page,
    },
    /// v1b-20: the target session (started for a `start` act) and its send row.
    WidgetAct {
        session: String,
        send: crate::delivery::Send,
    },
    // v1b-05: bytes received so far; `path` (absolute) once the last piece is saved.
    Image {
        received: u64,
        path: Option<String>,
    },
    // v1a-13
    WindowAuth {
        port: u16,
        token: String,
    },
    // V2.5-15: Settings > Browser access, window only (`http::browser::Op`, never a `Request`).
    BrowserAccess {
        status: crate::http::browser::Status,
    },
    // v1a-47: Browse online, window only (`themes_online::Op`, never a `Request`).
    ThemeIndex {
        themes: Vec<crate::themes_online::Entry>,
    },
    Theme {
        theme: crate::themes_online::Theme,
    },
    // v2-7: Search's Sessions scope, window only (`chat::search::Op`, never a `Request`).
    SessionsSearch {
        scanned: usize,
        results: Vec<crate::chat::search::Found>,
    },
    SessionsHit {
        cursor: Option<u64>,
        generation: u64,
    },
    // v2-10c: the library cache. `LibsResolve` and `LibsEntry` answer the owner's requests; `Libs` and `LibPinned`
    // answer the window's `libs::Op` (never a `Request`).
    LibsResolve {
        results: Vec<crate::libs::Resolved>,
    },
    /// Ticket 573: the only reply that carries a token's secret.
    TokenCreated {
        token: crate::tokens::Token,
        secret: String,
    },
    Tokens {
        tokens: Vec<crate::tokens::Token>,
    },
    LibsEntry {
        entry: Option<crate::libs::Entry>,
        /// The store file, built from the validated hash; the caller hashes what it reads before serving.
        path: Option<PathBuf>,
    },
    Libs {
        entries: Vec<crate::libs::Entry>,
        auto_allow: Vec<crate::libs::AutoAllow>,
        /// Ticket 366: the shipped default switches, so Settings can mark them and offer them again once off.
        defaults: Vec<crate::libs::AutoAllow>,
        /// False: the lockfile on disk was set aside (broken or newer); changes last until the core exits.
        saved: bool,
    },
    LibPinned {
        entry: crate::libs::Entry,
    },
    // Owner 2026-11-16: teammates, answers to the window's `team::Op` (never a `Request`).
    Team {
        teammates: Vec<crate::team::Teammate>,
        /// Ticket 1168: the same roster as bots (face, seat, model rule), in the same order.
        bots: Vec<crate::team::Bot>,
        /// The folder every Home teammate works in.
        home: PathBuf,
        /// The id of the bot this request made (`bot_new`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        made: Option<String>,
    },
    /// Ticket 1168: a bot's SOUL file as it is now. `first`: its first chat, while that lasts.
    BotSoul {
        id: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        first: Option<crate::team::First>,
    },
    /// Ticket 990 slice i: the user's roles.
    Roles {
        roles: Vec<crate::roles::Role>,
    },
    /// Ticket 990 slice i: what to start for a seat of a role on a task (`task staff`): the caller sends the start.
    Staff {
        task: String,
        folder: Option<PathBuf>,
        session: StartSession,
        /// Look v9 B N-S3-6: the level the seat opens at (none for a role with its own model); the caller sends it
        /// with `assign`, so the seat's session carries it as a teammate's seat does.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<crate::team::Level>,
        /// Ticket 1055: why the seat does not open at the asked level (a Worker models rule, its Builder's level).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
    },
    /// Ticket 990 slice h: notes, newest first.
    Notes {
        notes: Vec<crate::notes::Listed>,
    },
    /// Ticket 990 slice g: tasks as the ledger has them, each with its state word now.
    Tasks {
        tasks: Vec<crate::ledger::View>,
        /// Slice i: what the asked place decided (its way of working, what its seats may do); absent when no one
        /// place was asked.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        place: Option<crate::ledger::Place>,
    },
    /// Home view change 1: every registered project's row (`task digest`), in the order the Home view shows them.
    Digest {
        projects: Vec<crate::ledger::DigestRow>,
        /// Ticket 993 rule 6: the schedules whose last run failed or could not start; each one needs the user as a
        /// pending decision does. Left out when there is none.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        failed_runs: Vec<crate::ledger::FailedRun>,
        /// Ticket 1002 lane 2: the Outbox cards waiting for the user (each needs the user, as a decision does).
        #[serde(default, skip_serializing_if = "is_zero")]
        outbox: usize,
        /// Ticket 1003: the open loops, counted by the core (promises, waiting-for, and how many are overdue).
        #[serde(default, skip_serializing_if = "crate::loops::Counts::is_zero")]
        loops: crate::loops::Counts,
        /// Ticket 1003: the open-loop cards waiting for the user (each needs the user, as a decision does).
        #[serde(default, skip_serializing_if = "is_zero")]
        loop_cards: usize,
    },
    /// Ticket 1003: the open loops (`task loops`), oldest first, with their counts and the local date they were
    /// counted on.
    Loops {
        loops: Vec<crate::loops::Row>,
        counts: crate::loops::Counts,
        today: String,
    },
    /// The window's start waits for memory (`StartOrWait`): the status bar lists it.
    MemoryWaiting {
        text: String,
    },
    /// The starts waiting for memory (`pressure::wait::Shown`).
    MemoryWait {
        entries: Vec<serde_json::Value>,
    },
    /// A waiting start the owner started anyway; `mine`: the owner had asked for it.
    MemoryWaitStarted {
        session: String,
        mine: bool,
    },
    /// Ticket 990: the seat's session after `team_open` (found or started).
    TeamOpened {
        session: Session,
        /// False: the seat was already open and nothing was sent.
        started: bool,
        /// Ticket 992: why the seat's level is not the asked one (a pin, Auto's limit, a working seat), in plain words.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
    },
    TeamBrief {
        teammate: crate::team::Teammate,
        /// Where its session starts: its project, or the Home folder.
        project: PathBuf,
        /// Its first prompt: the job, the memory as it is now, the other teammates of its room.
        prompt: String,
        memory: PathBuf,
    },
    // Ticket 276: env holds names only.
    Extensions {
        dir: String,
        items: Vec<crate::extensions::Item>,
        mcp: Vec<crate::extensions::McpServer>,
        // Ticket 276 round 3: agent configs past the read cap; the page names them instead of "no servers".
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        mcp_too_large: Vec<crate::extensions::TooLarge>,
        own: Vec<crate::extensions::McpServer>,
        // Ticket 455: Nunchiro's own hooks, exactly as a launch passes them.
        #[serde(default)]
        hooks: Vec<crate::extensions::HookLine>,
    },
    // Ticket 452: `editable` is false for the shipped skill; `more` when a bound cut the list.
    ExtensionsFiles {
        id: String,
        editable: bool,
        files: Vec<crate::extensions::FileEntry>,
        more: bool,
    },
    ExtensionsFile {
        id: String,
        path: String,
        text: String,
        editable: bool,
    },
    // Ticket 370: the answer to every clone request.
    ProjectClone {
        state: crate::projects::clone::State,
    },
    // V2.5-15
    ProjectCreated {
        path: PathBuf,
        /// Ticket 370: `git init` succeeded, so the folder is a repository.
        repo: bool,
        /// Ticket 370: the folder exists but a Git step failed; git's last error line.
        warning: Option<String>,
    },
    ProjectIcon {
        mime: Option<String>,
        data_b64: Option<String>,
    },
    // Ticket 375
    EditorApps {
        apps: Vec<String>,
    },
    // V2.5-12: first-run import, window only (`import::Op`, never a `Request`).
    ImportList {
        items: Vec<crate::import::Item>,
    },
    /// Ticket 1123: `import_list` with `folders_only`: the folders alone, no conversation words.
    ImportFolders {
        folders: Vec<crate::import::Folder>,
    },
    ImportAdded {
        total: usize,
    },
    ImportSearch {
        results: Vec<crate::chat::search::Found>,
    },
    /// An imported conversation as chat events (`chat::Event` shape), bounded; `left_out` counts what was cut.
    ImportRead {
        id: String,
        agent: crate::accounts::Agent,
        project: String,
        title: String,
        entries: Vec<serde_json::Value>,
        truncated: bool,
        left_out: usize,
    },
    // V2.5-11
    Schedules {
        schedules: Vec<crate::schedule::Entry>,
    },
    /// 392: `import_list` with `projects`: each project's own conversations, newest first; a project with none is empty.
    ImportProjects {
        projects: std::collections::BTreeMap<String, Vec<crate::import::Item>>,
    },
}

pub type Response = Result<Reply, String>;
