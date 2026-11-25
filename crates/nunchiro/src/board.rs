// V2.5-35 (ticket 183): `nunchiro board list|create|add|move|done|note|self` (V2.5-69, ticket 289: `create` is `add` with a
// column and a one-line why, `note` rewrites the why). Each verb is one core request, the same ones the
// window sends; the core's rights check (`board::rights`) decides what the caller may write. Inside a session the
// caller is that session (its token, or the owner token checked against the peer); outside, the owner.
use nunchiro_core::{api::*, board::Attachment, board::Receipt};
use serde_json::Value;
use std::path::Path;

const HELP: &str = "nunchiro board list [--json]
nunchiro board create TITLE [--column COLUMN] [--why LINE] [--group ID] [--ref PATH|URL] [--waits-on CARD]... [--attach SESSION [--role ROLE]]... [--json]
nunchiro board add TITLE ...   (the same as create)
nunchiro board move CARD COLUMN [--json]
nunchiro board done CARD [--receipt \"<sha> · <command> · <result>\"] [--json]
nunchiro board note CARD TEXT [--json]
nunchiro board self [--json]
COLUMN is a column id or title, or a watch name: next (the first column that claims no state), needs-you (the
needs-decision column). --why is the one line that says why a card waits.
Inside a session the core checks what the session may write: the coordinator (a session with live child sessions)
writes every card of its children's projects; any other session moves only the card it is attached to. An agent's
move into Done needs a receipt, or the card stops in Review. No herdr import.";

pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    let json = args.iter().any(|a| a == "--json");
    let args: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|a| *a != "--json")
        .collect();
    match args.as_slice() {
        [] | ["--help"] => {
            println!("{HELP}");
            Ok(())
        }
        ["list"] => {
            let mut board = call(home, Request::BoardSnapshot)?;
            mark_archived(&mut board);
            if json {
                return print(&board);
            }
            for card in cards(&board).iter().filter(|c| c["source"] == "manual") {
                println!("{}", line(card));
            }
            Ok(())
        }
        ["create" | "add", rest @ ..] => {
            let (request, column, why) = add(rest)?;
            let title = match &request {
                Request::BoardAdd { title, .. } => title.clone(),
                _ => unreachable!(),
            };
            let before = ids(&call(home, Request::BoardSnapshot)?);
            let columns = call(home, Request::BoardSnapshot)?;
            // The column is resolved before anything is written, so an unknown one leaves no card.
            let column = column.map(|c| column_id(&columns, &c)).transpose()?;
            let mut board = call(home, request)?;
            let mut card = new_card(&board, &title, &before)?;
            if column.is_some() || why.is_some() {
                board = put(home, &card, why, column)?;
                card = new_card(&board, &title, &before)?;
            }
            if json {
                return print(&card);
            }
            println!("added {}", line(&card));
            Ok(())
        }
        ["note", id, text] => {
            let board = call(home, Request::BoardSnapshot)?;
            let card = cards(&board)
                .into_iter()
                .find(|c| c["source"] == "manual" && c["id"] == *id)
                .ok_or_else(|| format!("board card not found: {id}"))?;
            let board = put(home, &card, Some(text.to_string()), None)?;
            let card = cards(&board)
                .into_iter()
                .find(|c| c["id"] == *id)
                .ok_or("card not in the board")?;
            if json {
                return print(&card);
            }
            println!("{}", line(&card));
            Ok(())
        }
        ["move", id, column] => {
            let board = call(home, Request::BoardSnapshot)?;
            let column = column_id(&board, column)?;
            let board = call(
                home,
                Request::BoardMove {
                    source: nunchiro_core::board::Source::Manual,
                    id: id.to_string(),
                    column: column.clone(),
                },
            )?;
            landed(&board, id, &column, json)
        }
        ["done", id, rest @ ..] => {
            let receipt = match rest {
                [] => None,
                ["--receipt", text] => Some(receipt(text)?),
                _ => return Err(usage()),
            };
            let board = call(
                home,
                Request::BoardDone {
                    id: id.to_string(),
                    receipt,
                },
            )?;
            let done = board["columns"]
                .as_array()
                .and_then(|c| c.iter().find(|c| c["proof"] == true).or_else(|| c.last()))
                .and_then(|c| c["id"].as_str())
                .unwrap_or("done")
                .to_string();
            landed(&board, id, &done, json)
        }
        ["self"] => {
            let board = call(home, Request::BoardSelf)?;
            let card = cards(&board).into_iter().next();
            match (card, json) {
                (card, true) => print(&card.unwrap_or(Value::Null)),
                (Some(card), false) => {
                    println!("{}", line(&card));
                    Ok(())
                }
                (None, false) => {
                    println!("no card is attached to this session");
                    Ok(())
                }
            }
        }
        _ => Err(usage()),
    }
}

fn usage() -> String {
    format!("usage:\n{HELP}")
}

