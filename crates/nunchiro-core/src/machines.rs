//! v1a-06: SSH is user authority; the local core authorizes each session caller first.
pub(crate) mod aliases; // v25f
mod channel; // V2-12m-a
pub mod discovery;
#[cfg(test)]
pub(crate) mod refresh_tests;
pub mod share; // ticket 1050
mod transport;
use crate::{api::*, grants, sessions::Sessions, store};
pub use channel::{
    Channel, ChannelState, PROTOCOL, accepts, control_path, core_in_ssh_login,
    login_session_matters, private_dir, relay_accepts, ssh_login,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    #[serde(default)]
    pub projects: BTreeMap<PathBuf, PathBuf>,
    pub host: Option<String>,
    pub user: Option<String>,
    pub port: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Caller {
    pub id: String,
    pub project: PathBuf,
    #[serde(default)]
    pub permission_answers: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(rename = "MachinesStatus"))]
pub struct Status {
    pub machine: String,
    pub status: String,
    pub error: Option<String>,
    // V2-12m-a: the alias' persistent channel, once an owner snapshot started it. Omitted otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<Channel>,
}
#[derive(Clone)]
pub(crate) struct Child {
    pub parent: String,
    pub project: PathBuf,
}
#[derive(Default)]
pub(crate) struct State {
    channels_checked_at: Option<Instant>,
    channels_checked_aliases: Vec<String>,
    channels_checked_store: Option<(u64, SystemTime)>,
    channels_checked_error: Option<String>,
    pub callers: BTreeMap<String, Caller>,
    pub children: BTreeMap<(String, String), Child>,
    pub cache: BTreeMap<String, Vec<Session>>,
    // V2-12m-a: aliases whose channel thread runs; a stopping core waits until it is empty.
    pub refreshing: BTreeSet<String>,
    pub cancel: BTreeMap<String, Arc<AtomicBool>>,
    pub next_slot: usize,
    pub forgetting: BTreeSet<String>,
    pub starting: BTreeMap<String, usize>,
    pub unseen_starts: BTreeMap<String, BTreeMap<String, Session>>,
    pub retry: BTreeMap<String, Arc<AtomicBool>>,
    pub channels: BTreeMap<String, Channel>,
    // V2-12m-a: answers sent per alias, until a push no longer holds them (r3: or a second push still does).
    pub answered: BTreeMap<String, BTreeMap<String, channel::Mark>>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Known {
    version: u32,
    machines: Vec<String>,
}
/// V2-12m-a: the relay's reply to a second answer for one item id.
pub const ALREADY_ANSWERED: &str = "already answered";
pub fn valid_alias(alias: &str) -> Result<(), String> {
    if alias.is_empty()
        || alias.len() > 128
        || alias.starts_with('-')
        // "." or ".." would name a folder, not a file, as known_hosts.d/<alias> (ticket 1050).
        || alias.bytes().all(|b| b == b'.')
        || !alias
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err("invalid machine alias".into());
    }
    Ok(())
}
pub(crate) fn known(home: &Path) -> Result<Vec<String>, String> {
    #[cfg(test)]
    refresh_tests::record(home, false);
    let bytes = match crate::store::read_regular(&home.join("machines.json")) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let data: Known =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid machines store: {e}"))?;
    if data.version != 1 {
        return Err("unsupported machines store version".into());
    }
    let mut seen = BTreeSet::new();
    for alias in &data.machines {
        valid_alias(alias)?;
        if !seen.insert(alias) {
            return Err("duplicate machine alias".into());
        }
    }
    Ok(data.machines)
}
fn remember(home: &Path, alias: &str) -> Result<(), String> {
    let mut machines = known(home)?;
    if !machines.iter().any(|m| m == alias) {
        machines.push(alias.into());
        store::write_capped(
            &home.join("machines.json"),
            &serde_json::to_vec(&Known {
                version: 1,
                machines,
            })
            .map_err(|e| e.to_string())?,
            store::READ_MAX,
        )?;
    }
    Ok(())
}

