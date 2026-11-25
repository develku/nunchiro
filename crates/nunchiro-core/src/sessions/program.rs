//! The agent program a session runs and its shared `--version` probes.
use super::*;
pub(super) type VersionProbe = std::sync::mpsc::Receiver<Result<String, String>>;
pub(super) const VERSION_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
// The probe's own bound: a hung binary's process group is killed here and the session reads `unknown`.
pub(super) const VERSION_CEILING: std::time::Duration = std::time::Duration::from_secs(60);
/// V1A-91: a program as given and the file it resolves to; probes of one key share one child.
type FlightKey = (String, Option<PathBuf>);
type Flights = BTreeMap<FlightKey, Vec<std::sync::mpsc::Sender<Result<String, String>>>>;
static VERSION_FLIGHTS: std::sync::Mutex<Flights> = std::sync::Mutex::new(BTreeMap::new());
fn flights() -> std::sync::MutexGuard<'static, Flights> {
    VERSION_FLIGHTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
/// Frees its flight's slot when the probe answers, fails, or its thread panics or never starts; a freed slot's
/// waiters get the answer, or a closed channel (which reads as "probe ended without an answer").
struct Flight(Option<FlightKey>);
impl Flight {
    fn finish(mut self) -> Vec<std::sync::mpsc::Sender<Result<String, String>>> {
        let key = self.0.take().unwrap();
        flights().remove(&key).unwrap_or_default()
    }
}
impl Drop for Flight {
    fn drop(&mut self) {
        if let Some(key) = self.0.take() {
            flights().remove(&key);
        }
    }
}
/// The program a Claude or Codex session runs: the approved path (ticket 358), else `name` on PATH. Ticket 32: unit tests point it at fake agents instead of
/// changing the process PATH, which other threads read.
pub(super) fn agent_program(
    name: &'static str,
    approved: Option<&crate::approval::CommandProof>,
) -> String {
    if let Some(approved) = approved {
        return approved.path().to_string();
    }
    #[cfg(test)]
    if let Some((claude, codex)) = FAKE_AGENTS.get() {
        return if name == "claude" { claude } else { codex }.clone();
    }
    name.to_string()
}
/// The file `program` runs, found as `execvp` finds it on the core's PATH (which it never changes), through
/// symlinks; `None` when there is none (the spawn then fails on its own).
pub(super) fn resolved(program: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    if program.contains('/') {
        return fs::canonicalize(program).ok();
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(program))
        .find(|p| fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
        .and_then(|p| fs::canonicalize(p).ok())
}
/// Runs `agent_version` on its own thread; the answer, or the error naming the program, arrives on the receiver.
/// V1A-91: a call while a probe of the same program and file is in flight waits on that probe's answer instead.
// shortcut: a core that dies mid-probe leaves the probe child running until it exits on its own (its own process
// group, no ceiling left to kill it); record probe pids for the next core to kill if hung `--version` binaries show up.
pub(super) fn version_probe(
    program: &str,
    ceiling: std::time::Duration,
) -> Result<VersionProbe, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let key = (program.to_string(), resolved(program));
    {
        let mut flights = flights();
        if let Some(waiting) = flights.get_mut(&key) {
            waiting.push(sender);
            return Ok(receiver);
        }
        flights.insert(key.clone(), vec![sender]);
    }
    // Moved into the thread; a spawn that fails drops it, which frees the slot.
    let flight = Flight(Some(key));
    let program = program.to_string();
    std::thread::Builder::new()
        .name("version-probe".into())
        .spawn(move || {
            let answer = agent_version(&program, ceiling);
            let answer = answer.map_err(|e| format!("{program} --version: {e}"));
            for sender in flight.finish() {
                let _ = sender.send(answer.clone());
            }
        })
        .map_err(|e| format!("version probe thread: {e}"))?;
    Ok(receiver)
}
fn agent_version(program: &str, ceiling: std::time::Duration) -> Result<String, String> {
    let mut command = crate::process::command(program);
    command.arg("--version");
    let output = match crate::process::output(command, ceiling) {
        // Ticket 424 round 2: a run killed before it printed stays "unknown", as any other failed run.
        Err(e) if e.ends_with(crate::process::KILLED_SILENT) => return Ok("unknown".into()),
        result => result?,
    };
    if !output.status.success() {
        return Ok("unknown".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}