fn call(home: &Path, request: Request) -> Result<Value, String> {
    super::ensure_core(home)?;
    match super::call(home, request)? {
        Reply::BoardSnapshot { board } => serde_json::to_value(board).map_err(|e| e.to_string()),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}

/// JSON as today, with each hidden character (`board::rights::hidden`) and each control serde leaves raw (DEL, C1)
/// written as a `\uXXXX` escape (a surrogate pair above U+FFFF): JSON structure is ASCII, so they sit inside strings;
/// a parser gets the stored text back, a terminal or an agent reading raw output sees the escape.
fn print(value: &Value) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let mut out = String::with_capacity(json.len());
    for c in json.chars() {
        if c.is_control() || nunchiro_core::board::rights::hidden(c) {
            for unit in c.encode_utf16(&mut [0; 2]) {
                out += &format!("\\u{unit:04x}");
            }
        } else {
            out.push(c);
        }
    }
    println!("{out}");
    Ok(())
}

fn cards(board: &Value) -> Vec<Value> {
    board["cards"].as_array().cloned().unwrap_or_default()
}

fn ids(board: &Value) -> Vec<Value> {
    cards(board).into_iter().map(|c| c["id"].clone()).collect()
}

/// Control characters (tab included: it separates the fields) and hidden bidi or zero-width marks as `\u{..}`, so
/// stored card text never drives or reorders the terminal.
fn safe(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() || nunchiro_core::board::rights::hidden(c) {
                c.escape_unicode().to_string()
            } else {
                c.to_string()
            }
        })
        .collect()
}

/// Ticket 1066: sets `archived` on every card: true when it is in a done column and arrived there more than
/// `settings.done_days` days ago (the rule the window's Done column uses).
fn mark_archived(board: &mut Value) {
    let span = board["settings"]["done_days"].as_u64().unwrap_or(7) * 86_400_000;
    let now = nunchiro_core::queue::now_ms();
    for card in board["cards"].as_array_mut().into_iter().flatten() {
        let old = card["done_at"]
            .as_u64()
            .is_some_and(|at| now.saturating_sub(at) > span);
        card["archived"] = Value::Bool(old);
    }
}

/// `id  column  title  group  ref  session:role,...  receipt  archived`, tab-separated; the last field is
/// `archived` for a card past `done_days` in Done, else empty.
fn line(card: &Value) -> String {
    let attached: Vec<String> = card["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| {
            let who = a["label"]
                .as_str()
                .filter(|l| !l.is_empty())
                .or(a["session_id"].as_str())
                .unwrap_or_default();
            match a["role"].as_str() {
                Some(role) if !role.is_empty() => format!("{who}:{role}"),
                _ => who.to_string(),
            }
        })
        .collect();
    let receipt = &card["receipt"];
    let receipt = if receipt.is_null() {
        String::new()
    } else {
        format!(
            "{} · {} · {}",
            receipt["sha"].as_str().unwrap_or_default(),
            receipt["command"].as_str().unwrap_or_default(),
            receipt["result"].as_str().unwrap_or_default()
        )
    };
    let attached = attached.join(",");
    let mut fields = vec![
        card["id"].as_str().unwrap_or_default(),
        card["column"].as_str().unwrap_or_default(),
        card["title"].as_str().unwrap_or_default(),
        card["group"].as_str().unwrap_or_default(),
        card["ref"].as_str().unwrap_or_default(),
        &attached,
        &receipt,
    ];
    // Only `list` marks cards; the other commands print the old seven fields.
    if !card["archived"].is_null() {
        fields.push(if card["archived"] == true {
            "archived"
        } else {
            ""
        });
    }
    fields.into_iter().map(safe).collect::<Vec<_>>().join("\t")
}

/// A column by id or by title (case-insensitive), else by a watch name: `next` is the first column that claims no
/// state (To do), `needs-you` the first one cards raise decisions in.
fn column_id(board: &Value, name: &str) -> Result<String, String> {
    let columns = || board["columns"].as_array().into_iter().flatten();
    columns()
        .find(|c| c["id"] == name)
        .or_else(|| {
            columns().find(|c| {
                c["title"]
                    .as_str()
                    .is_some_and(|t| t.eq_ignore_ascii_case(name))
            })
        })
        .or_else(|| match name.to_ascii_lowercase().as_str() {
            "next" => columns().find(|c| c["states"].as_array().is_none_or(|s| s.is_empty())),
            "needs-you" => columns().find(|c| {
                c["needs_decision"] == true
                    || c["states"]
                        .as_array()
                        .is_some_and(|s| s.iter().any(|s| s == "needs_decision"))
            }),
            _ => None,
        })
        .and_then(|c| c["id"].as_str())
        .map(String::from)
        .ok_or_else(|| format!("board column not found: {name}"))
}

