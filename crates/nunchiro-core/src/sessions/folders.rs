//! The Assistant's folder grants in the registry (`folder_grant` has the rules): a folder the owner names in a message
//! typed in the window becomes a working folder of that run (Claude's `/add-dir`, its two questions answered by the
//! core for exactly that folder), read and write for the conversation. The owner's message waits until the folder is
//! added (`granting` holds every send to the seat), so the seat reads it with the folder in reach.
use super::*;
use crate::folder_grant::{self, Step};
use std::time::{Duration, Instant};

/// One run's folders on their way in: the queue, and the one being added now.
#[derive(Default)]
pub(crate) struct Granting {
    /// Each folder with the time it was offered: the deadline counts from there, typed or not.
    pending: Vec<(PathBuf, Instant)>,
    now: Option<Adding>,
}
impl Granting {
    fn offer(&mut self, folder: PathBuf, at: Instant) {
        let busy = self.now.as_ref().is_some_and(|a| a.folder == folder);
        if !busy && !self.pending.iter().any(|(f, _)| *f == folder) {
            self.pending.push((folder, at));
        }
    }
    /// The offers past `GIVE_UP` that were never typed (no box showed in time) leave the queue.
    fn expire(&mut self, at: Instant) -> Vec<PathBuf> {
        let (old, keep) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|(_, offered)| at.duration_since(*offered) > GIVE_UP);
        self.pending = keep;
        old.into_iter().map(|(f, _)| f).collect()
    }
    /// `/add-dir` is on the screen now: its questions are the core's, not cards.
    pub(super) fn adding(&self) -> bool {
        self.now.is_some()
    }
}
struct Adding {
    folder: PathBuf,
    offered: Instant,
    entered: bool,
    /// The core's Down went out for the first question (Enter only after it).
    downed: bool,
    key: Instant,
}
/// How long the line and its Enter, and each answer, wait for Claude to draw; and when an add is given up (the folder
/// then stays out, and the owner's message goes on).
const ENTER_AFTER: Duration = Duration::from_millis(600);
const KEY_GAP: Duration = Duration::from_millis(800);
const GIVE_UP: Duration = Duration::from_secs(30);

