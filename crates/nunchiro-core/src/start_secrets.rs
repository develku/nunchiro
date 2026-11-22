//! Ticket 457 (owner decision 2026-11-12, option b): the secret variables of the environment a core started in.
//! `core.start.json` keeps their names; their values live in one generic-password item of the macOS keychain, scoped
//! to the Nunchiro home, so a restart asked from a session (ticket 32) still gets them. A value never reaches a file
//! under the home, a log line or an error string.
//!
//! Ticket 1009: the item's access list trusts only the program that wrote it (the core; the CLI that restarts it is
//! the same executable), so `security find-generic-password -w` from a session's shell, or any other program, gets a
//! keychain dialog or a refusal instead of the value. That needs the Security framework in process: an item written
//! by `/usr/bin/security` trusts `security` itself. No call here may show a dialog (interaction is turned off), so a
//! locked keychain or an item a rebuilt binary no longer matches reads as none: the ticket 32 fallback.
use std::{collections::BTreeMap, path::Path, path::PathBuf};

/// Ticket 1009 round 6: the item this build writes (in process, its access list names this executable, plain JSON).
const SERVICE: &str = "Nunchiro core start (core only)";
/// The item builds before ticket 1009 wrote with `/usr/bin/security` (hex-encoded JSON; its access list trusts
/// `security`). Read through `security` as before, until a new item is written and read back; then it goes.
const SERVICE_OLD: &str = "Nunchiro core start";
/// A start's secrets are a few keys; more is refused (and the earlier item goes), as the `security -i` line limit did.
const MAX: usize = 4096;
/// Round 9 (Codex MUST): the key in the item that holds the start's generation, which `core.start.json` repeats as
/// `secrets_gen`. A restart applies the item only when both match, so an item a failed update left behind (a locked
/// keychain) never hands an earlier credential to a newer record. `=` cannot be in a variable name, so no secret
/// shares this key. A pre-1009 item has no generation and is never applied.
pub const GEN: &str = "=gen";

/// The one definition of a secret variable, any case: a name ending in `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`,
/// `_PAT`, `_PASS`, `_PWD` or `_CREDENTIALS` (`*_API_KEY` is a `*_KEY`, `MYSQL_PWD` a `*_PWD`), or one of the names
/// that hold a password without such an ending: `PGPASSWORD` and `DATABASE_URL` (its URL carries the password).
/// Ticket 1024: also `BW_SESSION` (Bitwarden's vault key), `PASSPHRASE` and `*_PASSPHRASE`, and the plurals `*_KEYS`
/// and `*_TOKENS`, but for a name with the word `MAX` (`MAX_THINKING_TOKENS` is a count, and an agent needs it).
pub fn is_secret(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    ["PGPASSWORD", "DATABASE_URL", "BW_SESSION", "PASSPHRASE"].contains(&name.as_str())
        || [
            "_KEY",
            "_TOKEN",
            "_SECRET",
            "_PASSWORD",
            "_PAT",
            "_PASS",
            "_PWD",
            "_CREDENTIALS",
            "_PASSPHRASE",
            "_KEYS",
        ]
        .iter()
        .any(|end| name.ends_with(end))
        || (name.ends_with("_TOKENS") && !name.split('_').any(|word| word == "MAX"))
}

/// Ticket 1024: whether `value` holds a URL with a password in its user part (`scheme://user:pass@host`), anywhere
/// in it: such a variable is a secret under any name (`REDIS_URL`, `PIP_INDEX_URL`). The user part ends at the last
/// `@` before the path, so a `:` or `@` in a path or query does not count.
pub fn has_url_password(value: &str) -> bool {
    value.match_indices("://").any(|(at, _)| {
        let rest = &value[at + 3..];
        let end = rest.find(|c: char| matches!(c, '/' | '?' | '#') || c.is_whitespace());
        rest[..end.unwrap_or(rest.len())]
            .rsplit_once('@')
            .and_then(|(user, _)| user.split_once(':'))
            .is_some_and(|(_, password)| !password.is_empty())
    })
}

/// Ticket 1009 round 5: the login shell of the account this process runs as (the directory's record, not `SHELL`,
/// which a restart takes from the editable `core.start.json`). None when the record has none.
pub fn account_shell() -> Option<PathBuf> {
    // SAFETY: getpwuid returns a pointer to static storage or null; the shell string is copied before any other call.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            return None;
        }
        let shell = std::ffi::CStr::from_ptr((*pw).pw_shell).to_bytes();
        let shell =
            PathBuf::from(<std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(shell));
        (shell.is_absolute() && shell.is_file()).then_some(shell)
    }
}

