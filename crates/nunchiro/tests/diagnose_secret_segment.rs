//! V2-13b: a machine project path with a secret-looking segment (a token shape, a 32/40/64-hex digest, a long
//! base64url token) never reaches a `nunchiro diagnose` bundle. The pair is dropped and counted under `dropped`
//! without its key; the ordinary pair beside it stays unchanged. The helper below is the small part of
//! `tests/diagnose.rs` this file needs.
#[path = "../../nunchiro-core/tests/fixtures/git_env.rs"]
mod git_env;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
/// A key shape (`sk-` plus 40 letters) and a SHA-256-looking digest; the marker words make a leak greppable.
const KEY_SEGMENT: &str = "sk-SECRETSEGMENTKEYAAAAAAAAAAAAAAAAAAAAAAAA";
const HEX_SEGMENT: &str = "5ec12e75e9e1a0b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b";
/// A git commit id (40 hex) and an unprefixed base64url token (40 characters, letters and digits mixed, `-` and `_`).
const SHA40_SEGMENT: &str = "5ec1a0b3c4d5e6f708192a3b4c5d6e7f8091a2b3";
const TOKEN_SEGMENT: &str = "Zx9_TOKENSEGMENTq7-Lm3Rp8Vb2Nc5Kd1Hs4Jw6";
/// A standard-base64 token whose `+` cuts it into two 16-character runs.
const B64_PLUS_SEGMENT: &str = "Ab3dEf5hIj7lMn9p+Qr1tUv3xYz5bC7eG";

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.scratch");
        fs::create_dir_all(&root).unwrap();
        let home = root.canonicalize().unwrap().join(format!(
            "dgs{:x}-{:x}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(home.join("bin")).unwrap();
        Self(home)
    }
    /// Writes `settings.json`, runs `nunchiro diagnose` and returns the bundle folder.
    fn bundle(&self, settings: &Value) -> PathBuf {
        fs::write(self.0.join("settings.json"), settings.to_string()).unwrap();
        let out = git_env::scrubbed(env!("CARGO_BIN_EXE_nunchiro"))
            .arg("diagnose")
            .env_clear()
            .env("NUNCHIRO_TEST_OPENER", "record") // ticket 840: env_clear drops what `scrubbed` set
            .env("NUNCHIRO_HOME", &self.0)
            .env("HOME", &self.0)
            .env("PATH", format!("{}/bin:/usr/bin:/bin", self.0.display()))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let path = PathBuf::from(String::from_utf8(out.stdout).unwrap().trim());
        assert!(path.starts_with(self.0.join("diagnose")), "{path:?}");
        path
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

fn json_of(bundle: &Path, name: &str) -> Value {
    serde_json::from_slice(&fs::read(bundle.join(name)).unwrap()).unwrap()
}
/// Every byte of every file in the bundle.
fn bundle_text(bundle: &Path) -> String {
    let all: Vec<u8> = fs::read_dir(bundle)
        .unwrap()
        .flat_map(|e| fs::read(e.unwrap().path()).unwrap())
        .collect();
    String::from_utf8_lossy(&all).into_owned()
}

/// An ordinary pair beside pairs whose key side or value side holds a token-shaped segment.
fn machines() -> Value {
    json!({"mini": {"projects": {
        "/w/ordinary": "/srv/ordinary",
        format!("/w/{KEY_SEGMENT}"): "/srv/key-keyed",
        "/w/key-valued": format!("/srv/{KEY_SEGMENT}/proj"),
    }}})
}

// A token-shaped segment, on either side of a pair, drops that pair: it is counted without its key, and the sentinel
// appears in no bundle file.
#[test]
fn diagnose_secret_segment_dropped() {
    let h = Home::new();
    let bundle = h.bundle(&json!({"machines": machines()}));
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(settings["dropped"], json!(["machines (2 entries)"]));
    let text = bundle_text(&bundle);
    for secret in ["SECRETSEGMENT", &KEY_SEGMENT[3..]] {
        assert!(!text.contains(secret), "{secret} leaked into the bundle");
    }
}

// Not vacuous: the ordinary pair beside the secret ones is kept exactly, and is the only pair left.
#[test]
fn diagnose_secret_segment_neighbour_kept() {
    let h = Home::new();
    let bundle = h.bundle(&json!({"machines": machines()}));
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(
        settings["machines"],
        json!({"mini": {"projects": {"/w/ordinary": "/srv/ordinary"}}})
    );
}

/// The bundle for an ordinary pair beside a key-side and a value-side pair holding `segment`; asserts both secret pairs
/// are dropped and counted without their key, the ordinary pair stays exactly, and `segment` is in no bundle file.
fn assert_segment_dropped(segment: &str) {
    let h = Home::new();
    let bundle = h.bundle(&json!({"machines": {"mini": {"projects": {
        "/w/ordinary": "/srv/ordinary",
        format!("/w/{segment}"): "/srv/secret-keyed",
        "/w/secret-valued": format!("/srv/{segment}/proj"),
    }}}}));
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(settings["dropped"], json!(["machines (2 entries)"]));
    assert_eq!(
        settings["machines"],
        json!({"mini": {"projects": {"/w/ordinary": "/srv/ordinary"}}})
    );
    let text = bundle_text(&bundle);
    assert!(!text.contains(segment), "{segment} leaked into the bundle");
    // A token split by `.`, `+` or `=` leaks as its pieces too.
    for piece in segment.split(['.', '+', '=']).filter(|p| p.len() >= 8) {
        assert!(!text.contains(piece), "{piece} leaked into the bundle");
    }
    assert!(
        !text.contains("secret-"),
        "a dropped pair was named: {text}"
    );
}

// A 64-hex segment (a SHA-256 or a token digest): the redactor has no 64-hex shape, so `clean` checks it itself.
#[test]
fn diagnose_secret_segment_hex_dropped() {
    assert_segment_dropped(HEX_SEGMENT);
}

// A 40-hex git commit id, upper case too (the hex rule ignores case).
#[test]
fn diagnose_secret_segment_sha40_dropped() {
    assert_segment_dropped(SHA40_SEGMENT);
    assert_segment_dropped(&SHA40_SEGMENT.to_uppercase());
}

// An unprefixed base64url token (32 or more characters, letters and digits mixed), also with a file suffix after it.
#[test]
fn diagnose_secret_segment_base64url_dropped() {
    assert_segment_dropped(TOKEN_SEGMENT);
    assert_segment_dropped(&format!("{TOKEN_SEGMENT}.git"));
}

// Over-redaction guard: ordinary words, a long dictionary-style name, short hex and an 8-to-31-character mixed name
// stay unchanged beside one dropped token pair (so the filter is shown to run).
#[test]
fn diagnose_secret_segment_short_and_words_kept() {
    let kept = json!({
        "/w/project": "/srv/my-long-project-name-without-digits",
        "/w/a1b2": "/srv/deadbeef/proj",
        "/w/release-2026-q4": "/srv/app_v2_build_31_chars_xyz123456",
    });
    let mut projects = kept.as_object().unwrap().clone();
    projects.insert("/w/blob".into(), json!(format!("/srv/{TOKEN_SEGMENT}")));
    let h = Home::new();
    let bundle = h.bundle(&json!({"machines": {"mini": {"projects": projects}}}));
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(settings["dropped"], json!(["machines (1 entries)"]));
    assert_eq!(settings["machines"], json!({"mini": {"projects": kept}}));
}

/// V2-13b follow-up: a 40-hex sha cut 20/20 by `.` (each half under 32, so no run alone looks secret), mixed and
/// all-digit.
#[test]
fn diagnose_split_hex_by_dot_dropped() {
    assert_segment_dropped(&format!(
        "{}.{}",
        &SHA40_SEGMENT[..20],
        &SHA40_SEGMENT[20..]
    ));
    assert_segment_dropped(&format!("{}.{}", "1".repeat(20), "2".repeat(20)));
}

/// A standard-base64 token: 16 mixed characters, `+`, 16 mixed characters, also with `=` padding.
#[test]
fn diagnose_base64_plus_token_dropped() {
    assert_segment_dropped(B64_PLUS_SEGMENT);
    assert_segment_dropped(&format!("{B64_PLUS_SEGMENT}=="));
}

/// V2-13b follow-up: a 64-hex segment in `worktrees_dir` drops the key (named under `dropped`), and the hex is in no
/// file.
#[test]
fn diagnose_worktrees_dir_hex_dropped() {
    let h = Home::new();
    let bundle = h.bundle(&json!({"worktrees_dir": format!("/x/{HEX_SEGMENT}/wt")}));
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(settings["dropped"], json!(["worktrees_dir"]));
    assert!(settings.get("worktrees_dir").is_none());
    assert!(!bundle_text(&bundle).contains(HEX_SEGMENT));
}

/// V2-13b follow-up: an entry of `usage_link_roots` with a 64-hex segment is dropped and counted; the other entry
/// stays.
#[test]
fn diagnose_usage_link_roots_hex_dropped() {
    let h = Home::new();
    let bundle =
        h.bundle(&json!({"usage_link_roots": ["/w/links", format!("/x/{HEX_SEGMENT}/wt")]}));
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(settings["dropped"], json!(["usage_link_roots (1 entries)"]));
    assert_eq!(settings["usage_link_roots"], json!(["/w/links"]));
    assert!(!bundle_text(&bundle).contains(HEX_SEGMENT));
    // A non-string entry drops the whole key, named once and not counted.
    let bundle = h.bundle(&json!({"usage_link_roots": [format!("/x/{HEX_SEGMENT}/wt"), 1]}));
    assert_eq!(
        json_of(&bundle, "settings.json")["dropped"],
        json!(["usage_link_roots"])
    );
    assert!(!bundle_text(&bundle).contains(HEX_SEGMENT));
}

/// V2-13b follow-up: a machine alias that is a 64-hex word, or a 40-hex sha split by `.`, drops that machine
/// (counted, not named); the ordinary machine stays.
#[test]
fn diagnose_alias_hex_dropped() {
    let split = format!("{}.{}", &SHA40_SEGMENT[..20], &SHA40_SEGMENT[20..]);
    let h = Home::new();
    let bundle = h.bundle(&json!({"machines": {
        HEX_SEGMENT: {"projects": {"/a": "/b"}},
        split.clone(): {"projects": {"/a": "/b"}},
        "mini": {"projects": {"/a": "/b"}},
    }}));
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(settings["dropped"], json!(["machines (2 entries)"]));
    assert_eq!(
        settings["machines"],
        json!({"mini": {"projects": {"/a": "/b"}}})
    );
    let text = bundle_text(&bundle);
    for secret in [HEX_SEGMENT, &SHA40_SEGMENT[..20], &SHA40_SEGMENT[20..]] {
        assert!(!text.contains(secret), "{secret} leaked into the bundle");
    }
}

/// Over-redaction guard for the joined rule and the newly checked fields: short hex, 8-31 character names, dotted
/// names, `+` in a name and ordinary `worktrees_dir`/`usage_link_roots` stay unchanged.
#[test]
fn diagnose_ordinary_values_kept() {
    let machines = json!({
        "my.project.v2": {"projects": {
            "/w/deadbeef": "/srv/my.project.v2",
            "/w/release-2026-q4": "/srv/app_v2_build_31_chars_xyz123456",
            "/w/com.example.app.v2": "/srv/c++/lib.2026.11",
            "/w/v1.2.3+build.42": "/srv/x=1/y",
        }},
        "mini": {"projects": {"/a": "/b"}},
    });
    let settings = json!({
        "machines": machines,
        "worktrees_dir": "/work/my.trees.v2",
        "usage_link_roots": ["/w/links", "/srv/deadbeef/my.project.v2"],
    });
    let h = Home::new();
    let kept = json_of(&h.bundle(&settings), "settings.json");
    assert_eq!(kept["dropped"], json!([]));
    for key in ["machines", "worktrees_dir", "usage_link_roots"] {
        assert_eq!(kept[key], settings[key], "{key}");
    }
}

/// Review r3 item 1: a path or machine name ending in a secret word (`api-token`) drops only its own entry; the
/// other machine and the other pairs stay.
#[test]
fn diagnose_secret_word_entry_drops_only_itself() {
    let h = Home::new();
    let bundle = h.bundle(&json!({"machines": {
        "mini": {"projects": {"/w/ok": "/srv/ok", "/w/api-token": "/srv/x"}},
        "ci-token": {"projects": {"/w/z": "/srv/z"}},
        "book": {"projects": {"/w/b": "/srv/b"}},
    }}));
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(
        settings["machines"],
        json!({"mini": {"projects": {"/w/ok": "/srv/ok"}}, "book": {"projects": {"/w/b": "/srv/b"}}})
    );
    assert_eq!(settings["dropped"], json!(["machines (2 entries)"]));
    assert!(!bundle_text(&bundle).contains("ci-token"));
}

/// Review r3 item 2, r4 item 1: an IP address anywhere in a path (project path, worktrees_dir, usage_link_roots), also
/// inside a segment (`:22`, `user@`, `nas-` around it), drops that entry alone.
#[test]
fn diagnose_ip_in_path_segment_dropped() {
    let h = Home::new();
    for ip in [
        "/net/10.0.0.5/share",
        "/Volumes/192.168.1.20/proj",
        "/net/10.0.0.5:22/share",
        "/mnt/admin@192.168.1.20/x",
        "/Volumes/nas-10.0.0.5/p",
    ] {
        let bundle = h.bundle(&json!({
            "machines": {"mini": {"projects": {"/w/ok": "/srv/ok", ip: "/srv/k", "/w/v": ip}}},
            "worktrees_dir": ip,
            "usage_link_roots": ["/w/links", ip],
        }));
        let settings = json_of(&bundle, "settings.json");
        assert_eq!(
            settings["machines"],
            json!({"mini": {"projects": {"/w/ok": "/srv/ok"}}}),
            "{ip}"
        );
        assert_eq!(
            settings["dropped"],
            json!([
                "machines (2 entries)",
                "usage_link_roots (1 entries)",
                "worktrees_dir"
            ]),
            "{ip}"
        );
        assert_eq!(settings["usage_link_roots"], json!(["/w/links"]));
        let text = bundle_text(&bundle);
        assert!(
            !text.contains("10.0.0.5") && !text.contains("192.168.1.20"),
            "{ip}"
        );
    }
    // Not an IP: fewer than four digit parts in every run, or a non-digit part inside the run.
    for ok in ["/w/1.2.3", "/w/v1.2.3-4", "/w/1.2.x.4", "/w/1.2.3_4.5"] {
        let bundle = h.bundle(&json!({"worktrees_dir": ok}));
        assert_eq!(json_of(&bundle, "settings.json")["worktrees_dir"], ok);
    }
    // r4: a run with four or more digit parts is an IP even inside a version (`v1.2.3.4a`, `1.2.3.4.5`).
    for gone in ["/w/v1.2.3.4a", "/w/1.2.3.4.5"] {
        let bundle = h.bundle(&json!({"worktrees_dir": gone}));
        assert_eq!(
            json_of(&bundle, "settings.json")["dropped"],
            json!(["worktrees_dir"]),
            "{gone}"
        );
    }
}

/// Review r4 item 1: a machine name holding an IP (`nas-10.0.0.5`) drops that machine alone.
#[test]
fn diagnose_ip_in_machine_name_dropped() {
    let h = Home::new();
    let bundle = h.bundle(&json!({"machines": {
        "nas-10.0.0.5": {"projects": {"/a": "/b"}},
        "book": {"projects": {"/w/b": "/srv/b"}},
    }}));
    let settings = json_of(&bundle, "settings.json");
    assert_eq!(
        settings["machines"],
        json!({"book": {"projects": {"/w/b": "/srv/b"}}})
    );
    assert_eq!(settings["dropped"], json!(["machines (1 entries)"]));
    assert!(!bundle_text(&bundle).contains("10.0.0.5"));
}

/// Review r3 item 3: a base64 token cut by `~`, `:`, `@` or `%` is judged whole; `/` still separates.
#[test]
fn diagnose_more_joiners_dropped() {
    let (a, b) = ("Ab3dEf5hIj7lMn9p", "Qr1tUv3xYz5bC7eG");
    for j in ["~", ":", "@", "%"] {
        assert_segment_dropped(&format!("{a}{j}{b}"));
    }
    let h = Home::new();
    let bundle = h.bundle(&json!({"worktrees_dir": format!("/w/{a}/{b}")}));
    assert_eq!(json_of(&bundle, "settings.json")["dropped"], json!([]));
}
