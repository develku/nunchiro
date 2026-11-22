//! V2-3a: handoff text from projected chat events. Pure: no I/O, no clock, no model call.
use super::Page;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, path::Path};

const CAP: usize = 8192;
const REQUEST_CHARS: usize = 300;
const RESULT_CHARS: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Handoff {
    pub text: String,
    pub prompts: usize,
    pub files: usize,
    pub bytes: usize,
}

/// One line, at most `max` chars; a cut ends in `…` inside that budget.
fn fold(text: &str, max: usize) -> String {
    let line = text.replace(['\r', '\n'], " ");
    let line = line.trim();
    if line.chars().count() <= max {
        return line.into();
    }
    let mut cut: String = line.chars().take(max - 1).collect();
    cut.push('…');
    cut
}

/// Side chat carries at most five user turns, including only their results, edits and todos.
pub fn build_last_five(
    events: &[Value],
    from_agent: &str,
    session_id: &str,
    root: &Path,
    older_cut: bool,
) -> Handoff {
    let start = events
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, e)| e["kind"] == "message" && e["role"] == "user")
        .nth(4)
        .map_or(0, |(i, _)| i);
    build(
        &events[start..],
        from_agent,
        session_id,
        root,
        older_cut || start > 0,
    )
}

/// `events` are the `data` of chat events; only those after the last `switch` count.
///
/// `older_cut`: the history read stopped short of the chat's start, so the text says so.
pub fn build(
    events: &[Value],
    from_agent: &str,
    session_id: &str,
    root: &Path,
    older_cut: bool,
) -> Handoff {
    let start = events
        .iter()
        .rposition(|e| e["kind"] == "switch")
        .map_or(0, |i| i + 1);
    let (mut turns, mut todos) = (0, vec![]);
    let (mut requests, mut results) = (vec![], vec![]);
    let mut files: Vec<(String, u64, u64)> = vec![];
    let mut file_at: HashMap<String, usize> = HashMap::new();
    for e in &events[start..] {
        match e["kind"].as_str() {
            Some("message") if e["role"] == "user" => {
                let line = fold(e["text"].as_str().unwrap_or_default(), REQUEST_CHARS);
                if !line.is_empty() {
                    requests.push(line);
                }
            }
            Some("final_text") => {
                let line = fold(e["text"].as_str().unwrap_or_default(), RESULT_CHARS);
                if !line.is_empty() {
                    results.push(line);
                }
            }
            Some("turn") if matches!(e["state"].as_str(), Some("completed" | "interrupted")) => {
                turns += 1
            }
            Some("edit") => {
                let raw = e["path"].as_str().unwrap_or_default();
                if raw.is_empty() {
                    continue;
                }
                let path = match Path::new(raw).strip_prefix(root) {
                    Ok(p) if !p.as_os_str().is_empty() => p.to_str().unwrap_or(raw),
                    _ => raw,
                }
                .to_string();
                let (added, removed) = (
                    e["added"].as_u64().unwrap_or(0),
                    e["removed"].as_u64().unwrap_or(0),
                );
                match file_at.get(&path) {
                    Some(&i) => {
                        (files[i].1, files[i].2) = (files[i].1 + added, files[i].2 + removed)
                    }
                    None => {
                        file_at.insert(path.clone(), files.len());
                        files.push((path, added, removed));
                    }
                }
            }
            Some("tool_use") => {
                let (list, key) = match e["name"].as_str() {
                    Some("TodoWrite") => (&e["input"]["todos"], "content"),
                    Some("update_plan") => (&e["input"]["plan"], "step"),
                    _ => continue,
                };
                // The newest list replaces the older one, even when it is empty; a malformed call keeps it.
                if !list.is_array() {
                    continue;
                }
                todos = list
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|t| t["status"] != "completed")
                    .filter_map(|t| t[key].as_str())
                    .map(|s| fold(s, RESULT_CHARS))
                    .collect();
            }
            _ => {}
        }
    }
    let files: Vec<String> = files
        .into_iter()
        .map(|(p, a, r)| format!("{p} +{a} −{r}"))
        .collect();
    let short: String = session_id.chars().take(8).collect();
    let mut header = format!("Handoff from {from_agent} ({turns} turns, session {short})\n");
    if older_cut {
        header += "(earlier history left out)\n";
    }
    let prompts = requests.len();
    let total = requests.len() + results.len();
    let size = Sizes::new(&header, &requests, &results, &files, &todos);
    // Oldest Results first, then oldest Requests, never the newest Request.
    let (mut first_request, mut first_result) = (0, 0);
    while size.at(first_request, first_result, 0, true) > CAP {
        if first_result < results.len() {
            first_result += 1;
        } else if first_request + 1 < requests.len() {
            first_request += 1;
        } else {
            break;
        }
    }
    // Only when the Files list alone is over the cap: drop Open todos, then the oldest files
    // whole, so the cut never lands inside a line and the text says what is missing.
    let (mut first_file, mut with_todos) = (0, true);
    if size.at(first_request, first_result, 0, true) > CAP {
        with_todos = false;
        while size.at(first_request, first_result, first_file, false) > CAP
            && first_file + 1 < files.len()
        {
            first_file += 1;
        }
    }
    let left = total - (requests.len() - first_request) - (results.len() - first_result);
    let mut text = render(
        &header,
        left,
        &requests[first_request..],
        &results[first_result..],
        (first_file, &files),
        if with_todos { &todos } else { &[] },
    );
    // shortcut: one file line plus the newest request can still pass the cap (paths are unbounded), cut on a char boundary; upgrade when paths need folding.
    if text.len() > CAP {
        let mut end = CAP;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    Handoff {
        prompts: prompts - first_request,
        files: files.len() - first_file,
        bytes: text.len(),
        text,
    }
}

