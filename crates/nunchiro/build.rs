//! F1: `nunchiro --version` names the build's git sha, so a stale copy on PATH shows. No git (a source tarball): no sha.
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

fn main() {
    if let Some(sha) = git(&["rev-parse", "--short=9", "HEAD"]) {
        println!("cargo:rustc-env=NUNCHIRO_GIT_SHA={sha}");
    }
    // HEAD moves on a checkout or commit; a missing path just reruns this cheap script every build.
    if let Some(head) = git(&["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={head}");
    }
    println!("cargo:rerun-if-changed=build.rs");
    // In a worktree HEAD names the branch and does not change on a commit; a stamped build (an RC, a release) asks again.
    for stamp in ["NUNCHIRO_BUILD", "NUNCHIRO_RELEASE"] {
        println!("cargo:rerun-if-env-changed={stamp}");
    }
}
