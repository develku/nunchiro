//! Small reads of a connection's peer and its line, moved out of `server.rs` to keep it within its size.

/// Whether the peer closed its end: a held hook's client the agent ended (its timeout, or the person's interrupt).
pub(super) fn peer_gone(fd: i32) -> bool {
    let mut byte = 0u8;
    // SAFETY: a one-byte, non-blocking peek on the descriptor this connection owns for the whole call.
    let n = unsafe {
        libc::recv(
            fd,
            (&mut byte as *mut u8).cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    n == 0
}
/// V2.5-48: the hook bridge's start (`started_ms`, beside `token` and `request`); the core clamps it
/// (`nudge::counted_from`).
pub(super) fn started_ms(line: &str) -> Option<u64> {
    #[derive(serde::Deserialize)]
    struct Started {
        started_ms: Option<u64>,
    }
    serde_json::from_str::<Started>(line)
        .ok()
        .and_then(|s| s.started_ms)
}
