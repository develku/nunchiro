//! Text left in an agent's terminal box comes home to the window's composer (the gap rule's last piece). One row of the
//! owner's words, no collapsed paste label, Type in terminal off and no key for `TYPING_QUIET`: the words are kept on disk
//! first (`<home>/aside/<id>.json`, a side file: an older core refuses unknown saved fields), then the box is cleared
//! with Ctrl+U, and once a later pass reads it empty the snapshot's `draft_home` hands the words to the composer, which
//! answers `draft_taken`. A box that stays full gets nothing more; more than one row or a label is never touched.
use super::*;

pub use crate::api::DraftHome;
/// A clear the core wrote and is waiting to see on the screen.
pub(super) struct Homing {
    /// What the side file holds: earlier words no window took, then `line`.
    words: String,
    /// The row of the box this clear takes out.
    line: String,
    at: std::time::Instant,
    /// The box did not read empty in time: nothing more is written for these words.
    stuck: bool,
    /// The side file still holds them.
    filed: bool,
}
/// How long a clear may take to show before the core stops trying for those words.
pub(super) const CLEAR_SHOWS: std::time::Duration = std::time::Duration::from_millis(1500);
const ASIDE: &str = "aside";

fn aside(home: &Path, id: &str) -> PathBuf {
    home.join(ASIDE).join(format!("{id}.json"))
}
/// The side files a core left, by session id (read at start). A file that does not read is left alone.
pub(super) fn load_aside(home: &Path) -> BTreeMap<String, DraftHome> {
    let Ok(dir) = fs::read_dir(home.join(ASIDE)) else {
        return BTreeMap::new();
    };
    dir.flatten()
        .filter_map(|e| {
            let id = e.file_name().to_str()?.strip_suffix(".json")?.to_string();
            let file = fs::File::open(e.path()).ok()?;
            let bytes = store::read_capped(file, 2 * crate::delivery::SEND_LIMIT as u64).ok()?;
            Some((id, serde_json::from_slice(&bytes).ok()?))
        })
        .collect()
}

