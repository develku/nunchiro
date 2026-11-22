//! V2-8a (needs 82): the one outbound call `worktree_clean.rs` may make, pinned exactly: a single `gh pr view --json
//! headRefName -- <url>` and no other process spawn or network client. Returns the source with that one call taken
//! out, so the caller's usual bans (another `gh`, curl, a client) still apply to everything else in the file.
#![allow(dead_code)] // each test file uses part of it
pub fn worktree_clean_without_its_gh(text: &str) -> String {
    // The shipped code: the file's test module (it runs `git` to build fixtures) is not compiled into the core.
    let text = shipped(text);
    assert_eq!(
        text.matches("#[cfg(").count(),
        0,
        "worktree_clean.rs: code hidden behind another cfg"
    );
    // Ticket 1024: the core's spawns are spelled `process::command` (no secret variable inherited).
    const SPAWN: &str = "crate::process::command(\"gh\")";
    const ARGV: &str = "gh.args([\"pr\", \"view\", \"--json\", \"headRefName\", \"--\", url])";
    assert_eq!(
        text.matches(SPAWN).count(),
        1,
        "worktree_clean.rs: exactly one gh spawn"
    );
    assert_eq!(
        text.matches("process::command(").count() + text.matches("Command::new(").count(),
        1,
        "worktree_clean.rs: no other process spawn"
    );
    assert_eq!(
        text.matches(ARGV).count(),
        1,
        "worktree_clean.rs: the gh argv changed"
    );
    assert_eq!(
        text.matches("gh.arg").count(),
        1,
        "worktree_clean.rs: extra gh arguments"
    );
    for banned in [
        "TcpStream",
        "UdpSocket",
        "UnixStream",
        "std::net",
        "Client::new(",
        "curl",
        "GH_TOKEN",
        "GITHUB_TOKEN",
    ] {
        assert!(!text.contains(banned), "worktree_clean.rs has {banned}");
    }
    text.replacen(SPAWN, "", 1)
}

/// The file without its one trailing `#[cfg(test)] mod tests { ... }`: exactly one marker, it opens `mod tests`, and
/// no top-level item follows it, so no shipped code can sit behind it.
pub fn shipped(text: &str) -> &str {
    assert_eq!(
        text.matches("#[cfg(test)]").count(),
        1,
        "worktree_clean.rs: one test module marker"
    );
    let at = text
        .find("#[cfg(test)]\nmod tests {")
        .expect("worktree_clean.rs: the marker opens mod tests");
    let rest = &text[at..];
    let top: Vec<&str> = rest
        .lines()
        .skip(2)
        .filter(|l| !l.is_empty() && !l.starts_with(' '))
        .collect();
    assert_eq!(top, ["}"], "worktree_clean.rs: code after the test module");
    &text[..at]
}
