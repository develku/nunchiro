// v1a-53: flow control of window output. The pacing state alone; the window loop over a real socket is in
// tests/flow_control.rs.
use super::{Pace, UNACKED_MAX, UNACKED_TOTAL};
use crate::pty::REPLAY_BYTES;

const MIB: u64 = 1 << 20;

/// What a window whose only unacked output is `p`'s has left of the total.
fn alone(p: &Pace) -> Option<u64> {
    Some(UNACKED_TOTAL - p.unacked())
}

#[test]
fn ack_validation() {
    let mut p = Pace::default();
    p.sent(1000);
    assert!(!p.ack(1001), "past what was sent");
    assert!(p.ack(600));
    assert!(!p.ack(599), "lower than before");
    assert!(p.ack(600), "the same value again is harmless");
    assert!(p.ack(1000));
    // An ignored ack changes nothing: the window still counts 0 bytes in flight.
    assert!(!p.ack(5000));
    assert_eq!(p.unacked(), 0);
}

#[test]
fn ack_advances_window() {
    let mut p = Pace::default();
    // A window that never acked is not paced (old builds); one that acks is.
    assert_eq!(
        p.take(None, 100 * MIB as usize, false),
        Some(100 * MIB as usize)
    );
    let first = p.take(alone(&p), 100 * MIB as usize, false).unwrap();
    assert_eq!(
        first as u64, UNACKED_TOTAL,
        "a lone session stops at the window's total"
    );
    p.sent(first as u64);
    assert!(p.held(alone(&p), 1));
    assert_eq!(p.take(alone(&p), 100, false), None);
    assert!(p.ack(3 * MIB));
    assert!(!p.held(alone(&p), 1));
    // Acking N bytes lets N more go, and no more: sent never passes acked plus the total.
    assert_eq!(
        p.take(alone(&p), 100 * MIB as usize, false),
        Some(3 * MIB as usize)
    );
    p.sent(3 * MIB);
    assert!(p.held(alone(&p), 1));
}

#[test]
fn each_session_keeps_its_own_room_when_the_window_total_is_used() {
    let mut quiet = Pace::default();
    // Busy sessions hold the whole total: a quiet one still sends up to its own `UNACKED_MAX`.
    assert_eq!(quiet.take(Some(0), 10, false), Some(10));
    quiet.sent(UNACKED_MAX - 10);
    assert_eq!(quiet.take(Some(0), 100, false), Some(10));
    quiet.sent(10);
    assert!(quiet.held(Some(0), 1));
    // A busy one past its own room waits for the total.
    let mut busy = Pace::default();
    busy.sent(5 * MIB);
    assert!(busy.held(Some(0), 1));
    assert_eq!(
        busy.take(Some(2 * MIB), 10 * MIB as usize, false),
        Some(2 * MIB as usize)
    );
}

#[test]
fn pace_skip_goes_whole_or_waits() {
    let mut p = Pace::default();
    p.sent(UNACKED_TOTAL);
    p.ack(UNACKED_TOTAL - MIB / 2); // half a MiB of room
    // Behind by more than the replay: the skip waits until the whole newest replay fits, never a part of it.
    assert!(p.held(Some(MIB / 2), REPLAY_BYTES as u64 + 1));
    assert_eq!(p.take(Some(MIB / 2), REPLAY_BYTES, true), None);
    // Not behind by more than the replay: the half MiB of room goes out.
    assert!(!p.held(Some(MIB / 2), REPLAY_BYTES as u64));
    assert_eq!(
        p.take(Some(MIB / 2), REPLAY_BYTES, false),
        Some(MIB as usize / 2)
    );
    p.ack(UNACKED_TOTAL);
    assert!(!p.held(alone(&p), 50 * MIB));
    assert_eq!(p.take(alone(&p), REPLAY_BYTES, true), Some(REPLAY_BYTES));
}
