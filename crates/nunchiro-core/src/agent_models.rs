//! Ticket 1100: the Codex models the window offers and the core accepts, from Codex's own catalog. Codex fetches its
//! model list itself and keeps it in `$CODEX_HOME/models_cache.json` (else `~/.codex`), so a model Codex adds shows
//! here once Codex has fetched it, without a Nunchiro update. The file is Codex's, not ours: it is read without
//! following a link, at most `READ_MAX` bytes, unknown fields ignored, and anything wrong with it (missing, empty,
//! too large, malformed, no listed model) gives the fixed list below, as before this ticket. A bad entry is skipped
//! alone. T3 Code and Orca ask a running `codex app-server` (`model/list`) instead; the cache needs no process.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One model as the window lists it: Codex's slug (passed as `-m`), its display name and its own efforts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Model {
    pub value: String,
    pub label: String,
    pub efforts: Vec<String>,
}

const FULL: &[&str] = &["low", "medium", "high", "xhigh", "max", "ultra"];
const NO_ULTRA: &[&str] = &["low", "medium", "high", "xhigh", "max"];
/// Codex 0.161.0's listed models (models_cache.json, 2026-11-18), for a Mac whose cache cannot be read.
/// `fallback_equals_the_recorded_cache` keeps it equal to that file's shape.
pub(crate) const CODEX_FALLBACK: &[(&str, &str, &[&str])] = &[
    ("gpt-6.1-terra", "GPT-6.1 Terra", FULL),
    ("gpt-6.1-sol", "GPT-6.1-Sol", FULL),
    ("gpt-6-astra", "GPT-6-Astra", FULL),
    ("gpt-6-sol", "GPT-6-Sol", FULL),
    ("gpt-6-luna", "GPT-6-Luna", NO_ULTRA),
    ("gpt-5.6-sol", "GPT-5.6-Sol", FULL),
    ("gpt-5.6-terra", "GPT-5.6-Terra", FULL),
    ("gpt-5.6-luna", "GPT-5.6-Luna", NO_ULTRA),
];
/// Codex's efforts for a session that names no model.
pub(crate) const CODEX_DEFAULT_EFFORTS: &[&str] = NO_ULTRA;
/// The real file is about 0.5 MB (each model carries its instructions); a file past this is not a catalog.
const READ_MAX: u64 = 8 << 20;
/// More rows than any menu shows; a longer list is cut, never refused.
const MODELS_MAX: usize = 64;

/// The Codex models of this Mac: Codex's own listed ones, else the fixed list.
pub(crate) fn codex() -> Vec<Model> {
    crate::accounts::config_home(crate::api::AgentKind::Codex, None)
        .and_then(|home| kept(&home.join("models_cache.json")))
        .unwrap_or_else(fallback)
}

pub fn fallback() -> Vec<Model> {
    CODEX_FALLBACK
        .iter()
        .map(|(value, label, efforts)| Model {
            value: value.to_string(),
            label: label.to_string(),
            efforts: efforts.iter().map(|e| e.to_string()).collect(),
        })
        .collect()
}

/// `read`, kept by (path, mtime, size): every start and switch asks, and the file changes about once a day.
fn kept(path: &Path) -> Option<Vec<Model>> {
    type Key = (PathBuf, std::time::SystemTime, u64);
    static KEPT: std::sync::Mutex<Option<(Key, Option<Vec<Model>>)>> = std::sync::Mutex::new(None);
    let file = crate::store::open_regular(path).ok()?;
    let meta = file.metadata().ok()?;
    let key = (path.to_path_buf(), meta.modified().ok()?, meta.len());
    if let Some((at, models)) = KEPT.lock().ok()?.as_ref()
        && *at == key
    {
        return models.clone();
    }
    let models = crate::store::read_capped(file, READ_MAX)
        .ok()
        .and_then(|bytes| parse(&bytes));
    *KEPT.lock().ok()? = Some((key, models.clone()));
    models
}

#[derive(Deserialize)]
struct Cache {
    models: Vec<serde_json::Value>,
}
#[derive(Deserialize)]
struct Entry {
    slug: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    supported_reasoning_levels: Vec<Level>,
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    priority: Option<i64>,
}
#[derive(Deserialize)]
struct Level {
    effort: String,
}