impl Sessions {
    /// The owner typed `text` to session `id` in the window's composer (`folder_offer`): the folders it names
    /// (`folder_grant::named`) are added to
    /// the run when it is the Assistant's (Home) Claude seat. Every other sender and seat gets none.
    pub(crate) fn grant_named_folders(&mut self, id: &str, text: &str) -> Vec<PathBuf> {
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        let meta = &entry.meta;
        if !meta.home_lock
            || meta.kind != AgentKind::Claude
            || meta.side_chat
            || !entry.agent_live()
            || entry.pty.is_none()
        {
            return vec![];
        }
        let had = meta.folders.clone();
        let named = folder_grant::named(text, &self.settings.user_home, &self.home);
        // A folder the owner removed in this run is still one of Claude's working folders: naming it again gives it
        // back at once, with no `/add-dir` (Claude would not ask again).
        let mut grants = folder_grant::load(&self.home, id);
        let back: Vec<PathBuf> = named
            .iter()
            .filter(|f| !had.contains(f) && grants.removed.contains(f))
            .cloned()
            .collect();
        if !back.is_empty() {
            grants.removed.retain(|r| !back.contains(r));
            if let Ok(entry) = self.entry(id) {
                entry.meta.folders.extend(back.iter().cloned());
                grants.granted = entry.meta.folders.clone();
            }
            if let Err(e) = folder_grant::save(&self.home, id, &grants).and_then(|()| self.save()) {
                eprintln!("session {id}: folder access: {e}");
            }
        }
        let at = Instant::now();
        let g = self.folder_grants.entry(id.to_string()).or_default();
        let mut coming = back.clone();
        for folder in named
            .into_iter()
            .filter(|f| !had.contains(f) && !back.contains(f))
        {
            g.offer(folder.clone(), at);
            coming.push(folder);
        }
        coming
    }
    /// A folder is on its way in: the seat takes no other input until it is added or given up.
    pub(crate) fn granting(&self, id: &str) -> bool {
        self.folder_grants
            .get(id)
            .is_some_and(|g| g.now.is_some() || !g.pending.is_empty())
    }
    /// Each tick: types `/add-dir <folder>` into an idle seat, answers its two questions for exactly that folder, and
    /// records the folder once Claude says it was added.
    pub(super) fn advance_grants(&mut self) {
        let ids: Vec<String> = self.folder_grants.keys().cloned().collect();
        for id in ids {
            if let Err(e) = self.advance_grant(&id) {
                eprintln!("session {id}: folder access: {e}");
                self.folder_grants.remove(&id);
            }
        }
    }
    fn advance_grant(&mut self, id: &str) -> Result<(), String> {
        let at = Instant::now();
        let live = self.entries.get(id).is_some_and(|e| e.agent_live());
        if !live {
            self.folder_grants.remove(id);
            return Ok(());
        }
        let idle = !self.queue.attention(id).working && !self.pending_enter.contains_key(id);
        let entry = self.entry(id)?;
        let text = entry.observer.screen.text();
        // An empty box, or one that shows only Claude's faint suggested prompt (typing replaces it).
        let at_box = composer(&text, entry.meta.kind)
            .is_some_and(|b| b.trim().is_empty() || entry.observer.screen.composer_faint());
        let (user_home, home) = (self.settings.user_home.clone(), self.home.clone());
        let g = self.folder_grants.entry(id.to_string()).or_default();
        for folder in g.expire(at) {
            eprintln!(
                "session {id}: {} was never added (no input box in time)",
                folder.display()
            );
        }
        let mut keys: Vec<u8> = vec![];
        let mut done: Option<(PathBuf, bool)> = None;
        match &mut g.now {
            None if g.pending.is_empty() => {
                self.folder_grants.remove(id);
                return Ok(());
            }
            None if idle && at_box => {
                let (folder, offered) = g.pending.remove(0);
                // Checked again now: the path may lead elsewhere since it was named (a folder swapped for a link).
                if !folder_grant::still(&folder, &user_home, &home) {
                    eprintln!(
                        "session {id}: {} changed since it was named",
                        folder.display()
                    );
                    return Ok(());
                }
                keys.extend(format!("/add-dir {}", folder.display()).bytes());
                g.now = Some(Adding {
                    folder,
                    offered,
                    entered: false,
                    downed: false,
                    key: at,
                });
            }
            None => {}
            Some(a) if at.duration_since(a.offered) > GIVE_UP => {
                keys.push(0x1b); // a question still open is left with Esc
                done = Some((a.folder.clone(), false));
            }
            Some(a) if !a.entered => {
                if at.duration_since(a.key) >= ENTER_AFTER {
                    keys.push(b'\r');
                    a.entered = true;
                    a.key = at;
                }
            }
            Some(a) => match folder_grant::step(&text, &a.folder, a.downed) {
                Step::Added => done = Some((a.folder.clone(), true)),
                Step::Failed => done = Some((a.folder.clone(), false)),
                Step::Keys(k) if at.duration_since(a.key) >= KEY_GAP => {
                    a.downed |= k == b"\x1b[B";
                    a.key = at;
                    keys.extend_from_slice(k);
                }
                Step::Keys(_) | Step::Wait => {}
            },
        }
        if done.is_some() {
            g.now = None;
        }
        if !keys.is_empty() {
            let entry = self.entry(id)?;
            entry.observer.recheck = true;
            entry
                .pty
                .as_mut()
                .ok_or("the seat has no terminal")?
                .write(&keys)?;
        }
        match done {
            Some((folder, true)) if !folder_grant::still(&folder, &user_home, &home) => {
                eprintln!(
                    "session {id}: {} changed while it was added",
                    folder.display()
                );
            }
            Some((folder, true)) => {
                let entry = self.entry(id)?;
                if !entry.meta.folders.contains(&folder) {
                    entry.meta.folders.push(folder);
                }
                self.save_folders(id)?;
                self.save()?;
            }
            Some((folder, false)) => {
                eprintln!(
                    "session {id}: {} was not added as a working folder",
                    folder.display()
                );
            }
            None => {}
        }
        Ok(())
    }
    /// The window's Remove on a folder's line: the grant ends. Claude keeps the folder among its working folders for
    /// this run, so the lock hook refuses its file tools there from now on.
    pub(crate) fn remove_folder(&mut self, id: &str, folder: &Path) -> Response {
        let entry = self.entry(id)?;
        let before = entry.meta.folders.len();
        entry.meta.folders.retain(|f| f != folder);
        if entry.meta.folders.len() == before {
            return Err("this conversation has no access to that folder".into());
        }
        let mut grants = folder_grant::load(&self.home, id);
        if !grants.removed.iter().any(|f| f == folder) {
            grants.removed.push(folder.to_path_buf());
        }
        grants.granted = self.entry(id)?.meta.folders.clone();
        folder_grant::save(&self.home, id, &grants)?;
        self.save()?;
        Ok(Reply::Ack)
    }
    /// The hook's file for run `id`: its granted folders now, and the removed ones it keeps refusing.
    fn save_folders(&mut self, id: &str) -> Result<(), String> {
        let mut grants = folder_grant::load(&self.home, id);
        grants.granted = self.entry(id)?.meta.folders.clone();
        grants.removed.retain(|r| !grants.granted.contains(r));
        folder_grant::save(&self.home, id, &grants)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A folder offered but never typed (no box ever showed) is dropped at the same deadline as one typed, so it cannot
    // hold the seat's sends for ever.
    #[test]
    fn an_offer_never_typed_is_dropped_at_the_deadline() {
        let at = Instant::now();
        let mut g = Granting::default();
        g.offer(
            PathBuf::from("/x/old"),
            at - GIVE_UP - Duration::from_secs(1),
        );
        g.offer(PathBuf::from("/x/new"), at);
        assert_eq!(g.expire(at), vec![PathBuf::from("/x/old")]);
        assert_eq!(
            g.expire(at + GIVE_UP + Duration::from_secs(1)),
            vec![PathBuf::from("/x/new")]
        );
        assert!(g.pending.is_empty());
    }
}
