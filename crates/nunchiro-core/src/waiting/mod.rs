//! Read-only adapters for current terminal and transcript turn state.
pub mod screen;
pub mod transcript;

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
pub struct Observer {
    pub screen: screen::Screen,
    pub output_offset: u64,
    // v1a-19 r2: the last pass left output unfed, so `screen` (and the screen queue item) is not current.
    pub behind: bool,
    pub transcript: Option<PathBuf>,
    pub next_search: Instant,
    /// Ticket 501: the wait before the next search for a transcript not found yet.
    pub search_wait: Duration,
    /// When the last search was planned: a hook never brings the next one closer than `SEARCH_FIRST` after it.
    pub searched_at: Option<Instant>,
    /// Set by a new start: the core may answer Claude's question about the session's own artifact folder
    /// (`screen::add_dir_question`). Cleared by the answer or by Claude's input box (the start is over), never by the time
    /// (look 11-17 v3 P2: a trust question answered after a minute was followed by that question): nothing an agent
    /// prints later can make the core press a key. The instant is when the start began.
    pub own_folder: Option<Instant>,
    /// When the core last moved the cursor on that question: a second chunk of the same screen does not move it again.
    pub own_folder_key: Option<Instant>,
    /// w10 item 12: since when the start question the core answers itself is on the screen. Past `OWN_GIVE_UP` the core
    /// stops answering it and it shows as a card; while it waits the observer reads the screen even with no new output
    /// (`recheck`), so a key Claude did not take is pressed again.
    pub own_folder_since: Option<Instant>,
    pub recheck: bool,
    /// Seventh look (B S1-1): the screen as the agent last drew it, kept when a resize blanks `screen`, and since when.
    /// An agent that draws nothing after the resize (no SIGWINCH reached it, or it saw no change) leaves the terminal
    /// showing this: `Sessions::tick` puts it back once the redraw's time is over.
    pub unredrawn: Option<(screen::Screen, Instant)>,
    /// Look 11-17 v5 item 1: when the tick last looked for a question on an unchanged screen with no card for it.
    pub reread: Option<Instant>,
    /// Until when the screen may end the turn: set when the core writes an interrupt key (Esc, Ctrl+C) to a working
    /// Claude. Claude 2.1.326 fires no hook and may write no record when a turn is interrupted, so its input box back
    /// with no "esc to interrupt" footer is the only sign the turn ended (look 11-17 N0).
    pub interrupted: Option<Instant>,
    /// Look 1117 v12 N12-S2-3: since when the screen has shown that box with no working footer, frame after frame. Only
    /// a box that stays a second ends the turn: a Claude that goes on after a hook's deny (it did not honour the deny's
    /// `interrupt`) draws its box for a frame between the dialog and its next step, and the deny's instruction was
    /// typed into that running turn and lost.
    pub at_box: Option<Instant>,
    /// Look 11-17 v3 P1: a new Claude start whose input box has not shown yet (its startup questions may still come).
    /// Ended by the box, by the session's first hook after SessionStart (a turn's hooks run after the startup questions;
    /// SessionStart fires before the box is drawn, look 11-17 v8 N1), or by `STARTUP_QUIET` with
    /// no question on the screen (`quiet_since`), so a box this build cannot read never holds a first message for ever.
    pub before_box: bool,
    /// Since when the screen of a starting session shows no question; `None` while one shows, and until its first output
    /// (w10 item 2: many seats starting under load draw their first screen late; the quiet time counts from it).
    pub quiet_since: Option<Instant>,
    /// When a new start began, until its first output: a session that never draws anything ends its start after
    /// `STARTUP_SILENT`.
    pub silent_since: Option<Instant>,
    /// Look 11-17 v3 P3: the core interrupted this Claude; the next submit clears its input box first (an early Stop puts
    /// the stopped prompt back there, and the follow-up was glued after it).
    pub clear_box: bool,
    /// Look 11-17 v3 P5: this core has read a permission-mode footer on this session's screen.
    pub footer_seen: bool,
    /// Ticket 1010: Claude's fast mode pause notice on the last screen read (`claude_modes::fast_read`): one that stays
    /// up is read once.
    pub fast_notice: Option<String>,
}
/// Ticket 501: a Codex search walks the whole sessions folder. The first waits are short (a new session writes its
/// transcript within a turn); each search doubles the wait, up to `SEARCH_MAX`. A found transcript is not searched for
/// again, so only searches that find nothing ever wait long.
/// Look 11-17 v3 P1: how long a starting session's screen shows no question before its start counts as over.
pub(crate) const STARTUP_QUIET: Duration = Duration::from_secs(20);
/// w10 item 12: how long the core keeps answering one of Claude's start questions itself before it is a card.
pub(crate) const OWN_GIVE_UP: Duration = Duration::from_secs(10);
/// w10 item 2: a start that has drawn nothing at all for 120 s is over too (a held first message is not kept for
/// ever; a real Claude draws its first screen in seconds, a loaded machine in well under two minutes).
pub(crate) const STARTUP_SILENT: Duration = Duration::from_secs(120);
/// `STARTUP_QUIET`, or the override of a test run: the web specs' fake agent draws no input box, so every first message
/// there would wait the whole quiet time (NUNCHIRO_STARTUP_QUIET_MS, as NUNCHIRO_SETTLE_MS shortens the settle time).
pub(crate) fn startup_quiet() -> Duration {
    static QUIET: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *QUIET.get_or_init(|| {
        std::env::var("NUNCHIRO_STARTUP_QUIET_MS")
            .ok()
            .and_then(|ms| ms.parse().ok())
            .map_or(STARTUP_QUIET, Duration::from_millis)
    })
}
pub(crate) const SEARCH_FIRST: Duration = Duration::from_millis(500);
pub(crate) const SEARCH_MAX: Duration = Duration::from_secs(30);
impl Default for Observer {
    fn default() -> Self {
        Self {
            screen: screen::Screen::new(160, 50),
            output_offset: 0,
            behind: false,
            transcript: None,
            next_search: Instant::now(),
            search_wait: SEARCH_FIRST,
            searched_at: None,
            own_folder: None,
            own_folder_key: None,
            own_folder_since: None,
            recheck: false,
            unredrawn: None,
            reread: None,
            interrupted: None,
            at_box: None,
            before_box: false,
            quiet_since: None,
            silent_since: None,
            clear_box: false,
            footer_seen: false,
            fast_notice: None,
        }
    }
}
impl Observer {
    /// Whether a search for the transcript is due at `now`; when it is, the next one is set `search_wait` later and
    /// the wait after it doubles. Here, not after the search: the observer drops a search that found nothing without
    /// coming back to the registry.
    pub(crate) fn search_due(&mut self, now: Instant) -> bool {
        if now < self.next_search {
            return false;
        }
        self.next_search = now + self.search_wait;
        self.searched_at = Some(now);
        self.search_wait = (self.search_wait * 2).min(SEARCH_MAX);
        true
    }
    /// The agent did something (a hook): its transcript may exist now, so search at the next tick, but never sooner
    /// than `SEARCH_FIRST` after the last search (security r1: a hook flood would otherwise walk at the tick rate).
    pub(crate) fn search_soon(&mut self, now: Instant) {
        self.search_wait = SEARCH_FIRST;
        let soon = self
            .searched_at
            .map_or(now, |at| now.max(at + SEARCH_FIRST));
        self.next_search = self.next_search.min(soon);
    }
}

