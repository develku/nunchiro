//! The socket's wire as one JSON Schema (2020-12): `docs/api/nunchiro-api.schema.json`, written from these Rust
//! types by `api_schema_is_current`, so the release links no schema crate. `NUNCHIRO_UPDATE_API_SCHEMA=1` rewrites it.
use super::*;
use serde_json::{Value, json};

/// The operations an outside token may call (the `read` and `supervised` scopes, `docs/cli.md` "Outside callers"):
/// `x-stability: stable`, kept compatible. Every other operation is `window`: the window's own, free to change.
/// `tests/api_schema.rs` checks this list against what a supervised token is really allowed.
pub(crate) const STABLE: &[&str] = &[
    "list",
    "snapshot",
    "events",
    "agent_list",
    "agent_get",
    "agent_read",
    "read",
    "room_check",
    "room_thread",
    "room_answer",
    "worktree",
    "start",
    "agent_prompt",
    "agent_send",
    "send_text",
    "cancel_send",
    "room_send",
    "room_reply",
    "close",
];

const FILE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/api/nunchiro-api.schema.json"
);

/// Each request variant's `op`, in declaration order.
fn ops(request: &Value) -> Vec<String> {
    request["oneOf"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v["properties"]["op"]["const"].as_str().map(String::from))
        .collect()
}

pub(crate) fn generate() -> Value {
    let mut generator = schemars::generate::SchemaSettings::draft2020_12().into_generator();
    let envelope = generator.subschema_for::<Envelope>();
    let response_ref = generator.subschema_for::<Response>();
    let event = generator.subschema_for::<crate::events::Event>();
    let mut defs = serde_json::to_value(generator.definitions()).unwrap();
    // `Response` is an alias of `Result<Reply, String>`; give it its own name in the schema.
    if let Some(map) = defs.as_object_mut()
        && let Some(result) = map.remove("Result_of_Reply_or_string")
    {
        map.insert("Response".into(), result);
    }
    let response = json!({"$ref": "#/$defs/Response"});
    assert_eq!(
        serde_json::to_value(response_ref).unwrap()["$ref"],
        "#/$defs/Result_of_Reply_or_string"
    );
    for variant in defs["Request"]["oneOf"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        let op = variant["properties"]["op"]["const"]
            .as_str()
            .unwrap_or_default();
        let stability = if STABLE.contains(&op) {
            "stable"
        } else {
            "window"
        };
        variant["x-stability"] = json!(stability);
    }
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://raw.githubusercontent.com/develku/nunchiro/main/docs/api/nunchiro-api.schema.json",
        "title": "Nunchiro local API",
        "description": "Every line on the wire. A caller writes one envelope as a JSON line to $NUNCHIRO_HOME/core.sock and reads one response line back; `nunchiro events` prints event lines. A request variant's x-stability is stable (an outside token may call it; kept compatible) or window (the window's own; may change). See docs/api.md.",
        "anyOf": [
            {"title": "envelope", "allOf": [envelope]},
            {"title": "response", "allOf": [response]},
            {"title": "event", "allOf": [event]},
        ],
        "$defs": defs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_schema_is_current() {
        let text = serde_json::to_string_pretty(&generate()).unwrap() + "\n";
        if std::env::var_os("NUNCHIRO_UPDATE_API_SCHEMA").is_some() {
            std::fs::create_dir_all(std::path::Path::new(FILE).parent().unwrap()).unwrap();
            std::fs::write(FILE, &text).unwrap();
        }
        let committed = std::fs::read_to_string(FILE).unwrap_or_default();
        assert!(
            committed == text,
            "docs/api/nunchiro-api.schema.json is not the wire the code has; run NUNCHIRO_UPDATE_API_SCHEMA=1 cargo test -p nunchiro-core api_schema_is_current"
        );
    }

    #[test]
    fn every_request_is_in_the_schema_once_with_a_stability() {
        let schema = generate();
        let request = &schema["$defs"]["Request"];
        let names = ops(request);
        let mut unique = names.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(names.len(), unique.len(), "an op is listed twice");
        // The variant count read from the source, so a variant the schema drops is caught.
        let source = include_str!("../api.rs");
        let body = &source[source.find("pub enum Request {").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let variants = body
            .lines()
            .filter(|l| {
                let t = l.strip_prefix("    ").unwrap_or("");
                t.starts_with(|c: char| c.is_ascii_uppercase())
            })
            .count();
        assert_eq!(names.len(), variants);
        for variant in request["oneOf"].as_array().unwrap() {
            let s = variant["x-stability"].as_str().unwrap();
            assert!(s == "stable" || s == "window");
        }
        for op in STABLE {
            assert!(names.iter().any(|n| n == op), "{op} is not a request");
        }
    }

    #[test]
    fn the_docs_list_the_stable_operations() {
        let docs = include_str!("../../../../docs/api.md");
        let start = docs
            .find("Stable operations:")
            .expect("docs/api.md lists the stable operations");
        let para = &docs[start..start + docs[start..].find("\n\n").unwrap()];
        let listed: Vec<&str> = para.split('`').skip(1).step_by(2).collect();
        assert_eq!(listed, STABLE, "docs/api.md and api::schema::STABLE differ");
    }
}
