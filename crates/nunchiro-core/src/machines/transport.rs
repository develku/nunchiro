//! Bounded SSH capture; unlike launch version probes, snapshots may reach 8 MiB.
use std::{
    io::Read,
    os::{fd::AsRawFd, unix::process::CommandExt},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};
pub fn output(mut command: Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .process_group(0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
        {
            unsafe {
                libc::killpg(child.id() as i32, libc::SIGKILL);
            }
            let _ = child.wait();
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    let deadline = Instant::now() + timeout;
    let mut status = None;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut out_done = false;
    let mut err_done = false;
    let result = loop {
        let mut progress = false;
        for (reader, bytes, done) in [
            (&mut stdout as &mut dyn Read, &mut out, &mut out_done),
            (&mut stderr as &mut dyn Read, &mut err, &mut err_done),
        ] {
            if *done {
                continue;
            }
            let mut buf = [0; 8192];
            match reader.read(&mut buf) {
                Ok(0) => *done = true,
                Ok(n) => {
                    progress = true;
                    let keep = n.min(8 * 1024 * 1024 + 1 - bytes.len());
                    bytes.extend_from_slice(&buf[..keep]);
                }
                Err(e)
                    if [
                        std::io::ErrorKind::WouldBlock,
                        std::io::ErrorKind::Interrupted,
                    ]
                    .contains(&e.kind()) => {}
                Err(e) => {
                    if status.is_none() {
                        stop_command(&mut child);
                    }
                    return Err(e.to_string());
                }
            }
        }
        if status.is_none() {
            match crate::process::exited(child.id()) {
                Ok(true) => {
                    // Retire the group before wait() releases the leader's PID for reuse.
                    unsafe {
                        libc::killpg(child.id() as i32, libc::SIGKILL);
                    }
                    match child.wait() {
                        Ok(exit) => status = Some(exit),
                        Err(e) => break Err(e.to_string()),
                    }
                }
                Ok(false) => {}
                Err(e) => break Err(e.to_string()),
            }
        }

        if status.is_some() && out_done && err_done {
            break Ok(());
        }
        if Instant::now() >= deadline {
            break Err(format!(
                "command timed out after {} ms",
                timeout.as_millis()
            ));
        }
        if !progress {
            thread::sleep(Duration::from_millis(10));
        }
    };
    if result.is_err() && status.is_none() {
        stop_command(&mut child);
    }
    result?;
    if out.len() > 8 * 1024 * 1024 || err.len() > 8 * 1024 * 1024 {
        return Err("remote reply exceeds 8 MiB limit".into());
    }
    Ok(Output {
        status: status.unwrap(),
        stdout: out,
        stderr: err,
    })
}
fn stop_command(child: &mut std::process::Child) {
    if crate::process::exited(child.id()).is_ok() {
        unsafe {
            libc::killpg(child.id() as i32, libc::SIGKILL);
        }
        let _ = child.wait();
    }
}
