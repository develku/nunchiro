//! General orchestration commands; policy remains in the core.
use nunchiro_core::api::*;
use std::{
    path::Path,
    thread,
    time::{Duration, Instant},
};

/// Ticket 573 slice 2: an error starting with this exits 2: the agent waits on a question, permission or dialog.
pub const NEEDS_ANSWER: &str = "agent_blocked";
/// Ends with exit 2; `run` prints the agent's record.
fn needs_answer(session: &Session) -> Result<(), String> {
    Err(format!(
        "{NEEDS_ANSWER}: {} waits for an answer",
        session.id
    ))
}
/// A session that waits at a question in its terminal which no prompt may answer (a start question such as folder
/// trust): the core keeps a prompt sent to it in the queue.
fn at_dialog(session: &Session) -> bool {
    (session.pending.iter()).any(|d| d.kind == nunchiro_core::queue::Kind::Dialog)
}
/// Ends with exit 2 for a prompt kept behind such a question: which session waits at what, that the prompt is kept,
/// what to do, and how to drop the prompt. `machine`: the `--machine` this command ran with.
fn kept_behind(session: &Session, send: &str, machine: Option<&str>) -> String {
    let name = match session.label.as_str() {
        "" => &session.id,
        label => label,
    };
    let choices = (session.pending.iter())
        .find(|d| d.kind == nunchiro_core::queue::Kind::Dialog)
        .map(|d| {
            let labels: Vec<String> = d
                .choices
                .iter()
                .map(|c| format!("\"{}\"", c.label))
                .collect();
            labels.join(" / ")
        })
        .unwrap_or_default();
    let (on, cli, trust) = match machine {
        Some(m) => (
            format!(" on {m}"),
            format!("nunchiro --machine {m}"),
            " To trust a folder for later starts, run the agent once in that folder in a terminal on that Mac.",
        ),
        None => (String::new(), "nunchiro".into(), ""),
    };
    format!(
        "{NEEDS_ANSWER}: {name} waits at a question in its terminal{on} ({choices}). The prompt is queued and goes in once \
         the question is answered there; the Nunchiro window shows the question as a card on that session.{trust} To \
         drop the prompt: {cli} agent cancel {} {send}",
        session.id
    )
}
fn resolve(home: &Path, name: &str) -> Result<Session, String> {
    let Reply::Snapshot { mut sessions, .. } = super::call(home, Request::Snapshot)? else {
        return Err("invalid snapshot reply".into());
    };
    if let Some(at) = sessions.iter().position(|s| s.id == name) {
        return Ok(sessions.swap_remove(at));
    }
    // Sixth look (Home, S2): a seat replaced for another level leaves its ended session under the same label, and
    // the lead's `agent send <label>` was refused as ambiguous. The one that runs is the one meant.
    sessions.retain(|s| s.label == name);
    if sessions.iter().any(|s| s.state == SessionState::Running) {
        sessions.retain(|s| s.state == SessionState::Running);
    }
    if sessions.len() > 1 {
        return Err("ambiguous agent label; use session id".into());
    }
    sessions
        .pop()
        .ok_or_else(|| "agent not found in grants".into())
}
fn get(home: &Path, id: &str) -> Result<Session, String> {
    match super::call(home, Request::AgentGet { id: id.into() })? {
        Reply::Agent { session } => Ok(session),
        _ => Err("invalid agent reply".into()),
    }
}
/// The tree's reading (`status` and `agentState` in web/src/types.ts, `Session::listed_state` of ticket 1016): a live
/// shell whose agent failed (a problem card, the failed flag) is failed, one whose agent quit is exited.
fn status(session: &Session) -> &str {
    let running = session.state == SessionState::Running;
    if session.state == SessionState::Failed
        || running && (session.problem.is_some() || session.attention.failed)
    {
        "failed"
    } else if !running || session.agent_ended {
        "exited"
    } else if nunchiro_core::delivery::blocked(&session.pending) {
        "blocked"
    } else if session.attention.working {
        "working"
    } else if session.completion_seq > 0 {
        "done"
    } else {
        "idle"
    }
}
fn matches(session: &Session, until: &[String]) -> bool {
    let state = status(session);
    until
        .iter()
        .any(|u| u == state || u == "idle" && state == "done")
}
/// Why a wait ends now: the agent no longer runs (its session ended, or it failed or quit and left its shell), so it
/// reaches no other state. `None` while it runs.
fn ended(session: &Session) -> Option<String> {
    let word = match status(session) {
        _ if session.state != SessionState::Running => format!("{:?}", session.state),
        word @ ("failed" | "exited") => word.into(),
        _ => return None,
    };
    Some(format!(
        "agent_ended: {} is {word}, not running",
        session.id
    ))
}
fn record(session: &Session) -> Result<serde_json::Value, String> {
    let mut value = serde_json::to_value(session).map_err(|e| e.to_string())?;
    value["status"] = status(session).into();
    value["agent_session"] = session.agent_session_id.clone().into();
    Ok(value)
}
fn output(session: &Session) -> Result<(), String> {
    println!("{}", record(session)?);
    Ok(())
}
fn options(args: &[String]) -> Result<(bool, Vec<String>, u64), String> {
    let mut wait = false;
    let mut until = vec![];
    let mut timeout = 300_000;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--wait" => wait = true,
            "--until" => {
                i += 1;
                let value = args.get(i).ok_or("missing until state")?;
                if !["working", "done", "idle", "blocked", "failed", "exited"]
                    .contains(&value.as_str())
                {
                    return Err("invalid until state".into());
                }
                until.push(value.clone());
            }
            "--timeout" => {
                i += 1;
                timeout = args
                    .get(i)
                    .ok_or("missing timeout")?
                    .parse()
                    .map_err(|_| "invalid timeout")?;
            }
            _ => return Err("unknown agent option".into()),
        }
        i += 1;
    }
    if until.is_empty() {
        until.push("done".into());
    }
    Ok((wait, until, timeout))
}
/// Ticket 571: the room options, after `send`, `ask`, `reply`, `check` or `thread read`; `positional` words must remain.
struct RoomArgs {
    to: Option<String>,
    thread: Option<String>,
    project: std::path::PathBuf,
    wait: bool,
    timeout: u64,
    words: Vec<String>,
}
fn room_args(home: &Path, args: &[&str], ask: bool, positional: usize) -> Result<RoomArgs, String> {
    let mut room = RoomArgs {
        to: None,
        thread: None,
        project: std::env::current_dir().map_err(|e| e.to_string())?,
        wait: false,
        timeout: 600,
        words: vec![],
    };
    let mut i = 0;
    while i < args.len() {
        let value = || args.get(i + 1).copied().ok_or("missing option value");
        match args[i] {
            "--to" if positional > 0 => {
                let to = value()?;
                // `person` is the person's seat; anything else is a session id or label.
                room.to = Some(if to == nunchiro_core::room::PERSON {
                    to.into()
                } else {
                    resolve(home, to)?.id
                });
                i += 1;
            }
            "--thread" if positional > 0 => {
                room.thread = Some(value()?.into());
                i += 1;
            }
            "--project" => {
                room.project = value()?.into();
                i += 1;
            }
            "--wait" if ask => room.wait = true,
            "--timeout" if ask => {
                room.timeout = value()?.parse().map_err(|_| "invalid timeout")?;
                i += 1;
            }
            // Round 2: `--` ends the options; every word after it is a positional word, even one that starts with `--`.
            "--" => {
                room.words
                    .extend(args[i + 1..].iter().map(|w| (*w).to_string()));
                break;
            }
            word if word.starts_with("--") => return Err(format!("unknown option {word}")),
            word => room.words.push(word.into()),
        }
        i += 1;
    }
    if room.words.len() != positional {
        return Err("wrong number of arguments".into());
    }
    Ok(room)
}
/// One JSON object per message: the body stays quoted data. C0 and C1 control characters other than newline and tab
/// are dropped: JSON escapes C0 but prints C1 (such as U+009B, a terminal control introducer) raw.
fn room_print(reply: Reply) -> Result<(), String> {
    let Reply::Room { messages } = reply else {
        return Err("invalid room reply".into());
    };
    for mut message in messages {
        message
            .body
            .retain(|c| !c.is_control() || matches!(c, '\n' | '\t'));
        println!(
            "{}",
            serde_json::to_string(&message).map_err(|e| e.to_string())?
        );
    }
    Ok(())
}
fn room_send(home: &Path, args: &[&str], ask: bool) -> Result<(), String> {
    let room = room_args(home, args, ask, 1)?;
    let reply = super::call(
        home,
        Request::RoomSend {
            to: room.to,
            thread: room.thread,
            body: room.words[0].clone(),
            ask,
            project: Some(room.project.clone()),
        },
    )?;
    if !room.wait {
        return room_print(reply);
    }
    let Reply::Room { messages } = reply else {
        return Err("invalid room reply".into());
    };
    let ask = messages.first().ok_or("ask not recorded")?.id.clone();
    let until = Instant::now() + Duration::from_secs(room.timeout);
    loop {
        let give_up = Instant::now() >= until;
        let answer = super::call(
            home,
            Request::RoomAnswer {
                ask: ask.clone(),
                give_up,
                project: Some(room.project.clone()),
            },
        );
        // Exit 2 tells a timeout from a refusal (exit 1), even if the core could not log the timeout event.
        let timeout = |why: &str| -> ! {
            eprintln!(
                "nunchiro: ask_timeout: no reply to {ask} within {} s{why}",
                room.timeout
            );
            std::process::exit(2);
        };
        let Reply::Room { messages } = (match answer {
            Err(e) if give_up => timeout(&format!(" (timeout event not logged: {e})")),
            answer => answer?,
        }) else {
            return Err("invalid room reply".into());
        };
        if !messages.is_empty() {
            return room_print(Reply::Room { messages });
        }
        if give_up {
            timeout("");
        }
        thread::sleep(Duration::from_millis(200));
    }
}
pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    let result = verb(home, args);
    // Ticket 573: exit 2 always prints the agent (its `pending` names what it asks), also when the core refused the
    // verb before any delivery.
    if let Err(e) = &result
        && e.starts_with(NEEDS_ANSWER)
        && let Some(session) = args.get(1).and_then(|name| resolve(home, name).ok())
    {
        output(&session)?;
    }
    result
}
/// `nunchiro agent`, `agent --help` and `agent <verb> ... --help` print this (look v10 Home S2-3: a lead's
/// `agent reply --help` failed with "unknown option --help", so it took its own working reply for a failure too and
/// answered by typing into the worker's terminal instead).
pub const USAGE: &str = "nunchiro agent start <name> --kind claude|codex --project <dir> [--worktree] [--model <m>] [--effort <level>] [--env <KEY=VALUE>]... [--receipt <id>] [-- <args>...]
nunchiro agent prompt <agent> <text> [--wait] [--until done|idle|blocked]... [--timeout <ms>]
nunchiro agent send <agent> <text> [--wait] [--until ...] [--timeout <ms>]   (types the text into the agent's terminal)
nunchiro agent wait <agent> --until working|done|idle|blocked|failed|exited [--timeout <ms>]
nunchiro agent read <agent> [--lines <n>] [--source screen|transcript]
nunchiro agent get <agent> --json
nunchiro agent list [--mine] [--json]
nunchiro agent send-keys <agent> <key>...
nunchiro agent cancel <agent> <send-id>
The room (one quoted body after the options; `--` ends the options):
nunchiro agent send [--to <seat>] [--thread <name>] <body>
nunchiro agent ask [--to <seat>] [--thread <name>] [--wait [--timeout <s>]] <body>
nunchiro agent reply <message-id> <body>   (answers an ask; the id is the one `agent check` prints)
nunchiro agent check
nunchiro agent thread read <thread>";
fn verb(home: &Path, args: &[String]) -> Result<(), String> {
    // Only the options ask for help: a word after `--` belongs to the agent's own command line.
    if args.is_empty()
        || args
            .iter()
            .take_while(|a| *a != "--")
            .any(|a| a == "--help")
    {
        println!("{USAGE}");
        return Ok(());
    }
    super::ensure_core(home)?;
    let words: Vec<_> = args.iter().map(String::as_str).collect();
    match words.as_slice() {
        // Ticket 571: a room message has one word after its options; `send <agent> <text>` types into a terminal.
        ["send", rest @ ..]
            if rest.len() == 1 || rest.first().is_some_and(|w| w.starts_with("--")) =>
        {
            room_send(home, rest, false)
        }
        ["ask", rest @ ..] => room_send(home, rest, true),
        ["reply", rest @ ..] => {
            let room = room_args(home, rest, false, 2)?;
            room_print(super::call(
                home,
                Request::RoomReply {
                    message: room.words[0].clone(),
                    body: room.words[1].clone(),
                    project: Some(room.project),
                },
            )?)
        }
        ["check", rest @ ..] => {
            let room = room_args(home, rest, false, 0)?;
            room_print(super::call(
                home,
                Request::RoomCheck {
                    project: Some(room.project),
                },
            )?)
        }
        ["thread", "read", rest @ ..] => {
            let room = room_args(home, rest, false, 1)?;
            room_print(super::call(
                home,
                Request::RoomThread {
                    thread: room.words[0].clone(),
                    project: Some(room.project),
                },
            )?)
        }
        // `agent start --help` once started a session labeled "--help": a name never starts with "-".
        ["start", name, ..] if name.starts_with('-') => Err(format!(
            "usage: agent start <name> --kind claude|codex --project <dir> [options]; \"{name}\" is an option, not a name"
        )),
        ["start", name, tail @ ..] => {
            let mut args = vec![
                "session".into(),
                "start".into(),
                "--label".into(),
                (*name).into(),
            ];
            args.extend(tail.iter().map(|s| (*s).into()));
            // Ticket 573 slice 2 (Orca): every start has a receipt; a retry passes it back with `--receipt`.
            let options = tail.split(|s| *s == "--").next().unwrap_or_default();
            let receipt = match options.iter().position(|s| *s == "--receipt") {
                Some(i) => options
                    .get(i + 1)
                    .ok_or("missing value for --receipt")?
                    .to_string(),
                None => {
                    let receipt = new_receipt()?;
                    let at = args.iter().position(|s| s == "--").unwrap_or(args.len());
                    args.splice(at..at, ["--receipt".into(), receipt.clone()]);
                    receipt
                }
            };
            let reply = super::call(home, super::parse(&args)?)?;
            let mut value = serde_json::to_value(&reply).map_err(|e| e.to_string())?;
            value["receipt"] = receipt.into();
            println!("{value}");
            Ok(())
        }
        ["get", name, "--json"] => output(&resolve(home, name)?),
        // V2.5-30: the core decides who "mine" is (the token's or the peer-checked session); no option names it.
        ["list", flags @ ..] => {
            let (mut mine, mut json) = (false, false);
            for flag in flags {
                match *flag {
                    "--mine" => mine = true,
                    "--json" => json = true,
                    _ => return Err("unknown agent list option".into()),
                }
            }
            let Reply::Snapshot { sessions, .. } = super::call(home, Request::AgentList { mine })?
            else {
                return Err("invalid list reply".into());
            };
            if json {
                let records = sessions.iter().map(record).collect::<Result<Vec<_>, _>>()?;
                println!("{}", serde_json::Value::from(records));
            } else {
                for s in &sessions {
                    let parent = s.parent.as_deref().unwrap_or("-");
                    println!("{}\t{}\t{}\t{}", s.id, s.label, status(s), parent);
                }
            }
            Ok(())
        }
        ["read", name, tail @ ..] => {
            let session = resolve(home, name)?;
            let mut lines = 50;
            let mut source = "screen";
            let mut i = 0;
            while i < tail.len() {
                let option = tail[i];
                i += 1;
                let value = *tail.get(i).ok_or("missing read option value")?;
                match option {
                    "--lines" => lines = value.parse().map_err(|_| "invalid line count")?,
                    "--source" if ["screen", "transcript"].contains(&value) => source = value,
                    _ => return Err("invalid read option".into()),
                }
                i += 1;
            }
            match super::call(
                home,
                Request::AgentRead {
                    id: session.id,
                    source: source.into(),
                    lines,
                },
            )? {
                Reply::Text { text } => {
                    println!("{text}");
                    Ok(())
                }
                _ => Err("invalid read reply".into()),
            }
        }
        ["send-keys", name, keys @ ..] if !keys.is_empty() => {
            let session = resolve(home, name)?;
            let reply = super::call(
                home,
                Request::AgentKeys {
                    id: session.id,
                    keys: keys.iter().map(|k| (*k).into()).collect(),
                },
            )?;
            println!(
                "{}",
                serde_json::to_string(&reply).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        ["cancel", name, send] => {
            let session = resolve(home, name)?;
            super::call(
                home,
                Request::CancelSend {
                    id: session.id,
                    send: (*send).into(),
                },
            )?;
            Ok(())
        }
        ["wait", name, tail @ ..] => {
            let (_, until, timeout) =
                options(&tail.iter().map(|s| (*s).into()).collect::<Vec<_>>())?;
            let session = resolve(home, name)?;
            let start = Instant::now();
            loop {
                let session = get(home, &session.id)?;
                if matches(&session, &until) {
                    return output(&session);
                }
                if status(&session) == "blocked" {
                    return needs_answer(&session);
                }
                // Ticket 305: a session that no longer runs (it ended, or a next core found it Resumable) never
                // reaches another state, so the wait ends now rather than at its timeout; so does an agent that
                // failed or quit and left its shell (w73), which a wait for idle or done once read as idle.
                if let Some(e) = ended(&session) {
                    return Err(e);
                }
                if start.elapsed() >= Duration::from_millis(timeout) {
                    return Err("agent_wait_timeout".into());
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
        [command @ ("prompt" | "send"), name, text, tail @ ..] => {
            let (wait, until, timeout) =
                options(&tail.iter().map(|s| (*s).into()).collect::<Vec<_>>())?;
            let before = resolve(home, name)?;
            // Home look S1-1: a lead's `agent send <assistant> "<job>"` typed the job into Claude's input and never
            // submitted it; the assistant sat idle. To an agent, `send` submits as `prompt` does (send-keys stays for
            // keys); only a shell gets the exact text with no Enter.
            let submit = *command == "prompt" || before.kind != AgentKind::Shell;
            let request = if submit {
                Request::AgentPrompt {
                    id: before.id.clone(),
                    text: (*text).into(),
                }
            } else {
                Request::AgentSend {
                    id: before.id.clone(),
                    text: (*text).into(),
                }
            };
            let reply = super::call(home, request)?;
            let Reply::Delivery { send } = reply else {
                return Err("invalid send reply".into());
            };
            let machine = std::env::var("NUNCHIRO_MACHINE").ok();
            if send.status == "queued" && (!wait || *command == "send") {
                // Kept behind a question: exit 2 with the reason, as for every blocked agent.
                let session = get(home, &before.id)?;
                if at_dialog(&session) {
                    return Err(kept_behind(&session, &send.id, machine.as_deref()));
                }
                println!(
                    "{}",
                    serde_json::to_string(&Reply::Delivery { send }).map_err(|e| e.to_string())?
                );
                return Ok(());
            }
            if *command == "send" {
                return output(&get(home, &before.id)?);
            }
            let start = Instant::now();
            let mut active = false;
            let mut delivered_since = None;
            loop {
                let session = get(home, &before.id)?;
                let row = session
                    .send_queue
                    .iter()
                    .chain(session.send_log.iter())
                    .find(|s| s.id == send.id)
                    .ok_or("send log entry missing")?;
                if matches!(row.status.as_str(), "failed" | "canceled") {
                    return Err(format!("send {}", row.status));
                }
                if row.status == "queued" {
                    // Kept behind a question: no turn will end until someone answers it, so the wait ends now.
                    if at_dialog(&session) && !until.iter().any(|u| u == "blocked") {
                        return Err(kept_behind(&session, &row.id, machine.as_deref()));
                    }
                    if start.elapsed() >= Duration::from_millis(timeout)
                        || wait
                            && status(&session) == "blocked"
                            && until.iter().any(|u| u == "blocked")
                    {
                        println!(
                            "{}",
                            serde_json::to_string(&Reply::Delivery { send: row.clone() })
                                .map_err(|e| e.to_string())?
                        );
                        return Ok(());
                    }
                    thread::sleep(Duration::from_millis(50));
                    continue;
                }
                // v1a-15: a pasted prompt is `attempting` until its Enter; the stall clock starts at delivery.
                if row.status == "attempting" {
                    if start.elapsed() >= Duration::from_millis(timeout) {
                        return Err("agent_wait_timeout".into());
                    }
                    thread::sleep(Duration::from_millis(50));
                    continue;
                }
                let delivered_since = delivered_since.get_or_insert_with(Instant::now);
                if status(&session) == "blocked" {
                    if wait && until.iter().any(|u| u == "blocked") {
                        return output(&session);
                    }
                    return needs_answer(&session);
                }
                active |= row.status == "delivered"
                    && (session.completion_seq > row.completion_seq
                        || session.attention.working
                        || session.attention.last_activity > row.last_activity);
                if active && (!wait || matches(&session, &until)) {
                    return output(&session);
                }
                if let Some(e) = ended(&session) {
                    return Err(e);
                }
                if !active && delivered_since.elapsed() >= Duration::from_secs(5) {
                    return Err("agent_prompt_stalled".into());
                }
                if start.elapsed() >= Duration::from_millis(timeout) {
                    return Err("agent_wait_timeout".into());
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
        _ => Err("unknown agent command".into()),
    }
}
/// 24 random hex characters.
fn new_receipt() -> Result<String, String> {
    use std::io::Read;
    let mut bytes = [0u8; 12];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("receipt: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running() -> Session {
        serde_json::from_value(serde_json::json!({
            "id": "s1", "kind": "claude", "project": "/p", "cwd": "/p", "label": "one", "state": "running",
            "agent_session_id": null, "agent_version": null, "untested": false, "pid": null,
            "attention": {"completion_seq": 0, "working": false, "waiting": false, "stale": false,
            "failed": false, "last_activity": 0, "background": 0}, "pending": []
        }))
        .expect("session meta")
    }

    /// w73 (after ticket 1016): Claude exited with code 3 and left its shell. `agent list` and `agent get` say failed, as
    /// the tree and `session list` do; a wait for idle or done ends at once (`agent_ended`) instead of reading it idle,
    /// and a wait for failed returns it.
    #[test]
    fn an_agent_that_failed_reads_failed_and_ends_a_wait() {
        let idle = vec!["idle".to_string()];
        let mut s = running();
        assert_eq!(status(&s), "idle");
        assert!(matches(&s, &idle) && ended(&s).is_none());
        s.completion_seq = 1;
        s.agent_ended = true;
        assert_eq!(status(&s), "exited");
        s.problem = nunchiro_core::problems::ended(AgentKind::Claude, b"boom\r\n", Some(3), true);
        assert!(s.problem.is_some());
        assert_eq!(status(&s), "failed");
        assert_eq!(record(&s).unwrap()["status"], "failed");
        assert!(!matches(&s, &idle) && !matches(&s, &["done".into()]));
        assert!(matches(&s, &["failed".into()]));
        assert_eq!(
            ended(&s).as_deref(),
            Some("agent_ended: s1 is failed, not running")
        );
        let mut flagged = running();
        flagged.attention.failed = true;
        assert_eq!(status(&flagged), "failed");
        // A session that no longer runs keeps its stored state in the message (a next core found it Resumable).
        flagged.state = SessionState::Resumable;
        assert_eq!(
            ended(&flagged).as_deref(),
            Some("agent_ended: s1 is Resumable, not running")
        );
    }
}