/// The keychain file the item lives in, read from a start environment: `NUNCHIRO_KEYCHAIN` when set (empty: none;
/// `.cargo/config.toml` sets it empty so a test core never writes the owner's keychain), else the login keychain under
/// `HOME`. Only an existing file named by an absolute path: `security` given a missing keychain falls back to the
/// default one, and it looks a relative name up under `$HOME/Library/Keychains`, not the working directory.
pub fn keychain(var: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let path = match var("NUNCHIRO_KEYCHAIN") {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(var("HOME")?).join("Library/Keychains/login.keychain-db"),
    };
    (path.is_absolute() && path.is_file() && quotable(&path.to_string_lossy())).then_some(path)
}

/// Ticket 1009 round 7 (Codex NOTE): `core.start.json` read with a fixed ceiling before any parse; a larger file (a
/// start environment is a few KiB) reads as none. Ticket 1024: so does anything but a regular file. The open does not
/// wait (a FIFO a same-user process put there would hold a restart until someone wrote to it), and the kind is read
/// from the opened file, not the path.
pub fn read_record(path: &Path) -> Option<Vec<u8>> {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    const RECORD_MAX: u64 = 1 << 20;
    let mut bytes = Vec::new();
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    file.metadata().ok()?.is_file().then_some(())?;
    file.take(RECORD_MAX + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= RECORD_MAX).then_some(bytes)
}

/// Ticket 1009 round 6: set by the CLI on a core it starts from `core.start.json` when a named secret could not be
/// restored; that core keeps the item and the record's names as they are.
pub const UNREAD: &str = "NUNCHIRO_START_SECRETS_UNREAD";

/// Ticket 1009 round 5: whether this process runs with the hardened runtime (`codesign --options runtime`). Without
/// it a same-user process can start this executable with `DYLD_INSERT_LIBRARIES` and read the item the access list
/// trusts it with, so no item is written or read (fail closed; the restart then starts without the secrets).
pub fn hardened() -> bool {
    mac::hardened() || cfg!(test) // unit tests run unsigned; the integration tests use a hardened copy
}
const NOT_HARDENED: &str = "this build is not signed with the hardened runtime, so start secrets are not kept in the keychain";

/// Writes (or replaces) this home's item with `values`, readable only by this executable.
pub fn store(
    keychain: &Path,
    home: &Path,
    values: &BTreeMap<String, String>,
) -> Result<(), String> {
    // Round 6: nothing is deleted here; an earlier item stays for a build that may read it.
    if !hardened() {
        return Err(NOT_HARDENED.into());
    }
    let json = serde_json::to_vec(values).map_err(|_| "secrets not encoded".to_string())?;
    if json.len() > MAX {
        forget(keychain, home);
        return Err(format!(
            "{} secret variable(s) too long for one keychain item",
            values.len()
        ));
    }
    // Round 6/7 (Codex MUST): an earlier item is updated in place, never deleted first.
    let account = account(home)?;
    mac::store(keychain, SERVICE, &account, &json)?;
    // The pre-1009 item goes only once the new one reads back.
    if mac::load(keychain, SERVICE, &account).as_deref() == Some(&json[..]) {
        mac::forget(keychain, SERVICE_OLD, &account);
        Ok(())
    } else {
        Err("keychain item not read back".into())
    }
}

/// This home's item, or None when there is none or this executable may not read it.
pub fn load(keychain: &Path, home: &Path) -> Option<BTreeMap<String, String>> {
    if !hardened() {
        eprintln!("start secrets: {NOT_HARDENED}; a restart starts without them");
        return None;
    }
    let account = account(home).ok()?;
    if mac::exists(keychain, SERVICE, &account) {
        return serde_json::from_slice(&mac::load(keychain, SERVICE, &account)?).ok();
    }
    serde_json::from_slice(&unhex(&old_load(keychain, &account)?)?).ok()
}

/// The pre-1009 item's hex text, read by `security` (which its access list trusts, so no dialog), bounded at 5 s.
fn old_load(keychain: &Path, account: &str) -> Option<String> {
    use std::{
        io::Read,
        process::Stdio,
        time::{Duration, Instant},
    };
    let mut child = crate::process::command("/usr/bin/security")
        .args([
            "find-generic-password",
            "-a",
            account,
            "-s",
            SERVICE_OLD,
            "-w",
        ])
        .arg(keychain)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let until = Instant::now() + Duration::from_secs(5);
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill(); // our own child, by its handle
                let _ = child.wait();
                break false;
            }
        }
    };
    let mut hex = String::new();
    // The reply is a few KiB at most, below a pipe's buffer, so reading after the exit cannot block.
    child
        .stdout
        .take()?
        .take(2 * MAX as u64 + 2)
        .read_to_string(&mut hex)
        .ok()?;
    ok.then(|| hex.trim().to_string())
}

