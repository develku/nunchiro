//! v1a-17: gates a test holds a core call with, instead of timing it. Each cleans up on drop, so a test that fails
//! leaves no build behind and no core parked.
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

/// A hold shim (a dylib the core loads through DYLD_INSERT_LIBRARIES), built into its own folder.
#[cfg(target_os = "macos")]
pub struct Shim {
    dir: PathBuf,
    pub dylib: PathBuf,
}
#[cfg(target_os = "macos")]
impl Shim {
    pub fn build(source: &Path) -> Self {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!(
                "shim-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&dir).unwrap();
        let shim = Self {
            dylib: dir.join("hold.dylib"),
            dir,
        };
        // Ticket 1142: only the core loads the shim. Without this its sessions inherit DYLD_INSERT_LIBRARIES, and on a
        // host without SIP (GitHub's macOS runners) even /bin/sh and /bin/cat load it and die: "incompatible
        // architecture" (they are arm64e, the shim arm64).
        let own = shim.dir.join("only-this-process.c");
        fs::write(
            &own,
            "#include <stdlib.h>\n__attribute__((constructor)) static void only_this_process(void) { unsetenv(\"DYLD_INSERT_LIBRARIES\"); }\n",
        )
        .unwrap();
        let compile = std::process::Command::new("cc")
            .args(["-dynamiclib", "-Wall", "-Wextra", "-Werror"])
            .arg(source)
            .arg(&own)
            .arg("-o")
            .arg(&shim.dylib)
            .env("TMPDIR", &shim.dir)
            .output()
            .unwrap();
        assert!(
            compile.status.success(),
            "{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        shim
    }
}
#[cfg(target_os = "macos")]
impl Drop for Shim {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// A hold file: the held call waits while it exists. Dropping it releases the call too.
pub struct Hold(PathBuf);
impl Hold {
    pub fn new(path: PathBuf, text: &str) -> Self {
        fs::write(&path, text).unwrap();
        Self(path)
    }
    pub fn release(&self) {
        fs::remove_file(&self.0).unwrap();
    }
}
impl Drop for Hold {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Waits for `marker`, which the held call writes; the deadline only turns a hold never reached into a failure.
pub fn reached(marker: &Path, what: &str) {
    let until = Instant::now() + Duration::from_secs(30);
    while !marker.exists() {
        assert!(Instant::now() < until, "{what}");
        thread::sleep(Duration::from_millis(10));
    }
}