pub fn transport(home: &Path, alias: &str, request: Request) -> Response {
    send(home, alias, request, None)
}
// V2-12m-a: with `master`, the request rides that alias' ControlMaster instead of opening its own connection.
fn send(home: &Path, alias: &str, request: Request, master: Option<&Path>) -> Response {
    valid_alias(alias)?;
    let path = home.join(format!("remote-{}.tmp", store::new_id()?));
    // A private stdin file avoids putting prompts or delegation metadata in SSH's argv.
    let result = (|| {
        let bytes = serde_json::to_vec(
            &serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"protocol":PROTOCOL,"request":request}),
        )
        .map_err(|e| e.to_string())?;
        let file = request_file(&path, &bytes).map_err(|e| e.to_string())?;
        #[cfg(test)]
        if let Some(swap) = compatibility_tests::AFTER_REQUEST.take() {
            swap(&path);
        }
        let mut command = crate::process::command(
            std::env::var_os("NUNCHIRO_SSH").unwrap_or_else(|| "ssh".into()),
        );
        command
            .args(channel::remote_argv(
                home,
                alias,
                master.map(|path| (path, false)),
            )?)
            .env_remove("NUNCHIRO_TOKEN")
            .env_remove("NUNCHIRO_MACHINE")
            .stdin(Stdio::from(file));
        let output = transport::output(command, Duration::from_secs(6))
            .map_err(|e| format!("machine {alias}: SSH {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "machine {alias}: SSH {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        serde_json::from_slice(&output.stdout).map_err(|e| {
            format!("machine {alias}: invalid or oversized remote reply (8 MiB limit): {e}")
        })?
    })();
    let _ = fs::remove_file(path);
    result
}
/// Ticket 437: the request written and rewound on the handle that created it, which becomes SSH's stdin. No reopen by
/// path: a file swapped for a FIFO there is never opened, so nothing waits before the transport timeout starts.
fn request_file(path: &Path, bytes: &[u8]) -> std::io::Result<fs::File> {
    use std::io::{Seek, Write};
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.rewind()?;
    Ok(file)
}
fn label(reply: &mut Reply, alias: &str) {
    match reply {
        Reply::Snapshot { sessions, .. } => {
            for s in sessions {
                s.machine = Some(alias.into());
            }
        }
        Reply::Started { session } | Reply::Agent { session } => {
            session.machine = Some(alias.into())
        }
        _ => {}
    }
}
pub(crate) fn dispatch(
    registry: &Mutex<Sessions>,
    home: &Path,
    owner: bool,
    token: &str,
    alias: String,
    request: Request,
    stopping: &AtomicBool,
) -> Response {
    valid_alias(&alias)?;
    if matches!(
        request,
        Request::Remote { .. }
            | Request::Forwarded { .. }
            | Request::MachineStatus { .. }
            | Request::Hook { .. }
    ) {
        return Err("remote transport operation not permitted".into());
    }
    let (caller, forwarded, master, taken) = {
        let mut sessions = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        let caller = if owner {
            None
        } else {
            Some(sessions.agent_caller(token)?)
        };
        if sessions.remote.forgetting.contains(&alias) {
            return Err("machine is being forgotten".into());
        }
        let delegated = sessions.remote_authorize(caller.as_ref(), &alias, &request)?;
        // Every fallible step before an answer's item is taken (r2): an error must not hide a pending item.
        remember(home, &alias)?;
        // V2-12m-a: a mismatched machine gets no request; one that is up gets it over its master.
        let master = match sessions.remote.channels.get(&alias) {
            Some(c) if c.state == ChannelState::VersionMismatch => {
                return Err(c.error.clone().unwrap_or_else(|| "version mismatch".into()));
            }
            Some(c) if c.state == ChannelState::Up => Some(c.slot),
            _ => None,
        };
        // V2-12m-a: an answer leaves once: its item must be pending in the pushed rows and is taken out as it is sent.
        // A failed send puts it back; the relay pushes again only when the remote rows change. While the channel is not
        // up the answer still goes, over its own connection: the cached row may be stale, but the relay takes one answer
        // per item id and the remote queue re-checks that the item is still pending, so a stale row cannot be answered
        // twice or after the remote is done with it.
        let taken = match &request {
            Request::Answer { item, .. } => Some(
                sessions
                    .remote
                    .cache
                    .get_mut(&alias)
                    .into_iter()
                    .flatten()
                    .find_map(|row| {
                        let at = row.pending.iter().position(|d| &d.id == item)?;
                        Some(row.pending.remove(at))
                    })
                    .ok_or("remote decision not found")?,
            ),
            _ => None,
        };
        if let Some(item) = &taken {
            sessions
                .remote
                .answered
                .entry(alias.clone())
                .or_default()
                .insert(item.id.clone(), channel::Mark::Sending);
        }
        if matches!(request, Request::Start { .. } | Request::StartAnyway { .. }) {
            *sessions.remote.starting.entry(alias.clone()).or_default() += 1;
        }
        (caller, delegated, master, taken)
    };
    // A start can create a remote session before its first push; removal must wait for its reply too.
    struct Starting<'a>(&'a Mutex<Sessions>, &'a str, bool);
    impl Drop for Starting<'_> {
        fn drop(&mut self) {
            if self.2
                && let Ok(mut s) = self.0.lock()
                && let Some(count) = s.remote.starting.get_mut(self.1)
            {
                *count -= 1;
                if *count == 0 {
                    s.remote.starting.remove(self.1);
                }
            }
        }
    }
    let starts = matches!(request, Request::Start { .. } | Request::StartAnyway { .. });
    let _starting = Starting(registry, &alias, starts);
    // Outside the registry lock: the folder check touches the disk.
    let master = master.and_then(|slot| control_path(home, slot).ok());
    let sent = if stopping.load(Ordering::SeqCst) {
        Err("core is stopping".into())
    } else {
        send(home, &alias, forwarded, master.as_deref())
    };
    // An earlier send was applied and only its reply got lost: done. The remote no longer holds the item: its row goes.
    let sent = match sent {
        Err(e) if taken.is_some() && e.contains(ALREADY_ANSWERED) => Ok(Reply::Ack),
        sent => sent,
    };
    let gone = matches!(&sent, Err(e) if e.contains("decision not found"));
    if let (Err(_), Some(item)) = (&sent, taken)
        && !gone
        && let Ok(mut sessions) = registry.lock()
        && sessions
            .remote
            .answered
            .get_mut(&alias)
            .is_some_and(|ids| ids.remove(&item.id).is_some())
        && let Some(row) = sessions
            .remote
            .cache
            .get_mut(&alias)
            .into_iter()
            .flatten()
            .find(|row| row.id == item.session_id)
        && !row.pending.iter().any(|d| d.id == item.id)
    {
        row.pending.push(item);
    }
    if let (Ok(_), Request::Answer { item, .. }) = (&sent, &request)
        && let Ok(mut sessions) = registry.lock()
        && let Some(mark) = sessions
            .remote
            .answered
            .get_mut(&alias)
            .and_then(|ids| ids.get_mut(item))
    {
        *mark = channel::Mark::Sent;
    }
    let mut reply = sent?;
    let mut sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    label(&mut reply, &alias);
    if let Reply::Started { session } = &reply {
        let Some(row) = channel::clean(&alias, vec![session.clone()]).pop() else {
            return Err("invalid remote session id".into());
        };
        // A successful start precedes its first push; keep it visible through older empty pushes.
        let cached = sessions.remote.cache.entry(alias.clone()).or_default();
        if !cached.iter().any(|r| r.id == row.id) {
            cached.push(row.clone());
            if row.state == SessionState::Running {
                sessions
                    .remote
                    .unseen_starts
                    .entry(alias.clone())
                    .or_default()
                    .insert(row.id.clone(), row);
            }
        }
    }
    if let Request::Close { id } = &request {
        if let Some(unseen) = sessions.remote.unseen_starts.get_mut(&alias) {
            unseen.remove(id);
        }
        if let Some(rows) = sessions.remote.cache.get_mut(&alias) {
            rows.retain(|s| &s.id != id);
        }
    }
    if let Some(caller) = &caller {
        sessions.agent_caller(token)?;
        if let Reply::Started { session } = &reply {
            sessions.remote_child(&alias, caller, session);
        }
    }
    Ok(reply)
}
pub(crate) fn forwarded(
    registry: &Mutex<Sessions>,
    caller: Caller,
    request: Request,
    stopping: &AtomicBool,
) -> Response {
    if !store::valid_id(&caller.id) || !caller.project.is_absolute() {
        return Err("invalid remote caller".into());
    }
    let delegated = caller.clone();
    let caller = grants::Caller {
        id: caller.id,
        project: fs::canonicalize(caller.project).map_err(|e| e.to_string())?,
    };
    // v1a-22
    let (mut sessions, ()) = Sessions::past_busy_worktree(registry, |sessions| {
        if stopping.load(Ordering::SeqCst) {
            return Err("core is stopping".into());
        }
        sessions.remote.callers.insert(
            caller.id.clone(),
            Caller {
                project: caller.project.clone(),
                ..delegated.clone()
            },
        );
        sessions.check_remote_agent(&caller, &request)
    })?;
    if let Request::AgentRead { id, source, lines } = &request
        && source == "transcript"
    {
        let plan = sessions.transcript_read(id, *lines)?;
        drop(sessions);
        let reply = plan.read();
        let mut sessions = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        if stopping.load(Ordering::SeqCst) {
            return Err("core is stopping".into());
        }
        sessions.check_remote_agent(&caller, &request)?;
        if !sessions.transcript_read_current(&plan) {
            return Err("transcript identity changed during read".into());
        }
        return reply;
    }

    if let Request::Start {
        session,
        folder,
        env,
        receipt: _, // ticket 573: receipts are kept by the core that is asked, not across machines
    } = request
    {
        // A session's start from another Mac is held as one from this Mac.
        let who = crate::pressure::Who::Session;
        crate::pressure::check_start(&session, who, false, "forwarded start")?;
        let launch = sessions
            .launch_as(Some(&caller), session, true)?
            .with_folder(folder)
            .with_env(env)?;
        drop(sessions);
        let mut launch = launch.prepare()?;
        let (_sessions, session) = Sessions::past_busy_worktree(registry, |sessions| {
            if stopping.load(Ordering::SeqCst) {
                return Err("core is stopping".into());
            }
            sessions.start_granted(&caller, &launch, true)
        })?; // v1a-22
        launch.committed = true;
        return Ok(Reply::Started { session });
    }
    sessions.handle_remote_agent(&caller, request)
}
pub(crate) fn status(
    registry: &Mutex<Sessions>,
    home: &Path,
    label: Option<String>,
    retry: bool,
) -> Response {
    if retry {
        let alias = label.as_ref().ok_or("retry needs a listed machine alias")?;
        valid_alias(alias)?;
        let mut s = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        if !s.remote_aliases(known(home)?).contains(alias) {
            return Err("machine alias is not listed".into());
        }
        if s.remote
            .channels
            .get(alias)
            .is_some_and(|c| !matches!(c.state, ChannelState::Up | ChannelState::Connecting))
            && let Some(wake) = s.remote.retry.get(alias)
        {
            wake.store(true, Ordering::SeqCst);
            if let Some(c) = s.remote.channels.get_mut(alias) {
                c.state = ChannelState::Connecting;
                c.since_ms = crate::queue::now_ms();
            }
            drop(s);
            let until = std::time::Instant::now() + Duration::from_secs(3);
            while std::time::Instant::now() < until {
                if registry
                    .lock()
                    .map_err(|_| "session registry unavailable")?
                    .remote
                    .channels
                    .get(alias)
                    .is_none_or(|c| c.state != ChannelState::Connecting)
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    let aliases = if let Some(alias) = label {
        valid_alias(&alias)?;
        vec![alias]
    } else {
        let s = registry
            .lock()
            .map_err(|_| "session registry unavailable")?;
        s.remote_aliases(known(home)?)
    };
    let machines = aliases
        .into_iter()
        .map(|machine| {
            // V2-12m-a: a running channel answers without another SSH request.
            let channel = registry
                .lock()
                .map_err(|_| "session registry unavailable")?
                .remote
                .channels
                .get(&machine)
                .cloned();
            let error = match &channel {
                Some(c) if c.state == ChannelState::Up => None,
                Some(c) => Some(c.error.clone().unwrap_or_else(|| "connecting".into())),
                None => transport(home, &machine, Request::List).err(),
            };
            let status = match (&channel, &error) {
                (_, None) => "reachable",
                (Some(c), _) if c.state == ChannelState::VersionMismatch => "version_mismatch",
                (None, Some(e)) if e.contains("version mismatch") => "version_mismatch",
                _ => "unreachable",
            };
            Ok(Status {
                machine,
                status: status.into(),
                error,
                channel,
            })
        })
        .collect::<Result<_, String>>()?;
    Ok(Reply::Machines { machines })
}
/// Owner snapshots share a one-second refresh budget; changed stores or configured aliases refresh immediately.
pub(crate) fn ensure_channels(
    registry: &Arc<Mutex<Sessions>>,
    home: &Path,
    stopping: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    if stopping.load(Ordering::SeqCst) {
        return Ok(());
    }
    let stored_file = match fs::metadata(home.join("machines.json")) {
        Ok(metadata) => Some((
            metadata.len(),
            metadata.modified().map_err(|e| e.to_string())?,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let configured = sessions.remote_aliases(vec![]);
    if stored_file == sessions.remote.channels_checked_store
        && configured == sessions.remote.channels_checked_aliases
        && sessions
            .remote
            .channels_checked_at
            .is_some_and(|at| at.elapsed() < Duration::from_secs(1))
    {
        return sessions
            .remote
            .channels_checked_error
            .clone()
            .map_or(Ok(()), Err);
    }
    let stored = known(home);
    // Share the refresh budget and its error across owner windows and socket snapshots.
    sessions.remote.channels_checked_at = Some(Instant::now());
    sessions.remote.channels_checked_aliases = configured;
    sessions.remote.channels_checked_store = stored_file;
    sessions.remote.channels_checked_error = stored.as_ref().err().cloned();
    for alias in sessions.remote_aliases(stored?) {
        channel::ensure(&mut sessions, registry, home, &alias, stopping);
    }
    Ok(())
}
// Snapshots use pushed rows plus starts awaiting their first push; a dead SSH transport never delays local reads.
pub(crate) fn snapshot(
    registry: &Arc<Mutex<Sessions>>,
    home: &Path,
    token: &str,
    owner: bool,
    reply: &mut Reply,
    stopping: &Arc<AtomicBool>,
) -> Result<(), String> {
    let Reply::Snapshot { sessions: rows, .. } = reply else {
        return Ok(());
    };
    let sessions = registry
        .lock()
        .map_err(|_| "session registry unavailable")?;
    let caller = if owner {
        None
    } else {
        Some(sessions.agent_caller(token)?)
    };
    // Q10: a relay row never shares an id with a row shown before it (this core's, or an earlier machine's), so every
    // id in a snapshot names one session and the window's requests on it go to one place (`holder`).
    let mut ids: BTreeSet<String> = rows.iter().map(|r| r.id.clone()).collect();
    for (alias, remote) in &sessions.remote.cache {
        rows.extend(
            remote
                .iter()
                .filter(|row| {
                    caller
                        .as_ref()
                        .is_none_or(|c| sessions.remote_owned(c, alias, &row.id))
                        && !sessions.is_local(&row.id)
                        && ids.insert(row.id.clone())
                })
                .cloned(),
        );
    }
    if stopping.load(Ordering::SeqCst) {
        return Ok(());
    }
    // V2-12m-a: rows arrive pushed over each alias' channel; only the owner starts one, a session token never does.
    drop(sessions);
    if owner {
        // Q9 ko-J8-1: a bad machines.json must not fail local snapshots; MachineDetails reports the store error.
        let _ = ensure_channels(registry, home, stopping);
    }
    Ok(())
}

/// Q10: the machine whose pushed rows hold session `id`, as `snapshot` shows it: never for an id of this core, and the
/// first machine in name order when two push the same id.
pub(crate) fn holder(sessions: &Sessions, id: &str) -> Option<String> {
    if sessions.is_local(id) {
        return None;
    }
    let (alias, _) = sessions
        .remote
        .cache
        .iter()
        .find(|(_, rows)| rows.iter().any(|r| r.id == id))?;
    Some(alias.clone())
}
/// Q10: likewise for a pushed decision: an item this core's queue holds is always answered here.
pub(crate) fn item_holder(sessions: &Sessions, item: &str) -> Option<String> {
    if sessions.queue.decision(item).is_ok() {
        return None;
    }
    let (alias, _) = sessions.remote.cache.iter().find(|(alias, rows)| {
        rows.iter().any(|r| {
            r.pending.iter().any(|d| d.id == item)
                && holder(sessions, &r.id).as_ref() == Some(*alias)
        })
    })?;
    Some(alias.clone())
}
/// Q10: a remote session's output after `after`, over the alias' master only: a machine that is not up is never dialled
/// per poll. The reply is untrusted: at most one replay's bytes, and its cursors must follow `after`.
pub(crate) fn read_output(
    registry: &Mutex<Sessions>,
    home: &Path,
    alias: &str,
    id: &str,
    after: u64,
) -> Result<(Vec<u8>, u64, u64, bool), String> {
    let slot = match registry
        .lock()
        .map_err(|_| "session registry unavailable")?
        .remote
        .channels
        .get(alias)
    {
        Some(c) if c.state == ChannelState::Up => c.slot,
        _ => return Err(format!("machine {alias}: not connected")),
    };
    let master = control_path(home, slot)?;
    let request = Request::Read {
        id: id.into(),
        after,
    };
    match send(home, alias, request, Some(&master))? {
        Reply::Output {
            data,
            start,
            end,
            truncated,
        } if data.len() <= crate::pty::REPLAY_BYTES
            && start >= after
            && start.checked_add(data.len() as u64) == Some(end) =>
        {
            Ok((data, start, end, truncated))
        }
        _ => Err(format!("machine {alias}: invalid remote output")),
    }
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;

    std::thread_local! {
        /// Run once by the next `send` on this thread, right after it wrote its request file.
        pub(super) static AFTER_REQUEST: std::cell::Cell<Option<fn(&Path)>> = const { std::cell::Cell::new(None) };
    }
    fn swap_for_fifo(path: &Path) {
        fs::remove_file(path).unwrap();
        let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    }
    /// Ticket 437: `send` hands SSH the handle that wrote the request. Its file swapped for a FIFO before SSH starts is
    /// never opened (a reopen by path would wait there for a writer), and SSH still reads the whole request.
    #[test]
    fn send_with_its_request_file_swapped_for_a_fifo_does_not_block() {
        let dir = std::env::temp_dir().join(format!("ns-request-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ssh = dir.join("ssh");
        fs::write(
            &ssh,
            "#!/bin/sh\ncat > \"$(dirname \"$0\")/stdin\"\nprintf '{\"Err\":\"stub reply\"}'\n",
        )
        .unwrap();
        fs::set_permissions(&ssh, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
        // Only `send` here and channel/probe paths no unit test reaches spawn `NUNCHIRO_SSH`.
        unsafe { std::env::set_var("NUNCHIRO_SSH", &ssh) };
        let (tx, rx) = std::sync::mpsc::channel();
        let home = dir.clone();
        std::thread::spawn(move || {
            AFTER_REQUEST.set(Some(swap_for_fifo));
            let _ = tx.send(send(&home, "mini", Request::List, None));
        });
        let reply = rx.recv_timeout(Duration::from_secs(10));
        let stdin = fs::read_to_string(dir.join("stdin"));
        let left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("remote-"))
            .collect();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(reply.expect("send blocked").unwrap_err(), "stub reply");
        let sent: serde_json::Value = serde_json::from_str(&stdin.unwrap()).unwrap();
        assert_eq!(sent["request"], serde_json::json!({"op":"list"}));
        assert!(left.is_empty(), "{left:?}");
    }
    /// Ticket 437: the request file swapped for a FIFO after it was written; SSH's stdin still reads the request at
    /// once from the kept handle.
    #[test]
    fn request_file_swapped_for_a_fifo_does_not_block() {
        use std::io::Read;
        let dir = std::env::temp_dir().join(format!("ns-request-file-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("remote-x.tmp");
        let mut file = request_file(&path, b"{\"request\":1}").unwrap();
        swap_for_fifo(&path);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut read = String::new();
            let _ = tx.send(file.read_to_string(&mut read).map(|_| read));
        });
        let read = rx.recv_timeout(Duration::from_secs(2));
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(read.unwrap().unwrap(), "{\"request\":1}");
    }

    mod old_reader {
        use super::*;

        // Verbatim Config from 5d02b8dfa2bbee70d2570fa76e767fd1d42256b8, before ticket 41.
        #[derive(Clone, Default, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub(crate) struct Config {
            pub projects: BTreeMap<PathBuf, PathBuf>,
        }
    }

    #[test]
    fn machine_config_old_reader_compatibility() {
        let legacy = serde_json::json!({"projects":{"/local":"/remote"}});
        let old: old_reader::Config = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(old.projects[Path::new("/local")], Path::new("/remote"));
        let current: Config = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(current.projects, old.projects);
        for (field, value) in [
            ("host", serde_json::json!("macbook.local")),
            ("user", serde_json::json!("me")),
            ("port", serde_json::json!(22)),
        ] {
            let mut fixture = legacy.clone();
            fixture[field] = value;
            assert!(serde_json::from_value::<Config>(fixture.clone()).is_ok());
            let error = serde_json::from_value::<old_reader::Config>(fixture)
                .err()
                .expect("the pre-change reader must reject the new field");
            assert!(
                error
                    .to_string()
                    .contains(&format!("unknown field `{field}`")),
                "{error}"
            );
        }
        let settings = serde_json::json!({"machines":{"macbook":Config {
            projects: current.projects,
            host: Some("macbook.local".into()), user: Some("me".into()), port: Some(22),
        }}});
        let current: BTreeMap<String, Config> =
            serde_json::from_value(settings["machines"].clone()).unwrap();
        assert_eq!(current["macbook"].port, Some(22));
        assert!(
            serde_json::from_value::<BTreeMap<String, old_reader::Config>>(
                settings["machines"].clone()
            )
            .is_err()
        );
    }
}
