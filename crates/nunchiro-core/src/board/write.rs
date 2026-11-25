//! v1b-16: the GUI writer. Replaces only `[[columns]]` through `toml_edit`, so comments, spacing,
//! key order and every other table (`[sources]` included) keep their bytes. V2.5-38: `[settings]` the same way.
use super::{Column, Settings, State, persistence};
use std::{fs, os::unix::fs::PermissionsExt, path::Path};
use toml_edit::{Array, ArrayOfTables, DocumentMut, Item, Table, TableLike, Value, value};

const CHANGED: &str = "board.toml changed, reloaded";

pub(super) fn revision(disk: &persistence::Disk) -> String {
    disk.config_stamp
        .as_ref()
        .map(|s| serde_json::to_string(s).unwrap_or_default())
        .unwrap_or_default()
}

/// `disk` has just been reloaded, so its stamp and error describe the file as it is now.
pub(super) fn put(
    home: &Path,
    disk: &mut persistence::Disk,
    revision: &str,
    columns: &[Column],
) -> Result<(), String> {
    if revision != self::revision(disk) {
        return Err(CHANGED.into());
    }
    if let Some(error) = &disk.config_error {
        return Err(error.clone());
    }
    if columns.is_empty() || columns.len() > 64 {
        return Err("expected 1 to 64 columns".into());
    }
    edit(home, disk, |doc| {
        replace_columns(doc, columns);
        // V2.5-36: the user chose needs 43's four on purpose; version 2 keeps the next read from migrating them.
        // Any other write leaves the version, so a hand-edited file keeps its bytes.
        if columns == super::old_defaults() {
            set_version(doc);
        }
        Ok(())
    })
}

/// V2.5-38 (ticket 186): writes `[settings]` (both keys), keeping every other byte. Same revision rule as `put`.
/// Without board.toml the file is created with the columns the board shows, so it parses.
pub(super) fn put_settings(
    home: &Path,
    disk: &mut persistence::Disk,
    revision: &str,
    settings: &Settings,
) -> Result<(), String> {
    if revision != self::revision(disk) {
        return Err(CHANGED.into());
    }
    if let Some(error) = &disk.config_error {
        return Err(error.clone());
    }
    settings.check()?;
    let columns = disk.columns.clone();
    edit(home, disk, |doc| {
        if !doc.contains_key("columns") {
            replace_columns(doc, &columns);
        }
        let table = doc
            .entry("settings")
            .or_insert_with(|| Item::Table(Table::new()))
            .as_table_like_mut()
            .ok_or("board.toml: settings is not a table")?;
        set(
            table,
            "stale_minutes",
            Value::from(i64::from(settings.stale_minutes)),
        );
        set(
            table,
            "turn_end_nudge",
            Value::from(settings.turn_end_nudge),
        );
        set(
            table,
            "done_days",
            Value::from(i64::from(settings.done_days)),
        );
        Ok(())
    })
}

/// Reads board.toml as the reloaded stamp names it, applies `change`, checks the result with the parser and
/// writes it atomically (mode kept). `disk` has just been reloaded and its revision checked.
fn edit(
    home: &Path,
    disk: &mut persistence::Disk,
    change: impl FnOnce(&mut DocumentMut) -> Result<(), String>,
) -> Result<(), String> {
    let path = home.join("board.toml");
    // 15's reader (regular file, no symlink, 1 MiB). The stamp before and after the read must both be
    // the reloaded one, so the bytes are the file the revision names.
    let stamp = || match fs::symlink_metadata(&path) {
        Ok(meta) => Ok(Some((persistence::Stamp::of(&meta), meta))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    };
    let before = stamp()?;
    let bytes = persistence::read_regular(&path, 1024 * 1024)?;
    let after = stamp()?;
    let (text, mode) = match (before, bytes, after) {
        (Some((a, meta)), Some(bytes), Some((b, _)))
            if a == b && disk.config_stamp.as_ref() == Some(&a) =>
        {
            (
                String::from_utf8(bytes).map_err(|e| e.to_string())?,
                Some(meta.permissions().mode() & 0o7777),
            )
        }
        (None, None, None) if disk.config_stamp.is_none() => ("version = 2\n".to_string(), None),
        _ => return Err(CHANGED.into()),
    };
    let mut doc: DocumentMut = text.parse().map_err(|e| format!("board.toml: {e}"))?;
    change(&mut doc)?;
    let out = doc.to_string();
    // 15's parser holds every rule (ids, titles, state claims, size); refuse before writing.
    super::config::parse(&out)?;
    if out.len() > 1024 * 1024 {
        return Err("board.toml would exceed 1 MiB".into());
    }
    if out != text {
        // An editor save since the read is kept: refuse rather than write over it (as `migrate_v1`).
        if stamp()?.map(|(s, _)| s) != disk.config_stamp {
            return Err(CHANGED.into());
        }
        crate::store::private_dir(home)?;
        crate::store::atomic_write(&path, out.as_bytes())?;
        if let Some(mode) = mode {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode))
                .map_err(|e| e.to_string())?;
        }
    }
    disk.reload(home);
    Ok(())
}

