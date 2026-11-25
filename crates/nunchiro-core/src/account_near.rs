//! Ticket 1126: when the owner's default account for new sessions has used the owner's level of its week
//! (`accounts.near_percent`, 98 unless set; round 4), a card in the status bar offers the next account (one click).
//! The 5-hour share never counts. Only the owner's click moves the default: every
//! usage number is something a session can write (Claude's come from its sessions' own status lines, Codex's from
//! rollout files under the account folder), so none moves it by itself (Codex security looks P1, 1126 rounds 2 and 3).
//!
//! Records, in `settings.json` `features` through the owner's settings writer (`Sessions::quit_settings`), so the
//! window and the core read one copy: `accounts.near.<agent>` (the card), `accounts.all_near.<agent>` (the red card).
//! No request op runs this rule and no session writes any of these keys (`quit_settings` is owner-only).
use crate::{
    accounts::{Agent, OWN, agent_name},
    api::{LifetimePatch, Reply, Response},
    sessions::Sessions,
    usage::Limit,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, sync::Mutex};

/// The owner's level for the card (`accounts.near_percent`, percent of the week used; owner 2026-11-25 "사용자가 용량을
/// 지정할수 있게"). Written only through `quit_settings` (owner-only), like every `accounts.*` key.
pub(crate) const NEAR_PERCENT: &str = "accounts.near_percent";
/// Missing or outside 50..=99: 98, the round 1 level.
pub(crate) fn near_percent(sessions: &Sessions) -> u8 {
    sessions
        .feature::<u64>(NEAR_PERCENT)
        .filter(|p| (50..=99).contains(p))
        .map_or(98, |p| p as u8)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    /// The default is below the level: no card.
    Quiet,
    /// The card offers `next`; nothing switches.
    Card { next: String },
    /// No account is below the level: nothing to switch to; `first` resets first.
    AllNear { first: String, resets_at: i64 },
}

/// `order`: the agent's account ids, "Your own" first, then registry order. `weekly`: each id's last weekly record.
/// The next account is the first after `current` (wrapping) below `at` percent used; one with no record yet comes after
/// every one known to be below it.
// shortcut: a signed-out account is not skipped (the core keeps no sign-in state; a probe is a Node start per
// account); the window's menu shows it signed out. Keep a last-known state per account when that matters.
pub(crate) fn decide(
    order: &[String],
    current: &str,
    weekly: &BTreeMap<String, Limit>,
    now: i64,
    at: u8,
) -> Decision {
    let ahead = |id: &str| weekly.get(id).filter(|l| l.resets_at > now);
    // `Limit` counts what is left.
    let near = |id: &str| ahead(id).is_some_and(|l| l.left_pct <= 100 - at);
    if !near(current) {
        return Decision::Quiet;
    }
    let from = order
        .iter()
        .position(|id| id == current)
        .map_or(0, |i| i + 1);
    let free = || {
        order
            .iter()
            .cycle()
            .skip(from)
            .take(order.len())
            .filter(|id| id.as_str() != current && !near(id))
    };
    match free()
        .find(|id| ahead(id).is_some())
        .or_else(|| free().next())
    {
        Some(next) => Decision::Card { next: next.clone() },
        None => {
            let (first, resets_at) = order
                .iter()
                .map(String::as_str)
                .chain([current])
                .filter(|id| near(id))
                .filter_map(|id| Some((id.to_string(), ahead(id)?.resets_at)))
                .min_by_key(|(_, at)| *at)
                .unwrap_or_else(|| (current.to_string(), 0));
            Decision::AllNear { first, resets_at }
        }
    }
}

/// Runs the rule for `agent` and writes only the records that changed; it never writes the default. Called with the
/// registry locked.
pub(crate) fn check(
    sessions: &mut Sessions,
    home: &Path,
    agent: Agent,
    weekly: &BTreeMap<String, Limit>,
    now: i64,
) {
    let key = |k: &str| format!("accounts.{k}.{}", agent_name(agent));
    let order: Vec<String> = std::iter::once(OWN.to_string())
        .chain(
            crate::accounts::registered(home)
                .unwrap_or_default()
                .into_iter()
                .filter(|(a, _)| *a == agent)
                .map(|(_, id)| id),
        )
        .collect();
    let current = sessions
        .feature::<String>(&key("default"))
        .filter(|id| order.contains(id))
        .unwrap_or_else(|| OWN.to_string());
    let used = |id: &str| {
        weekly
            .get(id)
            .filter(|l| l.resets_at > now)
            .map(|l| 100 - l.left_pct.min(100))
    };
    let resets = weekly.get(&current).map_or(0, |l| l.resets_at);
    let mut want: BTreeMap<String, Value> = [key("near"), key("all_near")]
        .map(|k| (k, Value::Null))
        .into();
    match decide(&order, &current, weekly, now, near_percent(sessions)) {
        Decision::Quiet => {}
        Decision::Card { next } => {
            want.insert(
                key("near"),
                json!({"id": current, "used": used(&current), "next": next, "next_used": used(&next), "resets_at": resets}),
            );
        }
        Decision::AllNear { first, resets_at } => {
            want.insert(
                key("all_near"),
                json!({"id": current, "used": used(&current), "first": first, "first_reset": resets_at}),
            );
        }
    }
    want.retain(|k, v| sessions.feature::<Value>(k).unwrap_or(Value::Null) != *v);
    if want.is_empty() {
        return;
    }
    let patch = LifetimePatch {
        features: Some(want),
        ..Default::default()
    };
    if let Err(e) = sessions.quit_settings(patch) {
        eprintln!("account near-limit record: {e}");
    }
}

