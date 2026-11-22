//! v1b-40: the set-aside state files in a folder, shared by the unit and integration tests.
use std::{fs, path::Path};

/// Each `*.aside` file in `home` as (name, bytes), sorted by name.
pub fn asides(home: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<_> = fs::read_dir(home)
        .unwrap()
        .map(|e| e.unwrap())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".aside"))
        .map(|e| {
            (
                e.file_name().to_string_lossy().into_owned(),
                fs::read(e.path()).unwrap(),
            )
        })
        .collect();
    out.sort();
    out
}
