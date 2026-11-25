//! Ticket 1113: close proposals survive a restart and replace only the same target's open card.
#[path = "fixtures/home.rs"]
mod home;
use nunchiro_core::{
    api::AgentKind,
    queue::{OwnerAsk, Queue},
};
use serde_json::json;

#[test]
fn close_cards_are_durable_and_deduplicated_by_target() {
    let home = home::short("close-card");
    let mut queue = Queue::open(&home).unwrap();
    queue.register("lead", AgentKind::Claude, 1).unwrap();
    let ask = |target: &str, why: &str| -> OwnerAsk {
        serde_json::from_value(json!({"type":"session_close", "target":target,
            "label":"Old session", "place":home, "why":why}))
        .unwrap()
    };
    let first = queue
        .ask_owner("lead", ask("target-a", "Unused account"))
        .unwrap();
    assert_eq!(
        first,
        queue
            .ask_owner("lead", ask("target-a", "Unused account"))
            .unwrap()
    );
    queue
        .ask_owner("lead", ask("target-a", "Ready to log out"))
        .unwrap();
    queue
        .ask_owner("lead", ask("target-b", "Another session"))
        .unwrap();
    drop(queue);
    let cards = Queue::open(&home).unwrap().owner_items();
    assert_eq!(cards.len(), 2);
    assert!(
        cards
            .iter()
            .any(|c| serde_json::to_value(&c.owner).unwrap()["why"] == "Ready to log out")
    );
    assert!(!cards.iter().any(|c| c.id == first));
}
