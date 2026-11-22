//! V1A-67 (needs 71): the terminal font the user picked, handed to the window when its WKWebView cannot see it.
//! The page names a family, never a path. Only files directly in `~/Library/Fonts` or `/Library/Fonts` whose own
//! family name (read by CoreText) is that family are read, after symlinks resolve inside the same folder; the bytes
//! go back through `invoke()` into a `FontFace`, so the window CSP stays as it is. Nothing is listed but family names.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// The only file types read.
const EXTENSIONS: [&str; 5] = ["ttf", "otf", "ttc", "woff", "woff2"];
/// One font file at most; larger files are skipped.
const FILE_CAP: u64 = 32 << 20;
/// Family names the page may ask about in one call (the curated list plus the symbols face fits).
const NAMES_CAP: usize = 64;

/// One face of a font file: what CoreText reports for its first (or only) font.
#[derive(Clone, Debug, PartialEq)]
pub struct Meta {
    pub family: String,
    pub weight: f64,
    pub italic: bool,
}

/// A file to serve and the descriptors its `FontFace` gets. `stamp` is the scanned file's (see `Stamp`): `pack` serves
/// the path only while the file it opens still has it.
#[derive(Debug, PartialEq)]
pub struct Face {
    pub path: PathBuf,
    pub stamp: Stamp,
    pub weight: u16,
    pub italic: bool,
}

/// A family name as the termFont list allows one (settings.ts `FAMILY`): letters, digits, space, `.`, `_`, `-`.
pub fn valid_family(name: &str) -> bool {
    (1..=100).contains(&name.chars().count())
        && !name.starts_with(['.', ' '])
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
}

/// The user's font folder (`$HOME/Library/Fonts`) and the machine's.
pub fn folders() -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        list.push(PathBuf::from(home).join("Library/Fonts"));
    }
    list.push(PathBuf::from("/Library/Fonts"));
    list
}

fn font_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// CoreText's answer per file, kept while the file's size, inode and change time stay the same (unlike the
/// modification time, `cp -p` or an installer cannot carry the change time over), so a rescan reads
/// only new or changed files. A scan drops the entries of files it no longer sees in its folders.
pub type Stamp = (u64, u64, i64, i64);
type Stamped = (Stamp, Option<Meta>);
static METAS: LazyLock<Mutex<HashMap<PathBuf, Stamped>>> = LazyLock::new(Default::default);

