//! V2.5-34 r2: the account's home from the passwd database. `HOME` can be overridden by whoever starts the app (the
//! real-app check does), this cannot, so the RC build compares against it to find the owner's `~/.nunchiro`.
//! `passwd_home` is lifted from MonoCode `src-tauri/src/lib.rs` (`passwd_identity`, its `getpwuid_r` call), reduced
//! to the home directory.
//!
//! MonoCode licence (applies to the lifted function):
//!
//! MIT License. Copyright (c) 2026 Nick. Permission is hereby granted, free of charge, to any person
//! obtaining a copy of this software and associated documentation files (the "Software"), to deal in the
//! Software without restriction, including without limitation the rights to use, copy, modify, merge,
//! publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
//! Software is furnished to do so, subject to the following conditions: The above copyright notice and
//! this permission notice shall be included in all copies or substantial portions of the Software.
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//! LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
//! NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
//! WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
//! SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
use std::{ffi::CStr, os::unix::ffi::OsStrExt, path::PathBuf};

/// The current user's home directory as the passwd database has it, or `None` when there is no entry.
pub fn passwd_home() -> Option<PathBuf> {
    // getpwuid_r, not getpwuid: `home()` runs on several threads and getpwuid shares one static buffer.
    let uid = unsafe { libc::getuid() };
    let mut buf = vec![0u8; 4096];
    let mut pwd = unsafe { std::mem::zeroed::<libc::passwd>() };
    let mut result = std::ptr::null_mut::<libc::passwd>();
    // SAFETY: every pointer is valid for the call and buf outlives the reads of pwd's fields below.
    let rc = unsafe {
        libc::getpwuid_r(
            uid,
            &mut pwd,
            buf.as_mut_ptr() as *mut libc::c_char,
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    // SAFETY: getpwuid_r succeeded, so pw_dir is a NUL-terminated string inside buf.
    let dir = unsafe { CStr::from_ptr(pwd.pw_dir) }.to_bytes();
    (!dir.is_empty()).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(dir)))
}

#[cfg(test)]
mod tests {
    #[test]
    fn passwd_home_is_an_absolute_folder() {
        let home = super::passwd_home().expect("the test user has a passwd entry");
        assert!(home.is_absolute() && home.is_dir(), "{}", home.display());
    }
}
