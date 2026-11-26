//! Bounded current-screen VT reader; scrollback never supplies a fresh decision.
use crate::{
    api::AgentKind,
    queue::{Choice, Kind},
};
#[derive(Debug)]
pub struct Detection {
    pub kind: Kind,
    pub text: String,
    pub choices: Vec<Choice>,
}
#[cfg(test)]
thread_local!(pub(crate) static TEXT_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) });
/// A faint cell's character is stored `FAINT` above its own code point (the last Unicode plane, private use); only
/// characters below `FAINT_MAX` are moved, so the sum is always a valid `char`.
const FAINT: u32 = 0x10_0000;
const FAINT_MAX: u32 = 0x1_0000;
fn plain(c: char) -> char {
    if c as u32 >= FAINT {
        char::from_u32(c as u32 - FAINT).unwrap_or(c)
    } else {
        c
    }
}

pub struct Screen {
    cells: Vec<Vec<char>>,
    cols: usize,
    rows: usize,
    x: usize,
    y: usize,
    saved: (usize, usize),
    escape: Vec<u8>,
    string: bool,
    utf8: Vec<u8>,
    /// Ticket 991 (B2): SGR 2 (faint) is on. A cell written faint holds its character moved up by `FAINT`, so every
    /// erase and scroll keeps working on plain `char`s; `text` moves it back.
    faint: bool,
    /// Something was written or erased here since this screen was made (a mode switch or a cursor move is neither).
    drawn: bool,
    /// Look 1117 v11 A-S3-7: the program in front switched to the alternate screen (`CSI ? 1049 h`, 1047, 47): a
    /// full-screen program (vim, less) waiting for keys. Kept through a resize by its caller.
    pub(crate) alt: bool,
    /// The agent's input box has shown on this screen (`note_box`): its start is over, so a start dialog's rows read
    /// later (a transcript view, a redraw caught before its box) are no card. Kept through a reset and a resize.
    pub(crate) started: std::sync::atomic::AtomicBool,
    // Rendered text, dropped by `feed`; the idle tick reads an unchanged screen every 50 ms.
    text_cache: std::sync::OnceLock<String>,
    // S9: what `read_once` read from this text (the permission mode footer), dropped with `text_cache`.
    read_cache: std::sync::OnceLock<Option<String>>,
    // W35 picker: `read_fast`'s slot (Claude's fast mode ↯), dropped with `text_cache`.
    fast_cache: std::sync::OnceLock<Option<Option<bool>>>,
}
impl Screen {
    pub fn new(cols: usize, rows: usize) -> Self {
        let cols = cols.clamp(1, 500);
        let rows = rows.clamp(1, 300);
        Self {
            cells: vec![vec![' '; cols]; rows],
            cols,
            rows,
            x: 0,
            y: 0,
            saved: (0, 0),
            escape: vec![],
            string: false,
            utf8: vec![],
            faint: false,
            drawn: false,
            alt: false,
            started: std::sync::atomic::AtomicBool::new(false),
            text_cache: std::sync::OnceLock::new(),
            read_cache: std::sync::OnceLock::new(),
            fast_cache: std::sync::OnceLock::new(),
        }
    }
    pub(crate) fn drawn(&self) -> bool {
        self.drawn
    }
    /// Lane w96: every cell is a space (a redraw that has cleared the screen and not yet drawn on it).
    pub(crate) fn blank(&self) -> bool {
        self.cells.iter().flatten().all(|c| *c == ' ')
    }
    /// This screen at another size, as a terminal keeps what it shows through a resize: rows leave at the top while
    /// the cursor is below the new last row, then rows and columns are cut or added at the bottom and the right.
    /// shortcut: a narrower size cuts long rows where xterm re-wraps them, so a prompt wider than the new size may
    /// not read; re-wrap here if an agent is seen to skip its redraw after getting narrower.
    pub(crate) fn fit(mut self, cols: usize, rows: usize) -> Self {
        let (cols, rows) = (cols.clamp(1, 500), rows.clamp(1, 300));
        while self.cells.len() > rows && self.y >= rows {
            self.cells.remove(0);
            self.y -= 1;
        }
        self.cells.resize(rows, vec![' '; cols]);
        for row in &mut self.cells {
            row.resize(cols, ' ');
        }
        (self.cols, self.rows) = (cols, rows);
        (self.x, self.y) = (self.x.min(cols - 1), self.y.min(rows - 1));
        self.saved = (self.saved.0.min(cols - 1), self.saved.1.min(rows - 1));
        self.text_cache.take();
        self.read_cache.take();
        self.fast_cache.take();
        self
    }
    pub fn feed(&mut self, bytes: &[u8]) {
        self.text_cache.take();
        self.read_cache.take();
        self.fast_cache.take();
        for &b in bytes {
            if !self.utf8.is_empty() && !(0x80..=0xbf).contains(&b) {
                self.utf8.clear();
                self.put('\u{fffd}');
            }
            if self.string {
                if b == 7 || b == b'\\' && self.escape.last() == Some(&27) {
                    self.string = false;
                    self.escape.clear();
                } else if b == 27 {
                    self.escape = vec![27];
                } else {
                    self.escape.clear();
                }
                continue;
            }
            if !self.escape.is_empty() {
                self.escape.push(b);
                if self.escape.len() > 256 {
                    self.escape.clear();
                    continue;
                }
                if self.escape.len() == 2 {
                    match b {
                        b']' | b'P' | b'^' | b'_' => {
                            self.string = true;
                            self.escape.clear();
                        }
                        b'[' | b'(' | b')' => {}
                        b'7' => {
                            self.saved = (self.x, self.y);
                            self.escape.clear();
                        }
                        b'8' => {
                            (self.x, self.y) = self.saved;
                            self.escape.clear();
                        }
                        _ => self.escape.clear(),
                    }
                } else if self.escape[1] == b'[' && (0x40..=0x7e).contains(&b) {
                    let seq = std::mem::take(&mut self.escape);
                    self.csi(&seq[2..seq.len() - 1], b);
                } else if self.escape[1] != b'[' {
                    self.escape.clear();
                }
                continue;
            }
            match b {
                27 => {
                    self.escape.push(b);
                    self.utf8.clear();
                }
                b'\r' => self.x = 0,
                b'\n' | 11 | 12 => self.newline(),
                8 => self.x = self.x.saturating_sub(1),
                9 => self.x = ((self.x / 8 + 1) * 8).min(self.cols - 1),
                0..=31 | 127 => {}
                _ => {
                    self.utf8.push(b);
                    match std::str::from_utf8(&self.utf8) {
                        Ok(s) => {
                            let chars: Vec<_> = s.chars().collect();
                            self.utf8.clear();
                            for ch in chars {
                                self.put(ch);
                            }
                        }
                        Err(e) if e.error_len().is_none() && self.utf8.len() < 4 => {}
                        _ => {
                            self.utf8.clear();
                            self.put('\u{fffd}');
                        }
                    }
                }
            }
        }
    }
    fn newline(&mut self) {
        self.y += 1;
        if self.y >= self.rows {
            self.cells.remove(0);
            self.cells.push(vec![' '; self.cols]);
            self.y = self.rows - 1;
        }
    }
    fn put(&mut self, ch: char) {
        if ('\u{300}'..='\u{36f}').contains(&ch) {
            return;
        }
        if self.x >= self.cols {
            self.x = 0;
            self.newline();
        }
        self.drawn = true;
        // The last plane is where faint cells are kept; a real character from it is drawn as unknown.
        let ch = if ch as u32 >= FAINT { '\u{fffd}' } else { ch };
        self.cells[self.y][self.x] = if self.faint && ch != ' ' && (ch as u32) < FAINT_MAX {
            char::from_u32(ch as u32 + FAINT).unwrap_or(ch)
        } else {
            ch
        };
        self.x += 1;
        if ('\u{1100}'..='\u{115f}').contains(&ch)
            || ('\u{2e80}'..='\u{a4cf}').contains(&ch)
            || ('\u{ac00}'..='\u{d7a3}').contains(&ch)
            || ch as u32 >= 0x1f000
        {
            if self.x < self.cols {
                self.cells[self.y][self.x] = '\0';
            }
            self.x += 1;
        }
    }
    fn csi(&mut self, raw: &[u8], command: u8) {
        let text = String::from_utf8_lossy(raw);
        let params: Vec<usize> = text
            .trim_start_matches(['?', '>', '!'])
            .split(';')
            .map(|n| n.parse().unwrap_or(0))
            .collect();
        let a = params.first().copied().unwrap_or(0);
        let n = a.max(1);
        let b = params.get(1).copied().unwrap_or(1).max(1);
        self.drawn |= b"JKP@XSTLM".contains(&command);
        match command {
            b'H' | b'f' => {
                self.y = n.saturating_sub(1).min(self.rows - 1);
                self.x = b.saturating_sub(1).min(self.cols - 1);
            }
            b'A' => self.y = self.y.saturating_sub(n),
            b'B' => self.y = self.y.saturating_add(n).min(self.rows - 1),
            b'C' => self.x = self.x.saturating_add(n).min(self.cols - 1),
            b'D' => self.x = self.x.saturating_sub(n),
            b'E' => {
                self.x = 0;
                self.y = self.y.saturating_add(n).min(self.rows - 1);
            }
            b'F' => {
                self.x = 0;
                self.y = self.y.saturating_sub(n);
            }
            b'G' | b'`' => self.x = n.saturating_sub(1).min(self.cols - 1),
            b'd' => self.y = n.saturating_sub(1).min(self.rows - 1),
            b'J' => match a {
                0 => {
                    self.cells[self.y][self.x.min(self.cols)..].fill(' ');
                    for row in &mut self.cells[self.y + 1..] {
                        row.fill(' ');
                    }
                }
                1 => {
                    for row in &mut self.cells[..self.y] {
                        row.fill(' ');
                    }
                    self.cells[self.y][..=self.x.min(self.cols - 1)].fill(' ');
                }
                2 | 3 => self.cells.iter_mut().for_each(|r| r.fill(' ')),
                _ => {}
            },
            b'K' => match a {
                0 => self.cells[self.y][self.x.min(self.cols)..].fill(' '),
                1 => self.cells[self.y][..=self.x.min(self.cols - 1)].fill(' '),
                2 => self.cells[self.y].fill(' '),
                _ => {}
            },
            b'P' => {
                let x = self.x.min(self.cols - 1);
                let n = n.min(self.cols - x);
                self.cells[self.y].drain(x..x + n);
                self.cells[self.y].extend(vec![' '; n]);
            }
            b'@' => {
                let x = self.x.min(self.cols - 1);
                for _ in 0..n.min(self.cols - x) {
                    self.cells[self.y].insert(x, ' ');
                    self.cells[self.y].pop();
                }
            }
            b'X' => {
                let x = self.x.min(self.cols - 1);
                self.cells[self.y][x..x.saturating_add(n).min(self.cols)].fill(' ');
            }
            b'S' => {
                for _ in 0..n.min(self.rows) {
                    self.cells.remove(0);
                    self.cells.push(vec![' '; self.cols]);
                }
            }
            b'T' => {
                for _ in 0..n.min(self.rows) {
                    self.cells.pop();
                    self.cells.insert(0, vec![' '; self.cols]);
                }
            }
            b'L' => {
                for _ in 0..n.min(self.rows) {
                    self.cells.insert(self.y, vec![' '; self.cols]);
                    self.cells.pop();
                }
            }
            b'M' => {
                for _ in 0..n.min(self.rows - self.y) {
                    self.cells.remove(self.y);
                    self.cells.push(vec![' '; self.cols]);
                }
            }
            // Look 1117 v11 A-S3-7: the alternate screen on and off (`CSI ? 1049 h` / `l`, and the older 1047 and 47).
            b'h' | b'l'
                if text.starts_with('?')
                    && params.iter().any(|p| matches!(p, 47 | 1047 | 1049)) =>
            {
                self.alt = command == b'h'
            }
            // Plain `CSI s` and `CSI u` only. With a marker, `u` is the kitty keyboard protocol (`CSI ? u` asks,
            // `CSI > 1 u` pushes, `CSI < u` pops, `CSI = 1 u` sets): Claude 2.1.326 sends `CSI ? u` after it draws its
            // "Adding a new directory" question, and read as a restore it moved the cursor home, so the rows Claude
            // drew next (the cursor mark on an option) landed at the top of the screen.
            b's' if !text.starts_with(['?', '>', '<', '=']) => self.saved = (self.x, self.y),
            b'u' if !text.starts_with(['?', '>', '<', '=']) => (self.x, self.y) = self.saved,
            // Only faint is kept. A colour's own parameters (`38;2;r;g;b`, `38;5;n`) are skipped: their 2 is no faint.
            b'm' if !text.starts_with(['?', '>', '!']) => {
                let mut i = 0;
                while i < params.len() {
                    match params[i] {
                        0 | 22 => self.faint = false,
                        2 => self.faint = true,
                        38 | 48 | 58 => i += if params.get(i + 1) == Some(&2) { 4 } else { 2 },
                        _ => {}
                    }
                    i += 1;
                }
            }
            _ => {}
        }
    }
    pub fn text(&self) -> String {
        self.text_cache
            .get_or_init(|| {
                #[cfg(test)]
                TEXT_CALLS.with(|c| c.set(c.get() + 1));
                self.cells
                    .iter()
                    .map(|r| {
                        r.iter()
                            .filter(|c| **c != '\0')
                            .map(|c| plain(*c))
                            .collect::<String>()
                            .trim_end()
                            .to_string()
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .clone()
    }
    /// Ticket 991 (B2): the last input-box row (`❯` or `›` in the first column) holds text and all of it is faint: an
    /// agent's placeholder or its suggested next prompt, not something the user typed.
    pub(crate) fn composer_faint(&self) -> bool {
        self.cells
            .iter()
            .rev()
            .find(|r| matches!(plain(r[0]), '❯' | '›'))
            .is_some_and(|r| {
                let mut text = r[1..]
                    .iter()
                    .filter(|c| !c.is_whitespace() && **c != '\0')
                    .peekable();
                text.peek().is_some() && text.all(|c| *c as u32 >= FAINT)
            })
    }
    /// S9: `read` of this screen's text, run once per screen change: snapshots read an unchanged screen many times a
    /// second. One reader per screen (the session's permission mode); a second reader would need its own slot.
    pub(crate) fn read_once(&self, read: impl FnOnce(&str) -> Option<String>) -> Option<String> {
        self.read_cache.get_or_init(|| read(&self.text())).clone()
    }
    /// Ticket 1010: Claude's `↯` in its footer, the rows under its input box (after the last `❯` row and the rule that
    /// closes the box): `Some(true)` when it is faint (Claude dims it while fast mode cools down), `None` with no `↯`
    /// there. One typed into the box or printed in the chat is not in these rows.
    pub(crate) fn fast_mark(&self) -> Option<bool> {
        let at = self.cells.iter().rposition(|r| plain(r[0]) == '❯')?;
        self.cells[at + 1..]
            .iter()
            .skip_while(|r| plain(r[0]) != '─')
            .flatten()
            .find(|c| plain(**c) == '\u{21AF}')
            .map(|c| *c as u32 >= FAINT)
    }
    /// W35 picker: `read_once`'s second slot, for the fast mode sign: `fast_mark` while `boxed` finds Claude's input box
    /// in this screen's text, `None` when the box is not on the screen.
    pub(crate) fn read_fast(&self, boxed: impl FnOnce(&str) -> bool) -> Option<Option<bool>> {
        *self
            .fast_cache
            .get_or_init(|| boxed(&self.text()).then(|| self.fast_mark()))
    }
    pub fn reset(&mut self) {
        let started = self.started();
        *self = Self::new(self.cols, self.rows);
        self.started = started.into();
    }
    /// The session's start is over (its first hook after SessionStart): start dialogs make no card from here.
    pub(crate) fn mark_started(&self) {
        self.started
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
    pub(crate) fn started(&self) -> bool {
        self.started.load(std::sync::atomic::Ordering::Relaxed)
    }
    /// Notes the agent's input box in `text` (this screen's text): a row from the first column that starts with `❯`
    /// (Claude) or `›` (Codex) and is no numbered choice. True when it is there.
    pub(crate) fn note_box(&self, text: &str) -> bool {
        let boxed = text
            .lines()
            .any(|l| l.starts_with(['\u{276f}', '\u{203a}']) && choice_row(l).is_none());
        if boxed {
            self.started
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        boxed
    }
    pub fn detect(&self, kind: AgentKind) -> Option<Detection> {
        if kind == AgentKind::Shell {
            return None;
        }
        self.detect_in(kind, &self.text())
    }
    /// `detect` on `text`, which must be this screen's `text()` (the observe pass builds it once for two readers).
    pub fn detect_in(&self, kind: AgentKind, text: &str) -> Option<Detection> {
        if kind == AgentKind::Shell {
            return None;
        }
        let normalized = text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        let trust = normalized.contains("trust this folder?")
            || normalized.contains("is this a project you created or one you trust")
            // Claude 2.1.326: the same question for a folder given with `--add-dir` ("Adding a new directory").
            || normalized.contains("is this a directory you created or one you trust")
            || normalized.contains("allow external claude.md file imports?");
        // w25-m: the same questions cut off by a short window (`cut_off`): no options to read, still the user's.
        let trust = trust || normalized.contains(CUT_OFF) || start_rows(text);
        let (mut choices, cursors) = Self::choices(text);
        let permission = normalized.contains("do you want to proceed?")
            || normalized.contains("would you like to run the following command")
            || normalized.contains("allow ") && normalized.contains("this time")
            // v1b-12: Claude Code's file edit, create and overwrite prompts. Only as a prompt (two choices or a
            // cancel hint), never agent prose; and a question asking the same words ("Enter to select") stays one.
            || !normalized.contains("enter to select")
                && (choices.len() >= 2 || normalized.contains("esc to cancel"))
                && ["do you want to make this edit to", "do you want to create", "do you want to overwrite"]
                    .iter()
                    .any(|p| normalized.contains(p));
        // A permission prompt whose preview shows a start dialog's words (an edit to a file holding them) stays one.
        // A start dialog only before the input box ever showed, never over a permission prompt (an edit to a file
        // holding its words), and only as the last fallback: it never changes a question, a plan or a notice.
        let boxed = self.note_box(text);
        let start = !permission && !boxed && !self.started() && start_dialog(text);
        let plan = choices.len() >= 2 && plan_dialog(&normalized);
        // Look 1117 v13 N13-S3-4: Codex's rate-limit nudge only switches this session's model or keeps it (its "never show
        // again" changes settings and stays terminal-only), so it is a question. Its list takes the digit alone: a digit
        // picks and closes it (Codex `ListSelectionView`), so an Enter after it would reach the composer.
        let rate_limit = kind == AgentKind::Codex
            && choices.len() >= 2
            && normalized.contains("approaching rate limits");
        if rate_limit {
            for choice in &mut choices {
                choice.keys.retain(|k| k != "enter");
            }
        }
        let question = normalized.contains("question 1/")
            || rate_limit
            || (normalized.contains("enter to select") || plan) && !permission && !trust;
        let background = normalized.contains("shell still running")
            || normalized.contains("shells still running");
        // Fail closed only for an idle choice prompt: one cursor line plus a confirm/cancel hint.
        // "esc to interrupt" (a working agent) and quoted `>` lists never match.
        // Look 1117 v12 N12-S2-2: Codex's popups end "enter select · esc back" (its rate-limit model switch) or "Press
        // enter to confirm or esc to go back".
        let unclassified_prompt = choices.len() >= 2
            && cursors == 1
            && [
                "enter to confirm",
                "enter to select",
                "esc to cancel",
                "enter select",
                "esc to go back",
            ]
            .iter()
            .any(|hint| normalized.contains(hint));
        let item_kind = if trust {
            Kind::Dialog
        } else if permission {
            Kind::Permission
        } else if question {
            Kind::Question
        } else if background {
            Kind::Background
        } else if unclassified_prompt || start {
            Kind::Dialog
        } else {
            return None;
        };
        // V2.5-87: no focus report reaches the card; the answer check compares this same text.
        for choice in &mut choices {
            choice.label = without_focus_reports(&choice.label);
        }
        Some(Detection {
            kind: item_kind,
            text: without_focus_reports(prompt_region(kind, text)),
            choices,
        })
    }
    fn choices(text: &str) -> (Vec<Choice>, usize) {
        let mut choices: Vec<Choice> = vec![];
        let mut cursors = 0;
        // Ticket 991 B4: a prompt numbers its options 1, 2, 3…; a diff or code row above it that reads like one (a
        // wrapped `0..100` → "0" ".100") is no option. Only the last run counted up from 1 is kept; with no option 1 on
        // screen (a scrolled list) every row stays, as before, so a dialog is never missed.
        let rows: Vec<_> = text.lines().filter_map(choice_row).collect();
        let rows = match rows.iter().rposition(|(n, _, _)| *n == "1") {
            Some(start) => {
                let run = rows[start..]
                    .iter()
                    .enumerate()
                    .take_while(|(i, (n, _, _))| n.parse::<usize>().ok() == Some(i + 1))
                    .count();
                &rows[start..start + run]
            }
            None => &rows[..],
        };
        for &(number, label, cursor) in rows {
            cursors += usize::from(cursor);
            let label = label.to_string();
            let low = label.to_lowercase();
            let changes_settings = low.contains("always")
                || low.contains("trust")
                || low.contains("don't ask")
                || low.contains("do not ask")
                || low.contains("remember")
                || low.contains("allow all")
                || low.contains("yes, and")
                || low.contains("permanent")
                || low.contains("never show");
            choices.push(Choice {
                label,
                keys: vec![number.into(), "enter".into()],
                changes_settings,
            });
        }
        (choices, cursors)
    }
}

/// Look 1117 v10 N10-S2-5: Claude's plan approval ("Ready to code?"; the heading scrolls off above a long plan), from
/// the lines right above its options; `normalized` is the screen's words, one space apart, lower case. A choice of
/// Claude's own options, answered as a question.
pub(crate) fn plan_dialog(normalized: &str) -> bool {
    normalized.contains("claude has written up a plan")
        && normalized.contains("would you like to proceed?")
}

/// Ticket 991 B3/B4: Claude draws its prompt below a full-width rule; the transcript above it (the banner, earlier output,
/// the tool row whose `⏺` blinks every second while it waits) is not the prompt. A decision's text is that region, so a
/// blink neither re-files the item under a new id nor fails the answer's screen check, and the card shows the request.
/// No rule, or no option row below it: the whole screen, as before.
fn prompt_region(kind: AgentKind, text: &str) -> &str {
    if kind == AgentKind::Codex {
        // w10 item 10 (S3): Codex's approval prompt starts at its own question; an earlier approval's line above it
        // ("You approved codex to run … this time") is not part of this request.
        // The first question on the screen, not the last: a command can print a second "Would you like to …" row, and
        // starting there would hide the real command above it.
        // Its sign-in screen starts at its welcome line: the logo above it is animated for the first seconds.
        let at = text.find("Would you like to ").or_else(|| {
            text.contains("Sign in with ChatGPT")
                .then(|| text.find("Welcome to Codex"))
                .flatten()
        });
        return at.map_or(text, |at| {
            &text[text[..at].rfind('\n').map_or(0, |n| n + 1)..]
        });
    }
    if kind != AgentKind::Claude {
        return text;
    }
    // From column 0 only (after one Codex look): Claude indents what the request holds (a command, a heredoc line of
    // the same character), so a rule inside the request cannot move the boundary and hide the lines above it.
    let rule = |l: &str| {
        let t = l.trim_end();
        t.chars().count() >= 20 && t.chars().all(|c| c == '\u{2500}')
    };
    // Byte offset of each line start (`lines` splits on '\n'; the screen's text has no '\r').
    let mut starts = vec![];
    let mut at = 0;
    for line in text.split('\n') {
        starts.push((at, line));
        at += line.len() + 1;
    }
    // Look 11-17 N1: Claude 2.1.326 draws a second rule inside its question dialog, above "4. Chat about this"; the
    // region starts at the last rule with the option list's first row ("1.") below it, else at the last rule.
    let first = |i: usize| {
        starts[i..]
            .iter()
            .any(|(_, l)| choice_row(l).is_some_and(|(n, _, _)| n == "1"))
    };
    let rules: Vec<usize> = (0..starts.len()).filter(|&i| rule(starts[i].1)).collect();
    match rules.iter().rev().find(|&&i| first(i)).or(rules.last()) {
        Some(&i) if starts[i..].iter().any(|(_, l)| choice_row(l).is_some()) => {
            &text[starts[i].0..]
        }
        _ => text,
    }
}

/// V2.5-87: drops the terminal's focus reports, as a tty echoes them (`^[[I` focus-in, `^[[O` focus-out: sent while the
/// agent is not reading raw input, they land on its screen as text) and raw. Nothing else: any other caret text is part
/// of what the agent shows (a command's `^[[:alpha:]]`), and the card must not hide it (review r1 MUST-1).
fn without_focus_reports(text: &str) -> String {
    ["^[[I", "^[[O", "\x1b[I", "\x1b[O"]
        .iter()
        .fold(text.to_string(), |t, report| t.replace(report, ""))
}

/// The marks a choice row may start with (cursor or radio).
pub(crate) const CHOICE_MARKS: [char; 5] = ['❯', '›', '>', '○', '●'];
/// v1a-24 r3: the one choice-row rule, shared with `sessions::composer` so the two cannot drift: a numbered option
/// (`N.` or `N)`) after optional marks and spaces. Gives its number, its label and whether a mark led it. v1a-24 r4:
/// no digit or `%` may follow, so `45.2%`, `2.1.310` or `3.5k` leading a status row is no option. v1a-30: anything
/// else may (`1.(default)`, `1.✅`, `1.` with its label wrapped): a missed option lets an Enter press a dialog's
/// default. Circled, bracketed and fullwidth numbers are no option; neither agent numbers its choices so.
/// Claude Code 2.1.326 asks about every `--add-dir` folder when a session starts ("Adding a new directory: <path> ...
/// No, exit / Yes, add it", the cursor on No; Enter there ends Claude). When `text` is that question about exactly
/// `folder`, the row the cursor is on: `false` on "No, exit", `true` on "Yes, add it". The terminal wraps a long path
/// onto the next rows: the rows between the heading and the next sentence, each without its indent, are the path, and
/// they must be `folder` to the letter (a space inside a row is the path's own).
pub fn add_dir_question(text: &str, folder: &std::path::Path) -> Option<bool> {
    if add_dir_folder(text)? != folder.to_string_lossy() {
        return None;
    }
    cursor_on_yes(text, "Yes, add it")
}

/// Look 11-17 C7: Claude's folder-trust question ("Accessing workspace: <path> ... Quick safety check: Is this a project
/// you created or one you trust? ... No, exit / Yes, I trust this folder", the cursor on No), read as `add_dir_question`.
pub fn trust_question(text: &str, folder: &std::path::Path) -> Option<bool> {
    if trust_folder(text)? != folder.to_string_lossy() {
        return None;
    }
    cursor_on_yes(text, "Yes, I trust this folder")
}

/// The folder Claude's trust question names, once drawn as far as the sentence after the path.
pub fn trust_folder(text: &str) -> Option<String> {
    let after = text.rsplit_once("Accessing workspace:")?.1;
    Some(
        after
            .split_once("Quick safety check")?
            .0
            .lines()
            .map(str::trim)
            .collect(),
    )
}

/// w25-m: Claude 2.1.328 draws its start questions (folder trust, "Adding a new directory") short below 30 rows; cut
/// off, they take only "No" and end in this hint ("To trust this folder, first make the window taller", "To add it, ...").
const CUT_OFF: &str = "first make the window taller";
/// The screen shows that hint: a start question no key may answer until the window is taller.
pub fn cut_off(text: &str) -> bool {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .contains(CUT_OFF)
}

/// w25-s: a start question's own option rows ("No, exit" and its Yes row), each a whole row: a narrow window wraps the
/// question past the terminal's rows and its heading scrolls off the top, while these rows stay at the bottom.
fn start_rows(text: &str) -> bool {
    let rows: Vec<&str> = text
        .lines()
        .map(|l| {
            l.trim_start_matches(|c: char| !c.is_alphanumeric())
                .trim_end()
        })
        .collect();
    rows.contains(&"No, exit")
        && rows
            .iter()
            .any(|r| *r == "Yes, I trust this folder" || *r == "Yes, add it")
}

/// A start dialog other than folder trust that waits for the user before the session starts: Claude's theme picker,
/// sign-in question and security notes, Codex's sign-in and update screens. Each is read by its heading row and a row of
/// its own below it (a numbered option or its hint), each a whole row: words inside a row of a diff or of code, or a
/// heading quoted without its dialog, are no start dialog. `detect_in` reads it only before the input box ever showed.
fn start_dialog(text: &str) -> bool {
    let rows: Vec<&str> = text.lines().map(str::trim).collect();
    let row = |r: &str| rows.iter().any(|l| l.eq_ignore_ascii_case(r));
    let starts = |r: &str| rows.iter().any(|l| l.starts_with(r));
    let option = |r: &str| {
        text.lines()
            .filter_map(choice_row)
            .any(|(_, label, _)| label.trim_start().starts_with(r))
    };
    let next = row("Press enter to continue");
    row("Choose the text style that looks best with your terminal")
        && row("To change this later, run /theme")
        || row("Select login method:") && option("Claude account with subscription")
        || row("Security notes:") && next && option("Claude can make mistakes.")
        || starts("Welcome to Codex") && next && option("Sign in with ChatGPT")
        || starts("\u{2728} Update available!") && next && option("Update now")
}

/// w25-s: a start question's "No, exit" row is still on the screen, read across rows a narrow window split: the question
/// waits even where the core cannot read it.
pub fn start_question_left(text: &str) -> bool {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .contains("No, exit")
}

/// The row the cursor is on in a "No, exit" / `yes` start question: `false` on No, `true` on Yes. The last such rows:
/// an answered question above (the trust question's own "No, exit") can still be on the screen (look 11-17 v4 N1).
fn cursor_on_yes(text: &str, yes: &str) -> Option<bool> {
    let row = |label: &str| {
        text.lines()
            .rev()
            .map(str::trim)
            .find(|l| l.ends_with(label))
    };
    let cursor = |l: &str| l.starts_with('\u{276f}');
    match (cursor(row("No, exit")?), cursor(row(yes)?)) {
        (true, false) => Some(false),
        (false, true) => Some(true),
        _ => None,
    }
}

/// The folder Claude's "Adding a new directory" question names, once the question is drawn as far as the sentence
/// after the path; `None` before that (the first rows of the question arrive in a read of their own).
pub fn add_dir_folder(text: &str) -> Option<String> {
    let after = text.rsplit_once("Adding a new directory:")?.1;
    Some(
        after
            .split_once("This session")?
            .0
            .lines()
            .map(str::trim)
            .collect(),
    )
}

/// The screen shows Claude's input box and no start question: the start is over. From then on the screen can hold
/// what an agent printed, so the core answers no start question after it.
pub fn past_start(text: &str) -> bool {
    // w10 item 3: the input box's own row, from the first column and no numbered choice (as `delivery::composer_mark`);
    // Claude's other start dialogs (theme, login method, an API key, MCP server approval) draw `❯ 1. …` rows.
    !text.contains("No, exit")
        && text
            .lines()
            .any(|l| l.starts_with('\u{276f}') && choice_row(l).is_none())
}

pub(crate) fn choice_row(line: &str) -> Option<(&str, &str, bool)> {
    let bare = line.trim_start();
    let rest = bare.trim_start_matches(|c: char| c.is_whitespace() || CHOICE_MARKS.contains(&c));
    let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    let label = rest[digits..].strip_prefix(['.', ')'])?;
    (digits > 0 && !label.starts_with(|c: char| c.is_ascii_digit() || c == '%'))
        .then(|| (&rest[..digits], label.trim(), bare.len() != rest.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// w10 item 10 (S3): a Codex approval card's text starts at its own question, never at an earlier approval's line.
    #[test]
    fn w10_codex_region_starts_at_its_question() {
        let screen = "  You approved codex to run git tag a HEAD this time\n\n  Would you like to run the following command?\n\n  $ git tag b HEAD\n\n\u{203a} 1. Yes, proceed (y)\n";
        let got = prompt_region(AgentKind::Codex, screen);
        assert!(got.starts_with("  Would you like to run"), "{got}");
        assert!(!got.contains("You approved"));
        let spoof = "  Would you like to run the following command?\n\n  $ rm -rf x; echo '\n  Would you like to run the following command?\n\n  $ ls'\n\n\u{203a} 1. Yes, proceed (y)\n";
        assert!(prompt_region(AgentKind::Codex, spoof).contains("rm -rf x"));
    }

    /// Look 11-17 v4 N1: in a narrow terminal the answered trust question (its own "No, exit") stays on the screen above
    /// the artifact folder's question; the rows read are the last ones, so the cursor row is found.
    #[test]
    fn n1_add_dir_question_below_an_answered_trust_question() {
        let folder = std::path::Path::new(
            "/private/var/folders/jr/T/ns-click-x/home/artifacts/765370bf-7a43",
        );
        let screen = " Accessing workspace:\n\n /tmp/orchard\n\n Quick safety check: Is this a project you created or one you trust?\n\n   No, exit\n \u{276f} Yes, I trust this folder\n\n Adding a new directory:\n\n /private/var/folders/jr/T/ns-c\n lick-x/home/artifacts/765370bf\n -7a43\n\n This session hasn't worked here before. Is this a directory you created or one you trust?\n\n \u{276f} No, exit\n   Yes, add it\n\n Esc to exit \u{b7} To add it, press \u{2193} to Yes, then Enter\n";
        assert_eq!(add_dir_question(screen, folder), Some(false));
        assert_eq!(
            add_dir_question(
                &screen.replace(
                    "\u{276f} No, exit\n   Yes, add it",
                    "  No, exit\n \u{276f} Yes, add it"
                ),
                folder
            ),
            Some(true)
        );
    }

    /// Look 11-17 v5 item 6: the folder's path cut at any column (40, 60, 80; inside a word, as "ns-c" / "lick-…"),
    /// by Claude's own wrap (each row indented) or by the terminal's (rows from column 0), is read whole.
    #[test]
    fn v5_6_a_wrapped_folder_path_is_read_whole() {
        let artifacts = "/private/var/folders/jr/yqyyd28j0z94g1w76lmd37hh0000gn/T/ns-click-p5pjqw61/home/artifacts/7d9f088a-1b2c-4d5e-8f90-123456789abc";
        let home = "/private/var/folders/jr/yqyyd28j0z94g1w76lmd37hh0000gn/T/ns-click-p5pjqw61/home/team/home";
        for cols in [40usize, 60, 80] {
            let rows = |path: &str| {
                let chars: Vec<char> = path.chars().collect();
                chars
                    .chunks(cols - 2)
                    .map(|c| format!(" {}\r\n", c.iter().collect::<String>()))
                    .collect::<String>()
            };
            let add = format!(
                " Adding a new directory:\r\n\r\n{}\r\n This session hasn't worked here before. Is this a directory you created or one you trust?\r\n\r\n \u{276f} No, exit\r\n   Yes, add it\r\n\r\n Enter to confirm \u{b7} Esc to cancel\r\n",
                rows(artifacts)
            );
            let trust = format!(
                " Accessing workspace:\r\n\r\n{}\r\n Quick safety check: Is this a project you created or one you trust?\r\n\r\n \u{276f} No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm \u{b7} Esc to cancel\r\n",
                rows(home)
            );
            // Claude's own wrap, then the terminal's: the whole path printed on one row at `cols` columns.
            let terminal = format!(
                " Adding a new directory:\r\n\r\n {artifacts}\r\n\r\n This session hasn't worked here before. Is this a directory you created or one you trust?\r\n\r\n \u{276f} No, exit\r\n   Yes, add it\r\n"
            );
            for (bytes, folder, add_dir) in [
                (add, artifacts, true),
                (trust, home, false),
                (terminal, artifacts, true),
            ] {
                let mut screen = Screen::new(cols, 40);
                screen.feed(bytes.as_bytes());
                let text = screen.text();
                let folder = std::path::Path::new(folder);
                let got = if add_dir {
                    add_dir_question(&text, folder)
                } else {
                    trust_question(&text, folder)
                };
                assert_eq!(got, Some(false), "{cols} columns:\n{text}");
            }
        }
    }

    /// Look 11-17 C7: Claude 2.1.326's folder-trust question, as its screen draws it; another folder is not read.
    #[test]
    fn c7_trust_question_names_the_folder_and_the_cursor_row() {
        let folder = std::path::Path::new("/Users/me/.nunchiro/team/home");
        let ask = |no: &str, yes: &str| {
            format!(
                " Accessing workspace:\n\n /Users/me/.nunchiro/team/home\n\n Quick safety check: Is this a project you created or one you trust?\n\n Security guide\n\n {no}No, exit\n {yes}Yes, I trust this folder\n\n Enter to confirm \u{b7} Esc to cancel\n"
            )
        };
        assert_eq!(trust_question(&ask("\u{276f} ", "  "), folder), Some(false));
        assert_eq!(trust_question(&ask("  ", "\u{276f} "), folder), Some(true));
        let other = std::path::Path::new("/Users/me/Projects/app");
        assert_eq!(trust_question(&ask("\u{276f} ", "  "), other), None);
        assert_eq!(
            add_dir_question(&ask("\u{276f} ", "  "), folder),
            None,
            "not the add-dir question"
        );
    }

    /// Look 11-17 N1: Claude 2.1.326's question dialog has a second rule above "4. Chat about this"; the item's text is
    /// the whole dialog from its heading, with the question and every option, not the tail below that rule.
    #[test]
    fn n1_question_region_starts_at_its_heading() {
        let rule = "\u{2500}".repeat(40);
        let screen = format!(
            "\u{276f} ask me\n{rule}\n \u{2610} Colour\n\nWhich colour should go in a comment?\n\n\u{276f} 1. red\n  2. blue\n  3. Type something.\n{rule}\n  4. Chat about this\n\nEnter to select \u{b7} \u{2191}/\u{2193} to navigate \u{b7} Esc to cancel\n"
        );
        let got = prompt_region(AgentKind::Claude, &screen);
        assert!(got.starts_with(&rule), "{got}");
        assert!(
            got.contains("Which colour should go in a comment?"),
            "{got}"
        );
        assert!(got.contains("4. Chat about this"), "{got}");
        // One rule above the options, as before: from that rule.
        let one = format!(
            "output\n{rule}\n Bash command\n Do you want to proceed?\n\u{276f} 1. Yes\n  2. No\n"
        );
        assert_eq!(prompt_region(AgentKind::Claude, &one), &one[7..]);
    }

    /// Claude 2.1.326's question about an `--add-dir` folder, as its screen draws it (the path wrapped at 64 columns).
    #[test]
    fn add_dir_question_names_the_folder_and_the_cursor_row() {
        let folder = std::path::Path::new(
            "/private/var/folders/jr/T/ns-click-x/home/artifacts/be76ce43-0d25-4934-8def-30c5d8ed7558",
        );
        let ask = |cursor_on_yes: bool| {
            let (no, yes) = if cursor_on_yes {
                ("  ", "\u{276f} ")
            } else {
                ("\u{276f} ", "  ")
            };
            format!(
                " Adding a new directory:\n /private/var/folders/jr/T/ns-c\n lick-x/home/artifacts/be76ce43-0d25-4934-8def-30c5d8ed\n 7558\n\n This session hasn't worked here before. Is this a directory you created or one you trust?\n\n Security guide\n\n {no}No, exit\n {yes}Yes, add it\n\n Enter to confirm · Esc to cancel\n"
            )
        };
        assert_eq!(add_dir_question(&ask(false), folder), Some(false));
        assert_eq!(add_dir_question(&ask(true), folder), Some(true));
        // Another folder, a folder below it, and the plain folder-trust question are not it.
        assert_eq!(
            add_dir_question(
                &ask(false),
                std::path::Path::new(
                    "/private/var/folders/jr/T/ns-click-x/home/artifacts/be76ce43"
                )
            ),
            None
        );
        assert_eq!(add_dir_question(&ask(false), &folder.join("sub")), None);
        // The question's first rows alone name no folder yet; the whole question names it with the wrap joined.
        assert_eq!(
            add_dir_folder(" Adding a new directory:\n /private/var/folders/jr/T/ns-c\n"),
            None
        );
        assert_eq!(add_dir_folder(&ask(false)).as_deref(), folder.to_str());
        // A path that differs only by a space is another folder (Codex look).
        let spaced = ask(false).replace("30c5d8ed\n 7558", "30c5d8ed\n 75 58");
        assert_eq!(add_dir_question(&spaced, folder), None);
        assert_eq!(
            add_dir_question(
                " Accessing workspace:\n /tmp/p\n \u{276f} No, exit\n   Yes, I trust this folder\n",
                std::path::Path::new("/tmp/p")
            ),
            None
        );
        // As Claude draws it: the options with no mark, a keyboard query (`CSI ? u`), then the mark by rows counted
        // up from where the drawing ended. The query moves no cursor, so the mark lands on its option.
        let mut live = Screen::new(160, 50);
        live.feed(
            format!(
                "\x1b7\x1b[r\x1b8\r\r\n────\r\r\n\x1b[2GAdding a new directory:\r\r\n\r\r\n\x1b[2G{}\r\r\n\r\r\n\x1b[2GThis session hasn't worked here before.\r\r\n\r\r\n\x1b[4GNo, exit\r\r\n\x1b[4GYes, add it\r\r\n\r\r\n\x1b[2GEnter to confirm · Esc to cancel\r\r\n\x1b[>0q\x1b[?u\x1b[c\r\x1b[1C\x1b[4A\u{276f}\x1b[4GNo, exit\r\x1b[3C\x1b[1BYes, add it\r\r\n\r\n\r\n",
                folder.display()
            )
            .as_bytes(),
        );
        assert_eq!(
            add_dir_question(&live.text(), folder),
            Some(false),
            "{}",
            live.text()
        );
        live.feed("\x1b[1C\x1b[4A\x1b[1D\x1b[4B\r\x1b[1C\x1b[4A \x1b[4GNo, exit\r\x1b[1C\x1b[1B\u{276f}\x1b[4GYes, add it\r\r\n\r\n\r\n".as_bytes());
        assert_eq!(
            add_dir_question(&live.text(), folder),
            Some(true),
            "{}",
            live.text()
        );
        // The question is a dialog card when the core does not answer it.
        let mut s = Screen::new(120, 20);
        s.feed(ask(false).replace('\n', "\r\n").as_bytes());
        assert_eq!(
            s.detect(AgentKind::Claude).map(|d| d.kind),
            Some(Kind::Dialog)
        );
    }

    /// w25-m: below 30 rows Claude 2.1.328 cuts its start questions off, draws no Yes row and takes only "No"; its hint
    /// says to make the window taller. That screen is a dialog card (no choices), and never one the core answers.
    #[test]
    fn w25m_cut_off_start_question_is_a_card() {
        let folder = std::path::Path::new("/tmp/orchard");
        let add = " Adding a new directory:\n /tmp/orchard\n \u{2193} No, exit\n Esc to exit \u{b7} To add it, first make the window taller\n";
        let trust = " Accessing workspace:\n   \u{2193} No, exit\n\n \u{26a0} To trust this folder, first make the\n window taller \u{b7} Esc to cancel\n";
        for text in [add, trust] {
            assert!(cut_off(text), "{text}");
            let mut s = Screen::new(63, 4);
            s.feed(text.replace('\n', "\r\n").as_bytes());
            let d = s.detect(AgentKind::Claude).expect(text);
            assert_eq!(d.kind, Kind::Dialog);
            assert!(d.choices.is_empty());
            assert_eq!(add_dir_question(text, folder), None);
            assert_eq!(trust_question(text, folder), None);
        }
        assert!(!cut_off(" \u{276f} No, exit\n   Yes, add it\n"));
    }

    /// Look 1117 v17 B (w25-s): a narrow side pane wraps the trust question onto more rows than the terminal has, and
    /// its heading ("Accessing workspace", "Is this a project ... you trust?") scrolls off the top. Its own option rows
    /// are still on the screen: still a dialog card, never one the core answers (no folder to check).
    #[test]
    fn w25s_start_question_with_its_heading_scrolled_off_is_a_card() {
        let folder = std::path::Path::new("/tmp/harbor");
        let trust = " trust? (Like your own code, a\n well-known open source project,\n or work from your team). If\n not, take a moment to review\n what's in this folder first.\n\n Claude Code'll be able to read,\n edit, and execute files here.\n\n Security guide\n\n \u{276f} No, exit\n   Yes, I trust this folder\n\n Enter to confirm \u{b7}\n Esc to cancel\n";
        let add = " here before.\n\n \u{276f} No, exit\n   Yes, add it\n\n Enter to confirm \u{b7}\n Esc to cancel\n";
        for text in [trust, add] {
            let mut s = Screen::new(32, 16);
            s.feed(text.replace('\n', "\r\n").as_bytes());
            let d = s.detect(AgentKind::Claude).expect(text);
            assert_eq!(d.kind, Kind::Dialog);
            assert_eq!(trust_question(&s.text(), folder), None);
            assert_eq!(add_dir_question(&s.text(), folder), None);
        }
        // Prose or code that only names the rows is no question.
        let mut s = Screen::new(80, 10);
        s.feed(b"  let rows = [\"No, exit\", \"Yes, add it\"];\r\n");
        assert!(s.detect(AgentKind::Claude).is_none());
    }

    #[test]
    fn past_start_is_claudes_input_box_and_no_start_question() {
        assert!(past_start(
            " Claude Code v2.1.326\n\n────\n\u{276f} \n────\n"
        ));
        assert!(!past_start(
            " Security guide\n\n \u{276f} No, exit\n   Yes, add it\n"
        ));
        assert!(!past_start(
            " Do you trust this folder?\n \u{276f} 1. Yes, I trust this folder\n   2. No, exit\n"
        ));
        assert!(!past_start("────\n Adding a new directory:\n"));
        // w10 item 3: another start dialog's numbered cursor row, or an indented one, is no input box.
        assert!(!past_start(
            "Choose the text style\n\u{276f} 1. Dark mode\n  2. Light mode\n"
        ));
        assert!(!past_start(
            "Select login method:\n \u{276f} 1. Claude account\n   2. Console account\n"
        ));
        assert!(past_start(
            "\u{2500}\u{2500}\n\u{276f} Try \"fix lint errors\"\n\u{2500}\u{2500}\n"
        ));
    }

    /// Ticket 991 (B2): Claude 2.1.325 draws the placeholder and its suggested next prompt faint (`ESC[2m`).
    #[test]
    fn faint_input_row_is_a_suggestion_not_a_draft() {
        let mut screen = Screen::new(60, 6);
        screen.feed("────\r\n\u{276f}\u{a0}\x1b[2mcommit this\x1b[22m\r\n────\r\n".as_bytes());
        assert!(screen.composer_faint());
        assert_eq!(
            screen.text().lines().nth(1),
            Some("\u{276f}\u{a0}commit this"),
            "the text reads as before"
        );
        // Typed text is drawn plain; a colour's parameters are not the faint switch.
        let mut typed = Screen::new(60, 6);
        typed.feed(
            "────\r\n\u{276f}\u{a0}\x1b[38;2;200;200;200mfix the bug\x1b[39m\r\n────\r\n"
                .as_bytes(),
        );
        assert!(!typed.composer_faint());
        // An empty box is no suggestion, and an erase leaves no faint cell behind.
        screen.feed(b"\x1b[2;1H\x1b[2K\xe2\x9d\xaf ");
        assert!(!screen.composer_faint());
    }

    /// Ticket 1010: Claude's ↯ under its box: in colour while fast mode is on, faint in a cooldown (2.1.330 `Lqe`:
    /// `dim(promptBorder(↯))`); one typed into the box, or in the chat above, is not the sign.
    #[test]
    fn fast_mark_is_claudes_own_under_its_box() {
        let draw = |below: &str| {
            let mut s = Screen::new(60, 12);
            s.feed(format!("\u{23fa} about \u{21af}\r\n────\r\n\u{276f} typed \u{21af}\r\n  more \u{21af}\r\n────\r\n{below}").as_bytes());
            s
        };
        assert_eq!(draw("  \u{23f8} plan mode on\r\n").fast_mark(), None);
        assert_eq!(
            draw("  Opus 5.5 \x1b[38;2;255;120;20m\u{21af}\x1b[39m\r\n").fast_mark(),
            Some(false)
        );
        assert_eq!(
            draw("  Opus 5.5 \x1b[2m\x1b[38;2;136;136;136m\u{21af}\x1b[39m\x1b[22m\r\n")
                .fast_mark(),
            Some(true)
        );
        // No box on the screen: nothing to read from.
        let mut bare = Screen::new(60, 4);
        bare.feed("  Opus 5.5 \u{21af}\r\n".as_bytes());
        assert_eq!(bare.fast_mark(), None);
    }

    /// Ticket 991 B4: a wrapped code row above the prompt (`0..100` read as option "0") and prose numbered above it are
    /// not the prompt's options; the last run counted from 1 is.
    #[test]
    fn b4_only_the_prompts_own_numbered_run_is_choices() {
        let mut s = Screen::new(80, 20);
        s.feed(
            " Steps:\r\n 1. read\r\n 2. write\r\n  7    raise ValueError(f'percent must be\r\n     0..100, got {percent}')\r\n Do you want to make this edit to app.py?\r\n \u{276f} 1. Yes\r\n   2. No\r\n Esc to cancel\r\n"
                .as_bytes(),
        );
        let d = s.detect(AgentKind::Claude).unwrap();
        let labels: Vec<_> = d.choices.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["Yes", "No"]);
    }

    /// Ticket 991 B3/B4: the blinking tool row above Claude's prompt is not part of the decision's text.
    #[test]
    fn b3_a_claude_prompts_text_is_the_region_below_its_rule() {
        let rule = "\u{2500}".repeat(40);
        let frame = |bullet: &str| {
            let mut s = Screen::new(80, 20);
            s.feed(
                format!(" Claude Code v2.1.325\r\n{bullet} Running pytest\r\n{rule}\r\n Bash command\r\n Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. No\r\n Esc to cancel\r\n")
                    .as_bytes(),
            );
            s.detect(AgentKind::Claude).unwrap().text
        };
        let on = frame("\u{23fa}");
        assert_eq!(on, frame(" "), "a blink changes nothing");
        assert!(on.starts_with(&rule) && !on.contains("Claude Code"));
        // A rule inside the request (indented, as Claude draws a command) is no boundary: the command above it stays.
        let mut s = Screen::new(80, 20);
        s.feed(
            format!("{rule}\r\n Bash command\r\n   rm -rf /work/data\r\n   {rule}\r\n Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. No\r\n")
                .as_bytes(),
        );
        assert!(
            s.detect(AgentKind::Claude)
                .unwrap()
                .text
                .contains("rm -rf /work/data")
        );
        // Without a rule above the options the whole screen stays.
        let mut s = Screen::new(80, 10);
        s.feed(" Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. No\r\n".as_bytes());
        assert!(
            s.detect(AgentKind::Claude)
                .unwrap()
                .text
                .contains("Do you want to proceed?")
        );
    }

    #[test]
    fn idle_tick_skips_unchanged_screen() {
        let mut s = Screen::new(80, 10);
        s.feed(b"hello\r\n");
        TEXT_CALLS.with(|c| c.set(0));
        let first = s.text();
        assert_eq!(s.text(), first);
        assert_eq!(TEXT_CALLS.with(|c| c.get()), 1, "unchanged screen rebuilt");
        s.feed(b"more");
        assert!(s.text().contains("more"));
        assert_eq!(
            TEXT_CALLS.with(|c| c.get()),
            2,
            "changed screen not rebuilt"
        );
    }
    #[test]
    fn alternate_screen_is_followed() {
        let mut s = Screen::new(80, 10);
        s.feed(b"\x1b[?1049h\x1b[H~");
        assert!(s.alt);
        s.feed(b"\x1b[?25h");
        assert!(s.alt, "another mode is no exit");
        s.feed(b"\x1b[?1049l$ ");
        assert!(!s.alt);
    }
    #[test]
    fn read_once_until_the_screen_changes() {
        let mut s = Screen::new(80, 10);
        s.feed(b"mode a");
        let reads = std::cell::Cell::new(0);
        let read = |t: &str| {
            reads.set(reads.get() + 1);
            Some(t.trim().to_string())
        };
        assert_eq!(s.read_once(read).as_deref(), Some("mode a"));
        assert_eq!(s.read_once(read).as_deref(), Some("mode a"));
        assert_eq!(reads.get(), 1, "unchanged screen read again");
        s.feed(b"\rmode b");
        assert_eq!(s.read_once(read).as_deref(), Some("mode b"));
        assert_eq!(reads.get(), 2);
    }

    /// Look 1117 v12 N12-S2-2: Codex's rate-limit dialog (numbered options under its question, one `›` cursor, its
    /// "enter select · esc back" footer) is a card; Codex's plain numbered output is none.
    #[test]
    fn n12_codex_rate_limit_dialog_is_a_card() {
        let dialog = "\u{2500} Worked for 7s \u{2022} 5:02 AM\r\n\r\n  Approaching rate limits\r\n  Switch to gpt-6-luna for lower credit usage?\r\n\r\n\u{203a} 1. Switch to gpt-6-luna\r\n  2. Keep current model\r\n  3. Keep current model (never show again)\r\n\r\n  enter select \u{b7} esc back\r\n\r\n  \u{26a0} weekly 10% left\r\n\r\n\u{203a} Ask Codex to do anything\r\n\r\n  GPT-6-Luna medium \u{b7} /tmp/x\r\n  ? for shortcuts\r\n";
        let plain = "\u{2022} Steps:\r\n  1. Run ls\r\n  2. Read the output\r\n\r\n\u{203a} Ask Codex to do anything\r\n\r\n  ? for shortcuts\r\n";
        let mut s = Screen::new(120, 30);
        s.feed(dialog.as_bytes());
        let d = s.detect(AgentKind::Codex).expect("a card");
        // v13 N13-S3-4: a question card whose first two options the window sends, as the digit alone.
        assert_eq!(d.kind, Kind::Question);
        let got: Vec<_> = d
            .choices
            .iter()
            .map(|c| (c.label.as_str(), c.changes_settings, c.keys.join(" ")))
            .collect();
        assert_eq!(
            got,
            [
                ("Switch to gpt-6-luna", false, "1".into()),
                ("Keep current model", false, "2".into()),
                ("Keep current model (never show again)", true, "3".into())
            ]
        );
        s.reset();
        s.feed(plain.as_bytes());
        assert!(s.detect(AgentKind::Codex).is_none());
    }

    #[test]
    fn detect_in_matches_detect() {
        let mut s = Screen::new(120, 20);
        for (screen, kind) in [
            (
                " Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. No\r\n",
                AgentKind::Claude,
            ),
            (
                " Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. No\r\n",
                AgentKind::Shell,
            ),
            ("just prose\r\n", AgentKind::Codex),
        ] {
            s.reset();
            s.feed(screen.as_bytes());
            let a = s
                .detect_in(kind, &s.text())
                .map(|d| (d.kind, d.text, d.choices.len()));
            let b = s.detect(kind).map(|d| (d.kind, d.text, d.choices.len()));
            assert_eq!(a, b);
            assert_eq!(
                a.is_none(),
                kind == AgentKind::Shell || screen == "just prose\r\n"
            );
        }
    }

    #[test]
    fn detect_in_does_not_copy_text() {
        // Source check, not an allocation counter: `detect_in` must not copy the borrowed text up front.
        let src = include_str!("screen.rs");
        let start = src.find("pub fn detect_in").unwrap();
        let body = &src[start..];
        let body = &body[..body[1..].find("fn choices").unwrap()];
        for copy in [
            "text.to_string()",
            "text.to_owned()",
            "text.clone()",
            "String::from(text)",
        ] {
            assert!(!body.contains(copy), "detect_in copies text: {copy}");
        }
        let mut s = Screen::new(120, 20);
        for screen in [
            " Do you trust this folder?\r\n \u{276f} 1. Yes, I trust this folder\r\n   2. No, exit\r\n",
            " Do you want to proceed?\r\n \u{276f} 1. Yes\r\n   2. No\r\n",
            " Question 1/2\r\n \u{276f} 1. Red\r\n   2. Blue\r\n Enter to select\r\n",
            " 1 shell still running\r\n",
            " Pick one\r\n \u{276f} 1. A\r\n   2. B\r\n Enter to confirm\r\n",
            "just prose\r\n",
        ] {
            s.reset();
            s.feed(screen.as_bytes());
            let a = s
                .detect_in(AgentKind::Claude, &s.text())
                .map(|d| (d.kind, d.text, d.choices.len()));
            let b = s
                .detect(AgentKind::Claude)
                .map(|d| (d.kind, d.text, d.choices.len()));
            assert_eq!(a, b);
            assert_eq!(a.is_none(), screen == "just prose\r\n");
        }
    }

    fn fed(text: &str) -> Screen {
        let mut s = Screen::new(200, 60);
        s.feed(text.replace('\n', "\r\n").as_bytes());
        s
    }

    /// Start dialogs other than folder trust, as real agents drew them on a Mac with empty config folders (Claude
    /// 2.1.332's theme picker and security notes, Codex 0.162.1's sign-in screen): each waits for the user before the
    /// session starts, so each is a dialog card. Codex's own trust question was a card already and stays one.
    #[test]
    fn start_dialogs_of_real_agents_are_cards() {
        for (kind, text) in [
            (
                AgentKind::Claude,
                include_str!("../../tests/fixtures/start-screens/claude-2.1.332-theme.txt"),
            ),
            (
                AgentKind::Claude,
                include_str!(
                    "../../tests/fixtures/start-screens/claude-2.1.332-security-notes.txt"
                ),
            ),
            (
                AgentKind::Codex,
                include_str!("../../tests/fixtures/start-screens/codex-0.162.1-sign-in.txt"),
            ),
            (
                AgentKind::Codex,
                include_str!("../../tests/fixtures/start-screens/codex-0.162.1-trust.txt"),
            ),
        ] {
            let d = fed(text)
                .detect(kind)
                .unwrap_or_else(|| panic!("no card for: {text}"));
            assert_eq!(d.kind, Kind::Dialog, "{text}");
        }
        // Claude's sign-in question, as Claude Code draws it with no account (not drawn on this Mac: Claude found its
        // sign-in with an empty config folder too).
        let login = " Claude Code can be used with your Claude subscription or billed based on API usage through your Console\n account.\n\n Select login method:\n\n \u{276f} 1. Claude account with subscription \u{b7} Pro, Max, Team, or Enterprise\n\n   2. Anthropic Console account \u{b7} API usage billing\n\n   3. 3rd-party platform \u{b7} Amazon Bedrock, Microsoft Foundry, or Vertex AI\n";
        let d = fed(login).detect(AgentKind::Claude).expect("login");
        assert_eq!((d.kind, d.choices.len()), (Kind::Dialog, 3));
        // Codex's update screen, which Nunchiro keeps off (sessions/spawn.rs): a card if it ever shows.
        let update = "\u{2728} Update available! 0.161.0 -> 0.170.0\n\n\u{203a} 1. Update now\n  2. Skip\n  3. Skip until next version\n\n  Press enter to continue\n";
        let d = fed(update).detect(AgentKind::Codex).expect("update");
        assert_eq!((d.kind, d.choices.len()), (Kind::Dialog, 3));
    }

    /// Codex animates its logo above the sign-in screen for about ten seconds: the card's text starts at its welcome
    /// line, so each frame keeps the same card (a changed text would make a new card every frame).
    #[test]
    fn codex_sign_in_card_leaves_out_the_animated_logo() {
        let text = include_str!("../../tests/fixtures/start-screens/codex-0.162.1-sign-in.txt");
        let logo = text
            .lines()
            .find(|l| l.contains('\u{28ff}'))
            .expect("logo row");
        let other = text.replace(logo, &logo.replace('\u{28ff}', "\u{2800}"));
        let a = fed(text).detect(AgentKind::Codex).expect("card");
        let b = fed(&other).detect(AgentKind::Codex).expect("card");
        assert_eq!(a.text, b.text);
        assert!(
            a.text.trim_start().starts_with("Welcome to Codex"),
            "{}",
            a.text
        );
    }

    /// The same words in an agent's own output, with its input box on the screen, are no card: a start dialog is drawn
    /// before the box.
    #[test]
    fn start_dialog_words_in_normal_output_are_no_card() {
        let rule = "\u{2500}".repeat(40);
        for (kind, text) in [
            (AgentKind::Claude, format!("\u{23fa} The onboarding says \"Choose the text style that looks best with your terminal\", then Security notes: and Press Enter to continue.\n Select login method: is next.\n{rule}\n\u{276f} \n{rule}\n")),
            (AgentKind::Codex, "\u{2022} Codex printed: Welcome to Codex. Sign in with ChatGPT, Provide your own API key, Press enter to continue.\n\n\u{203a} Ask Codex to do anything\n".to_string()),
        ] {
            assert!(fed(&text).detect(kind).is_none(), "{text}");
        }
        // A permission prompt whose preview holds those words (an edit to the fixtures above) stays a permission.
        let create = " Create file\n claude-2.1.332-security-notes.txt\n\n Security notes:\n\n Press Enter to continue\n\n Do you want to create claude-2.1.332-security-notes.txt?\n \u{276f} 1. Yes\n   2. No\n\n Esc to cancel\n";
        let d = fed(create).detect(AgentKind::Claude).expect("permission");
        assert_eq!(d.kind, Kind::Permission);
        // Words inside a row (a diff, a line of code) are no start dialog.
        let diff = "  12 +        || has(&[\"security notes:\", \"press enter to continue\"])\n  13 +  Welcome to Codex, Sign in with ChatGPT, Press enter to continue\n";
        assert!(fed(diff).detect(AgentKind::Codex).is_none());
    }

    const CLAUDE_NOTES: &str =
        include_str!("../../tests/fixtures/start-screens/claude-2.1.332-security-notes.txt");
    const CODEX_SIGN_IN: &str =
        include_str!("../../tests/fixtures/start-screens/codex-0.162.1-sign-in.txt");

    /// A start dialog's rows on the screen (an agent showing one of the files above) never change what another prompt
    /// reads as: a question, a plan approval, Codex's rate-limit question and the shells notice keep their kind, so
    /// their cards can still be answered.
    #[test]
    fn start_dialog_rows_never_change_another_prompt() {
        let rule = "\u{2500}".repeat(40);
        for (kind, quoted, tail) in [
            (AgentKind::Claude, CLAUDE_NOTES, format!("{rule}\n \u{2610} Colour\n\nWhich colour?\n\n\u{276f} 1. red\n  2. blue\n{rule}\n\nEnter to select \u{b7} Esc to cancel\n")),
            (AgentKind::Claude, CLAUDE_NOTES, format!("{rule}\n Ready to code?\n\n Claude has written up a plan and is ready to execute. Would you like to proceed?\n\n \u{276f} 1. Yes, and auto-accept edits\n   2. Yes, and manually approve edits\n   3. No, keep planning\n")),
            (AgentKind::Claude, CLAUDE_NOTES, " Background shells still running\n \u{276f} 1. Kill and exit\n   2. Keep waiting\n".to_string()),
            (AgentKind::Codex, CODEX_SIGN_IN, "  Approaching rate limits\n  Switch to a smaller model?\n\n\u{203a} 1. Switch\n  2. Keep current model\n\n  Press enter to confirm or esc to go back\n".to_string()),
        ] {
            let alone = fed(&tail).detect(kind).map(|d| d.kind);
            let with = fed(&format!("{quoted}{tail}")).detect(kind).map(|d| d.kind);
            assert!(alone.is_some(), "{tail}");
            assert_eq!(with, alone, "{tail}");
        }
    }

    /// Once the agent's input box has shown, the session is past its start: a redraw that shows a start dialog's rows
    /// with no box (a transcript view, a frame read between the transcript and the box) is no card.
    #[test]
    fn start_dialog_rows_after_the_input_box_are_no_card() {
        let rule = "\u{2500}".repeat(40);
        for (kind, quoted, the_box) in [
            (
                AgentKind::Claude,
                CLAUDE_NOTES,
                format!("{rule}\n\u{276f} \n{rule}\n"),
            ),
            (
                AgentKind::Codex,
                CODEX_SIGN_IN,
                "\n\u{203a} Ask Codex to do anything\n".to_string(),
            ),
        ] {
            assert!(
                fed(quoted).detect(kind).is_some(),
                "a start screen before the box is a card"
            );
            let mut s = fed(&the_box);
            assert!(s.detect(kind).is_none());
            if kind == AgentKind::Codex {
                s.mark_started(); // Codex's start ends with its first hook, not its composer
            }
            s.feed(format!("\x1b[2J\x1b[H{}", quoted.replace('\n', "\r\n")).as_bytes());
            assert!(s.detect(kind).is_none(), "{quoted}");
        }
        // Heading rows alone, without the dialog's own options, are no start dialog either.
        let rows = " Select login method:\n\n Choose the text style that looks best with your terminal\n\n Security notes:\n\n Press Enter to continue\n";
        assert!(fed(rows).detect(AgentKind::Claude).is_none());
        let rows = "  Welcome to Codex, OpenAI's command-line coding agent\n\n  \u{2728} Update available! 0.161.0 -> 0.170.0\n\n  Press enter to continue\n";
        assert!(fed(rows).detect(AgentKind::Codex).is_none());
    }

    /// Codex 0.162.1 started by the core draws its composer ("› Ask Codex to do anything") for a moment before its
    /// sign-in screen: that composer does not end Codex's start, so the sign-in screen after it is still a card.
    /// Codex's start ends with its first hook after SessionStart (`mark_started`).
    #[test]
    fn codex_composer_before_its_sign_in_screen_does_not_end_the_start() {
        let mut s = fed("\n\u{203a} Ask Codex to do anything\n");
        assert!(s.detect(AgentKind::Codex).is_none());
        s.feed(format!("\x1b[2J\x1b[H{}", CODEX_SIGN_IN.replace('\n', "\r\n")).as_bytes());
        assert_eq!(
            s.detect(AgentKind::Codex).map(|d| d.kind),
            Some(Kind::Dialog)
        );
        s.mark_started();
        assert!(s.detect(AgentKind::Codex).is_none());
    }
}
