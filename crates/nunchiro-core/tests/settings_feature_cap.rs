//! V2.5-77: `settings.json` `features` holds at most `FEATURE_KEYS_MAX` (256) keys. A patch that would grow the stored
//! map past it is refused before anything is written; shrinking, rewriting and an over-cap file already on disk keep working.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{api::*, server::call};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::PathBuf};

const CAP: usize = 256;

struct Core {
    home: PathBuf,
    _serve: home::ServeGuard,
}
impl Core {
    /// A core started on a `settings.json` that already holds `keys` feature keys (`cap.k0`, `cap.k1`, ...).
    fn with_keys(tag: &str, keys: usize) -> Self {
        let home = home::short(tag);
        let features: BTreeMap<String, Value> =
            (0..keys).map(|i| (format!("cap.k{i}"), json!(i))).collect();
        fs::write(
            home.join("settings.json"),
            json!({"stale_after_ms": 5, "features": features}).to_string(),
        )
        .unwrap();
        let _serve = home::spawn_serve(&home, &[]);
        Self { home, _serve }
    }
    fn patch(&self, pairs: &[(&str, Value)]) -> Result<LifetimeSettings, String> {
        let features = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        match call(
            &self.home,
            Request::QuitSettings {
                patch: LifetimePatch {
                    features: Some(features),
                    // Another field beside the features: a refusal must not write this half either.
                    keep_awake: Some(true),
                    ..Default::default()
                },
            },
        )? {
            Reply::QuitSettings { settings } => Ok(settings),
            other => panic!("{other:?}"),
        }
    }
    fn read(&self) -> LifetimeSettings {
        match call(
            &self.home,
            Request::QuitSettings {
                patch: LifetimePatch::default(),
            },
        ) {
            Ok(Reply::QuitSettings { settings }) => settings,
            other => panic!("{other:?}"),
        }
    }
    fn file(&self) -> Vec<u8> {
        fs::read(self.home.join("settings.json")).unwrap()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        self._serve.stop();
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[test]
fn settings_features_key_cap_refused_unchanged() {
    // At the cap, one new key is refused; below it, a patch whose new keys pass it is refused too.
    for (tag, stored, new) in [("capfull", CAP, 1), ("capnear", CAP - 3, 4)] {
        let core = Core::with_keys(tag, stored);
        let before = core.file();
        let pairs: Vec<(String, Value)> =
            (0..new).map(|i| (format!("new.k{i}"), json!(1))).collect();
        let refs: Vec<(&str, Value)> = pairs.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        let e = core.patch(&refs).unwrap_err();
        assert!(e.contains("256"), "{tag}: the error names the cap: {e}");
        assert_eq!(
            core.file(),
            before,
            "{tag}: settings.json is byte-identical"
        );
        assert_eq!(core.read().features.len(), stored, "{tag}");
        assert!(
            !core.read().keep_awake,
            "{tag}: the other field was not written"
        );
    }
}

#[test]
fn settings_features_at_cap_rewrite_and_remove_ok() {
    let core = Core::with_keys("capok", CAP);
    // Rewriting existing keys adds none.
    let rewritten = core
        .patch(&[("cap.k0", json!("again")), ("cap.k1", json!(false))])
        .unwrap();
    assert_eq!(rewritten.features.len(), CAP);
    assert_eq!(rewritten.features["cap.k0"], "again");
    // A removal frees room for a new key in the same patch.
    let swapped = core
        .patch(&[("cap.k2", Value::Null), ("new.k", json!(1))])
        .unwrap();
    assert_eq!(swapped.features.len(), CAP);
    assert!(!swapped.features.contains_key("cap.k2") && swapped.features.contains_key("new.k"));
    // Removing keys only (an absent key too) always works.
    let shrunk = core
        .patch(&[
            ("cap.k3", Value::Null),
            ("cap.k4", Value::Null),
            ("no.such", Value::Null),
        ])
        .unwrap();
    assert_eq!(shrunk.features.len(), CAP - 2);
    // Up to exactly the cap is fine again, one past it is not.
    core.patch(&[("fill.a", json!(1)), ("fill.b", json!(2))])
        .unwrap();
    assert_eq!(core.read().features.len(), CAP);
    assert!(core.patch(&[("fill.c", json!(3))]).is_err());
}

#[test]
fn settings_features_over_cap_file_loads() {
    let core = Core::with_keys("capover", CAP + 44);
    let before = core.file();
    // Loaded whole: no key dropped, no write on open.
    assert_eq!(core.read().features.len(), CAP + 44);
    assert_eq!(core.file(), before);
    // Growing it is refused; rewriting and removing still work.
    assert!(core.patch(&[("new.k", json!(1))]).is_err());
    assert_eq!(core.file(), before);
    assert_eq!(
        core.patch(&[("cap.k0", json!("again"))])
            .unwrap()
            .features
            .len(),
        CAP + 44
    );
    assert_eq!(
        core.patch(&[("cap.k1", Value::Null)])
            .unwrap()
            .features
            .len(),
        CAP + 43
    );
}

/// v37-store-nofollow round 2: the core never writes a `settings.json` it then refuses to read. The largest file the
/// feature limits allow with flat values (256 keys of 4096-byte values, over 1 MiB) is written and read back, and later
/// writes still work. A patch whose pretty-printed file would pass the 4 MiB settings cap (nested values grow when
/// indented) is refused at write time; the file on disk stays as it was and stays readable and writable.
#[test]
fn settings_at_the_feature_limits_read_back_and_over_the_cap_is_refused() {
    const VALUE_MAX: usize = 4096; // `sessions::FEATURE_VALUE_MAX`
    let core = Core::with_keys("capbig", 0);
    let value = json!("v".repeat(VALUE_MAX - 2)); // the quotes count
    for batch in 0..CAP / 16 {
        let keys: Vec<String> = (0..16)
            .map(|i| format!("big.k{:03}_{}", batch * 16 + i, "x".repeat(48)))
            .collect();
        let pairs: Vec<(&str, Value)> = keys.iter().map(|k| (k.as_str(), value.clone())).collect();
        core.patch(&pairs)
            .unwrap_or_else(|e| panic!("batch {batch}: {e}"));
    }
    let full = core.file();
    assert!(full.len() > 1 << 20, "{} bytes", full.len());
    assert_eq!(core.read().features.len(), CAP);
    // Rewriting a key at the limits still reads and writes the whole file.
    let first = format!("big.k000_{}", "x".repeat(48));
    assert_eq!(
        core.patch(&[(first.as_str(), json!(1))]).unwrap().features[&first],
        json!(1)
    );
    // 100 nested arrays around 1948 zeros: 4095 bytes compact, about 400 KB once indented in the file.
    let nested: Value = serde_json::from_str(&format!(
        "{}{}{}",
        "[".repeat(100),
        vec!["0"; 1948].join(","),
        "]".repeat(100)
    ))
    .unwrap();
    assert!(serde_json::to_vec(&nested).unwrap().len() <= VALUE_MAX);
    let before = core.file();
    let deep: Vec<String> = (0..12)
        .map(|i| format!("big.k{i:03}_{}", "x".repeat(48)))
        .collect();
    let pairs: Vec<(&str, Value)> = deep.iter().map(|k| (k.as_str(), nested.clone())).collect();
    let e = core.patch(&pairs).unwrap_err();
    assert!(
        e.starts_with("settings.json would be ")
            && e.ends_with("over its 4194304-byte limit; nothing was written"),
        "{e}"
    );
    assert_eq!(core.file(), before);
    assert_eq!(core.read().features[&first], json!(1));
    assert_eq!(
        core.patch(&[(first.as_str(), json!(2))]).unwrap().features[&first],
        json!(2)
    );
}