fn render(
    header: &str,
    left_out: usize,
    requests: &[String],
    results: &[String],
    (files_left_out, files): (usize, &[String]),
    todos: &[String],
) -> String {
    let mut text = header.to_string();
    if left_out > 0 {
        text += &format!("\n({left_out} earlier items left out)\n");
    }
    let mut section = |title: &str, lines: Vec<String>| {
        if !lines.is_empty() {
            text += &format!("\n## {title}\n{}\n", lines.join("\n"));
        }
    };
    section(
        "Requests",
        requests
            .iter()
            .enumerate()
            .map(|(i, r)| format!("{}. {r}", i + 1))
            .collect(),
    );
    section(
        "Results",
        results.iter().map(|r| format!("- {r}")).collect(),
    );
    let mut lines: Vec<String> = files[files_left_out..]
        .iter()
        .map(|f| format!("- {f}"))
        .collect();
    if files_left_out > 0 {
        lines.insert(0, format!("({files_left_out} earlier files left out)"));
    }
    section("Files changed", lines);
    section(
        "Open todos",
        todos.iter().map(|t| format!("- [ ] {t}")).collect(),
    );
    text
}

fn digits(n: usize) -> usize {
    n.checked_ilog10().map_or(1, |d| d as usize + 1)
}

/// Rendered byte length of `render`'s output for any drop point in O(1), so the drop search is one pass.
struct Sizes<'a> {
    header: &'a str,
    requests: usize,
    results: usize,
    files: usize,
    // Suffix sums of line bytes; request lines count without their `N. ` prefix.
    request_bytes: Vec<usize>,
    result_bytes: Vec<usize>,
    file_bytes: Vec<usize>,
    // `numbers[m]`: digits of 1..=m, the request numbering after the oldest are dropped.
    numbers: Vec<usize>,
    todo_count: usize,
    todo_bytes: usize,
}

impl<'a> Sizes<'a> {
    fn new(
        header: &'a str,
        requests: &[String],
        results: &[String],
        files: &[String],
        todos: &[String],
    ) -> Self {
        let suffix = |lines: &[String], extra: usize| {
            let mut sums = vec![0; lines.len() + 1];
            for (i, l) in lines.iter().enumerate().rev() {
                sums[i] = sums[i + 1] + l.len() + extra;
            }
            sums
        };
        let mut numbers = vec![0; requests.len() + 1];
        for m in 1..=requests.len() {
            numbers[m] = numbers[m - 1] + digits(m);
        }
        Self {
            header,
            requests: requests.len(),
            results: results.len(),
            files: files.len(),
            request_bytes: suffix(requests, 2),
            result_bytes: suffix(results, 2),
            file_bytes: suffix(files, 2),
            numbers,
            todo_count: todos.len(),
            todo_bytes: todos.iter().map(|t| t.len() + 6).sum(),
        }
    }
    /// A section of `n` lines holding `bytes`: title line, the lines, a `\n` after each.
    fn section(title: &str, n: usize, bytes: usize) -> usize {
        if n == 0 {
            0
        } else {
            format!("\n## {title}\n").len() + bytes + n
        }
    }
    fn at(
        &self,
        first_request: usize,
        first_result: usize,
        first_file: usize,
        todos: bool,
    ) -> usize {
        let (requests, results) = (self.requests - first_request, self.results - first_result);
        let left = (self.requests + self.results) - requests - results;
        let mut size = self.header.len();
        if left > 0 {
            size += format!("\n({left} earlier items left out)\n").len();
        }
        size += Self::section(
            "Requests",
            requests,
            self.request_bytes[first_request] + self.numbers[requests],
        );
        size += Self::section("Results", results, self.result_bytes[first_result]);
        let mut files = self.files - first_file;
        let mut bytes = self.file_bytes[first_file];
        if first_file > 0 {
            files += 1;
            bytes += format!("({first_file} earlier files left out)").len();
        }
        size += Self::section("Files changed", files, bytes);
        if todos {
            size += Self::section("Open todos", self.todo_count, self.todo_bytes);
        }
        size
    }
}

