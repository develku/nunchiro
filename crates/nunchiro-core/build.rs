// V2.5-15: embeds the built web bundle (web/dist) for the browser listener. No bundle, an empty table: the
// listener then answers `/` with 503. Paths are matched exactly at runtime; nothing is read from disk there.
use std::{env, fs, path::Path};

fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.path());
    for e in entries {
        let path = e.path();
        if path.is_dir() {
            walk(&path, root, out);
        } else if let Ok(rel) = path.strip_prefix(root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            out.push((format!("/{rel}"), path.display().to_string()));
        }
    }
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn main() {
    let dist = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../web/dist");
    // A watched path that does not exist reruns this script (and rebuilds the crate) on every build; an empty bundle
    // folder is watched like a built one (git ignores it), and the web build filling it still reruns this. Dated in the
    // past, so the folder made during this run does not count as changed after it.
    if !dist.exists() && fs::create_dir_all(&dist).is_ok() {
        let _ =
            fs::File::open(&dist).and_then(|f| f.set_modified(std::time::SystemTime::UNIX_EPOCH));
    }
    println!("cargo:rerun-if-changed={}", dist.display());
    let mut files = vec![];
    walk(&dist, &dist, &mut files);
    let mut table = String::from("pub(crate) static ASSETS: &[(&str, &str, &[u8])] = &[\n");
    for (url, file) in &files {
        table.push_str(&format!(
            "    ({url:?}, {:?}, include_bytes!({file:?})),\n",
            content_type(url)
        ));
    }
    table.push_str("];\n");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("web_assets.rs");
    fs::write(out, table).unwrap();
}