/// Every font file directly in `folders` that stays inside its folder once symlinks resolve, with its metadata.
/// shortcut: subfolders are not searched (font installers put files at the top level); recurse if one is missed.
fn scan(
    folders: &[PathBuf],
    meta_of: &dyn Fn(&Path) -> Option<Meta>,
) -> Vec<(PathBuf, Stamp, Meta)> {
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut roots = Vec::new();
    for folder in folders {
        let Ok(root) = folder.canonicalize() else {
            continue;
        };
        roots.push(root.clone());
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(path) = entry.path().canonicalize() else {
                continue;
            };
            let Ok(info) = path.metadata() else {
                continue;
            };
            let small = info.is_file() && info.len() <= FILE_CAP;
            if !font_ext(&entry.path()) || !font_ext(&path) || !path.starts_with(&root) || !small {
                continue;
            }
            let stamp = stamp_of(&info);
            seen.insert(path.clone());
            let cached = METAS
                .lock()
                .ok()
                .and_then(|c| c.get(&path).filter(|e| e.0 == stamp).map(|e| e.1.clone()));
            let meta = cached.unwrap_or_else(|| {
                let meta = meta_of(&path);
                if let Ok(mut c) = METAS.lock() {
                    c.insert(path.clone(), (stamp, meta.clone()));
                }
                meta
            });
            if let Some(meta) = meta {
                found.push((path, stamp, meta));
            }
        }
    }
    // Entries under a scanned folder that the scan did not see (removed, renamed, no longer a font) go.
    if let Ok(mut c) = METAS.lock() {
        c.retain(|p, _| seen.contains(p) || !roots.iter().any(|r| p.starts_with(r)));
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

fn stamp_of(info: &std::fs::Metadata) -> Stamp {
    use std::os::unix::fs::MetadataExt;
    (info.len(), info.ino(), info.ctime(), info.ctime_nsec())
}

/// CSS weight for a CoreText weight trait: regular and bold only (the terminal draws nothing else).
fn css_weight(trait_weight: f64) -> Option<u16> {
    if trait_weight.abs() <= 0.05 {
        Some(400)
    } else if (0.35..=0.45).contains(&trait_weight) {
        Some(700)
    } else {
        None
    }
}

/// The regular, bold, italic and bold italic files of `family`, first file of each kept; nothing for a bad name.
pub fn resolve(
    family: &str,
    folders: &[PathBuf],
    meta_of: &dyn Fn(&Path) -> Option<Meta>,
) -> Vec<Face> {
    if !valid_family(family) {
        return Vec::new();
    }
    let mut faces: Vec<Face> = Vec::new();
    for (path, stamp, meta) in scan(folders, meta_of) {
        let Some(weight) = css_weight(meta.weight) else {
            continue;
        };
        if meta.family == family
            && !faces
                .iter()
                .any(|f| f.weight == weight && f.italic == meta.italic)
        {
            faces.push(Face {
                path,
                stamp,
                weight,
                italic: meta.italic,
            });
        }
    }
    faces
}

/// Which of `names` have a face in the folders, in the order asked; family names only, never paths.
pub fn available(
    names: &[String],
    folders: &[PathBuf],
    meta_of: &dyn Fn(&Path) -> Option<Meta>,
) -> Vec<String> {
    let found = scan(folders, meta_of);
    names
        .iter()
        .take(NAMES_CAP)
        .filter(|n| valid_family(n))
        .filter(|n| {
            found
                .iter()
                .any(|(_, _, m)| &m.family == *n && css_weight(m.weight).is_some())
        })
        .cloned()
        .collect()
}

/// The faces as one buffer: per face a big-endian u16 weight, a u8 italic flag, a u32 length, then the file bytes.
/// A file that vanished, grew past the cap, was swapped for a link, FIFO or folder, or was replaced by another file
/// (its size, inode or change time differ from the scan's) is left out: the open follows no link and never blocks, and
/// the checks run on the opened file itself, so the bytes served are the scanned file's or nothing. Not caught: an
/// in-place rewrite of the same inode between the fstat and the read (the next scan sees it).
pub fn pack(faces: &[Face]) -> Vec<u8> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let mut out = Vec::new();
    for face in faces {
        let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&face.path)
        else {
            continue;
        };
        if !file
            .metadata()
            .is_ok_and(|m| m.is_file() && m.len() <= FILE_CAP && stamp_of(&m) == face.stamp)
        {
            continue;
        }
        let mut bytes = Vec::new();
        let read = file.take(FILE_CAP + 1).read_to_end(&mut bytes);
        if read.is_err() || bytes.len() as u64 > FILE_CAP {
            continue;
        }
        out.extend_from_slice(&face.weight.to_be_bytes());
        out.push(face.italic as u8);
        out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(&bytes);
    }
    out
}

/// A descriptor's traits dictionary.
///
/// # Safety
/// `descriptor` is a valid CoreText descriptor.
#[cfg(target_os = "macos")]
unsafe fn traits_of(
    descriptor: &objc2_core_text::CTFontDescriptor,
) -> Option<objc2_core_foundation::CFRetained<objc2_core_foundation::CFDictionary>> {
    unsafe { descriptor.attribute(objc2_core_text::kCTFontTraitsAttribute) }?
        .downcast::<objc2_core_foundation::CFDictionary>()
        .ok()
}

/// The CFNumber a traits dictionary holds under `key` (CTFontTraits.h).
///
/// # Safety
/// `traits` came from `traits_of`, whose values under the CTFontTraits keys are CFNumbers.
#[cfg(target_os = "macos")]
unsafe fn number<'a>(
    traits: &'a objc2_core_foundation::CFDictionary,
    key: &objc2_core_foundation::CFString,
) -> Option<&'a objc2_core_foundation::CFNumber> {
    use objc2_core_foundation::{CFNumber, CFString};
    unsafe {
        traits
            .value((key as *const CFString).cast())
            .cast::<CFNumber>()
            .as_ref()
    }
}