/// V2-3b: redact ANSI-decorated secrets and secrets exposed by stripping controls.
pub fn outgoing(text: &str) -> String {
    let mut text = text.to_owned();
    // Redact ANSI-decorated secrets before stripping; redact newly joined secrets afterwards.
    for _ in 0..2 {
        text = String::from_utf8_lossy(&crate::logs::redact(text.as_bytes()))
            .chars()
            .filter(|&c| !c.is_control() || c == '\n' || c == '\t')
            .collect();
    }
    text
}

/// Reads pages newest first (`read(before, generation)`) back to the last switch or the chat's start.
/// Returns the events oldest first and whether the page cap stopped the walk short of both.
/// A reset between pages restarts the walk once on the new generation; a second one is an error.
pub fn collect(
    read: impl FnMut(Option<u64>, Option<u64>) -> Result<Page, String>,
) -> Result<(Vec<Value>, bool), String> {
    collect_through(None, read)
}

/// A fork includes only events up to the selected message cursor; unavailable cursors fail closed.
pub fn collect_through(
    through: Option<&str>,
    mut read: impl FnMut(Option<u64>, Option<u64>) -> Result<Page, String>,
) -> Result<(Vec<Value>, bool), String> {
    let through = through
        .map(|s| {
            let (generation, cursor) = s.split_once(':').ok_or("invalid message cursor")?;
            Ok::<_, &str>((
                generation
                    .parse::<u64>()
                    .map_err(|_| "invalid message cursor")?,
                cursor
                    .parse::<u64>()
                    .map_err(|_| "invalid message cursor")?,
            ))
        })
        .transpose()?;
    // shortcut: 100 pages (20k events) is the longest history read; upgrade when a chat outgrows it.
    const PAGES: usize = 100;
    let (mut generation, mut restarted) = (None, false);
    'walk: loop {
        let mut newest_first: Vec<Vec<Value>> = vec![];
        let mut before = None;
        let mut found = through.is_none();
        for _ in 0..PAGES {
            let page = read(before, generation)?;
            if through.is_some_and(|(g, _)| g != page.generation) {
                return Err("fork message changed; select it again".into());
            }
            match generation {
                Some(g) if g != page.generation => {
                    if restarted {
                        return Err("chat changed while reading".into());
                    }
                    (generation, restarted) = (Some(page.generation), true);
                    continue 'walk;
                }
                _ => generation = Some(page.generation),
            }
            let mut events = page.events;
            if !found {
                if let Some(i) = events
                    .iter()
                    .position(|e| through.is_some_and(|(_, cursor)| e.cursor == cursor))
                {
                    if !matches!(
                        events[i].data["kind"].as_str(),
                        Some("message" | "final_text")
                    ) {
                        return Err("not a message cursor".into());
                    }
                    events.truncate(i + 1);
                    found = true;
                } else {
                    before = page.before;
                    if before.is_none() {
                        return Err("fork message unavailable".into());
                    }
                    continue;
                }
            }
            let events: Vec<_> = events
                .into_iter()
                .map(|e| {
                    let mut data = e.data;
                    // A fork includes visible assistant messages, even before a Stop final_text exists.
                    if through.is_some() && data["kind"] == "message" && data["role"] == "assistant"
                    {
                        data["kind"] = Value::from("final_text");
                    }
                    data
                })
                .collect();
            let switched = events.iter().any(|e| e["kind"] == "switch");
            newest_first.push(events);
            before = page.before;
            if switched || before.is_none() {
                let events = newest_first.into_iter().rev().flatten().collect();
                return Ok((events, false));
            }
        }
        if !found {
            return Err("fork message unavailable".into());
        }
        let events = newest_first.into_iter().rev().flatten().collect();
        return Ok((events, true));
    }
}