fn replace_columns(doc: &mut DocumentMut, columns: &[Column]) {
    let inline = matches!(doc.get("columns"), Some(Item::Value(_)));
    let mut old = match doc.get_mut("columns").map(std::mem::take) {
        Some(Item::ArrayOfTables(old)) => old.into_iter().collect::<Vec<_>>(),
        // An inline `columns = [...]` array is rewritten as `[[columns]]` tables.
        Some(Item::Value(Value::Array(old))) => old
            .into_iter()
            .filter_map(|v| match v {
                Value::InlineTable(t) => {
                    let mut t = t.into_table();
                    t.fmt();
                    Some(t)
                }
                _ => None,
            })
            .collect(),
        _ => vec![],
    };
    let mut positions: Vec<isize> = old.iter().filter_map(Table::position).collect();
    positions.sort_unstable();
    let mut positions = positions.into_iter();
    let mut last = None;
    let mut tables = ArrayOfTables::new();
    for column in columns {
        let at = old
            .iter()
            .position(|t| t.get("id").and_then(Item::as_str) == Some(&column.id));
        let mut table = match at {
            Some(at) => {
                let mut table = old.remove(at);
                // Kept tables take the old slots in their new order; output sorts by slot.
                last = positions.next().or(last);
                table.set_position(last);
                table
            }
            None => {
                let mut table = Table::new();
                table.insert("id", value(column.id.as_str()));
                // A new table sits right after the table before it.
                table.set_position(last);
                table
            }
        };
        set(&mut table, "title", Value::from(column.title.as_str()));
        // Like `needs_decision`: a column without the key keeps its bytes while it takes no state.
        if !column.states.is_empty() || table.contains_key("states") {
            let states: Array = column.states.iter().map(state_name).collect();
            set(&mut table, "states", Value::Array(states));
        }
        if column.needs_decision || table.contains_key("needs_decision") {
            set(
                &mut table,
                "needs_decision",
                Value::from(column.needs_decision),
            );
        }
        if column.proof || table.contains_key("proof") {
            set(&mut table, "proof", Value::from(column.proof));
        }
        tables.push(table);
    }
    doc["columns"] = Item::ArrayOfTables(tables);
    // `columns = ` spacing from an inline array would land inside the `[[columns]]` header.
    if let Some(mut key) = doc.as_table_mut().key_mut("columns").filter(|_| inline) {
        key.leaf_decor_mut().clear();
    }
}

/// V2.5-36 (needs 150): rewrites a version-1 file on needs 43's defaults as version 2 with the five
/// default columns, keeping comments and other tables. `meta` is the file as read; a file changed since
/// is left alone. Returns the stamp of the written file.
pub(super) fn migrate_v1(
    path: &Path,
    text: &str,
    meta: &fs::Metadata,
) -> Result<persistence::Stamp, String> {
    let mut doc: DocumentMut = text.parse().map_err(|e| format!("board.toml: {e}"))?;
    set_version(&mut doc);
    replace_columns(&mut doc, &super::defaults());
    let out = doc.to_string();
    super::config::parse(&out)?;
    let now = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if persistence::Stamp::of(&now) != persistence::Stamp::of(meta) {
        return Err(CHANGED.into());
    }
    crate::store::atomic_write(path, out.as_bytes())?;
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(meta.permissions().mode() & 0o7777),
    )
    .map_err(|e| e.to_string())?;
    Ok(persistence::Stamp::of(
        &fs::symlink_metadata(path).map_err(|e| e.to_string())?,
    ))
}

/// Sets `version = 2`, keeping the old value's spacing and comment.
fn set_version(doc: &mut DocumentMut) {
    if let Some(old) = doc.get_mut("version").and_then(Item::as_value_mut)
        && old.as_integer() != Some(2)
    {
        let decor = old.decor().clone();
        *old = Value::from(2);
        *old.decor_mut() = decor;
    }
}

/// Writes `new` only when the value differs, keeping the old value's surrounding spaces and comment.
fn set(table: &mut dyn TableLike, key: &str, new: Value) {
    match table.get_mut(key).and_then(Item::as_value_mut) {
        Some(old) if same(old, &new) => {}
        Some(old) => {
            let decor = old.decor().clone();
            *old = new;
            *old.decor_mut() = decor;
        }
        None => {
            table.insert(key, Item::Value(new));
        }
    }
}

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::String(a), Value::String(b)) => a.value() == b.value(),
        (Value::Boolean(a), Value::Boolean(b)) => a.value() == b.value(),
        (Value::Integer(a), Value::Integer(b)) => a.value() == b.value(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b.iter()).all(|(a, b)| same(a, b))
        }
        _ => false,
    }
}

fn state_name(state: &State) -> &'static str {
    match state {
        State::Idle => "idle",
        State::Working => "working",
        State::NeedsDecision => "needs_decision",
        State::Review => "review",
        State::Done => "done",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Q9 fr-J10-1: an editor save between the read and the write is not overwritten.
    #[test]
    fn edit_keeps_an_editor_save_made_after_the_read() {
        let home = std::env::temp_dir().join(format!("nunchiro-board-edit-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        let path = home.join("board.toml");
        fs::write(
            &path,
            "version = 2\n[[columns]]\nid = \"todo\"\ntitle = \"To do\"\n",
        )
        .unwrap();
        let mut disk = persistence::Disk::default();
        disk.reload(&home);
        let saved = "version = 2\n[[columns]]\nid = \"todo\"\ntitle = \"Editor\"\n# longer\n";
        let result = edit(&home, &mut disk, |doc| {
            fs::write(&path, saved).unwrap();
            doc["columns"][0]["title"] = value("GUI");
            Ok(())
        });
        let now = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(&home).unwrap();
        assert_eq!(result, Err(CHANGED.to_string()));
        assert_eq!(now, saved);
    }
}