fn unhex(hex: &str) -> Option<Vec<u8>> {
    (hex.len().is_multiple_of(2) && hex.len() <= 2 * MAX).then_some(())?;
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Ticket 1033: whether `home` lies under the temp folder (`TMPDIR` or `/tmp`), where tests make their homes. Such a
/// home keeps no item unless `NUNCHIRO_KEYCHAIN` names a keychain: a test run outside cargo (a test binary started by
/// hand) misses the empty `NUNCHIRO_KEYCHAIN` of `.cargo/config.toml`, and its killed cores never remove their item.
pub fn temp_home(home: &Path) -> bool {
    let Ok(home) = home.canonicalize() else {
        return false;
    };
    [std::env::temp_dir(), PathBuf::from("/tmp")]
        .iter()
        .filter_map(|t| t.canonicalize().ok())
        .any(|t| home.starts_with(t))
}

/// Removes this home's item, if any (any program may delete one; reading is what the access list guards).
pub fn forget(keychain: &Path, home: &Path) {
    if let Ok(account) = account(home) {
        mac::forget(keychain, SERVICE, &account);
        mac::forget(keychain, SERVICE_OLD, &account);
    }
}

/// The item's account: the home's canonical path, so the core and a CLI naming the home another way agree.
fn account(home: &Path) -> Result<String, String> {
    let path = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let path = path.to_string_lossy().into_owned();
    if quotable(&path) {
        Ok(path)
    } else {
        Err("the home's path cannot be named to the keychain".into())
    }
}

/// Fits between the double quotes of a `security -i` word (how the item was written before ticket 1009; such paths
/// stay refused, so a home that had no item before has none now).
fn quotable(text: &str) -> bool {
    !text.contains(['"', '\\', '\n', '\r'])
}

/// Ticket 1009: the legacy file-keychain calls, the only ones that take a keychain file and an access list (the
/// data-protection keychain needs an entitlement a plain executable cannot carry). Deprecated, still supported.
#[cfg(target_os = "macos")]
#[allow(non_upper_case_globals, non_snake_case)]
mod mac {
    use std::{
        ffi::{CString, c_char, c_void},
        os::unix::ffi::OsStrExt,
        path::Path,
        ptr::null_mut,
    };
    type Ref = *mut c_void;
    #[repr(C)]
    struct Attribute {
        tag: u32,
        length: u32,
        data: *const c_void,
    }
    #[repr(C)]
    struct Attributes {
        count: u32,
        attr: *const Attribute,
    }
    const fn four(c: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*c)
    }
    const GENERIC_PASSWORD: u32 = four(b"genp");
    const UTF8: u32 = 0x0800_0100;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeArrayCallBacks: c_void;
        fn CFRelease(cf: Ref);
        fn CFArrayGetCount(array: Ref) -> isize;
        fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
        fn CFEqual(a: Ref, b: Ref) -> u8;
        fn CFStringCreateWithCString(alloc: Ref, s: *const c_char, encoding: u32) -> Ref;
        fn CFArrayCreate(
            alloc: Ref,
            values: *const Ref,
            count: isize,
            callbacks: *const c_void,
        ) -> Ref;
    }
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainOpen(path: *const c_char, keychain: *mut Ref) -> i32;
        fn SecKeychainSetUserInteractionAllowed(allowed: u8) -> i32;
        fn SecKeychainFindGenericPassword(
            keychain: Ref,
            service_len: u32,
            service: *const c_char,
            account_len: u32,
            account: *const c_char,
            data_len: *mut u32,
            data: *mut *mut c_void,
            item: *mut Ref,
        ) -> i32;
        fn SecKeychainItemFreeContent(attrs: Ref, data: *mut c_void) -> i32;
        fn SecKeychainItemDelete(item: Ref) -> i32;
        static kSecACLAuthorizationDecrypt: Ref;
        static kSecACLAuthorizationChangeACL: Ref;
        static kSecACLAuthorizationAny: Ref;
        fn SecKeychainItemCopyAccess(item: Ref, access: *mut Ref) -> i32;
        fn SecAccessCopyMatchingACLList(access: Ref, tag: Ref) -> Ref;
        fn SecACLCopyContents(
            acl: Ref,
            apps: *mut Ref,
            description: *mut Ref,
            prompt: *mut u16,
        ) -> i32;
        fn SecTrustedApplicationCopyData(app: Ref, data: *mut Ref) -> i32;
        fn SecKeychainItemModifyAttributesAndData(
            item: Ref,
            attrs: *const Attributes,
            len: u32,
            data: *const c_void,
        ) -> i32;
        fn SecTrustedApplicationCreateFromPath(path: *const c_char, app: *mut Ref) -> i32;
        fn SecAccessCreate(descriptor: Ref, trusted: Ref, access: *mut Ref) -> i32;
        fn SecKeychainItemCreateFromContent(
            class: u32,
            attrs: *const Attributes,
            len: u32,
            data: *const c_void,
            keychain: Ref,
            access: Ref,
            item: *mut Ref,
        ) -> i32;
    }

    /// Releases a Core Foundation object when it goes out of scope.
    pub(super) struct Owned(Ref);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }

    /// The keychain file, opened with dialogs off for this process (the core and the CLI show none of their own).
    fn open(keychain: &Path) -> Option<Owned> {
        let path = CString::new(keychain.as_os_str().as_bytes()).ok()?;
        let mut kc = null_mut();
        unsafe {
            SecKeychainSetUserInteractionAllowed(0);
            (SecKeychainOpen(path.as_ptr(), &mut kc) == 0).then_some(Owned(kc))
        }
    }

    /// The item with its data (`want_data`) or without (a delete needs only the item).
    fn find(
        kc: &Owned,
        service: &str,
        account: &str,
        want_data: bool,
    ) -> Option<(Owned, Option<Vec<u8>>)> {
        let (mut len, mut data, mut item) = (0u32, null_mut(), null_mut());
        let status = unsafe {
            SecKeychainFindGenericPassword(
                kc.0,
                service.len() as u32,
                service.as_ptr().cast(),
                account.len() as u32,
                account.as_ptr().cast(),
                if want_data { &mut len } else { null_mut() },
                if want_data { &mut data } else { null_mut() },
                &mut item,
            )
        };
        if status != 0 {
            return None;
        }
        // Round 3 (Codex NOTE): an item larger than any `store` writes is refused before it is copied or parsed.
        let bytes = (!data.is_null()).then(|| unsafe {
            let bytes = (len as usize <= super::MAX)
                .then(|| std::slice::from_raw_parts(data.cast::<u8>(), len as usize).to_vec());
            SecKeychainItemFreeContent(null_mut(), data);
            bytes
        });
        let bytes = bytes.flatten();
        Some((Owned(item), bytes))
    }

    /// The item's data, only when the item is ours (`ours`); an item someone else made is never read.
    pub(super) fn load(keychain: &Path, service: &str, account: &str) -> Option<Vec<u8>> {
        let kc = open(keychain)?;
        let (item, _) = find(&kc, service, account, false)?;
        if !ours(&item)? {
            eprintln!("start secrets: the keychain item is not this program's own; it is not read");
            return None;
        }
        find(&kc, service, account, true)?.1
    }

    /// Whether an item is there at all (ours or not), without reading its data.
    pub(super) fn exists(keychain: &Path, service: &str, account: &str) -> bool {
        open(keychain).is_some_and(|kc| find(&kc, service, account, false).is_some())
    }

    /// Round 8 (Codex MUST): an item is ours only when every entry of its access list that may read it or change the
    /// list (decrypt, change ACL, any) names a list of programs, and every program on it is this executable. An item a
    /// same-user process made first (`security add-generic-password -A`: any program reads it) is not.
    pub(super) fn ours(item: &Owned) -> Option<bool> {
        unsafe {
            let mut me = null_mut();
            if SecTrustedApplicationCreateFromPath(std::ptr::null(), &mut me) != 0 {
                return None;
            }
            let me = Owned(me);
            let mut mine = null_mut();
            if SecTrustedApplicationCopyData(me.0, &mut mine) != 0 {
                return None;
            }
            let mine = Owned(mine);
            let mut access = null_mut();
            if SecKeychainItemCopyAccess(item.0, &mut access) != 0 {
                return None;
            }
            let access = Owned(access);
            let mut decrypt_listed = false;
            for (tag, reads) in [
                (kSecACLAuthorizationDecrypt, true),
                (kSecACLAuthorizationChangeACL, false),
                (kSecACLAuthorizationAny, true),
            ] {
                let acls = SecAccessCopyMatchingACLList(access.0, tag);
                if acls.is_null() {
                    continue;
                }
                let acls = Owned(acls);
                for i in 0..CFArrayGetCount(acls.0) {
                    let acl = CFArrayGetValueAtIndex(acls.0, i);
                    let (mut apps, mut desc, mut prompt) = (null_mut(), null_mut(), 0u16);
                    if SecACLCopyContents(acl, &mut apps, &mut desc, &mut prompt) != 0 {
                        return None;
                    }
                    let _desc = Owned(desc);
                    if apps.is_null() {
                        return Some(false); // any program
                    }
                    let apps = Owned(apps);
                    for j in 0..CFArrayGetCount(apps.0) {
                        let mut data = null_mut();
                        if SecTrustedApplicationCopyData(
                            CFArrayGetValueAtIndex(apps.0, j),
                            &mut data,
                        ) != 0
                        {
                            return None;
                        }
                        let data = Owned(data);
                        if CFEqual(data.0, mine.0) == 0 {
                            return Some(false);
                        }
                        decrypt_listed |= reads;
                    }
                }
            }
            Some(decrypt_listed)
        }
    }

    unsafe extern "C" {
        fn csops(pid: i32, ops: u32, useraddr: *mut c_void, usersize: usize) -> i32;
    }
    /// The kernel's code-signing status of this process has CS_RUNTIME (0x10000), read with CS_OPS_STATUS (0).
    pub(super) fn hardened() -> bool {
        let mut flags: u32 = 0;
        let status = unsafe {
            csops(
                std::process::id() as i32,
                0,
                (&mut flags as *mut u32).cast(),
                std::mem::size_of::<u32>(),
            )
        };
        status == 0 && flags & 0x0001_0000 != 0
    }

    pub(super) fn forget(keychain: &Path, service: &str, account: &str) {
        if let Some(kc) = open(keychain) {
            while let Some((item, _)) = find(&kc, service, account, false) {
                if unsafe { SecKeychainItemDelete(item.0) } != 0 {
                    break;
                }
            }
        }
    }

    /// Round 7 (Codex MUST, second replacement FAIL): the found item's data is replaced in place, in one call, and a
    /// new item is added only when none exists. Nothing is deleted on this path, so a failed update (an item an
    /// earlier build's access list keeps from this one, a locked keychain) leaves the earlier item as it was.
    pub(super) fn store(
        keychain: &Path,
        service: &str,
        account: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let kc = open(keychain).ok_or("keychain not opened")?;
        let Some((item, _)) = find(&kc, service, account, false) else {
            return create(keychain, service, account, data).map(drop);
        };
        // Round 8 (Codex MUST): secrets are never written into an item someone else made. Nothing in it was ours, so
        // it goes and a fresh item with this program's access list takes its place.
        // A locked keychain cannot say whose the item is: nothing is replaced then.
        if !ours(&item).ok_or("the keychain item's access could not be read")? {
            eprintln!(
                "start secrets: the keychain item was not this program's own; it is replaced"
            );
            if unsafe { SecKeychainItemDelete(item.0) } != 0 {
                return Err("an untrusted keychain item could not be removed".into());
            }
            return create(keychain, service, account, data).map(drop);
        }
        #[cfg(test)]
        if super::tests::FAIL_UPDATE.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("keychain item not updated (test)".into());
        }
        let status = unsafe {
            SecKeychainItemModifyAttributesAndData(
                item.0,
                std::ptr::null(),
                data.len() as u32,
                data.as_ptr().cast(),
            )
        };
        match status {
            0 => Ok(()),
            status => Err(format!("keychain item not updated ({status})")),
        }
    }

    /// A new item that only this executable reads without a dialog; the access list's change entry names no program,
    /// so no one widens it without one.
    pub(super) fn create(
        keychain: &Path,
        service: &str,
        account: &str,
        data: &[u8],
    ) -> Result<Owned, String> {
        let kc = open(keychain).ok_or("keychain not opened")?;
        let label = CString::new(service).map_err(|e| e.to_string())?;
        unsafe {
            let mut me = null_mut();
            if SecTrustedApplicationCreateFromPath(std::ptr::null(), &mut me) != 0 {
                return Err("this program could not be named to the keychain".into());
            }
            let me = Owned(me);
            let list = Owned(CFArrayCreate(null_mut(), &me.0, 1, &kCFTypeArrayCallBacks));
            let descriptor = Owned(CFStringCreateWithCString(null_mut(), label.as_ptr(), UTF8));
            let mut access = null_mut();
            if list.0.is_null()
                || descriptor.0.is_null()
                || SecAccessCreate(descriptor.0, list.0, &mut access) != 0
            {
                return Err("keychain access list not made".into());
            }
            let access = Owned(access);
            let attrs = [
                Attribute {
                    tag: four(b"svce"),
                    length: service.len() as u32,
                    data: service.as_ptr().cast(),
                },
                Attribute {
                    tag: four(b"acct"),
                    length: account.len() as u32,
                    data: account.as_ptr().cast(),
                },
                Attribute {
                    tag: four(b"labl"),
                    length: service.len() as u32,
                    data: service.as_ptr().cast(),
                },
            ];
            let list = Attributes {
                count: attrs.len() as u32,
                attr: attrs.as_ptr(),
            };
            let mut item = null_mut();
            let status = SecKeychainItemCreateFromContent(
                GENERIC_PASSWORD,
                &list,
                data.len() as u32,
                data.as_ptr().cast(),
                kc.0,
                access.0,
                &mut item,
            );
            let item = Owned(item);
            match status {
                0 => Ok(item),
                status => Err(format!("keychain item not written ({status})")),
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use std::path::Path;
    pub(super) fn load(_: &Path, _: &str, _: &str) -> Option<Vec<u8>> {
        None
    }
    pub(super) fn exists(_: &Path, _: &str, _: &str) -> bool {
        false
    }
    pub(super) fn hardened() -> bool {
        false
    }
    pub(super) fn forget(_: &Path, _: &str, _: &str) {}
    pub(super) fn store(_: &Path, _: &str, _: &str, _: &[u8]) -> Result<(), String> {
        Err("no keychain on this system".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round 7: makes the next in-place update fail, as a keychain error would.
    pub(super) static FAIL_UPDATE: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);

    // The unit test binary is linker-signed ad hoc without the runtime flag.
    #[cfg(target_os = "macos")]
    #[test]
    fn unsigned_test_binary_is_not_hardened() {
        assert!(!mac::hardened());
    }

    #[test]
    fn record_read_is_bounded() {
        let dir = std::env::temp_dir().join(format!("nunchiro-1009-rec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("core.start.json");
        std::fs::write(&file, b"{}").unwrap();
        assert_eq!(read_record(&file).as_deref(), Some(&b"{}"[..]));
        std::fs::write(&file, vec![b' '; (1 << 20) + 1]).unwrap();
        assert_eq!(read_record(&file), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn secret_names() {
        for name in [
            "ANTHROPIC_API_KEY",
            "openai_api_key",
            "GH_TOKEN",
            "Github_Token",
            "AWS_SECRET",
            "DB_PASSWORD",
            "my_key",
            "PGPASSWORD",
            "pgpassword",
            "MYSQL_PWD",
            "DATABASE_URL",
            "database_url",
            "GITHUB_PAT",
            "smtp_pass",
            "FTP_PASS",
            "REDIS_PWD",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "aws_credentials",
        ] {
            assert!(is_secret(name), "{name}");
        }
        for name in [
            "PATH",
            "HOME",
            "KEY",
            "TOKEN_FILE",
            "SSH_AUTH_SOCK",
            "KEYCHAIN",
            "PASSWORDS",
            "PWD",
            "OLDPWD",
            "MANPATH",
            "PAT",
            "SSH_ASKPASS",
            "GIT_ASKPASS",
            "CREDENTIALS",
            "DATABASE_URL_FILE",
        ] {
            assert!(!is_secret(name), "{name}");
        }
    }

    // Ticket 1024: a FIFO a same-user process put in the record's place never holds a restart; only a regular file
    // is read.
    #[test]
    fn record_read_refuses_a_fifo_without_waiting() {
        use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
        let dir = std::env::temp_dir().join(format!("nunchiro-1024-fifo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("core.start.json");
        let name = std::ffi::CString::new(file.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (tell, told) = std::sync::mpsc::channel();
        let path = file.clone();
        std::thread::spawn(move || tell.send(read_record(&path)));
        let read = told.recv_timeout(std::time::Duration::from_secs(5));
        // A writer's end, so a read still waiting in `open` ends with the test.
        let _ = std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&file);
        assert_eq!(read, Ok(None), "the read waited on the FIFO");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Ticket 1024: more secret-shaped names, each with a near miss.
    #[test]
    fn secret_names_of_ticket_1024() {
        for name in [
            "BW_SESSION",
            "bw_session",
            "PASSPHRASE",
            "GPG_PASSPHRASE",
            "borg_passphrase",
            "API_KEYS",
            "ssh_keys",
            "ACCESS_TOKENS",
            "refresh_tokens",
        ] {
            assert!(is_secret(name), "{name}");
        }
        for name in [
            "BW_SESSIONS",
            "TERM_SESSION_ID",
            "PASSPHRASE_FILE",
            "PASSPHRASES",
            "HOTKEYS",
            "KEYS",
            "KEYS_DIR",
            "TOKENS",
            // A count of tokens, not a list of them.
            "MAX_THINKING_TOKENS",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "ANTHROPIC_MAX_TOKENS",
        ] {
            assert!(!is_secret(name), "{name}");
        }
    }

    // Ticket 1024: a value that holds a URL with a password is a secret under any name.
    #[test]
    fn url_password_values() {
        for value in [
            "redis://user:pw@host:6379/0",
            "https://u:p@pypi.example/simple",
            "postgres://:pw@db/x",
            "amqp+ssl://u:p@h",
            "https://plain.example/ https://u:p@second.example/",
            "https://u:p@ss@host/",
        ] {
            assert!(has_url_password(value), "{value}");
        }
        for value in [
            "",
            "https://host/path",
            "https://user@host/x",
            "https://user:@host/x",
            "https://host:8080/a",
            "https://host/a?next=u:p@h",
            "https://host/u:p@x",
            "git@github.com:org/repo.git",
            "user:pass@host",
            "/usr/bin:/bin",
        ] {
            assert!(!has_url_password(value), "{value}");
        }
    }

    // The guard `.cargo/config.toml` sets for every test process and the cores it starts.
    #[test]
    fn tests_see_no_keychain() {
        assert_eq!(std::env::var("NUNCHIRO_KEYCHAIN").as_deref(), Ok(""));
        assert_eq!(keychain(|k| std::env::var(k).ok()), None);
    }

    #[test]
    fn keychain_needs_an_existing_plain_file() {
        let dir = std::env::temp_dir().join(format!("nunchiro-457-{}", std::process::id()));
        let file = dir.join("Library/Keychains/login.keychain-db");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"").unwrap();
        let home = dir.to_string_lossy().into_owned();
        let from = |pairs: Vec<(&'static str, String)>| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone())
        };
        assert_eq!(
            keychain(from(vec![("HOME", home.clone())])),
            Some(file.clone())
        );
        // Set and empty: none, whatever HOME holds.
        assert_eq!(
            keychain(from(vec![
                ("HOME", home.clone()),
                ("NUNCHIRO_KEYCHAIN", String::new())
            ])),
            None
        );
        assert_eq!(
            keychain(from(vec![(
                "NUNCHIRO_KEYCHAIN",
                file.to_string_lossy().into()
            )])),
            Some(file.clone())
        );
        assert_eq!(keychain(from(vec![("HOME", format!("{home}/none"))])), None);
        assert_eq!(keychain(from(vec![])), None);
        // Round 2 (security S1): a relative name is a file here (the crate folder is the test's cwd), but `security`
        // looks it up under $HOME/Library/Keychains.
        assert!(std::path::Path::new("Cargo.toml").is_file());
        assert_eq!(
            keychain(from(vec![("NUNCHIRO_KEYCHAIN", "Cargo.toml".into())])),
            None
        );
        assert_eq!(keychain(from(vec![("HOME", ".".into())])), None);
        assert!(!quotable("a\"b") && !quotable("a\\b") && !quotable("a\nb") && quotable("/a b"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Ticket 1009: in a keychain made for the test (never the owner's), the item reads back here, and its access list
    // names this test executable alone, so `security` (and any other program) gets no silent read.
    #[cfg(target_os = "macos")]
    #[test]
    fn item_is_readable_by_its_writer_only() {
        let dir = std::env::temp_dir().join(format!("nunchiro-1009-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let kc = dir.join("t.keychain-db");
        // HOME here: `security` keeps the keychain search list under HOME, and the owner's must stay as it is.
        let security = |args: &[&str]| {
            std::process::Command::new("/usr/bin/security")
                .args(args)
                .arg(&kc)
                .env("HOME", &dir)
                .output()
                .unwrap()
        };
        assert!(security(&["create-keychain", "-p", "t"]).status.success());
        assert!(security(&["set-keychain-settings"]).status.success());
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let values = BTreeMap::from([("W36_API_SECRET".to_string(), "v-1009".to_string())]);
        store(&kc, &home, &values).unwrap();
        assert_eq!(load(&kc, &home), Some(values.clone()));
        // Written again (a restart): still one item, still readable.
        store(&kc, &home, &values).unwrap();
        assert_eq!(load(&kc, &home), Some(values));
        let dump = String::from_utf8_lossy(&security(&["dump-keychain", "-a"]).stdout).into_owned();
        let me = std::env::current_exe().unwrap();
        let decrypt = dump
            .split("entry ")
            .find(|e| e.contains("decrypt"))
            .unwrap_or_else(|| panic!("{dump}"));
        assert!(decrypt.contains("applications (1):"), "{decrypt}");
        assert!(decrypt.contains(&*me.to_string_lossy()), "{decrypt}");
        assert!(!dump.contains("/usr/bin/security"), "{dump}");
        assert!(!dump.contains("v-1009"), "{dump}");
        // Round 3: an oversized item (written past `store`'s cap) reads as none.
        let acct = account(&home).unwrap();
        forget(&kc, &home);
        drop(mac::create(&kc, SERVICE, &acct, &vec![b'x'; MAX + 1]).unwrap());
        assert_eq!(mac::load(&kc, SERVICE, &acct), None);
        forget(&kc, &home);
        mac::store(&kc, SERVICE, &acct, b"{}").unwrap();
        assert_eq!(load(&kc, &home), Some(BTreeMap::new()));
        // Round 6 (Codex MUST): an item an earlier build wrote with `security` (hex JSON) restores its values; the next
        // store replaces it only once the new item reads back.
        forget(&kc, &home);
        let old: String =
            br#"{"OLD_API_KEY":"v-old"}"#.iter().map(|b| format!("{b:02x}")).collect();
        assert!(
            security(&[
                "add-generic-password",
                "-a",
                &acct,
                "-s",
                SERVICE_OLD,
                "-w",
                &old
            ])
            .status
            .success()
        );
        let restored = BTreeMap::from([("OLD_API_KEY".to_string(), "v-old".to_string())]);
        assert_eq!(load(&kc, &home), Some(restored.clone()));
        let fresh = BTreeMap::from([("NEW_API_KEY".to_string(), "v-new".to_string())]);
        store(&kc, &home, &fresh).unwrap();
        assert_eq!(load(&kc, &home), Some(fresh.clone()));
        assert!(
            !security(&["find-generic-password", "-a", &acct, "-s", SERVICE_OLD])
                .status
                .success()
        );
        // Round 7: a failed in-place update leaves the earlier item loading.
        let other = BTreeMap::from([("OTHER_API_KEY".to_string(), "v-other".to_string())]);
        FAIL_UPDATE.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(store(&kc, &home, &other).is_err());
        FAIL_UPDATE.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(load(&kc, &home), Some(fresh.clone()));
        // And a working update replaces the data of the same item.
        store(&kc, &home, &other).unwrap();
        assert_eq!(load(&kc, &home), Some(other));
        store(&kc, &home, &fresh).unwrap();
        // Round 8 (Codex MUST): an item another program made first with open access (`-A`) is never loaded, and a
        // store replaces it with one only this executable reads.
        forget(&kc, &home);
        assert!(
            security(&[
                "add-generic-password",
                "-A",
                "-a",
                &acct,
                "-s",
                SERVICE,
                "-w",
                r#"{"PLANTED_KEY":"x"}"#
            ])
            .status
            .success()
        );
        assert_eq!(load(&kc, &home), None);
        store(&kc, &home, &fresh).unwrap();
        assert_eq!(load(&kc, &home), Some(fresh.clone()));
        let dump = String::from_utf8_lossy(&security(&["dump-keychain", "-a"]).stdout).into_owned();
        let decrypt = dump
            .split("entry ")
            .filter(|e| e.contains("decrypt"))
            .collect::<Vec<_>>();
        assert_eq!(decrypt.len(), 1, "{dump}");
        assert!(
            decrypt[0].contains("applications (1):") && decrypt[0].contains(&*me.to_string_lossy()),
            "{dump}"
        );
        // A store that fails (a locked keychain) leaves the earlier item in place.
        assert!(security(&["lock-keychain"]).status.success());
        assert!(store(&kc, &home, &restored).is_err());
        assert!(security(&["unlock-keychain", "-p", "t"]).status.success());
        assert_eq!(load(&kc, &home), Some(fresh));
        forget(&kc, &home);
        assert_eq!(load(&kc, &home), None);
        security(&["delete-keychain"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