/// The listed models of one cache file in Codex's order (`priority`), or None when it lists none.
pub(crate) fn parse(bytes: &[u8]) -> Option<Vec<Model>> {
    let cache: Cache = serde_json::from_slice(bytes).ok()?;
    let mut rows: Vec<(i64, Model)> = Vec::new();
    for entry in cache.models {
        let Ok(e) = serde_json::from_value::<Entry>(entry) else {
            continue;
        };
        // Codex hides internal models ("hide"); only what its own picker lists is offered.
        if e.visibility.as_deref() != Some("list")
            || !crate::sessions::model_word(&e.slug)
            || rows.iter().any(|(_, m)| m.value == e.slug)
        {
            continue;
        }
        let label = e
            .display_name
            .map(|n| n.trim().to_string())
            .filter(|n| {
                !n.is_empty() && n.chars().count() <= 64 && !n.chars().any(char::is_control)
            })
            .unwrap_or_else(|| e.slug.clone());
        let mut efforts: Vec<String> = Vec::new();
        for l in e.supported_reasoning_levels {
            // An effort goes into Codex's argv as a TOML string; a plain short word is all Codex has used.
            if l.effort.len() <= 16
                && l.effort.chars().all(|c| c.is_ascii_lowercase())
                && !l.effort.is_empty()
                && !efforts.contains(&l.effort)
            {
                efforts.push(l.effort);
            }
        }
        rows.push((
            e.priority.unwrap_or(i64::MAX),
            Model {
                value: e.slug,
                label,
                efforts,
            },
        ));
    }
    rows.sort_by_key(|(p, _)| *p); // stable: equal priorities keep the file's order
    rows.truncate(MODELS_MAX);
    (!rows.is_empty()).then(|| rows.into_iter().map(|(_, m)| m).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(
        slug: &str,
        name: &str,
        efforts: &[&str],
        visibility: &str,
        priority: i64,
    ) -> serde_json::Value {
        json!({
            "slug": slug, "display_name": name, "description": "x", "default_reasoning_level": "low",
            "supported_reasoning_levels": efforts.iter().map(|e| json!({"effort": e, "description": "d"})).collect::<Vec<_>>(),
            "visibility": visibility, "priority": priority, "shell_type": "unified_exec", "model_messages": {"a": "b"}
        })
    }
    fn file(models: Vec<serde_json::Value>) -> Vec<u8> {
        serde_json::to_vec(&json!({"fetched_at": "2026-11-24T03:35:52Z", "client_version": "0.172.0", "models": models})).unwrap()
    }

    #[test]
    fn a_new_listed_model_shows_with_its_name_and_efforts_and_hidden_ones_do_not() {
        let got = parse(&file(vec![
            entry("gpt-6.1-terra", "GPT-6.1 Terra", FULL, "list", 2),
            entry("gpt-reserve", "GPT-Reserve", NO_ULTRA, "hide", 3),
            entry("gpt-6.2-sol", "GPT-6.2 Sol", FULL, "list", 1),
        ]))
        .unwrap();
        assert_eq!(
            got.iter().map(|m| m.value.as_str()).collect::<Vec<_>>(),
            ["gpt-6.2-sol", "gpt-6.1-terra"]
        );
        assert_eq!(got[0].label, "GPT-6.2 Sol");
        assert_eq!(got[0].efforts, FULL);
    }

    #[test]
    fn a_bad_entry_is_skipped_alone_and_a_bad_file_gives_none() {
        let got = parse(&file(vec![
            json!({"slug": 7}),
            entry("-m", "flag", FULL, "list", 1),
            entry("gpt-x", "  ", &["low", "Hi gh", "low"], "list", 2),
        ]))
        .unwrap();
        assert_eq!(
            got,
            [Model {
                value: "gpt-x".into(),
                label: "gpt-x".into(),
                efforts: vec!["low".into()]
            }]
        );
        assert_eq!(parse(b""), None);
        assert_eq!(parse(b"{not json"), None);
        assert_eq!(parse(br#"{"models": []}"#), None);
        assert_eq!(parse(br#"{"models": {}}"#), None);
        assert_eq!(
            parse(&file(vec![entry("gpt-reserve", "R", FULL, "hide", 1)])),
            None
        );
    }

    #[test]
    fn a_missing_or_huge_file_gives_none() {
        let dir =
            std::env::temp_dir().join(format!("nunchiro-agent-models-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(kept(&dir.join("absent.json")), None);
        let huge = dir.join("huge.json");
        let mut bytes = file(vec![entry("gpt-6.2-sol", "GPT-6.2 Sol", FULL, "list", 1)]);
        bytes.truncate(bytes.len() - 1); // reopen the top object to pad it
        bytes.extend(format!(r#","pad":"{}"}}"#, "x".repeat(READ_MAX as usize)).as_bytes());
        std::fs::write(&huge, &bytes).unwrap();
        assert_eq!(kept(&huge), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The fixed list is what Codex 0.161.0 listed: the recorded cache (its listed rows, model text dropped) reads as it.
    #[test]
    fn fallback_equals_the_recorded_cache() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/codex/models_cache-0.161.0.json");
        assert_eq!(parse(&std::fs::read(path).unwrap()).unwrap(), fallback());
    }
}
