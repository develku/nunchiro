// The published API schema: `nunchiro api schema` prints the committed file, its `x-stability: stable` operations are
// exactly the ones an outside token may call, and the example client in docs/api/examples runs against a real core.
#[path = "../../nunchiro-core/tests/fixtures/home.rs"]
mod home;
use serde_json::{Map, Value, json};
use std::{
    io::{BufRead, BufReader, ErrorKind, Write},
    os::unix::net::UnixStream,
    path::Path,
    process::Command,
    time::Duration,
};

const SCHEMA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/api/nunchiro-api.schema.json");
const EXAMPLE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/api/examples/agents.py");

fn nunchiro(home: &Path) -> Command {
    let mut c = home::git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"));
    c.env("NUNCHIRO_HOME", home).env_remove("NUNCHIRO_TOKEN");
    c
}

fn core(tag: &str) -> home::ServeGuard {
    let home = home::short(tag);
    let user = home.join("user");
    std::fs::create_dir_all(&user).unwrap();
    let (user, claude, codex) = (
        user.to_str().unwrap().to_string(),
        home.join("claude-data").to_str().unwrap().to_string(),
        home.join("codex-data").to_str().unwrap().to_string(),
    );
    home::spawn_serve(
        &home,
        &[
            ("HOME", &user),
            ("CLAUDE_CONFIG_DIR", &claude),
            ("CODEX_HOME", &codex),
        ],
    )
}

fn token(home: &Path, scope: &str) -> String {
    let out = nunchiro(home)
        .env("NUNCHIRO_TOKEN", std::fs::read_to_string(home.join("core.token")).unwrap())
        .args(["token", "create", "--scope", scope])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

/// One response line, or `None` when the core keeps the line open (a stream such as `events`).
fn call(home: &Path, token: &str, request: &Value) -> Option<Value> {
    let mut s = UnixStream::connect(home.join("core.sock")).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    writeln!(s, "{}", json!({"token": token, "request": request})).unwrap();
    let mut line = String::new();
    match BufReader::new(s).read_line(&mut line) {
        Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => None,
        r => {
            r.unwrap();
            Some(serde_json::from_str(&line).unwrap())
        }
    }
}

/// The smallest value the schema accepts: required properties only, the first of every choice.
fn sample(schema: &Value, defs: &Value) -> Value {
    if let Some(r) = schema["$ref"].as_str() {
        return sample(&defs[r.trim_start_matches("#/$defs/")], defs);
    }
    if let Some(c) = schema.get("const") {
        return c.clone();
    }
    if let Some(e) = schema["enum"].as_array() {
        return e[0].clone();
    }
    for key in ["oneOf", "anyOf", "allOf"] {
        if let Some(first) = schema[key].as_array().and_then(|a| a.first()) {
            return sample(first, defs);
        }
    }
    let kind = match &schema["type"] {
        Value::Array(kinds) => kinds.iter().find(|k| *k != "null").cloned().unwrap_or_default(),
        kind => kind.clone(),
    };
    match kind.as_str().unwrap_or("object") {
        "string" => json!("x"),
        "integer" | "number" => json!(0),
        "boolean" => json!(false),
        "array" => json!([]),
        "null" => Value::Null,
        _ => {
            let mut out = Map::new();
            for name in schema["required"].as_array().into_iter().flatten() {
                let name = name.as_str().unwrap();
                out.insert(name.into(), sample(&schema["properties"][name], defs));
            }
            Value::Object(out)
        }
    }
}

fn schema() -> Value {
    serde_json::from_str(&std::fs::read_to_string(SCHEMA).expect("docs/api/nunchiro-api.schema.json")).unwrap()
}

#[test]
fn api_schema_prints_the_published_file() {
    let home = home::short("aps");
    let out = nunchiro(&home).args(["api", "schema"]).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8(out.stdout).unwrap(), std::fs::read_to_string(SCHEMA).unwrap());
    assert_eq!(schema()["$schema"], "https://json-schema.org/draft/2020-12/schema");
}

#[test]
fn stable_operations_are_the_ones_a_token_may_call() {
    let core = core("apt");
    let home = &core.home;
    let supervised = token(home, "supervised");
    let read = token(home, "read");
    let schema = schema();
    let defs = &schema["$defs"];
    let mut stable = 0;
    for variant in defs["Request"]["oneOf"].as_array().unwrap() {
        let op = variant["properties"]["op"]["const"].as_str().unwrap();
        let mut request = sample(variant, defs);
        if op == "worktree" {
            request["operation"] = json!("list"); // a token reads worktrees; making one is the window's
        }
        let reply = call(home, &supervised, &request);
        let refused = |r: &Option<Value>| {
            r.as_ref()
                .and_then(|r| r["Err"].as_str())
                .is_some_and(|e| e.contains("not granted to a"))
        };
        match variant["x-stability"].as_str().unwrap() {
            "stable" => {
                stable += 1;
                assert!(!refused(&reply), "{op} is stable but a supervised token is refused: {reply:?}");
            }
            "window" => {
                let err = reply.as_ref().and_then(|r| r["Err"].as_str());
                assert!(err.is_some(), "{op} is window-only but a supervised token got {reply:?}");
                // As today: a read token calling a window operation is refused.
                let reply = call(home, &read, &request);
                assert!(reply.and_then(|r| r["Err"].as_str().map(String::from)).is_some(), "{op}");
            }
            other => panic!("{op}: x-stability {other}"),
        }
    }
    assert!(stable >= 10, "only {stable} stable operations");
}

#[test]
fn the_example_client_lists_agents() {
    let core = core("ape");
    let home = &core.home;
    let owner = std::fs::read_to_string(home.join("core.token")).unwrap();
    let project = home.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let started = nunchiro(home)
        .env("NUNCHIRO_TOKEN", &owner)
        .args(["agent", "start", "example-seat", "--kind", "shell", "--project"])
        .arg(&project)
        .args(["--", "/bin/sh", "-c", "exec cat"])
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", String::from_utf8_lossy(&started.stderr));
    let read = token(home, "read");
    let out = Command::new("python3")
        .arg("-I")
        .arg(EXAMPLE)
        .env("NUNCHIRO_HOME", home)
        .env("NUNCHIRO_TOKEN", &read)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("example-seat"), "{text}");
}