impl Sessions {
    /// Session `id`'s box holds exactly one row of the owner's words that may come home now, if any.
    fn home_words(&self, id: &str) -> Option<String> {
        let e = self.entries.get(id)?;
        let now = std::time::Instant::now();
        if !self.owner_text(id)
            || e.observer.behind
            || e.pty
                .as_ref()
                .is_none_or(|p| p.end() != e.observer.output_offset)
            || self
                .home_quiet
                .get(id)
                .is_none_or(|(_, t)| t.elapsed() < SWITCH_SETTLE)
            || self.direct_until.get(id).is_some_and(|t| now < *t)
            || self.typing_until.get(id).is_some_and(|t| now < *t)
        {
            return None;
        }
        let screen = e.observer.screen.text();
        let first = composer(&screen, e.meta.kind)?;
        let rows = match e.meta.kind {
            AgentKind::Claude => box_rows(&screen),
            // Codex: the `›` row and no indented row under it before the blank row.
            _ => usize::from(box_text(&screen, e.meta.kind)? == first),
        };
        let words = first.trim().to_string();
        let label = words.starts_with("[Pasted") || words.starts_with("[Image");
        (rows == 1 && !label && !words.is_empty()).then_some(words)
    }
    /// One pass of the homecoming for session `id`: starts it (file, then Ctrl+U), or sees it through.
    pub(super) fn bring_home(&mut self, id: &str) -> Result<(), String> {
        if let Some(h) = self.homing.get(id) {
            let (stuck, filed, late) = (h.stuck, h.filed, h.at.elapsed() >= CLEAR_SHOWS);
            let (words, line) = (h.words.clone(), h.line.clone());
            let shown = self
                .entries
                .get(id)
                .and_then(|e| composer(&e.observer.screen.text(), e.meta.kind));
            if self.box_empty(id) {
                // The clear showed (late or not): the words are the composer's now. Not when the side copy went
                // because the box still showed them: then the owner emptied it himself.
                self.homing.remove(id);
                if filed {
                    self.entry(id)?.input = Default::default();
                    self.copy_gone(id);
                    let at = self.aside_at(id);
                    self.drafts_home.insert(id.into(), DraftHome { words, at });
                }
                return Ok(());
            }
            if !stuck && late {
                eprintln!(
                    "session {id}: the box did not read empty after its clear; nothing more is written"
                );
                self.homing.get_mut(id).unwrap().stuck = true;
            }
            if stuck || late {
                if shown.as_deref().is_some_and(|s| s.trim() == line) {
                    // The words are still in the box: the side copy of them is not needed (nothing is written again).
                    if filed {
                        self.unfile(id)?;
                        self.homing.get_mut(id).unwrap().filed = false;
                    }
                } else {
                    // Other words (he typed): this homecoming is over; a new one may start from them.
                    self.homing.remove(id);
                    if filed {
                        self.unfile(id)?;
                    }
                }
            }
            return Ok(());
        }
        let Some(words) = self.home_words(id) else {
            return Ok(());
        };
        // The words on disk first: a crash between the clear and the window loses nothing. Words no window took yet
        // stay in front of them (one line each).
        let at = queue::now_ms();
        let line = words.clone();
        let words = match self.drafts_home.get(id) {
            Some(before) => format!("{}\n{words}", before.words),
            None => words,
        };
        store::private_dir(&self.home.join(ASIDE))?;
        let file = serde_json::to_vec(&DraftHome {
            words: words.clone(),
            at,
        })
        .map_err(|e| e.to_string())?;
        store::atomic_write(&aside(&self.home, id), &file)?;
        // Two Ctrl+U per row and one more (`clear_box_first`): the line, then the break before it.
        self.live(id)?.write(&b"\x15".repeat(3))?;
        self.submitted.remove(id);
        self.homing.insert(
            id.into(),
            Homing {
                words,
                line,
                at: std::time::Instant::now(),
                stuck: false,
                filed: true,
            },
        );
        Ok(())
    }
    /// The side file goes back to the words no window took yet (or goes, with none).
    fn unfile(&self, id: &str) -> Result<(), String> {
        match self.drafts_home.get(id) {
            Some(before) => store::atomic_write(
                &aside(&self.home, id),
                &serde_json::to_vec(before).map_err(|e| e.to_string())?,
            ),
            None => {
                let _ = fs::remove_file(aside(&self.home, id));
                Ok(())
            }
        }
    }
    /// The time the side file of session `id` holds (now when it cannot be read).
    fn aside_at(&self, id: &str) -> u64 {
        fs::read(aside(&self.home, id))
            .ok()
            .and_then(|b| serde_json::from_slice::<DraftHome>(&b).ok())
            .map_or_else(queue::now_ms, |d| d.at)
    }
    /// The window's composer took session `id`'s words: the side file goes.
    pub(super) fn draft_taken(&mut self, id: &str) -> Response {
        self.drafts_home.remove(id);
        match fs::remove_file(aside(&self.home, id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
        Ok(Reply::Ack)
    }
    /// ⌘Z on words that came home: they go back into the agent's empty box, as a paste, with no Enter.
    pub(super) fn draft_put_back(&mut self, id: &str, words: String) -> Response {
        self.refresh()?;
        self.observe()?;
        crate::delivery::check_text(self.entry(id)?.meta.kind, &words)?;
        if words.contains(['\n', '\r']) || words.trim().is_empty() {
            return Err("only one line of words goes back into the box".into());
        }
        self.current(id)?;
        if !self.entry(id)?.agent_live()
            || !self.box_empty(id)
            || self.pending_enter.contains_key(id)
        {
            return Err("the agent's box is not empty: nothing was written".into());
        }
        let paste = self
            .entry(id)?
            .pty
            .as_ref()
            .is_some_and(Pty::bracketed_paste);
        let bytes = if paste {
            [b"\x1b[200~", words.as_bytes(), b"\x1b[201~"].concat()
        } else {
            words.into_bytes()
        };
        self.live(id)?.write(&bytes)?;
        self.entry(id)?.input.mark_uncertain(); // his words are in the box again
        self.touch_input(id);
        Ok(Reply::Ack)
    }
    /// Session `id` is closed: its words that never came home go with it.
    pub(super) fn forget_home(&mut self, id: &str) {
        self.homing.remove(id);
        self.home_ask.remove(id);
        self.home_quiet.remove(id);
        if self.drafts_home.remove(id).is_some() || aside(&self.home, id).exists() {
            let _ = fs::remove_file(aside(&self.home, id));
        }
    }
    /// At start: side files of sessions the store no longer has.
    pub(super) fn drop_orphan_asides(&mut self) {
        let gone: Vec<String> = (self.drafts_home.keys())
            .filter(|id| !self.entries.contains_key(*id))
            .cloned()
            .collect();
        for id in gone {
            self.forget_home(&id);
        }
    }
    /// The delivery pass's part: clears seen through, Type in terminal just off, and sessions whose queued row waits only
    /// for text in the box (`wants`, on an otherwise ready session).
    pub(super) fn home_pass(&mut self, wants: &[String]) -> Result<bool, String> {
        self.note_quiet();
        let live = &self.entries;
        self.homing.retain(|id, _| live.contains_key(id));
        self.home_ask.retain(|id| live.contains_key(id));
        let mut ids: Vec<String> = self.homing.keys().chain(&self.home_ask).cloned().collect();
        ids.extend(wants.iter().cloned());
        ids.sort();
        ids.dedup();
        let mut wrote = false;
        for id in ids {
            let before = self.homing.contains_key(&id);
            self.bring_home(&id)?;
            wrote |= !before && self.homing.contains_key(&id);
            if !self.homing.contains_key(&id) && !self.owner_text(&id) {
                self.home_ask.remove(&id);
            }
        }
        Ok(wrote)
    }
    /// The output offset each session last showed and since when (the homecoming reads a still screen only).
    pub(super) fn note_quiet(&mut self) {
        let now = std::time::Instant::now();
        let live = &self.entries;
        self.home_quiet.retain(|id, _| live.contains_key(id));
        for (id, e) in &self.entries {
            let offset = e.observer.output_offset;
            match self.home_quiet.get_mut(id) {
                Some(q) if q.0 == offset => {}
                Some(q) => *q = (offset, now),
                None => {
                    self.home_quiet.insert(id.clone(), (offset, now));
                }
            }
        }
    }
}