/// A session's settings write that only turns `accounts::LEADS_ANY` on: it becomes the owner's card
/// (`Sessions::ask_owner`), as `permission-answers on` does; any other session write stays refused.
pub(crate) fn asks_leads_any(patch: &LifetimePatch) -> bool {
    let on = LifetimePatch {
        features: Some([(crate::accounts::LEADS_ANY.to_string(), Value::Bool(true))].into()),
        ..Default::default()
    };
    serde_json::to_value(patch).ok() == serde_json::to_value(on).ok()
}

/// Each Claude account's last weekly record (`claude-limits.json`, ticket 1036).
pub(crate) fn claude_weekly(home: &Path) -> BTreeMap<String, Limit> {
    crate::usage::claude_limits(home)
        .into_iter()
        .filter_map(|(id, told)| Some((id, told.weekly?)))
        .collect()
}

/// After the window's usage read (every few minutes, and when a menu opens): the rule for both agents from the rows
/// it read. Codex's numbers live in its rollouts only, so this is where its card comes from; the rows are read off the
/// registry lock, which is taken only to check and write.
pub(crate) fn after_usage(registry: &Mutex<Sessions>, home: &Path, reply: &Response, now: i64) {
    let Ok(Reply::AccountUsage { rows }) = reply else {
        return;
    };
    let Ok(mut sessions) = registry.lock() else {
        return;
    };
    for agent in [Agent::Claude, Agent::Codex] {
        let weekly = rows
            .iter()
            .filter(|r| r.agent == agent)
            .filter_map(|r| Some((r.id.clone(), r.weekly?)))
            .collect();
        check(&mut sessions, home, agent, &weekly, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> Vec<String> {
        ["own", "main", "work", "spare"].map(String::from).to_vec()
    }
    fn week(pairs: &[(&str, u8)]) -> BTreeMap<String, Limit> {
        pairs
            .iter()
            .map(|(id, used)| {
                (
                    id.to_string(),
                    Limit {
                        left_pct: 100 - used,
                        resets_at: 1000,
                    },
                )
            })
            .collect()
    }
    const NOW: i64 = 100;

    #[test]
    fn at_98_the_card_names_the_next_account_below_98() {
        let w = week(&[("main", 98), ("work", 18), ("spare", 10)]);
        assert_eq!(
            decide(&ids(), "main", &w, NOW, 98),
            Decision::Card {
                next: "work".into()
            }
        );
        // 97% is no trigger.
        let w = week(&[("main", 97), ("work", 18)]);
        assert_eq!(decide(&ids(), "main", &w, NOW, 98), Decision::Quiet);
        // A record whose week has reset is no trigger either.
        assert_eq!(
            decide(&ids(), "main", &week(&[("main", 99)]), 1000, 98),
            Decision::Quiet
        );
    }

    #[test]
    fn the_owners_level_moves_the_trigger() {
        let w = week(&[("main", 80), ("work", 18)]);
        let card = Decision::Card {
            next: "work".into(),
        };
        assert_eq!(decide(&ids(), "main", &w, NOW, 80), card);
        assert_eq!(decide(&ids(), "main", &w, NOW, 81), Decision::Quiet);
        // An account at the level is no next one either.
        let w = week(&[("main", 85), ("work", 80), ("spare", 79)]);
        assert_eq!(
            decide(&ids(), "main", &w, NOW, 80),
            Decision::Card {
                next: "spare".into()
            }
        );
    }

    #[test]
    fn unknown_numbers_rank_after_known_and_the_order_wraps_to_your_own() {
        // work has no record yet, spare is known below 98%: spare first.
        let w = week(&[("main", 99), ("spare", 40)]);
        assert_eq!(
            decide(&ids(), "main", &w, NOW, 98),
            Decision::Card {
                next: "spare".into()
            }
        );
        // From spare the order wraps: "Your own" (known, 5%) before main.
        let w = week(&[("spare", 98), ("own", 5), ("main", 99), ("work", 99)]);
        assert_eq!(
            decide(&ids(), "spare", &w, NOW, 98),
            Decision::Card { next: "own".into() }
        );
        // Only unknown ones left: the first after the current one.
        let w = week(&[("main", 99)]);
        assert_eq!(
            decide(&ids(), "main", &w, NOW, 98),
            Decision::Card {
                next: "work".into()
            }
        );
    }

    #[test]
    fn every_account_at_98_switches_nothing_and_names_the_first_reset() {
        let mut w = week(&[("own", 98), ("main", 99), ("work", 100), ("spare", 98)]);
        w.get_mut("work").unwrap().resets_at = 500;
        assert_eq!(
            decide(&ids(), "main", &w, NOW, 98),
            Decision::AllNear {
                first: "work".into(),
                resets_at: 500
            }
        );
    }
}
