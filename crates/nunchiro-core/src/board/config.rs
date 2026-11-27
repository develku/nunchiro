use super::{Column, State};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use toml::Spanned;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: Spanned<u32>,
    columns: Spanned<Vec<ColumnInput>>,
    // v1b-17
    #[serde(default)]
    sources: Option<super::sources::SourceDocument>,
    // V2.5-38 (ticket 186): the edit panel's stale badge threshold and turn-end nudge.
    #[serde(default)]
    settings: Option<Spanned<Settings>>,
}

/// `[settings]` in board.toml. `done_days` (1, 7 or 30, default 7, ticket 1066) is how long a finished card stays in
/// the Done column before it moves to the Archive. `stale_minutes` is the stale badge threshold (1 to 1440, default 10);
/// `turn_end_nudge` turns ticket 187's turn-end context line on or off (default true). One struct for both keys:
/// `deny_unknown_fields` refuses any other key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields, default)]
pub struct Settings {
    pub stale_minutes: u32,
    pub turn_end_nudge: bool,
    pub done_days: u32,
}
impl Settings {
    /// The rule the parser and the writer share.
    pub(super) fn check(&self) -> Result<(), &'static str> {
        if !matches!(self.done_days, 1 | 7 | 30) {
            Err("settings.done_days must be 1, 7 or 30")
        } else if (1..=1440).contains(&self.stale_minutes) {
            Ok(())
        } else {
            Err("settings.stale_minutes must be 1 to 1440")
        }
    }
}
impl Default for Settings {
    fn default() -> Self {
        Settings {
            stale_minutes: 10,
            turn_end_nudge: true,
            done_days: 7,
        }
    }
}

/// The board settings of a board.toml text; a file without `[settings]` gives the defaults. Any error
/// in the document refuses it whole, like its columns.
pub(super) fn settings(text: &str) -> Result<Settings, String> {
    parse_settings(text).map(|(_, settings)| settings)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ColumnInput {
    id: Spanned<String>,
    title: Spanned<String>,
    #[serde(default)]
    states: Vec<Spanned<State>>,
    #[serde(default)]
    needs_decision: bool,
    // V2.5-36: version 2 key; a version-1 file may carry it too.
    #[serde(default)]
    proof: bool,
}

pub(super) fn parse(text: &str) -> Result<Vec<Column>, String> {
    parse_document(text).map(|(columns, _)| columns)
}
pub(super) fn parse_versioned(text: &str) -> Result<(u32, Vec<Column>), String> {
    parse_full(text).map(|(version, columns, _)| (version, columns))
}
pub(super) fn parse_document(
    text: &str,
) -> Result<(Vec<Column>, Option<super::sources::SourceDocument>), String> {
    parse_full(text).map(|(_, columns, sources)| (columns, sources))
}
/// V2.5-39: `[settings] turn_end_nudge`, default on (also without `[settings]`); a file that does not
/// parse is an error, so the caller sends no nudge.
pub(super) fn turn_end_nudge(text: &str) -> Result<bool, String> {
    settings(text).map(|s| s.turn_end_nudge)
}
type Parsed = (u32, Vec<Column>, Option<super::sources::SourceDocument>);
fn parse_full(text: &str) -> Result<Parsed, String> {
    parse_settings(text).map(|(parsed, _)| parsed)
}
fn parse_settings(text: &str) -> Result<(Parsed, Settings), String> {
    let error = |at: usize, why: &str| {
        format!(
            "board.toml line {}: {why}",
            text.as_bytes()[..at.min(text.len())]
                .iter()
                .filter(|b| **b == b'\n')
                .count()
                + 1
        )
    };
    let doc: Document = toml::from_str(text)
        .map_err(|e: toml::de::Error| error(e.span().map_or(0, |s| s.start), e.message()))?;
    let version = *doc.version.get_ref();
    if !matches!(version, 1 | 2) {
        return Err(error(doc.version.span().start, "unsupported board version"));
    }
    if doc.columns.get_ref().is_empty() || doc.columns.get_ref().len() > 64 {
        return Err(error(doc.columns.span().start, "expected 1 to 64 columns"));
    }
    // v1b-17: validate the entire document before applying any columns.
    if let Some(sources) = &doc.sources {
        sources.validate().map_err(|e| error(0, &e))?;
    }
    let settings = doc
        .settings
        .as_ref()
        .map_or(Settings::default(), |s| *s.get_ref());
    if let Err(why) = settings.check() {
        let at = doc.settings.as_ref().map_or(0, |s| s.span().start);
        return Err(error(at, why));
    }
    let mut ids = BTreeSet::new();
    let mut claimed = Vec::new();
    let mut columns = Vec::new();
    for column in doc.columns.into_inner() {
        if !crate::store::valid_id(column.id.get_ref()) || !ids.insert(column.id.get_ref().clone())
        {
            return Err(error(
                column.id.span().start,
                "invalid or duplicate column id",
            ));
        }
        if column.title.get_ref().trim().is_empty() || column.title.get_ref().len() > 256 {
            return Err(error(
                column.title.span().start,
                "column title must have 1 to 256 bytes",
            ));
        }
        for state in &column.states {
            if claimed.contains(state.get_ref()) {
                return Err(error(state.span().start, "state claimed more than once"));
            }
            claimed.push(state.get_ref().clone());
        }
        columns.push(Column {
            id: column.id.into_inner(),
            title: column.title.into_inner(),
            states: column.states.into_iter().map(Spanned::into_inner).collect(),
            needs_decision: column.needs_decision,
            proof: column.proof,
        });
    }
    Ok(((version, columns, doc.sources), settings))
}

#[cfg(test)]
mod tests {
    use super::*;

    const COLUMNS: &str = "version = 2\n[[columns]]\nid = \"todo\"\ntitle = \"To do\"\n";

    #[test]
    fn board_settings_defaults_without_table() {
        assert_eq!(settings(COLUMNS), Ok(Settings::default()));
        assert_eq!(Settings::default().stale_minutes, 10);
        assert!(Settings::default().turn_end_nudge);
    }

    #[test]
    fn board_settings_read_back() {
        let text = format!("{COLUMNS}[settings]\nstale_minutes = 5\nturn_end_nudge = false\n");
        assert_eq!(
            settings(&text),
            Ok(Settings {
                stale_minutes: 5,
                turn_end_nudge: false,
                done_days: 7
            })
        );
        // One key alone keeps the other's default.
        let text = format!("{COLUMNS}[settings]\nstale_minutes = 1440\n");
        assert_eq!(
            settings(&text).map(|s| (s.stale_minutes, s.turn_end_nudge)),
            Ok((1440, true))
        );
    }

    #[test]
    fn board_settings_refused_whole() {
        for bad in [
            "stale_minutes = 0",
            "stale_minutes = 1441",
            "stale_minutes = \"5\"",
            "stale_minutes = -1",
            "stale_minutes = 2.5",
            "turn_end_nudge = \"no\"",
            "nudge = true",
        ] {
            let text = format!("{COLUMNS}[settings]\n{bad}\n");
            let err = settings(&text).expect_err(bad);
            assert!(err.starts_with("board.toml line "), "{bad}: {err}");
            // The columns are refused with it: a broken file is refused whole.
            assert!(parse(&text).is_err(), "{bad}");
        }
    }
}