/// Immutable read plan; discovery and transcript I/O run outside the registry lock.
pub(crate) struct TranscriptJob {
    pub session: crate::api::Session,
    pub path: Option<PathBuf>,
    pub key: String,
    pub offset: u64,
    pub discarding: bool,
}
impl TranscriptJob {
    pub fn read(&self) -> (Option<PathBuf>, Result<Option<transcript::Batch>, String>) {
        let path = self
            .path
            .clone()
            .or_else(|| transcript::locate(&self.session));
        let result = match &path {
            Some(path) => transcript::read_batch(path, &self.key, self.offset, self.discarding),
            None => Ok(None),
        };
        (path, result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ticket 501: a Codex session whose transcript is never found, ticked every 50 ms for 60 s as the core's registry
    /// tick does: each due search walks `~/.codex/sessions`. Was 120 walks a minute (every 500 ms).
    #[test]
    fn a_missing_transcript_is_searched_less_often() {
        let mut o = Observer::default();
        let start = Instant::now();
        o.next_search = start;
        let walks = |o: &mut Observer, from: Duration, to: Duration| {
            let mut n = 0;
            let mut t = from;
            while t < to {
                if o.search_due(start + t) {
                    n += 1;
                }
                t += Duration::from_millis(50);
            }
            n
        };
        let minute = walks(&mut o, Duration::ZERO, Duration::from_secs(60));
        // 0, 0.5, 1.5, 3.5, 7.5, 15.5, 31.5, then every 30 s: 7 walks in the first minute.
        assert!(minute <= 8, "{minute} walks in a minute");
        assert_eq!(o.search_wait, SEARCH_MAX);
        let next = walks(&mut o, Duration::from_secs(60), Duration::from_secs(120));
        assert!(next <= 2, "{next} walks in the second minute");
        // Security r1: a hook flood (one per 50 ms tick) never searches more than once per `SEARCH_FIRST`.
        let mut flood = 0;
        let mut t = Duration::from_secs(120);
        while t < Duration::from_secs(130) {
            o.search_soon(start + t);
            if o.search_due(start + t) {
                flood += 1;
            }
            t += Duration::from_millis(50);
        }
        assert!(flood <= 20, "{flood} searches in 10 s of hooks");
        // A hook resets it: searched again at once, then soon.
        let later = start + Duration::from_secs(200);
        o.search_soon(later);
        assert_eq!(o.search_wait, SEARCH_FIRST);
        assert!(o.search_due(later));
    }
}
