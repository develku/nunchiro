mod agent;
mod board; // V2.5-35
mod browser; // V2.5-20
mod diagnose; // v2-13b
mod events; // ticket 573 slice 2
mod extensions; // ticket 455
mod hook;
mod layout;
mod machine; // v1a-06
mod mcp; // ticket 573
mod outbox; // ticket 1002 lane 2
mod skill; // V2.5-31
mod token; // ticket 573
// v1b-14
#[path = "../../../app/src-tauri/src/passwd.rs"]
mod passwd; // ticket 1082 round 2: the account's home, which HOME cannot move
mod schedule; // ticket 993
mod task; // ticket 990 slice g
mod update; // ticket 1082
mod update_claims; // ticket 1082 round 3: shared with the app
mod widget;
mod worktree;
use nunchiro_core::{
    accounts::{SignedIn, agent_name},
    api::*,
    server,
};
use std::{
    env,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

// v1a-23: what the CLI prints when a session asked for one of the two human actions.
pub(crate) const WAITING: &str = "waiting for the owner in the Nunchiro window";
// v1a-23: set on the helper that finishes a `serve restart` asked from inside a session (the asking process's pid).
const RESTARTER: &str = "NUNCHIRO_RESTARTER";
const BOT_USAGE: &str = "nunchiro bot offer \"<name>\" --job \"<one sentence>\" --why \"<what you counted>\" (inside a bot's session: asks the user on a card for a new bot)";
/// F24: `scripts/build-rc.sh` stamps each RC; a build without a stamp (cargo, the owner's) never replaces a core.
const BUILD: Option<&str> = option_env!("NUNCHIRO_BUILD");
/// `scripts/build-release.sh` stamps each official release. It orders cores for `serve update` as `BUILD` does, but it
/// is not the mark of an RC: nothing is refused on the owner's home, where the official app's core lives.
const RELEASE: Option<&str> = option_env!("NUNCHIRO_RELEASE");
/// Ticket 1082: this binary's git commit (build.rs). A core of another commit from this same install is replaced by
/// `serve update`, so a build swapped in place takes over the core without a stamp.
const COMMIT: Option<&str> = option_env!("NUNCHIRO_GIT_SHA");

fn main() {
    if let Err(e) = run() {
        eprintln!("nunchiro: {e}");
        // Ticket 573 slice 2 (T3): 2 says the agent waits on a question or permission, so a script can answer it.
        std::process::exit(if e.starts_with(agent::NEEDS_ANSWER) {
            2
        } else {
            1
        });
    }
}
fn home() -> Result<PathBuf, String> {
    let path = match env::var_os("NUNCHIRO_HOME") {
        Some(set) => PathBuf::from(set),
        None => default_home(
            cfg!(debug_assertions),
            &env::current_exe().map_err(|e| e.to_string())?,
            env::var_os("HOME"),
        )?,
    };
    if path.is_absolute() {
        Ok(path)
    } else {
        Err("NUNCHIRO_HOME must be absolute".into())
    }
}
/// The home when NUNCHIRO_HOME is unset: `~/.nunchiro` for a release build. Ticket 1130 (11-20 incident: a debug build
/// from a worktree ran on the owner's `~/.nunchiro` and tried to replace the owner's core): a debug build uses
/// `nunchiro-home` in the folder of its executable (`target/debug`) instead.
fn default_home(
    debug: bool,
    exe: &Path,
    user_home: Option<std::ffi::OsString>,
) -> Result<PathBuf, String> {
    if debug {
        return Ok(exe.parent().unwrap_or(exe).join("nunchiro-home"));
    }
    user_home
        .map(|h| PathBuf::from(h).join(".nunchiro"))
        .ok_or_else(|| "HOME is not set".into())
}
fn run() -> Result<(), String> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    // v1a-06: this is before any threads are started.
    if args.first().map(String::as_str) == Some("--machine") {
        let alias = args.get(1).ok_or("missing machine alias")?.clone();
        nunchiro_core::machines::valid_alias(&alias)?;
        unsafe {
            env::set_var("NUNCHIRO_MACHINE", alias);
        }
        args.drain(..2);
    }
    if args == ["--version"] {
        match option_env!("NUNCHIRO_GIT_SHA") {
            Some(sha) => println!("nunchiro {} ({sha})", env!("CARGO_PKG_VERSION")),
            None => println!("nunchiro {}", env!("CARGO_PKG_VERSION")),
        }
        return Ok(());
    }
    let home = home()?;
    // v1a-06
    if args.first().map(String::as_str) == Some("machine") {
        return machine::run(&home, &args[1..]);
    }
    // v2-1a: a session's PTY holder, started by the core (internal).
    if args.first().map(String::as_str) == Some("hold") {
        return nunchiro_core::holder::main(&home, &args[1..]);
    }
    if args == ["serve"] && env::var_os("NUNCHIRO_MACHINE").is_none() {
        let user_home = env::var_os("HOME").map(PathBuf::from);
        refuse_rc_core_start(BUILD, &home, user_home.as_deref())?;
        // Ticket 575: `serve` reads the login shell's PATH once it holds the core lock, before any thread.
        nunchiro_core::login_path::request();
        // v2-1a: holders run as `nunchiro hold` from this binary.
        nunchiro_core::holder::use_executable(env::current_exe().map_err(|e| e.to_string())?);
        if let Some(build) = BUILD.or(RELEASE).and_then(|b| b.parse().ok()) {
            let _ = server::BUILD.set(build);
        }
        if let Some(commit) = COMMIT {
            let _ = server::COMMIT.set(commit.into());
        }
        return server::serve(&home);
    }
    if args == ["--help"] || args.is_empty() {
        println!(
            "nunchiro serve [stop [--yes]]\nnunchiro serve status [--json]\nnunchiro session start --kind claude|codex|shell --project DIR [--worktree] [--label TEXT] [--model MODEL] [--effort LEVEL] [--resume ID] [--account LABEL] [--env KEY=VALUE]... [-- ARGS...]\nnunchiro session start --agent acp:NAME --project DIR [--worktree] [--label TEXT] [--resume ID]\nnunchiro session list|read|send-text|send-keys|close|label|resize\nnunchiro snapshot --json\nnunchiro widget new NAME\nnunchiro widget allow NAME --read|--act\nnunchiro permission-answers on|off [--project DIR]\nNUNCHIRO_HOME defaults to ~/.nunchiro (a debug build: nunchiro-home beside its binary); settings.json supports disable_hook_injection and worktrees_dir.\nread emits JSON byte replay; send-text writes exact text, send-keys enter submits.\nWaiting detection, queue and HTTP are reserved for later tickets."
        );
        println!(
            "nunchiro agent start|prompt|send|wait|read|get|list|send-keys|cancel|ask|reply|check\nnunchiro events [--project DIR] [--since ID]\nnunchiro agent thread read THREAD\nnunchiro worktree create|open|list|remove\nnunchiro layout <command> (see nunchiro layout --help)\nnunchiro session open --project DIR -- COMMAND\nnunchiro serve restart\nnunchiro serve update\nnunchiro diagnose\nnunchiro account list [--json]\nnunchiro account codex-reset [--reason TEXT] [--account ID] [--yes]\nnunchiro account leads-any on|off\nnunchiro browser open|goto|snapshot|click|fill|select|press|scroll|tabs|tab|handoff ARGS (inside a session)"
        );
        println!(
            "nunchiro --machine <m> ...\nnunchiro machine status [<label>]\nnunchiro --version\nnunchiro hold <session-id> (internal: a session's PTY holder, started by the core)"
        ); // v1a-06, v2-1a
        println!("nunchiro skill get orchestration [--file NAME] [--full]"); // V2.5-31
        println!(
            "nunchiro mcp -- a stdio MCP server: the agent, worktree and room verbs as tools\nnunchiro token create --scope read|supervised|full [--project DIR] [--expires 30m|12h|7d]\nnunchiro token list|revoke [--json] [ID]"
        ); // ticket 573
        println!(
            "nunchiro extensions list|show|new|on|off|mcp [<args>] (nunchiro extensions --help)"
        ); // ticket 455
        println!(
            "nunchiro board list|create|add|move|done|note|self [--json] (nunchiro board --help)"
        ); // V2.5-35
        println!(
            "nunchiro team open <name> [--level light|standard|deep] (inside a lead's session: opens a teammate of its place)"
        ); // ticket 990
        println!("{BOT_USAGE}");
        println!("{}", task::USAGE); // ticket 990 slice g
        println!("{}", schedule::USAGE); // ticket 993
        println!("{}", outbox::USAGE); // ticket 1002 lane 2
        println!("{}", update::USAGE); // ticket 1082
        return Ok(());
    }
    // V2.5-31: reads only the binary and the user's override folder; no core needed.
    if args.first().map(String::as_str) == Some("skill") {
        return skill::run(&home.join("skills"), &args[1..]);
    }
    // v2-13b
    if args == ["diagnose"] {
        return diagnose::run(&home);
    }
    // Ticket 1002 lane 1: the Home seat lock's hook, decided here without the core.
    if args.first().map(String::as_str) == Some("hook")
        && args.get(1).map(String::as_str) == Some("home-lock")
    {
        hook::home_lock(&home, &args[2..]);
    }
    // Ticket 1130 S1: every Claude session's outward hook, decided here without the core. Ticket 1149: Codex's
    // (`--codex`) asks the core for the owner's card.
    if args.first().map(String::as_str) == Some("hook")
        && args.get(1).map(String::as_str) == Some("outward")
    {
        hook::outward(&home, &args[2..]);
    }
    // Ticket 1036: Claude's status line command (the per-session settings name it); never fails the line.
    if args.first().map(String::as_str) == Some("hook")
        && args.get(1).map(String::as_str) == Some("statusline")
    {
        hook::statusline(&home);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("hook") {
        let hold = args.get(2).map(String::as_str) == Some("--hold");
        return hook::run(&home, args.get(1).map(String::as_str).unwrap_or(""), hold);
    }
    // v1b-14
    if args.first().map(String::as_str) == Some("widget") {
        return widget::run(&home, &args[1..], ensure_core);
    }
    if args.first().map(String::as_str) == Some("extensions") {
        return extensions::run(&home, &args[1..], ensure_core);
    }
    // V2.5-20
    if args.first().map(String::as_str) == Some("browser") {
        return browser::run(&home, &args[1..], ensure_core);
    }
    // Ticket 990: a lead opens the seat of a teammate of its place; the core refuses any other caller.
    if args.first().map(String::as_str) == Some("team") {
        let usage = "usage: nunchiro team open <name> [--level light|standard|deep]";
        let (name, level) = match args.as_slice() {
            [_, verb, name] if verb == "open" => (name, None),
            [_, verb, name, flag, level] if verb == "open" && flag == "--level" => (
                name,
                Some(nunchiro_core::team::Level::parse(level).ok_or(usage)?),
            ),
            _ => return Err(usage.into()),
        };
        ensure_core(&home)?;
        let reply = call(
            &home,
            Request::TeamOpen {
                name: name.clone(),
                level,
            },
        )?;
        println!(
            "{}",
            serde_json::to_string(&reply).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    // A bot's seat offers the user a new bot; the user's card makes it.
    if args.first().map(String::as_str) == Some("bot") {
        let usage = format!("usage: {BOT_USAGE}");
        let [_, verb, name, rest @ ..] = args.as_slice() else {
            return Err(usage);
        };
        let (mut job, mut why) = (None, None);
        let mut words = rest.iter();
        while let Some(word) = words.next() {
            match (word.as_str(), words.next()) {
                ("--job", Some(value)) => job = Some(value.clone()),
                ("--why", Some(value)) => why = Some(value.clone()),
                _ => return Err(usage),
            }
        }
        let (true, Some(job), Some(why)) = (verb == "offer", job, why) else {
            return Err(usage);
        };
        ensure_core(&home)?;
        call(
            &home,
            Request::BotOffer {
                name: name.clone(),
                job,
                why,
            },
        )?;
        println!(
            "The user is asked on a card. Nothing is made before their yes; go on with your work."
        );
        return Ok(());
    }
    // Ticket 990 slice g: the job ledger.
    if args.first().map(String::as_str) == Some("task") {
        return task::run(&home, &args[1..]);
    }
    // Ticket 993: schedules, read by the user and a place's lead; a lead's proposal is the user's card.
    if args.first().map(String::as_str) == Some("schedule") {
        return schedule::run(&home, &args[1..]);
    }
    // Ticket 1002 lane 2: the Home lead's outward action is the user's Outbox card.
    if args.first().map(String::as_str) == Some("outbox") {
        return outbox::run(&home, &args[1..]);
    }
    // Ticket 990 slice i: the user's roles; a lead proposes one on a card.
    if args.first().map(String::as_str) == Some("role") {
        let usage = "usage: nunchiro role list | propose \"<name>\" --job \"<what it does>\" --why \"<what you counted>\" [--kind claude|codex] [--model M] [--reviews]";
        let mut request = Request::Role {
            operation: args.get(1).cloned().unwrap_or_default(),
            role: None,
            name: None,
            why: None,
        };
        match args.get(1).map(String::as_str) {
            Some("list") if args.len() == 2 => {}
            Some("propose") => {
                let name = args.get(2).ok_or(usage)?.clone();
                let (mut job, mut why, mut kind, mut model, mut writes) =
                    (String::new(), None, AgentKind::Claude, None, true);
                let mut words = args[3..].iter();
                while let Some(word) = words.next() {
                    let mut value = || words.next().cloned().ok_or(usage);
                    match word.as_str() {
                        "--job" => job = value()?,
                        "--why" => why = Some(value()?),
                        "--model" => model = Some(value()?),
                        "--reviews" => writes = false,
                        "--kind" => {
                            kind = match value()?.as_str() {
                                "claude" => AgentKind::Claude,
                                "codex" => AgentKind::Codex,
                                _ => return Err(usage.into()),
                            }
                        }
                        _ => return Err(usage.into()),
                    }
                }
                request = Request::Role {
                    operation: "propose".into(),
                    role: Some(nunchiro_core::roles::Role {
                        name,
                        job,
                        kind,
                        model,
                        effort: None,
                        writes,
                    }),
                    name: None,
                    why,
                };
            }
            _ => return Err(usage.into()),
        }
        let proposed = args.get(1).map(String::as_str) == Some("propose");
        ensure_core(&home)?;
        match call(&home, request)? {
            Reply::Roles { .. } if proposed => {
                println!(
                    "The user is asked on a card. End your turn; the answer arrives as a room message."
                )
            }
            Reply::Roles { roles } => {
                for r in roles {
                    let does = if r.writes {
                        "writes"
                    } else {
                        "reviews, never edits"
                    };
                    println!("{} ({does}): {}", r.name, r.job);
                }
            }
            reply => println!(
                "{}",
                serde_json::to_string(&reply).map_err(|e| e.to_string())?
            ),
        }
        return Ok(());
    }
    // Ticket 990 slice h: the notes this session reads (the owner's shell: every note).
    if args.first().map(String::as_str) == Some("note") {
        if args.get(1).map(String::as_str) != Some("list") || args.len() > 3 {
            return Err("usage: nunchiro note list [--json]".into());
        }
        ensure_core(&home)?;
        let reply = call(
            &home,
            Request::Note {
                operation: "list".into(),
                id: None,
                text: None,
                scope: None,
                task: None,
                lesson: None,
            },
        )?;
        match reply {
            Reply::Notes { notes } if args.get(2).map(String::as_str) != Some("--json") => {
                let plain: Vec<_> = notes.into_iter().map(|l| l.note).collect();
                match nunchiro_core::notes::quote(&plain) {
                    block if block.is_empty() => println!("No note yet."),
                    block => print!("{block}"),
                }
            }
            reply => println!(
                "{}",
                serde_json::to_string(&reply).map_err(|e| e.to_string())?
            ),
        }
        return Ok(());
    }
    // V2.5-35
    if args.first().map(String::as_str) == Some("board") {
        return board::run(&home, &args[1..]);
    }
    if args.first().map(String::as_str) == Some("agent") {
        return agent::run(&home, &args[1..]);
    }
    // Ticket 573: the MCP server runs this binary per tool call, so a core starts on the first call, not here.
    if args == ["mcp"] {
        return mcp::run();
    }
    if args.first().map(String::as_str) == Some("token") {
        return token::run(&home, &args[1..]);
    }
    if args.first().map(String::as_str) == Some("events") {
        return events::run(&home, &args[1..]); // ticket 573 slice 2
    }
    // v2-2a
    if args.first().map(String::as_str) == Some("account") {
        return account(&home, &args[1..]);
    }
    // v1a-23
    if args.first().map(String::as_str) == Some("permission-answers") {
        return permission_answers(&home, &args[1..]);
    }
    if args.first().map(String::as_str) == Some("layout") {
        return layout::run(&home, &args[1..]);
    }
    if args.first().map(String::as_str) == Some("worktree") {
        return worktree::run(&home, &args[1..]);
    }
    if args.get(0..2) == Some(&["session".into(), "open".into()]) {
        let mut translated = vec![
            "session".into(),
            "start".into(),
            "--kind".into(),
            "shell".into(),
        ];
        translated.extend_from_slice(&args[2..]);
        ensure_core(&home)?;
        let reply = call(&home, parse(&translated)?)?;
        println!(
            "{}",
            serde_json::to_string(&reply).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    // v1a-06: service lifecycle must act on the target core, not the local lifetime lock.
    if env::var_os("NUNCHIRO_MACHINE").is_some()
        && (args == ["serve"] || args == ["serve", "restart"])
    {
        ensure_core(&home)?;
        call(
            &home,
            Request::RemoteService {
                restart: args.len() == 2,
            },
        )?;
        return Ok(());
    }
    let user_home = env::var_os("HOME").map(PathBuf::from);
    refuse_rc_on_owner_home(BUILD, &home, user_home.as_deref(), &args)?;
    // Internal: what the launchd job of `start_in_login_session` runs. It is already in the login session, so the
    // core starts as its child.
    if args == ["serve", "start", "--here"] {
        // launchd names its job here; the core's sessions should see what a terminal's shell sees. Single-threaded.
        let job = env::var("XPC_SERVICE_NAME")
            .ok()
            .filter(|label| label.starts_with(LOGIN_JOB));
        unsafe { env::set_var("XPC_SERVICE_NAME", "0") };
        let started = ensure_core_via(&home, None, true);
        // The job removes itself: it never outlives a caller that went away (an SSH connection that dropped).
        if let Some(label) = job {
            // Safety: getuid has no preconditions.
            let job = format!("gui/{}/{label}", unsafe { libc::getuid() });
            launchctl(&["bootout".as_ref(), job.as_ref()]);
        }
        return started;
    }
    if args == ["serve", "restart"] {
        // v1a-23: inside a session, a helper finishes the restart once this process has exited and the helper has
        // left the session's process tree (reparented). V2-1b r3: it starts a session of its own (setsid) and asks as
        // the owner, since a session may not make the core exit. This relies on the V1A-18 escape (setsid while the
        // asker exits), which any process in a session can also use.
        if env::var_os("NUNCHIRO_TOKEN").is_some() && env::var_os(RESTARTER).is_none() {
            use std::os::unix::process::CommandExt;
            let mut cmd = Command::new(env::current_exe().map_err(|e| e.to_string())?);
            cmd.args(["serve", "restart"])
                .env(RESTARTER, std::process::id().to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            // Safety: setsid is async-signal-safe.
            unsafe { cmd.pre_exec(nunchiro_core::process::setsid) };
            cmd.spawn().map_err(|e| e.to_string())?;
            println!("restarting the core; agents keep running");
            return Ok(());
        }
        let mut start = None;
        if let Some(asker) = env::var(RESTARTER).ok().and_then(|p| p.parse::<u32>().ok()) {
            let until = Instant::now() + Duration::from_secs(5);
            while std::os::unix::process::parent_id() == asker && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
            // v1a-23 r2 (S3): the next core starts as the old one did, not with the asking session's environment.
            start = recorded_start(&home);
            // V2-1b r3: outside the session now, the helper asks as the owner (a session's token may not stop the
            // core). Single-threaded here.
            unsafe { env::remove_var("NUNCHIRO_TOKEN") };
        }
        return swap_core(&home, start.as_ref());
    }
    if args == ["serve", "update"] {
        return serve_update(&home);
    }
    if args == ["serve", "status"] || args == ["serve", "status", "--json"] {
        // Scripts read the JSON: a pipe gets it without --json too, as before the record's text existed.
        let json = args.len() == 3 || !std::io::IsTerminal::is_terminal(&std::io::stdout());
        return serve_status(&home, json);
    }
    if args.first().map(String::as_str) == Some("update") {
        return update::run(&home, &args[1..]);
    }
    let request = parse(&args)?;
    let stop = matches!(request, Request::Stop);
    if !stop {
        ensure_core(&home)?;
    } else if args.last().map(String::as_str) != Some("--yes")
        && std::io::IsTerminal::is_terminal(&std::io::stdin())
        && !confirm_stop(&home)
    {
        return Err("not stopped".into());
    }
    if let Request::SendText { id, .. } = &request {
        wait_started(&home, id)?;
    }
    let list = matches!(request, Request::List);
    let mut reply = call(&home, request)?;
    // Ticket 1016: `session list` reads a session's state as the tree does; `snapshot --json` and the List the
    // machine channel mirrors keep the stored one (a shell left after its agent ended still runs).
    if let (true, Reply::Snapshot { sessions, .. }) = (list, &mut reply) {
        sessions.iter_mut().for_each(|s| s.state = s.listed_state());
    }
    println!(
        "{}",
        serde_json::to_string(&reply).map_err(|e| e.to_string())?
    );
    Ok(())
}
/// Ticket 1025 (look v26-a-S3-6): Claude drops keys typed before its input box draws, so `session send-text` waits
/// while the session is `starting`, as the window's composer holds a first message. `starting` always ends (the box,
/// the first hook, or the core's quiet and silent limits); past the bound, or when the list cannot be read, it sends.
/// Lane w102 (look v34 c R5): a start question (folder trust, imports) keeps the session `starting`; text typed into it
/// was lost and its Enter answered the question. The text is held, as the composer holds it, until `send-keys` answers
/// the question; at the bound with the question still up it fails and types nothing. A question once the session was
/// ready (a permission prompt) is answered by the text at once, as before.
fn wait_started(home: &Path, id: &str) -> Result<(), String> {
    // NUNCHIRO_SEND_WAIT_MS: a test's shorter bound, as NUNCHIRO_SETTLE_MS shortens the settle time.
    let bound = std::env::var("NUNCHIRO_SEND_WAIT_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
        .map_or(Duration::from_secs(150), Duration::from_millis);
    let until = Instant::now() + bound;
    let mut seen_starting = false;
    loop {
        let Ok(Reply::Snapshot { sessions, .. }) = call(home, Request::List) else {
            return Ok(());
        };
        let Some(s) = sessions.iter().find(|s| s.id == id) else {
            return Ok(());
        };
        seen_starting |= s.starting;
        // The core's silent limit can end `starting` under a question still up: it is still the start's question.
        let start_question = seen_starting && s.attention.waiting;
        if !s.starting && !start_question {
            return Ok(());
        }
        if Instant::now() >= until {
            if start_question {
                return Err(format!(
                    "not sent: session {id} is showing a start question; answer it first with `nunchiro session send-keys {id} <key>`, then send the text"
                ));
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}
/// The owner app's home: any path with a `.nunchiro` folder in it (any case), or one inside `$HOME/.nunchiro`.
fn is_owner_home(home: &Path, user_home: Option<&Path>) -> bool {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let real = canon(home);
    // F24 r6: `~/.nunchiro` may be a link to a folder of another name, so look before and after resolving it.
    home.components()
        .chain(real.components())
        .any(|c| c.as_os_str().eq_ignore_ascii_case(".nunchiro"))
        || user_home.is_some_and(|h| real.starts_with(canon(&h.join(".nunchiro"))))
}
/// S7 (11-11): an RC CLI run from a plain shell defaults to `~/.nunchiro` and started an RC core there at 22:57.
/// It may still talk to a core that is running; it never starts one on the owner's home.
fn refuse_rc_core_start(
    build: Option<&str>,
    home: &Path,
    user_home: Option<&Path>,
) -> Result<(), String> {
    if build.is_none() || !is_owner_home(home, user_home) {
        return Ok(());
    }
    Err(format!(
        "not started: this is an RC build and {} is the owner's home, where it never starts a core. Run it from a Nunchiro terminal, or set NUNCHIRO_HOME to this RC's own home.",
        home.display()
    ))
}
/// F24 r5: an RC's CLI typed by hand defaults to the owner's home, and an RC core there would write its own store
/// version over the owner's sessions. Same test as the app's `home_for`.
fn refuse_rc_on_owner_home(
    build: Option<&str>,
    home: &Path,
    user_home: Option<&Path>,
    args: &[String],
) -> Result<(), String> {
    let swaps = matches!(args, [serve, what] if serve == "serve" && (what == "restart" || what == "update"));
    if build.is_none() || !swaps || !is_owner_home(home, user_home) {
        return Ok(());
    }
    Err(format!(
        "not run: this is an RC build and {} is the owner's home, so `serve {}` would replace the owner's core with this RC. Run it from a Nunchiro terminal, or set NUNCHIRO_HOME to this RC's own home.",
        home.display(),
        args[1]
    ))
}
// V2-1b: the core exits and leaves every agent running in its holder; the next core reattaches them.
fn swap_core(home: &Path, start: Option<&Start>) -> Result<(), String> {
    let old = core_generation(home);
    call(home, Request::Exit)?;
    start_after_exit(home, start, old.as_deref())
}
/// What identifies the running core: `core.token` is rewritten at every core start.
fn core_generation(home: &Path) -> Option<Vec<u8>> {
    std::fs::read(home.join("core.token")).ok()
}
/// Waits for the core that was just asked to exit (`old`, its generation read before asking), then starts the next one.
/// Ticket 379: a next core another process already started, and that answers, is that next core.
fn start_after_exit(home: &Path, start: Option<&Start>, old: Option<&[u8]>) -> Result<(), String> {
    // F24: past the core's own wind-down (5 s for open connections such as a blocked hook, up to 30 s for a removal).
    let until = Instant::now() + Duration::from_secs(40);
    let lock = std::fs::File::open(home.join("core.lock")).map_err(|e| e.to_string())?;
    loop {
        if Instant::now() >= until {
            return Err("core stop timed out".into());
        }
        if old.is_some()
            && core_generation(home).as_deref() != old
            && std::os::unix::net::UnixStream::connect(home.join("core.sock")).is_ok()
        {
            return Ok(());
        }
        if !home.join("core.sock").exists() {
            match lock.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(std::fs::TryLockError::Error(error)) => return Err(error.to_string()),
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    drop(lock);
    ensure_core_from(home, start)
}
/// F24: run by the app at each page load. Replaces a core older than this binary (one that recorded no build is older
/// by definition) and prints `current`, `replaced`, or `kept` when a live session could not survive the swap.
fn serve_update(home: &Path) -> Result<(), String> {
    let me = env::current_exe().map_err(|e| e.to_string())?;
    println!("{}", update_core(home, BUILD.or(RELEASE), &me)?);
    Ok(())
}
fn update_core(home: &Path, build: Option<&str>, me: &Path) -> Result<&'static str, String> {
    ensure_core(home)?;
    // Ticket 1024: read as every other reader of the record does (1 MiB at most, a regular file only). One that is
    // not read names no older core, so nothing is replaced.
    let record = home.join("core.start.json");
    let started = match nunchiro_core::start_secrets::read_record(&record) {
        Some(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", record.display()))?
        }
        None => serde_json::Value::Null,
    };
    Ok(if !core_is_older(build, COMMIT, &started, me) {
        "current"
    } else {
        let holder_floor = nunchiro_core::holder::frame::MIN_COMPATIBLE;
        let old = core_generation(home);
        match call(home, Request::ExitIfIdle { holder_floor }) {
            Ok(_) => {
                start_after_exit(home, None, old.as_deref())?;
                "replaced"
            }
            Err(e) if e == server::EXIT_BUSY => "kept",
            // Ticket 1110: a core already winding down (another `serve update`'s exit; the app runs one at each page
            // load) ran nothing. Wait for it to go and for the next core, as after an exit of our own.
            Err(e) if e == server::NOT_SERVED => {
                start_after_exit(home, None, old.as_deref())?;
                "replaced"
            }
            // shortcut: a core from before `exit_if_idle` can only be judged from what it left on disk, with a moment
            // between the read and the exit. It goes away with the first update past this build.
            Err(e) if e.contains("unknown variant") => {
                let store = read_json(&home.join("sessions.json"))?;
                if swap_blockers(&store) + running_records(home) > 0 {
                    "kept"
                } else {
                    swap_core(home, None)?;
                    "replaced"
                }
            }
            Err(e) => return Err(e),
        }
    })
}
/// The sign-ins and sandbox runs a core has recorded as running: only a core from before `exit_if_idle` needs this.
fn running_records(home: &Path) -> usize {
    [".signin-logins", ".sandbox-runs"]
        .iter()
        .filter_map(|dir| std::fs::read_dir(home.join(dir)).ok())
        .map(Iterator::count)
        .sum()
}
/// A missing file reads as `null`: a home with no sessions yet has no blockers.
fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Value::Null),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}
/// Whether the running core (its `core.start.json`) is an older build of this same install: a binary at path `me`
/// stamped `mine` (a higher stamp), or of another git commit `commit` (ticket 1082: a build swapped in place, stamped or
/// not). Two stamps that say this binary is the lower one are a downgrade and replace nothing. An update keeps the path;
/// any other core (the owner's, a cargo build) is never this binary's to replace.
fn core_is_older(
    mine: Option<&str>,
    commit: Option<&str>,
    started: &serde_json::Value,
    me: &Path,
) -> bool {
    let same_install = started["exe"]
        .as_str()
        .is_some_and(|exe| same_file(Path::new(exe), me));
    let core = started["build"].as_u64();
    match mine.and_then(|m| m.parse::<u64>().ok()) {
        Some(mine) if core.is_some_and(|c| c > mine) => false,
        Some(mine) if core.unwrap_or(0) < mine => same_install,
        _ => same_install && commit.is_some_and(|c| started["commit"].as_str() != Some(c)),
    }
}
/// Links resolved; a path that cannot be resolved is the same as nothing.
fn same_file(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}
/// Work a core swap would lose, as `sessions.json` shows it (a core from before `exit_if_idle`): an ACP agent is a child
/// of the core and ends with it, a queued send is cancelled, and a holder below this binary's protocol floor could not
/// be reattached.
fn swap_blockers(store: &serde_json::Value) -> usize {
    let chats = store["sessions"].as_array().map_or(0, |rows| {
        rows.iter()
            .filter(|s| {
                (s["kind"] == "acp" && s["state"] == "running")
                    || s["send_queue"].as_array().is_some_and(|q| !q.is_empty())
            })
            .count()
    });
    let floor = u64::from(nunchiro_core::holder::frame::MIN_COMPATIBLE);
    let holders = store["live"].as_object().map_or(0, |live| {
        live.values()
            .filter(|l| l["holder"]["protocol"].as_u64().is_some_and(|p| p < floor))
            .count()
    });
    chats + holders
}
// V2-1b: whether a core runs, and every holder listening in this data folder with the session that records it; a
// holder no running core serves (or that no record names) is orphaned. Reads, never starts a core.
fn serve_status(home: &Path, json: bool) -> Result<(), String> {
    let core = std::os::unix::net::UnixStream::connect(home.join("core.sock")).is_ok();
    // The raw file: loading it as the core does could set it aside.
    let store: serde_json::Value = std::fs::read(home.join("sessions.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let recorded = |socket: &Path| {
        store["live"].as_object().and_then(|live| {
            live.iter()
                .find(|(_, l)| l["holder"]["socket"].as_str() == socket.to_str())
                .map(|(id, _)| id.clone())
        })
    };
    let holders: Vec<serde_json::Value> = nunchiro_core::holder::sockets(home)
        .into_iter()
        .filter(|socket| std::os::unix::net::UnixStream::connect(socket).is_ok())
        .map(|socket| {
            let session = recorded(&socket);
            serde_json::json!({
                "socket": socket,
                "orphaned": !core || session.is_none(),
                "session": session,
            })
        })
        .collect();
    let record = nunchiro_core::record::read(home);
    // The low-memory kills macOS reported over the last 7 days (null when its reports cannot be listed).
    let kills = nunchiro_core::pressure::kills(7);
    if json {
        println!(
            "{}",
            serde_json::json!({"core": core, "holders": holders, "record": record, "low_memory_kills_7d": kills})
        );
        return Ok(());
    }
    let orphaned = holders.iter().filter(|h| h["orphaned"] == true).count();
    println!(
        "core: {}\nholders: {} ({orphaned} orphaned)",
        if core { "running" } else { "not running" },
        holders.len()
    );
    match kills {
        Some(n) => println!("low-memory kills, last 7 days: {n}"),
        None => println!("low-memory kills, last 7 days: unknown (macOS reports not readable)"),
    }
    print!("{}", record_text(&record));
    Ok(())
}
/// The delivery record as `serve status` prints it on a terminal: per day, then per core restart.
fn record_text(record: &nunchiro_core::record::Record) -> String {
    let days = nunchiro_core::record::DAYS;
    let mut text = format!("\nPrompts, last {days} days (no message text is kept)\n");
    if record.days.is_empty() {
        text += "  none recorded\n";
    } else {
        text += "  day         delivered  sent again by the core  needed a person\n";
    }
    for (day, d) in &record.days {
        text += &format!(
            "  {day}  {:>9}  {:>22}  {:>15}\n",
            d.delivered, d.resent, d.person
        );
    }
    text += &format!("\nCore restarts, last {days} days (sessions running before -> came back)\n");
    if record.restarts.is_empty() {
        text += "  none recorded\n";
    }
    for r in &record.restarts {
        text += &format!(
            "  {}  {} -> {}\n",
            nunchiro_core::record::when(r.at_ms),
            r.before,
            r.after
        );
    }
    text
}
// v1a-09: from a terminal, ask once, listing what the full quit ends. Scripts (no tty) and `--yes` skip it.
fn confirm_stop(home: &Path) -> bool {
    let Ok(Reply::Snapshot { sessions, .. }) = call_once(home, Request::Snapshot) else {
        return true; // no core to describe; Stop reports its own error
    };
    let running: Vec<_> = sessions
        .iter()
        .filter(|s| s.state == SessionState::Running)
        .collect();
    let pending: usize = sessions.iter().map(|s| s.pending.len()).sum();
    println!("This ends {} running agent(s) and the core:", running.len());
    for s in &running {
        println!("  {:?} {} (pid {})", s.kind, s.label, s.pid.unwrap_or(0));
    }
    println!(
        "{pending} pending queue item(s) will be dropped (sessions are offered for resume next time)."
    );
    print!("Quit and stop all agents? [y/N] ");
    let _ = std::io::Write::flush(&mut std::io::stdout());
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).is_ok() && line.trim().eq_ignore_ascii_case("y")
}
/// Every CLI request to the core goes through here or `call_once` (ticket 305). A core winding down for an exit or a
/// signal did not run the request (v1a-66, NOT_SERVED): once its socket closes (bounded at 10 s), the next core gets
/// it. An owner's full stop sticks (NOT_SERVED_QUIT is not retried), and Stop and Exit are never rerun.
pub(crate) fn call(home: &Path, request: Request) -> Response {
    let retry = (!matches!(
        request,
        Request::Stop | Request::Exit | Request::ExitIfIdle { .. }
    ))
    .then(|| request.clone());
    match (server::call(home, request), retry) {
        (Err(e), Some(request)) if e == server::NOT_SERVED => {
            // A remote core's refusal: the local socket stays open, so retry at once.
            let until = Instant::now() + Duration::from_secs(10);
            while env::var_os("NUNCHIRO_MACHINE").is_none()
                && std::os::unix::net::UnixStream::connect(home.join("core.sock")).is_ok()
                && Instant::now() < until
            {
                thread::sleep(Duration::from_millis(20));
            }
            ensure_core(home)?;
            server::call(home, request)
        }
        (reply, _) => reply,
    }
}
/// One attempt, never a wait or a core start: the stop confirmation (it must not start a core) and the SSH relay
/// (its caller gives up after 6 s and retries, so a relay still waiting would run the request twice).
pub(crate) fn call_once(home: &Path, request: Request) -> Response {
    server::call(home, request)
}
fn ensure_core(home: &Path) -> Result<(), String> {
    // V2-2b: from inside a session (an agent on an account carries that account's folder and none of the owner's
    // keys), a new core starts as the old one did. Ticket 457 r2: a running core first, so a session's call reads no
    // keychain (`recorded_start` runs `security`; a locked keychain could wait 5 s on a dialog).
    if std::os::unix::net::UnixStream::connect(home.join("core.sock")).is_ok() {
        return Ok(());
    }
    let recorded = env::var_os("NUNCHIRO_TOKEN").and_then(|_| recorded_start(home));
    ensure_core_from(home, recorded.as_ref())
}
// v1a-23 r2 (S3): what the old core recorded at start (`core.start.json`): its executable and environment.
struct Start {
    exe: PathBuf,
    env: Vec<(String, String)>,
}
/// The dynamic loader's variables (macOS `DYLD_*`, the ELF loader's `LD_*`): never passed to a core, whether from
/// this CLI's environment or from `core.start.json`, which a same-user process can edit (ticket 1009 round 3: the
/// record would otherwise load a library into the core that gets the keychain's values).
fn loader_var(name: &str) -> bool {
    name.starts_with("DYLD_") || name.starts_with("LD_")
}
fn recorded_start(home: &Path) -> Option<Start> {
    let v: serde_json::Value = serde_json::from_slice(&nunchiro_core::start_secrets::read_record(
        &home.join("core.start.json"),
    )?)
    .ok()?;
    let mut start = Start {
        exe: PathBuf::from(v["exe"].as_str()?),
        env: v["env"]
            .as_object()?
            .iter()
            .map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
            .collect::<Option<_>>()?,
    };
    // Ticket 457: the record names the secret variables; their values come from the keychain the old core wrote, as
    // its environment names it. A value the keychain does not give back is left out (the ticket 32 fallback).
    let names: Vec<&str> = v["secrets"]
        .as_array()
        .map(|a| a.iter().filter_map(|n| n.as_str()).collect())
        .unwrap_or_default();
    let recorded = |k: &str| {
        start
            .env
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.clone())
    };
    // Ticket 1009 round 2 (Fable S2): the values go only to this executable. `exe` is read from a file a same-user
    // process can edit, and the keychain trusts this program, so another `exe` would be handed the secrets.
    let own = |p: &Path| std::fs::canonicalize(p).ok();
    let me = env::current_exe().ok().and_then(|me| own(&me));
    let same = own(&start.exe).is_some_and(|e| me.as_ref() == Some(&e));
    // Round 4 (Fable S3): the checked path is the one started, so a link in the record switched after the check
    // cannot point the start elsewhere.
    if same && let Some(me) = me {
        start.exe = me;
    }
    if let Some(mut values) = (same && !names.is_empty())
        .then(|| nunchiro_core::start_secrets::keychain(recorded))
        .flatten()
        .and_then(|keychain| nunchiro_core::start_secrets::load(&keychain, home))
        // Round 9 (Codex MUST): an item from another generation (a failed update) is never applied.
        .filter(|values| {
            v["secrets_gen"].as_str().is_some()
                && values
                    .get(nunchiro_core::start_secrets::GEN)
                    .map(String::as_str)
                    == v["secrets_gen"].as_str()
        })
    {
        start.env.extend(
            names
                .iter()
                .filter_map(|n| Some((n.to_string(), values.remove(*n)?))),
        );
    }
    // Ticket 1009 round 6 (Codex MUST): a named secret this start could not restore tells the next core so; it then
    // keeps the item and the names for a later start that can read them, instead of replacing them with none.
    if names.iter().any(|n| !start.env.iter().any(|(k, _)| k == n)) {
        start.env.push((
            nunchiro_core::start_secrets::UNREAD.to_string(),
            "1".to_string(),
        ));
    }
    // v1a-30: a missing executable (an upgrade rebuilt or moved it) is swapped for this binary; the recorded
    // environment stays.
    if !start.exe.is_file() {
        start.exe = env::current_exe().ok()?;
    }
    Some(start)
}
/// True when the core answered while waiting. A free lock, or a lock *error* (`flock` unsupported on this
/// filesystem), ends the wait: the caller spawns a core, whose own `serve` reports its lock result.
fn wait_out_lock(
    mut try_lock: impl FnMut() -> Result<(), std::fs::TryLockError>,
    mut connected: impl FnMut() -> bool,
    limit: Duration,
) -> bool {
    let until = Instant::now() + limit;
    while Instant::now() < until {
        if connected() {
            return true;
        }
        match try_lock() {
            Err(std::fs::TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(20)),
            _ => break,
        }
    }
    false
}
/// How a missing core is started. macOS ties the login keychain to the security session a process was born in: a core
/// started as the child of an SSH login, and every agent it starts, cannot read it (`claude` says "Not logged in",
/// `gh` that its token is invalid). So from an SSH login the core is started by the user's login (GUI) session.
#[derive(Clone, Copy, Debug, PartialEq)]
enum CoreStart {
    Direct,
    LoginSession,
}
/// `matters`: `machines::login_session_matters`. `recorded`: a start from `core.start.json` (a restart asked from
/// inside a session) keeps the old core's environment and place, as before.
fn core_start(matters: bool, ssh_login: bool, recorded: bool) -> CoreStart {
    if matters && ssh_login && !recorded {
        CoreStart::LoginSession
    } else {
        CoreStart::Direct
    }
}
/// The one-shot launchd job that starts the core: `nunchiro serve start --here` with the home, run once at load.
/// It holds no secret, and no `KeepAlive`: the job ends as soon as the core answers.
fn login_job(label: &str, exe: &str, home: &str) -> String {
    let xml = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{}</string>\n<key>ProgramArguments</key><array><string>{}</string><string>serve</string><string>start</string><string>--here</string></array>\n<key>EnvironmentVariables</key><dict><key>NUNCHIRO_HOME</key><string>{}</string></dict>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n",
        xml(label),
        xml(exe),
        xml(home)
    )
}
/// Starts the core from the user's login session: a job loaded into launchd's `gui/<uid>` domain (the way an app's
/// helper starts; herdr and Orca start their local servers so) runs this program there, and that run starts the core
/// as any terminal's would. The job and its file are removed again before this returns: nothing stays loaded, and the
/// core stops as every core does (`serve stop`). `Ok(false)`: no login session took the job (nobody is logged in at
/// this Mac's screen), so the caller starts the core itself.
const LOGIN_JOB: &str = "dev.nunchiro.core-start.";
/// Runs `launchctl`; true when it succeeded. `NUNCHIRO_LAUNCHCTL` names the program for fixtures, as `NUNCHIRO_SSH`
/// does for ssh.
fn launchctl(args: &[&std::ffi::OsStr]) -> bool {
    Command::new(env::var_os("NUNCHIRO_LAUNCHCTL").unwrap_or_else(|| "/bin/launchctl".into()))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
fn start_in_login_session(home: &Path) -> Result<bool, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let exe = env::current_exe().map_err(|e| e.to_string())?;
    let home = home.canonicalize().map_err(|e| e.to_string())?;
    let (Some(exe), Some(home_text)) = (exe.to_str(), home.to_str()) else {
        return Ok(false);
    };
    // Safety: getuid has no preconditions.
    let domain = format!("gui/{}", unsafe { libc::getuid() });
    let label = format!("{LOGIN_JOB}{}", std::process::id());
    // In the temp folder: launchd refuses a job file on an external volume, where a home may be.
    let file = env::temp_dir().join(format!("{label}.plist"));
    let _ = std::fs::remove_file(&file);
    let loaded = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(login_job(&label, exe, home_text).as_bytes())
        })
        .is_ok()
        && launchctl(&["bootstrap".as_ref(), domain.as_ref(), file.as_os_str()]);
    let _ = std::fs::remove_file(&file);
    if !loaded {
        return Ok(false);
    }
    // The job's own run waits 5 s for the core, after launchd started it.
    let until = Instant::now() + Duration::from_secs(10);
    let sock = home.join("core.sock");
    let mut up = false;
    while !up && Instant::now() < until {
        up = std::os::unix::net::UnixStream::connect(&sock).is_ok();
        if !up {
            thread::sleep(Duration::from_millis(20));
        }
    }
    // The core left the job as it started (its own session, `spawn_detached`), so removing the job stops nothing. The
    // job's own run removes it too (`serve start --here`); this covers a run that hangs.
    launchctl(&["bootout".as_ref(), format!("{domain}/{label}").as_ref()]);
    if up {
        Ok(true)
    } else {
        Err("core startup timed out in the login session; see logs/core.log".into())
    }
}
fn ensure_core_from(home: &Path, start: Option<&Start>) -> Result<(), String> {
    ensure_core_via(home, start, false)
}
/// `here`: this run is the login session's own (`serve start --here`), so the core starts as its child.
fn ensure_core_via(home: &Path, start: Option<&Start>, here: bool) -> Result<(), String> {
    if std::os::unix::net::UnixStream::connect(home.join("core.sock")).is_ok() {
        return Ok(());
    }
    // v1a-66: a stopping core removes core.sock before it exits and frees core.lock; wait out that gap (bounded,
    // like `serve restart`) instead of starting a core that fails with "core already running".
    if let Ok(lock) = std::fs::File::open(home.join("core.lock")) {
        let sock = home.join("core.sock");
        let connected = || std::os::unix::net::UnixStream::connect(&sock).is_ok();
        if wait_out_lock(|| lock.try_lock(), connected, Duration::from_secs(5)) {
            return Ok(());
        }
    }
    let user_home = env::var_os("HOME").map(PathBuf::from);
    refuse_rc_core_start(BUILD, home, user_home.as_deref())?;
    std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    // Chosen once the home exists (a test home is told by its place). With no login session the core starts here as
    // before; it then tells the machine that drives it (`machine relay --stream`), so that side can say why this
    // Mac's agents may not be signed in.
    let via = core_start(
        nunchiro_core::machines::login_session_matters(home),
        nunchiro_core::machines::ssh_login(),
        start.is_some(),
    );
    if !here && via == CoreStart::LoginSession && start_in_login_session(home)? {
        return Ok(());
    }
    let mut cmd = match start {
        Some(start) => {
            let mut cmd = Command::new(&start.exe);
            cmd.env_clear()
                .envs(
                    start
                        .env
                        .iter()
                        .filter(|(k, _)| !loader_var(k))
                        .map(|(k, v)| (k, v)),
                )
                .env("NUNCHIRO_HOME", home);
            // Ticket 1009 round 5 (Codex MUST): the core runs `SHELL` as its login probe; a recorded one could name
            // any program, so a start from the record uses the account's own login shell.
            if let Some(shell) = nunchiro_core::start_secrets::account_shell() {
                cmd.env("SHELL", shell);
            }
            cmd
        }
        None => Command::new(env::current_exe().map_err(|e| e.to_string())?),
    };
    // v1a-23 r2: a core never gets the dynamic loader's variables.
    for (key, _) in env::vars_os() {
        if loader_var(&key.to_string_lossy()) {
            cmd.env_remove(key);
        }
    }
    // V2-2b: an account's folder is never a core's "Your own".
    let accounts = [
        home.join("accounts"),
        home.canonicalize()
            .map_err(|e| e.to_string())?
            .join("accounts"),
    ];
    for key in nunchiro_core::accounts::CONFIG_ENV {
        let value = match start {
            Some(start) => start
                .env
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| PathBuf::from(v)),
            None => env::var_os(key).map(PathBuf::from),
        };
        if value.is_some_and(|v| accounts.iter().any(|a| v.starts_with(a))) {
            cmd.env_remove(key);
        }
    }
    cmd.env_remove("NUNCHIRO_MACHINE")
        // v1a-23: a core started from inside a session (a restart) is not that session.
        .env_remove("NUNCHIRO_TOKEN")
        .env_remove("NUNCHIRO_SESSION")
        .env_remove(RESTARTER)
        .arg("serve") // v1a-06
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // v2-13a: the core writes its own redacted, rotated logs/core.log; a pre-v2 core.log is left alone. Its
        // stderr is ours only while it starts, so a core that cannot open its logs still says why.
        .stderr(Stdio::piped());
    // Detach the core from the invoking terminal without a second daemon binary. Ticket 1154: and from the caller.
    let (core, startup) = spawn_detached(&mut cmd)?;
    let until = Instant::now() + Duration::from_secs(5);
    while Instant::now() < until {
        if std::os::unix::net::UnixStream::connect(home.join("core.sock")).is_ok() {
            // Closed now (as `startup` goes): the core's later mirror writes fail (EPIPE) instead of filling a pipe
            // nobody reads.
            return Ok(());
        }
        if core.gone() {
            let mut reason = vec![];
            if let Some(err) = startup {
                use std::io::Read;
                let _ = err.take(4096).read_to_end(&mut reason);
            }
            // A core that refused before opening its logs (a too-long socket path) leaves no core.log to see.
            let hint = if home.join("logs/core.log").exists() {
                "; see logs/core.log"
            } else {
                ""
            };
            return Err(format!(
                "core startup failed: {}{hint}",
                nunchiro_core::logs::excerpt(String::from_utf8_lossy(&reason).trim())
            ));
        }
        thread::sleep(Duration::from_millis(20));
    }
    core.kill();
    Err("core startup timed out".into())
}
/// Ticket 1154: a process started by `spawn_detached`, known to this one by the process group its middle process led
/// (it is not this process's child). Round 2 (Codex P2): the middle process stays unreaped while this lives. Its pid
/// is the group's id, and a zombie keeps that number from going to another process, so the group asked or stopped
/// here is never someone else's. Dropping this reaps it, on every way out.
struct Detached(std::process::Child);
impl Detached {
    fn group(&self) -> libc::pid_t {
        -(self.0.id() as libc::pid_t)
    }
    /// No live process is left in the group. The unreaped middle process keeps the group itself, so the answer is
    /// then EPERM (nothing there to signal), not ESRCH: any refusal means gone, since the program runs as this user.
    fn gone(&self) -> bool {
        // Safety: kill has no memory effects; a negative pid names a group.
        unsafe { libc::kill(self.group(), 0) != 0 }
    }
    fn kill(&self) {
        // Safety: as in `gone`.
        unsafe { libc::kill(self.group(), libc::SIGKILL) };
    }
}
impl Drop for Detached {
    fn drop(&mut self) {
        let _ = self.0.wait();
    }
}
/// Ticket 1154: starts `cmd` outside the caller's session and process tree; returns it with its stderr when piped. A
/// session's CLI call may be the one that starts the next core (in the gap of an update's or a restart's core swap),
/// and every holder refuses a peer inside a session: by its session id, or as a child of a process inside one. Such
/// a core got no session back for as long as it ran. So the program starts in a session of its own and is forked
/// once more by a middle process that exits at once: launchd's child from its first moment.
fn spawn_detached(
    cmd: &mut Command,
) -> Result<(Detached, Option<std::process::ChildStderr>), String> {
    use std::os::unix::process::CommandExt;
    // Safety: setsid, fork and _exit are async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            nunchiro_core::process::setsid()?;
            match libc::fork() {
                -1 => Err(std::io::Error::last_os_error()),
                0 => Ok(()),
                _ => libc::_exit(0),
            }
        })
    };
    // `spawn` returns once the program itself runs (or with the reason it could not).
    let mut middle = cmd.spawn().map_err(|e| e.to_string())?;
    let startup = middle.stderr.take();
    Ok((Detached(middle), startup))
}
// v1a-23: `nunchiro permission-answers on|off [--project DIR]`; from inside a session `on` waits for the owner.
fn permission_answers(home: &Path, args: &[String]) -> Result<(), String> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let (on, project) = match words.as_slice() {
        [state] => (*state, None),
        [state, "--project", dir] => (*state, Some(PathBuf::from(dir))),
        _ => return Err("usage: nunchiro permission-answers on|off [--project DIR]".into()),
    };
    let on = match on {
        "on" => true,
        "off" => false,
        _ => return Err("usage: nunchiro permission-answers on|off [--project DIR]".into()),
    };
    let project = match project {
        Some(p) => p,
        None => env::current_dir().map_err(|e| e.to_string())?,
    };
    ensure_core(home)?;
    match call(home, Request::PermissionAnswers { project, on })? {
        Reply::Waiting { .. } => println!("{WAITING}"),
        Reply::PermissionAnswers { project, on } => println!(
            "verified yes {} for {}",
            if on { "on" } else { "off" },
            project.display()
        ),
        _ => return Err("unexpected reply".into()),
    }
    Ok(())
}
// v2-2a: the registry with each row's signed-in state, "Your own" first; tab-separated (a label holds no control
// characters) or the reply's JSON.
fn account(home: &Path, args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("codex-reset") {
        return codex_reset(home, &args[1..]);
    }
    if args.first().map(String::as_str) == Some("leads-any") {
        return leads_any(home, &args[1..]);
    }
    let json = match args {
        [list] if list == "list" => false,
        [list, flag] if list == "list" && flag == "--json" => true,
        _ => return Err("usage: nunchiro account list [--json]".into()),
    };
    ensure_core(home)?;
    let Reply::Accounts { accounts } = call(home, Request::AccountList)? else {
        return Err("unexpected reply".into());
    };
    if json {
        println!("{}", serde_json::json!({ "accounts": accounts }));
        return Ok(());
    }
    println!("agent\tid\tlabel\tfolder\tsigned_in");
    for a in accounts {
        let signed_in = match a.signed_in {
            SignedIn::Yes => "yes",
            SignedIn::No => "no",
            SignedIn::Unknown => "unknown",
        };
        let (agent, folder) = (agent_name(a.agent), a.folder.display());
        println!("{agent}\t{}\t{}\t{folder}\t{signed_in}", a.id, a.label);
    }
    Ok(())
}
/// Owner 2026-11-25: `nunchiro account leads-any on|off`, "Leads may use any of my accounts". The owner's write; from
/// inside a session `on` waits for the owner's card and `off` is refused (the core's owner-only settings write).
fn leads_any(home: &Path, args: &[String]) -> Result<(), String> {
    let on = match args {
        [w] if w == "on" => true,
        [w] if w == "off" => false,
        _ => return Err("usage: nunchiro account leads-any on|off".into()),
    };
    ensure_core(home)?;
    let value = if on {
        serde_json::Value::Bool(true)
    } else {
        serde_json::Value::Null
    };
    let patch = LifetimePatch {
        features: Some([(nunchiro_core::accounts::LEADS_ANY.to_string(), value)].into()),
        ..Default::default()
    };
    match call(home, Request::QuitSettings { patch })? {
        Reply::Waiting { .. } => println!("{WAITING}"),
        Reply::QuitSettings { .. } => println!(
            "leads may use any of your accounts: {}",
            if on { "on" } else { "off" }
        ),
        _ => return Err("unexpected reply".into()),
    }
    Ok(())
}
/// Needs 225: inside a session, the agent's ask to use one Codex reset ticket (the owner's policy decides: refused,
/// a card in the Decisions widget, or used); outside one, the owner's own use, confirmed by `--yes`.
fn codex_reset(home: &Path, args: &[String]) -> Result<(), String> {
    const USAGE: &str =
        "usage: nunchiro account codex-reset [--reason TEXT] [--account ID] [--yes]";
    let (mut reason, mut account, mut yes) = (String::new(), None, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--reason" => reason = it.next().ok_or(USAGE)?.clone(),
            "--account" => account = Some(it.next().ok_or(USAGE)?.clone()),
            "--yes" => yes = true,
            _ => return Err(USAGE.into()),
        }
    }
    let agent = env::var_os("NUNCHIRO_TOKEN").is_some();
    if !agent && !yes {
        return Err(format!(
            "this uses one Codex reset ticket of {}; run again with --yes to use it",
            account.as_deref().unwrap_or("your own account")
        ));
    }
    ensure_core(home)?;
    match call(home, Request::CodexResetUse { account, reason })? {
        Reply::Waiting { .. } => println!("{WAITING}"),
        Reply::CodexResetUsed { outcome, .. } => println!("codex reset: {outcome}"),
        _ => return Err("unexpected reply".into()),
    }
    Ok(())
}
fn parse(args: &[String]) -> Result<Request, String> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["serve", "stop"] | ["serve", "stop", "--yes"] => Ok(Request::Stop),
        ["snapshot", "--json"] => Ok(Request::Snapshot),
        ["session", "list"] => Ok(Request::List),
        ["session", "read", id] => Ok(Request::Read {
            id: (*id).into(),
            after: 0,
        }),
        ["session", "read", id, "--after", after] => Ok(Request::Read {
            id: (*id).into(),
            after: after.parse().map_err(|_| "invalid byte cursor")?,
        }),
        ["session", "send-text", id, text] => Ok(Request::SendText {
            id: (*id).into(),
            text: (*text).into(),
            composer: false,
            seen: vec![],
        }),
        ["session", "send-keys", id, keys @ ..] if !keys.is_empty() => Ok(Request::SendKeys {
            id: (*id).into(),
            keys: keys.iter().map(|s| (*s).into()).collect(),
            seen: vec![],
            composer: false,
        }),
        ["session", "close", id, "--why", why] => Ok(Request::SessionTidy {
            id: (*id).into(),
            why: (*why).into(),
        }),
        ["session", "close", id] => Ok(Request::Close { id: (*id).into() }),
        ["session", "label", id, label] => Ok(Request::Label {
            id: (*id).into(),
            label: (*label).into(),
        }),
        ["session", "resize", id, cols, rows] => Ok(Request::Resize {
            id: (*id).into(),
            cols: cols.parse().map_err(|_| "invalid columns")?,
            rows: rows.parse().map_err(|_| "invalid rows")?,
        }),
        ["session", "start", tail @ ..] => {
            let mut session = StartSession {
                account: None,
                kind: AgentKind::Shell,
                project: env::current_dir().map_err(|e| e.to_string())?,
                worktree: false,
                label: String::new(),
                args: vec![],
                model: None,
                effort: None,
                resume: None,
            };
            let mut acp = None; // V2-4a
            let mut env = std::collections::BTreeMap::new(); // ticket 573; the core checks the names
            let mut receipt = None; // ticket 573 slice 2
            let mut anyway = false; // the owner's start past a memory-pressure hold
            let mut i = 0;
            while i < tail.len() {
                match tail[i] {
                    "--" => {
                        session.args = tail[i + 1..].iter().map(|s| (*s).into()).collect();
                        break;
                    }
                    "--worktree" => session.worktree = true,
                    "--anyway" => anyway = true,
                    option => {
                        i += 1;
                        let value = *tail
                            .get(i)
                            .ok_or_else(|| format!("missing value for {option}"))?;
                        match option {
                            "--kind" => {
                                session.kind = match value {
                                    "claude" => AgentKind::Claude,
                                    "codex" => AgentKind::Codex,
                                    "shell" => AgentKind::Shell,
                                    _ => return Err("invalid agent kind".into()),
                                }
                            }
                            "--project" => session.project = PathBuf::from(value),
                            "--label" => session.label = value.into(),
                            "--model" => session.model = Some(value.into()),
                            "--effort" => session.effort = Some(value.into()),
                            "--resume" => session.resume = Some(value.into()),
                            "--account" => session.account = Some(value.into()), // v2-2b
                            "--receipt" => {
                                server::check_receipt(value)?;
                                receipt = Some(value.into())
                            }
                            // Ticket 573 (cmux's `--env`): KEY=VALUE, repeatable, split at the first `=`.
                            "--env" => {
                                let (key, value) = value
                                    .split_once('=')
                                    .filter(|(key, _)| !key.is_empty())
                                    .ok_or("--env takes KEY=VALUE")?;
                                if env.insert(key.to_string(), value.to_string()).is_some() {
                                    return Err(format!("--env {key} given twice"));
                                }
                            }
                            // V2-4a: an approved `agents.toml` entry; it runs as approved, so no `-- ARGS`.
                            "--agent" => {
                                acp = Some(
                                    value
                                        .strip_prefix("acp:")
                                        .filter(|name| !name.is_empty())
                                        .ok_or("--agent takes acp:<name>")?
                                        .to_string(),
                                )
                            }
                            _ => return Err(format!("unknown option: {option}")),
                        }
                    }
                }
                i += 1;
            }
            if let Some(name) = acp {
                if !session.args.is_empty() {
                    return Err("an ACP agent runs with its approved args only".into());
                }
                session.kind = AgentKind::Acp;
                session.args = vec![name];
            }
            let start = Request::Start {
                session,
                folder: None,
                env,
                receipt,
            };
            Ok(match anyway {
                true => Request::StartAnyway {
                    start: Box::new(start),
                },
                false => start,
            })
        }
        _ => Err("unknown command; use --help".into()),
    }
}

