use super::*;

/// Output keeps a session's activity exact in memory, but queue.json gets a timestamp checkpoint at most every
/// ten seconds: each save rewrites the whole store with two full syncs under the registry lock, and a key typed
/// into any terminal waited behind it.
#[test]
fn output_checkpoints_activity_at_most_every_ten_seconds() {
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("queue-activity-{}", store::new_id().unwrap()));
    fs::create_dir_all(&home).unwrap();
    let mut q = Queue::open(&home).unwrap();
    q.register("s", AgentKind::Claude, 1).unwrap();
    let saved = || fs::read_to_string(home.join("queue.json")).unwrap();
    let t0 = now_ms() + 60_000;
    q.activity("s", t0).unwrap();
    let first = saved();
    q.activity("s", t0 + 5_000).unwrap();
    assert_eq!(
        q.attention("s").last_activity,
        t0 + 5_000,
        "exact in memory"
    );
    assert_eq!(saved(), first, "no save within the checkpoint");
    q.activity("s", t0 + 10_000).unwrap();
    assert_ne!(saved(), first, "checkpointed after it");
    fs::remove_dir_all(home).unwrap();
}