/// CoreText's family, weight and italic flag for the first font in a file.
#[cfg(target_os = "macos")]
pub fn meta_of(path: &Path) -> Option<Meta> {
    use objc2_core_foundation::{CFString, CFURL};
    use objc2_core_text::{
        CTFontDescriptor, CTFontManagerCreateFontDescriptorsFromURL, CTFontSymbolicTraits,
        kCTFontFamilyNameAttribute, kCTFontSymbolicTrait, kCTFontWeightTrait,
    };
    let url = CFURL::from_file_path(path)?;
    // SAFETY: plain CoreText calls on objects it returned; the array holds CTFontDescriptors (CTFontManager.h), and
    // every attribute is downcast with a check.
    unsafe {
        let list = CTFontManagerCreateFontDescriptorsFromURL(&url)?;
        let first = list.cast_unchecked::<CTFontDescriptor>().get(0)?;
        let family = first
            .attribute(kCTFontFamilyNameAttribute)?
            .downcast::<CFString>()
            .ok()?
            .to_string();
        let traits = traits_of(&first)?;
        let weight = number(&traits, kCTFontWeightTrait)
            .and_then(|n| n.as_f64())
            .unwrap_or(0.0);
        let symbolic = number(&traits, kCTFontSymbolicTrait)
            .and_then(|n| n.as_i64())
            .unwrap_or(0) as u32;
        Some(Meta {
            family,
            weight,
            italic: symbolic & CTFontSymbolicTraits::TraitItalic.bits() != 0,
        })
    }
}

#[cfg(not(target_os = "macos"))]
pub fn meta_of(_path: &Path) -> Option<Meta> {
    None
}

/// One installed family as the font picker lists it.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Family {
    pub name: String,
    pub mono: bool,
}

/// What the picker may offer: names the termFont grammar accepts, once each, sorted ignoring case.
fn listed(source: Vec<(String, bool)>) -> Vec<Family> {
    let mut list: Vec<Family> = source
        .into_iter()
        .filter(|(name, _)| valid_family(name))
        .map(|(name, mono)| Family { name, mono })
        .collect();
    list.sort_by_cached_key(|f| f.name.to_lowercase());
    list.dedup_by(|a, b| a.name == b.name);
    list
}

/// Every family CoreText can see, and whether the face it matches for that family is fixed-pitch.
#[cfg(target_os = "macos")]
fn installed() -> Vec<(String, bool)> {
    use objc2_core_foundation::{CFDictionary, CFString};
    use objc2_core_text::{
        CTFontDescriptor, CTFontManagerCopyAvailableFontFamilyNames, CTFontSymbolicTraits,
        kCTFontFamilyNameAttribute, kCTFontSymbolicTrait,
    };
    // SAFETY: plain CoreText calls on objects it returned; the array holds CFStrings (CTFontManager.h).
    unsafe {
        let names = CTFontManagerCopyAvailableFontFamilyNames();
        let names = names.cast_unchecked::<CFString>();
        (0..names.len())
            .filter_map(|i| names.get(i))
            .map(|name| {
                let wanted = CFDictionary::<CFString, CFString>::from_slices(
                    &[kCTFontFamilyNameAttribute],
                    &[&name],
                );
                let mono = CTFontDescriptor::with_attributes(wanted.as_opaque())
                    .matching_font_descriptor(None)
                    .and_then(|found| traits_of(&found))
                    .and_then(|traits| {
                        number(&traits, kCTFontSymbolicTrait).and_then(|n| n.as_i64())
                    })
                    .is_some_and(|bits| {
                        bits as u32 & CTFontSymbolicTraits::TraitMonoSpace.bits() != 0
                    });
                (name.to_string(), mono)
            })
            .collect()
    }
}

#[cfg(not(target_os = "macos"))]
fn installed() -> Vec<(String, bool)> {
    Vec::new()
}

/// Every installed family for the font picker: names and the monospace flag, never a path.
#[tauri::command]
pub async fn font_list<R: tauri::Runtime>(webview: tauri::Webview<R>) -> Vec<Family> {
    if webview.label() != "main" {
        return Vec::new();
    }
    tauri::async_runtime::spawn_blocking(|| listed(installed()))
        .await
        .unwrap_or_default()
}

/// Which of the page's curated family names the app can hand over (the webview's own detection misses them).
#[tauri::command]
pub async fn font_families<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    names: Vec<String>,
) -> Vec<String> {
    if webview.label() != "main" {
        return Vec::new();
    }
    // CoreText and file reads stay off the async runtime's threads.
    tauri::async_runtime::spawn_blocking(move || available(&names, &folders(), &meta_of))
        .await
        .unwrap_or_default()
}