#[cfg(test)]
mod tests {
    // Only a start from an SSH login where the session matters (macOS, no test home) goes through the login session; a
    // restart from the old core's record keeps its place.
    #[test]
    fn a_core_for_an_ssh_login_starts_in_the_login_session() {
        use super::{CoreStart::*, core_start};
        assert_eq!(core_start(true, true, false), LoginSession);
        assert_eq!(core_start(true, false, false), Direct);
        assert_eq!(core_start(false, true, false), Direct);
        assert_eq!(core_start(true, true, true), Direct);
    }
    // The job runs this program's internal start once, with the home; paths are written as XML text.
    #[test]
    fn the_login_job_runs_the_start_once_with_the_home() {
        let job = super::login_job(
            "dev.nunchiro.core-start.7",
            "/opt/a&b/nunchiro",
            "/Users/me/<home>",
        );
        assert!(
            job.contains("<key>Label</key><string>dev.nunchiro.core-start.7</string>"),
            "{job}"
        );
        assert!(
            job.contains("<array><string>/opt/a&amp;b/nunchiro</string><string>serve</string><string>start</string><string>--here</string></array>"),
            "{job}"
        );
        assert!(
            job.contains("<key>NUNCHIRO_HOME</key><string>/Users/me/&lt;home&gt;</string>"),
            "{job}"
        );
        assert!(
            job.contains("<key>RunAtLoad</key><true/>") && !job.contains("KeepAlive"),
            "{job}"
        );
    }
    // Ticket 1154 round 2 (Codex P2): the group a detached start is asked and stopped by stays this start's own. The
    // middle process is kept as a zombie (its pid, the group's id, cannot go to another process) while the program
    // is not this process's child; it reads as gone only once the program ended, and is reaped when the handle goes.
    #[test]
    fn a_detached_start_holds_its_group_id_until_it_is_dropped() {
        // An exited child that is not reaped yet (WNOWAIT leaves it so); false once reaped (ECHILD).
        let unreaped = |pid: u32| {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let flags = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
            // Safety: info is a valid, zeroed siginfo_t that waitid fills.
            let answer = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, flags) };
            answer == 0 && info.si_pid == pid as libc::pid_t
        };
        let wait = |what: &str, ok: &dyn Fn() -> bool| {
            let until = Instant::now() + Duration::from_secs(10);
            while !ok() {
                assert!(Instant::now() < until, "timed out: {what}");
                thread::sleep(Duration::from_millis(10));
            }
        };
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("30").stderr(Stdio::piped());
        let (sleep, startup) = spawn_detached(&mut cmd).unwrap();
        assert!(startup.is_some());
        let middle = sleep.0.id();
        wait("the middle process exits", &|| unreaped(middle));
        // The program runs in the middle's group, as launchd's child: `pgrep -g` lists it, `ps` names its parent.
        let members = || {
            let out = Command::new("/usr/bin/pgrep")
                .args(["-g", &middle.to_string()])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let program = members();
        assert!(!program.is_empty() && !program.contains('\n'), "{program}");
        let parent = Command::new("/bin/ps")
            .args(["-o", "ppid=", "-p", &program])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&parent.stdout).trim(), "1");
        assert!(!sleep.gone());
        sleep.kill();
        wait("the program is gone", &|| sleep.gone());
        // Still held: the id is not free for another group while the handle lives.
        assert!(unreaped(middle));
        drop(sleep);
        assert!(!unreaped(middle), "the middle process is reaped");
    }
    #[test]
    fn the_default_home_is_the_user_one_for_release_and_beside_the_binary_for_debug() {
        let exe = Path::new("/w/target/debug/nunchiro");
        let user = Some(std::ffi::OsString::from("/Users/u"));
        assert_eq!(
            default_home(false, exe, user.clone()).unwrap(),
            Path::new("/Users/u/.nunchiro")
        );
        assert_eq!(
            default_home(true, exe, user).unwrap(),
            Path::new("/w/target/debug/nunchiro-home")
        );
        assert!(default_home(false, exe, None).is_err());
    }

    #[test]
    fn recorded_link_to_this_binary_starts_this_binary() {
        let home = std::env::temp_dir().join(format!("nunchiro-w36-link-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let me = std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
        let link = home.join("exe-link");
        std::os::unix::fs::symlink(&me, &link).unwrap();
        let record = serde_json::json!({"exe": link, "env": {}, "secrets": []});
        std::fs::write(home.join("core.start.json"), record.to_string()).unwrap();
        let start = super::recorded_start(&home).unwrap();
        assert_eq!(start.exe, me);
        let _ = std::fs::remove_dir_all(&home);
    }
    #[test]
    fn loader_vars_never_reach_a_core() {
        for name in [
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "LD_AUDIT",
        ] {
            assert!(super::loader_var(name), "{name}");
        }
        for name in ["PATH", "LDFLAGS", "OLD_PWD", "HOME"] {
            assert!(!super::loader_var(name), "{name}");
        }
    }

    use super::*;
    use std::io::{Error, ErrorKind};

    // F24 r5: a stamped binary aimed at the owner's home is refused the two commands that swap a core; S7: and starting one.
    #[test]
    fn rc_cli_refuses_to_swap_the_owners_core() {
        let check = |build, home: &str, what: &str| {
            let args = ["serve".to_string(), what.to_string()];
            refuse_rc_on_owner_home(build, Path::new(home), None, &args)
        };
        // F24 r6: `$HOME/.nunchiro` is a link to a folder whose real path has no `.nunchiro` in it.
        let user_home = env::temp_dir().join(format!("nunchiro-f24-r6-{}", std::process::id()));
        let data = user_home.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let link = user_home.join(".nunchiro");
        std::os::unix::fs::symlink(&data, &link).unwrap();
        let restart = ["serve".to_string(), "restart".to_string()];
        let swap = |home: &Path, known: Option<&Path>| {
            refuse_rc_on_owner_home(Some("20"), home, known, &restart)
        };
        let known = Some(user_home.as_path());
        assert!(swap(&link, None).is_err()); // the default home, caught before the link is resolved
        assert!(swap(&data, known).is_err()); // NUNCHIRO_HOME naming the link's target
        assert!(swap(&data, None).is_ok()); // no other sign that this folder is the owner's
        assert!(swap(&user_home, known).is_ok());
        std::fs::remove_dir_all(&user_home).unwrap();

        let owner = "/Users/someone/.nunchiro";
        let refused = check(Some("20"), owner, "restart").unwrap_err();
        assert!(refused.contains(owner) && refused.contains("Nunchiro terminal"));
        assert!(check(Some("20"), owner, "update").is_err());
        assert!(check(Some("20"), "/Users/someone/.NUNCHIRO", "restart").is_err());
        assert!(check(None, owner, "restart").is_ok());
        assert!(check(Some("20"), "/Users/someone/.nunchiro-rc", "restart").is_ok());
        // S7: an RC build never starts a core on the owner's home; any other build or home may.
        assert!(
            refuse_rc_core_start(Some("20"), Path::new(owner), None)
                .unwrap_err()
                .contains("Nunchiro terminal")
        );
        assert!(
            refuse_rc_core_start(Some("20"), Path::new("/Users/someone/.NUNCHIRO"), None).is_err()
        );
        assert!(refuse_rc_core_start(None, Path::new(owner), None).is_ok());
        assert!(
            refuse_rc_core_start(
                Some("20"),
                Path::new("/Users/someone/.nunchiro-dev.nunchiro.app.rc"),
                None
            )
            .is_ok()
        );
        assert!(check(Some("20"), owner, "status").is_ok());
    }

    // F24: an unstamped core (every core before this ticket) is older; an unstamped binary replaces nothing.
    #[test]
    fn core_is_older_compares_build_stamps() {
        let me = std::env::current_exe().unwrap();
        let older =
            |mine, started: &serde_json::Value| super::core_is_older(mine, None, started, &me);
        let core = |build: serde_json::Value| serde_json::json!({"exe": me, "build": build});
        assert!(older(Some("20"), &serde_json::json!({"exe": me})));
        assert!(older(Some("20"), &core(19.into())));
        assert!(!older(Some("20"), &core(20.into())));
        assert!(!older(Some("20"), &core(21.into())));
        assert!(!older(None, &core(19.into())));
        assert!(!older(Some("20"), &serde_json::Value::Null));
    }

    // Ticket 1082: a build swapped in place replaces a core of another commit of this same install, stamped or not; two
    // stamps that make this binary the lower one are a downgrade and replace nothing.
    #[test]
    fn core_is_older_replaces_another_commit_of_this_install() {
        let me = std::env::current_exe().unwrap();
        let older = |mine, started: serde_json::Value| {
            super::core_is_older(mine, Some("bbb"), &started, &me)
        };
        assert!(older(None, serde_json::json!({"exe": me, "commit": "aaa"})));
        assert!(older(None, serde_json::json!({"exe": me})));
        assert!(!older(
            None,
            serde_json::json!({"exe": me, "commit": "bbb"})
        ));
        assert!(older(
            Some("20"),
            serde_json::json!({"exe": me, "build": 20, "commit": "aaa"})
        ));
        assert!(!older(
            Some("20"),
            serde_json::json!({"exe": me, "build": 21, "commit": "aaa"})
        ));
    }

    // F24 r2: an RC CLI run by hand reaches the owner's home; that unstamped core is not an older build of this install.
    #[test]
    fn core_is_older_leaves_another_install_alone() {
        let me = std::env::current_exe().unwrap();
        for exe in ["/bin/sh", "/no/such/nunchiro"] {
            let other = serde_json::json!({"exe": exe});
            assert!(
                !super::core_is_older(Some("20"), None, &other, &me),
                "{exe}"
            );
            assert!(
                !super::core_is_older(None, Some("abc"), &other, &me),
                "{exe}"
            );
        }
    }

    // Ticket 379: the update reads the store untyped, so a permission value this build no longer knows cannot stop it.
    // Also a next core started by another process: the swap takes it instead of waiting out the 40 s stop limit.
    #[test]
    fn core_is_older_swap_survives_a_store_with_an_unknown_permission() {
        use std::io::{BufRead, BufReader, Write};
        let home = std::env::temp_dir().join(format!("nunchiro-379-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let me = std::env::current_exe().unwrap();
        let write = |name: &str, text: String| std::fs::write(home.join(name), text).unwrap();
        write("core.lock", String::new());
        write("core.token", "old".into());
        write(
            "core.start.json",
            serde_json::json!({"exe": me, "build": 19}).to_string(),
        );
        write(
            "sessions.json",
            serde_json::json!({"version": 2, "live": {}, "sessions": [
                {"kind": "claude", "state": "running", "mode_state": {"skip": "ask"}, "permission": "no-such-value"}
            ]})
            .to_string(),
        );
        let listener = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
        let core = listener.try_clone().unwrap();
        let token = home.join("core.token");
        let older_core = std::thread::spawn(move || {
            // Refuses `exit_if_idle` as a core from before it does, takes `exit`, and the next core is up.
            let mut replies = [
                r#"{"Err":"unknown variant `exit_if_idle`"}"#,
                r#"{"Ok":{"type":"ack"}}"#,
            ]
            .iter();
            let mut reply = replies.next();
            while let Some(text) = reply {
                let (mut peer, _) = core.accept().unwrap();
                let mut line = String::new();
                BufReader::new(&peer).read_line(&mut line).unwrap();
                if !line.is_empty() {
                    writeln!(peer, "{text}").unwrap();
                    reply = replies.next();
                }
            }
            std::fs::write(token, "new").unwrap();
        });

        let word = super::update_core(&home, Some("20"), &me);

        older_core.join().unwrap();
        assert_eq!(word, Ok("replaced"));
        drop(listener);
        std::fs::remove_dir_all(&home).unwrap();
    }

    // Ticket 1110: two `serve update`s overlap (the app runs one at each page load). The second meets the old core
    // winding down for the first's exit; it waits for the next core instead of failing the install.
    #[test]
    fn update_waits_out_a_core_already_winding_down() {
        use std::io::{BufRead, BufReader, Write};
        let home = std::env::temp_dir().join(format!("nunchiro-1110-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let me = std::env::current_exe().unwrap();
        let write = |name: &str, text: String| std::fs::write(home.join(name), text).unwrap();
        write("core.lock", String::new());
        write("core.token", "old".into());
        write(
            "core.start.json",
            serde_json::json!({"exe": me, "build": 19}).to_string(),
        );
        let sock = home.join("core.sock");
        let old_core = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let (dir, sock2) = (home.clone(), sock.clone());
        let cores = std::thread::spawn(move || {
            let mut line = String::new();
            while line.is_empty() {
                let (mut peer, _) = old_core.accept().unwrap();
                BufReader::new(&peer).read_line(&mut line).unwrap();
                if !line.is_empty() {
                    writeln!(peer, r#"{{"Err":"{}"}}"#, server::NOT_SERVED).unwrap();
                }
            }
            std::thread::sleep(Duration::from_millis(200));
            drop(old_core);
            std::fs::remove_file(&sock2).unwrap();
            // The first update's next core comes up.
            std::fs::write(dir.join("core.token"), "new").unwrap();
            std::os::unix::net::UnixListener::bind(&sock2).unwrap()
        });

        let word = super::update_core(&home, Some("20"), &me);

        let next_core = cores.join().unwrap();
        assert_eq!(word, Ok("replaced"));
        drop(next_core);
        std::fs::remove_dir_all(&home).unwrap();
    }

    // Ticket 1024: `serve update` reads the record with the 1 MiB ceiling of every other read of it. A larger one is
    // not read at all, so it names no older core and nothing is asked of the running one (here it would answer busy).
    #[test]
    fn update_reads_the_start_record_bounded() {
        use std::io::{BufRead, BufReader, Write};
        let home = std::env::temp_dir().join(format!("nunchiro-1024-upd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let me = std::env::current_exe().unwrap();
        std::fs::write(home.join("core.token"), "t").unwrap();
        let record = |pad: usize| {
            let text = serde_json::json!({"exe": me, "build": 19, "pad": " ".repeat(pad)});
            std::fs::write(home.join("core.start.json"), text.to_string()).unwrap();
        };
        let core = std::os::unix::net::UnixListener::bind(home.join("core.sock")).unwrap();
        std::thread::spawn(move || {
            for peer in core.incoming() {
                let mut peer = peer.unwrap();
                let mut line = String::new();
                BufReader::new(&peer).read_line(&mut line).unwrap();
                if !line.is_empty() {
                    writeln!(peer, r#"{{"Err":"{}"}}"#, server::EXIT_BUSY).unwrap();
                }
            }
        });
        // In bounds: an older core of this install, asked to exit.
        record(0);
        assert_eq!(super::update_core(&home, Some("20"), &me), Ok("kept"));
        record(1 << 20);
        assert_eq!(super::update_core(&home, Some("20"), &me), Ok("current"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    // F24: only what could not survive the swap keeps the old core.
    #[test]
    fn swap_blockers_counts_live_chats_and_unreachable_holders() {
        let floor = u64::from(nunchiro_core::holder::frame::MIN_COMPATIBLE);
        let store = |kind: &str, state: &str, protocol: u64| {
            serde_json::json!({
                "sessions": [{"kind": kind, "state": state}],
                "live": {"a": {"holder": {"protocol": protocol}}},
            })
        };
        assert_eq!(super::swap_blockers(&store("claude", "running", floor)), 0);
        assert_eq!(super::swap_blockers(&store("acp", "resumable", floor)), 0);
        assert_eq!(super::swap_blockers(&store("acp", "running", floor)), 1);
        assert_eq!(
            super::swap_blockers(&store("claude", "running", floor - 1)),
            1
        );
        assert_eq!(super::swap_blockers(&serde_json::Value::Null), 0);
        let queued = serde_json::json!({"sessions": [{"kind": "shell", "state": "running", "send_queue": [{"id": "s"}]}]});
        assert_eq!(super::swap_blockers(&queued), 1);
    }

    // Ticket 573: `--env KEY=VALUE` repeats and splits at the first `=`; the core checks the names.
    #[test]
    fn session_start_env_takes_key_value_pairs() {
        let parse_args = |a: &[&str]| parse(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        let start = ["session", "start", "--project", "/tmp"];
        let Ok(Request::Start { env, .. }) = parse_args(
            &[
                &start[..],
                &["--env", "A=1", "--env", "B=x=y", "--env", "C="],
            ]
            .concat(),
        ) else {
            panic!("not a start");
        };
        let pairs: Vec<_> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(pairs, [("A", "1"), ("B", "x=y"), ("C", "")]);
        for bad in [
            &["--env", "NOEQUALS"][..],
            &["--env", "=v"],
            &["--env", "A=1", "--env", "A=2"],
            &["--env"],
        ] {
            assert!(parse_args(&[&start[..], bad].concat()).is_err(), "{bad:?}");
        }
    }

    // `--anyway` wraps the start, which the core lets past a memory-pressure hold for the owner only.
    #[test]
    fn session_start_anyway_wraps_the_start() {
        let parse_args = |a: &[&str]| parse(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        let Ok(Request::StartAnyway { start }) =
            parse_args(&["session", "start", "--anyway", "--project", "/tmp"])
        else {
            panic!("not a start anyway");
        };
        assert!(matches!(*start, Request::Start { .. }));
        assert!(matches!(
            parse_args(&["session", "start", "--project", "/tmp"]),
            Ok(Request::Start { .. })
        ));
    }

    // V2-4a
    #[test]
    fn session_start_agent_acp_names_the_entry_and_takes_no_args() {
        let parse_args = |a: &[&str]| parse(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        let Ok(Request::Start {
            session,
            folder: None,
            ..
        }) = parse_args(&[
            "session",
            "start",
            "--agent",
            "acp:gemini",
            "--project",
            "/tmp",
        ])
        else {
            panic!("not a start");
        };
        assert_eq!(session.kind, AgentKind::Acp);
        assert_eq!(session.args, ["gemini"]);
        for refused in [
            &["session", "start", "--agent", "gemini"][..],
            &["session", "start", "--agent", "acp:"],
            &["session", "start", "--agent", "acp:gemini", "--", "--yolo"],
        ] {
            assert!(parse_args(refused).is_err(), "{refused:?}");
        }
    }

    #[test]
    fn lock_error_ends_the_wait_without_failing() {
        let began = Instant::now();
        let answered = wait_out_lock(
            || {
                Err(std::fs::TryLockError::Error(Error::from(
                    ErrorKind::Unsupported,
                )))
            },
            || false,
            Duration::from_secs(5),
        );
        assert!(!answered);
        assert!(began.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn held_lock_keeps_waiting_until_the_core_answers() {
        let mut tries = 0;
        let answered = wait_out_lock(
            || Err(std::fs::TryLockError::WouldBlock),
            || {
                tries += 1;
                tries > 3
            },
            Duration::from_secs(5),
        );
        assert!(answered);
    }
}