fn title(board: &Value, id: &str) -> String {
    board["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|c| c["id"] == id)
        .and_then(|c| c["title"].as_str())
        .unwrap_or(id)
        .to_string()
}

/// Prints where the card landed; one that stopped short of a `proof` column (no receipt) fails with the reason.
fn landed(board: &Value, id: &str, asked: &str, json: bool) -> Result<(), String> {
    let card = cards(board)
        .into_iter()
        .find(|c| c["source"] == "manual" && c["id"] == id)
        .ok_or_else(|| format!("board card not found: {id}"))?;
    let column = card["column"].as_str().unwrap_or_default().to_string();
    if json {
        print(&card)?;
    } else if column == asked {
        println!("{}", line(&card));
    }
    if column != asked {
        return Err(format!(
            "receipt missing · stopped in {} on the way to {} (sha, command, result needed)",
            title(board, &column),
            title(board, asked)
        ));
    }
    Ok(())
}

/// `"<sha> · <command> · <result>"`: exactly three non-empty parts split on " · ".
fn receipt(text: &str) -> Result<Receipt, String> {
    match text
        .split(" · ")
        .map(str::trim)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [sha, command, result] if [sha, command, result].iter().all(|p| !p.is_empty()) => {
            Ok(Receipt {
                sha: sha.to_string(),
                command: command.to_string(),
                result: result.to_string(),
            })
        }
        _ => Err("malformed --receipt: expected \"<sha> · <command> · <result>\"".into()),
    }
}

/// The new card: the one of this title that the board did not hold before.
fn new_card(board: &Value, title: &str, before: &[Value]) -> Result<Value, String> {
    cards(board)
        .into_iter()
        .rev()
        .find(|c| c["source"] == "manual" && c["title"] == title && !before.contains(&c["id"]))
        .ok_or_else(|| "added card not in the board".into())
}

/// Rewrites a card's note and/or column (the window's own `board_put`; the core's rights check applies as to any write).
fn put(
    home: &Path,
    card: &Value,
    note: Option<String>,
    column: Option<String>,
) -> Result<Value, String> {
    call(
        home,
        Request::BoardPut {
            id: card["id"].as_str().map(String::from),
            title: card["title"].as_str().unwrap_or_default().to_string(),
            note: note.unwrap_or_else(|| card["note"].as_str().unwrap_or_default().to_string()),
            session_id: card["session_id"].as_str().map(String::from),
            column: Some(
                column.unwrap_or_else(|| card["column"].as_str().unwrap_or_default().to_string()),
            ),
        },
    )
}

fn add(args: &[&str]) -> Result<(Request, Option<String>, Option<String>), String> {
    let (mut title, mut group, mut reference) = (None, None, None);
    let (mut column, mut why) = (None, None);
    let (mut waits_on, mut attachments): (Vec<String>, Vec<Attachment>) = (vec![], vec![]);
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = || {
            it.next()
                .map(|v| v.to_string())
                .ok_or_else(|| format!("{arg} needs a value"))
        };
        match *arg {
            "--column" => column = Some(value()?),
            "--why" => {
                let line = value()?;
                if line.contains(['\n', '\r']) {
                    return Err("--why is one line: no line break".into());
                }
                why = Some(line);
            }
            "--group" => group = Some(value()?),
            "--ref" => reference = Some(value()?),
            "--waits-on" => waits_on.push(value()?),
            "--attach" => attachments.push(Attachment {
                session_id: value()?,
                role: String::new(),
            }),
            "--role" => {
                let role = value()?;
                attachments
                    .last_mut()
                    .ok_or("--role follows an --attach")?
                    .role = role;
            }
            flag if flag.starts_with("--") => return Err(format!("unknown flag: {flag}")),
            text if title.is_none() => title = Some(text.to_string()),
            _ => return Err(usage()),
        }
    }
    let request = Request::BoardAdd {
        title: title.ok_or("board create needs a TITLE")?,
        group,
        reference,
        waits_on: (!waits_on.is_empty()).then_some(waits_on),
        attachments: (!attachments.is_empty()).then_some(attachments),
    };
    Ok((request, column, why))
}

#[cfg(test)]
mod tests {
    #[test]
    fn mark_archived_follows_done_days() {
        let day = 86_400_000;
        let now = nunchiro_core::queue::now_ms();
        let card = |ago: u64| serde_json::json!({"done_at": now - ago * day / 2});
        let mut board = serde_json::json!({"settings": {"done_days": 7}, "cards": [card(2), card(20), serde_json::json!({"done_at": null})]});
        super::mark_archived(&mut board);
        let marks: Vec<_> = board["cards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["archived"].clone())
            .collect();
        assert_eq!(marks, [false, true, false]);
        assert_eq!(
            super::line(&board["cards"][1].clone())
                .split('\t')
                .next_back(),
            Some("archived")
        );
    }

    #[test]
    fn receipt_parses_three_parts() {
        let r = super::receipt("abc1234 · cargo test · 12 passed").unwrap();
        assert_eq!(
            (r.sha.as_str(), r.command.as_str(), r.result.as_str()),
            ("abc1234", "cargo test", "12 passed")
        );
        for bad in [
            "abc1234 cargo test ok",
            "a · b",
            "a · b · c · d",
            " · b · c",
        ] {
            assert!(super::receipt(bad).is_err(), "{bad}");
        }
    }
}