/// The packed faces of one family (see `pack`); empty when the folders have none, as for a system face.
/// The label check keeps other windows out; frames inside this window share its label, and what keeps them out is
/// Tauri's invoke key, which only the main frame's scripts hold (see `artifact_cannot_reach_font_route`).
#[tauri::command]
pub async fn font_faces<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    family: String,
) -> tauri::ipc::Response {
    if webview.label() != "main" {
        return tauri::ipc::Response::new(Vec::new());
    }
    let packed =
        tauri::async_runtime::spawn_blocking(move || pack(&resolve(&family, &folders(), &meta_of)))
            .await
            .unwrap_or_default();
    tauri::ipc::Response::new(packed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A fresh folder under the repo's `.scratch`, removed by `Drop` when a test passes.
    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Dir {
            static N: AtomicUsize = AtomicUsize::new(0);
            let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                "../../.scratch/fonts-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Dir(dir.canonicalize().unwrap())
        }
        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let p = self.0.join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            if !std::thread::panicking() {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    /// Fake CoreText: the file's text is `family|weight|italic`.
    fn fake(path: &Path) -> Option<Meta> {
        let text = std::fs::read_to_string(path).ok()?;
        let mut parts = text.split('|');
        Some(Meta {
            family: parts.next()?.into(),
            weight: parts.next()?.parse().ok()?,
            italic: parts.next()? == "1",
        })
    }

    fn stamp_of_path(path: &Path) -> Stamp {
        stamp_of(&path.metadata().unwrap())
    }

    fn paths(faces: &[Face]) -> Vec<PathBuf> {
        faces.iter().map(|f| f.path.clone()).collect()
    }

    #[test]
    fn font_resolves_only_inside_font_folders() {
        let (fonts, outside) = (Dir::new(), Dir::new());
        let regular = fonts.file("Mono-Regular.ttf", b"Mono|0|0");
        let bold = fonts.file("Mono-Bold.otf", b"Mono|0.4|0");
        fonts.file("Mono-Thin.ttf", b"Mono|-0.6|0"); // neither regular nor bold
        fonts.file("Mono-Second.TTF", b"Mono|0|0"); // a second regular: the first by path wins
        fonts.file("Mono.txt", b"Mono|0|1"); // not a font extension
        fonts.file("..Mono.dfont", b"Mono|0.4|1"); // not a font extension either
        let secret = outside.file("secret.ttf", b"Mono|0|1");
        std::os::unix::fs::symlink(&secret, fonts.0.join("Link-Italic.ttf")).unwrap();
        // A font-named link to a non-font file inside the folder is refused too.
        let note = fonts.file("note.txt", b"Mono|0.4|1");
        std::os::unix::fs::symlink(&note, fonts.0.join("Note-BoldItalic.ttf")).unwrap();
        std::fs::create_dir(fonts.0.join("sub.ttf")).unwrap();
        let folders = vec![fonts.0.clone()];

        let faces = resolve("Mono", &folders, &fake);
        assert_eq!(
            faces,
            vec![
                Face {
                    stamp: stamp_of_path(&bold),
                    path: bold,
                    weight: 700,
                    italic: false
                },
                Face {
                    stamp: stamp_of_path(&regular),
                    path: regular.clone(),
                    weight: 400,
                    italic: false
                },
            ]
        );
        assert!(resolve("Unknown", &folders, &fake).is_empty());
        assert!(resolve("../Mono", &folders, &fake).is_empty());
        assert!(resolve("..", &folders, &fake).is_empty());
        // A symlink inside the folder that points at another font inside it is fine.
        let inside = Dir::new();
        let real = inside.file("Real.ttf", b"Inner|0|0");
        std::os::unix::fs::symlink(&real, inside.0.join("Alias.ttf")).unwrap();
        assert_eq!(
            paths(&resolve("Inner", std::slice::from_ref(&inside.0), &fake)),
            vec![real]
        );
        // A folder that is itself a symlink resolves first, then holds its files.
        let linked = outside.0.join("linked-fonts");
        std::os::unix::fs::symlink(&fonts.0, &linked).unwrap();
        assert_eq!(resolve("Mono", &[linked], &fake).len(), 2);
        // Missing folders give nothing.
        assert!(resolve("Mono", &[fonts.0.join("missing")], &fake).is_empty());
    }

    #[test]
    fn font_route_takes_no_path() {
        let fonts = Dir::new();
        let file = fonts.file("Mono-Regular.ttf", b"Mono|0|0");
        let other = fonts.file("Other-Regular.ttf", b"Other|0|0");
        let folders = vec![fonts.0.clone()];
        for asked in [
            file.to_str().unwrap(),
            "Mono-Regular.ttf",
            "Mono-Regular",
            "/Library/Fonts",
            "Mono/../Mono",
            "Othe",
            "mono",
            "",
        ] {
            assert!(resolve(asked, &folders, &fake).is_empty(), "{asked}");
            assert!(pack(&resolve(asked, &folders, &fake)).is_empty(), "{asked}");
        }
        // Only the named family's files: an installed family that was not asked for stays out.
        assert_eq!(paths(&resolve("Mono", &folders, &fake)), vec![file.clone()]);
        assert_eq!(paths(&resolve("Other", &folders, &fake)), vec![other]);
        // The list call answers family names only, and only for families in the folders.
        let names: Vec<String> = ["Mono", "Gone", "Mono-Regular.ttf", "../Mono"]
            .map(String::from)
            .to_vec();
        assert_eq!(available(&names, &folders, &fake), vec!["Mono".to_string()]);
        let many: Vec<String> = std::iter::repeat_n("x".to_string(), NAMES_CAP)
            .chain(["Mono".into()])
            .collect();
        assert!(
            available(&many, &folders, &fake).is_empty(),
            "names past the cap are not looked at"
        );
    }

    #[test]
    fn packed_faces_carry_descriptors_and_bytes_within_the_cap() {
        let fonts = Dir::new();
        let a = fonts.file("A.ttf", b"abc");
        let big = fonts.0.join("Big.ttf");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(FILE_CAP + 1)
            .unwrap();
        let faces = [
            Face {
                stamp: stamp_of_path(&a),
                path: a,
                weight: 700,
                italic: true,
            },
            Face {
                stamp: stamp_of_path(&big),
                path: big.clone(),
                weight: 400,
                italic: false,
            },
            Face {
                stamp: (0, 0, 0, 0),
                path: fonts.0.join("gone.ttf"),
                weight: 400,
                italic: false,
            },
        ];
        assert_eq!(
            pack(&faces),
            [&[2, 188, 1, 0, 0, 0, 3][..], b"abc"].concat()
        );
        // The scan skips a file over the cap before it is ever read.
        std::fs::write(fonts.0.join("Small.ttf"), b"Big|0|0").unwrap();
        assert!(
            resolve("Big", std::slice::from_ref(&fonts.0), &|p: &Path| {
                assert_ne!(p, big, "an oversized file reached the reader");
                fake(p)
            })
            .len()
                == 1
        );
    }

    #[test]
    fn pack_refuses_a_file_swapped_after_the_scan() {
        let (fonts, outside) = (Dir::new(), Dir::new());
        let path = fonts.file("Mono-Regular.ttf", b"Mono|0|0");
        let faces = resolve("Mono", std::slice::from_ref(&fonts.0), &fake);
        assert_eq!(paths(&faces), vec![path.clone()]);
        // After the scan, the checked file becomes a link to a file elsewhere: nothing is read through it.
        let secret = outside.file("id_ed25519", b"secret");
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&secret, &path).unwrap();
        assert!(pack(&faces).is_empty());
        // A FIFO in its place is refused without blocking on the open.
        std::fs::remove_file(&path).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        assert!(pack(&faces).is_empty());
        // A directory in its place too.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(pack(&faces).is_empty());
    }

    #[test]
    fn pack_refuses_a_regular_file_replaced_after_the_scan() {
        let fonts = Dir::new();
        let path = fonts.file("Mono-Regular.ttf", b"Mono|0|0");
        let faces = resolve("Mono", std::slice::from_ref(&fonts.0), &fake);
        assert_eq!(paths(&faces), vec![path.clone()]);
        // Unchanged, it is served.
        assert!(!pack(&faces).is_empty());
        // Another regular file takes the path (new inode, same size): the scan never judged its bytes.
        let other = fonts.file("other.tmp", b"Evil|0|0");
        std::fs::rename(&other, &path).unwrap();
        assert!(pack(&faces).is_empty());
    }

    #[test]
    fn scan_prunes_removed_files() {
        let fonts = Dir::new();
        let a = fonts.file("A.ttf", b"A|0|0");
        let b = fonts.file("B.ttf", b"B|0|0");
        let folders = std::slice::from_ref(&fonts.0);
        let held = |p: &Path| METAS.lock().unwrap().contains_key(p);
        resolve("A", folders, &fake);
        assert!(held(&a) && held(&b));
        std::fs::remove_file(&b).unwrap();
        resolve("A", folders, &fake);
        assert!(held(&a) && !held(&b));
    }

    #[test]
    fn scan_reads_each_unchanged_file_once() {
        let fonts = Dir::new();
        fonts.file("A.ttf", b"A|0|0");
        let b = fonts.file("B.ttf", b"B|0|0");
        let reads = std::cell::Cell::new(0);
        let counted = |p: &Path| {
            reads.set(reads.get() + 1);
            fake(p)
        };
        let folders = std::slice::from_ref(&fonts.0);
        assert_eq!(resolve("A", folders, &counted).len(), 1);
        assert_eq!(reads.get(), 2);
        assert_eq!(
            available(&["B".into()], folders, &counted),
            vec!["B".to_string()]
        );
        assert_eq!(reads.get(), 2, "unchanged files are not read again");
        // A changed file (new size) is read again, with its new metadata.
        std::fs::write(&b, b"B2|0.4|0").unwrap();
        assert_eq!(resolve("B2", folders, &counted).len(), 1);
        assert_eq!(reads.get(), 3);
        // So is one replaced with the same size and its old modification time put back (cp -p, installers).
        let mtime = b.metadata().unwrap().modified().unwrap();
        std::fs::write(&b, b"B3|0.4|0").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&b)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        assert_eq!(resolve("B3", folders, &counted).len(), 1);
        assert_eq!(reads.get(), 4);
    }

    #[test]
    fn family_names_follow_the_termfont_grammar() {
        for ok in [
            "JetBrains Mono",
            "D2Coding",
            "Symbols Nerd Font Mono",
            "나눔고딕코딩",
            "Fira_Code-1.2",
        ] {
            assert!(valid_family(ok), "{ok}");
        }
        for bad in [
            "",
            "..",
            ".hidden",
            " lead",
            "a/b",
            "a\\b",
            "a\0b",
            "a\"b",
            &"x".repeat(101),
        ] {
            assert!(!valid_family(bad), "{bad:?}");
        }
    }

    /// Today's window CSP (V1A-64 and before). The bytes travel through `invoke()`, so it needs no `font-src`.
    const WINDOW_CSP: &str = "default-src 'self'; connect-src 'self' ws://127.0.0.1:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src nunchiro-artifact: http://nunchiro-artifact.localhost";

    #[test]
    fn window_csp_unchanged_but_font() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        let fonts: Vec<&str> = csp
            .split(';')
            .map(str::trim)
            .filter(|d| d.starts_with("font-src"))
            .collect();
        let rest: Vec<&str> = csp
            .split(';')
            .map(str::trim)
            .filter(|d| !d.starts_with("font-src"))
            .collect();
        assert_eq!(rest.join("; "), WINDOW_CSP);
        assert!(fonts.len() <= 1, "at most one font-src entry: {fonts:?}");
    }

    #[test]
    fn artifact_cannot_reach_font_route() {
        use crate::artifacts::{self, CSP_DEFAULT, CSP_NETWORK, Grants, NoContent};
        use tauri::http::{Method, Request};
        // 1. The artifact scheme serves no font file, whatever the path or query.
        let grants = Grants::open(Dir::new().0.join("grants.json"));
        for uri in [
            "nunchiro-artifact://localhost/Menlo.ttc",
            "nunchiro-artifact://localhost/fonts/Menlo",
            "nunchiro-artifact://localhost/x?family=Menlo",
            "nunchiro-artifact://localhost/..%2F..%2FLibrary%2FFonts%2FMenlo.ttc",
        ] {
            let request = Request::builder()
                .method(Method::GET)
                .uri(uri)
                .body(Vec::new())
                .unwrap();
            assert_eq!(
                artifacts::serve(&request, &NoContent, &grants, true).status(),
                404,
                "{uri}"
            );
        }
        // 2. No artifact or widget policy lets a frame talk to the app: no IPC scheme, nothing of the app's own.
        let widget = artifacts::widget_page::csp(&["example.com".into()], None).unwrap();
        for csp in [CSP_DEFAULT, CSP_NETWORK, widget.as_str()] {
            // v2-10c: the one app source is the library path, which serves only pinned hashes (artifacts/libs.rs).
            assert_eq!(csp.matches("nunchiro-").count(), 1, "{csp}");
            let csp = csp.replacen(" nunchiro-artifact://localhost/lib/", "", 1);
            for app_source in ["ipc:", "tauri:", "'self'", "nunchiro-", "localhost"] {
                assert!(!csp.contains(app_source), "{app_source} in {csp}");
            }
            assert!(
                csp.starts_with("sandbox allow-scripts;"),
                "opaque origin: {csp}"
            );
        }
        // 3. The commands answer only the main frame's own scripts. Tauri counts the registered artifact scheme as a
        //    local origin, so the guard is the invoke key: Tauri puts it into the main frame alone (main-frame-only
        //    init scripts) and drops any call without it. A sandboxed frame's fetch also sends Origin `null`.
        use tauri::ipc::InvokeResponse;
        use tauri::test::{INVOKE_KEY, mock_builder, mock_context, noop_assets};
        use tauri::webview::InvokeRequest;
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![font_faces, font_families])
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        // Some(ran) when Tauri answered at all; None when it dropped the call without an answer.
        let call = |url: &str, key: &str| {
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            AsRef::<tauri::Webview<_>>::as_ref(&window)
                .clone()
                .on_message(
                    InvokeRequest {
                        cmd: "font_faces".into(),
                        callback: tauri::ipc::CallbackFn(0),
                        error: tauri::ipc::CallbackFn(1),
                        url: url.parse().unwrap(),
                        body: serde_json::json!({ "family": "Menlo" }).into(),
                        headers: Default::default(),
                        invoke_key: key.into(),
                    },
                    Box::new(move |_, _, response, _, _| {
                        let _ = tx.send(matches!(response, InvokeResponse::Ok(_)));
                    }),
                );
            rx.recv().ok()
        };
        assert_eq!(call("tauri://localhost", INVOKE_KEY), Some(true));
        assert_eq!(
            call("nunchiro-artifact://localhost/a1", "guessed"),
            None,
            "an artifact frame's call without the key is dropped"
        );
        assert_eq!(
            call("tauri://localhost", "guessed"),
            None,
            "a call without the main frame's key is dropped"
        );
        assert_eq!(
            call("https://example.com", INVOKE_KEY),
            Some(false),
            "a remote origin is refused"
        );
    }

    #[test]
    fn font_list_keeps_valid_names_sorted_with_their_mono_flag() {
        let source = [
            ("Zapfino", false),
            (".Hidden UI", true),
            ("Bad/Name", true),
            ("iA Writer Mono", true),
            ("Menlo", true),
            ("Menlo", true),
        ]
        .map(|(n, m)| (n.to_string(), m))
        .to_vec();
        let got: Vec<(String, bool)> = listed(source)
            .into_iter()
            .map(|f| (f.name, f.mono))
            .collect();
        let want = [
            ("iA Writer Mono", true),
            ("Menlo", true),
            ("Zapfino", false),
        ]
        .map(|(n, m)| (n.to_string(), m));
        assert_eq!(got, want);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn coretext_lists_installed_families_with_mono_flags() {
        let list = listed(installed());
        let mono = |name: &str| list.iter().find(|f| f.name == name).map(|f| f.mono);
        assert_eq!(mono("Menlo"), Some(true));
        assert_eq!(mono("Helvetica"), Some(false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn coretext_reads_a_real_font_file() {
        let fonts = Dir::new();
        let menlo = fonts.0.join("Menlo.ttc");
        std::fs::copy("/System/Library/Fonts/Menlo.ttc", &menlo).unwrap();
        let meta = meta_of(&menlo).expect("CoreText reads Menlo");
        assert_eq!(
            (meta.family.as_str(), css_weight(meta.weight), meta.italic),
            ("Menlo", Some(400), false)
        );
        let faces = resolve("Menlo", std::slice::from_ref(&fonts.0), &meta_of);
        assert_eq!(paths(&faces), vec![menlo.clone()]);
        let packed = pack(&faces);
        assert_eq!(packed.len() as u64, 7 + menlo.metadata().unwrap().len());
        assert!(meta_of(&fonts.file("fake.ttf", b"not a font")).is_none());
    }
}
