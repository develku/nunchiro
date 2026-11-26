//! A connection's off-loop work: its admission place, its job threads and the sub-agent reader.
use super::*;
/// Ticket 421 round 2: a connection's admission place (`MAX_CONNECTIONS` windows, `MAX_BROWSERS` browsers), freed when
/// the last holder drops: the connection itself and each of its job threads. A closed connection's job threads run on to
/// the end of their work, so its place stays taken until they end, and churn is bounded by the connection cap.
pub(super) struct Lease(Option<Box<dyn FnOnce() + Send + Sync>>);
impl Lease {
    pub(super) fn new(free: impl FnOnce() + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self(Some(Box::new(free))))
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(free) = self.0.take() {
            free();
        }
    }
}
/// v2-7: per Search panel, the running page's cancel flag. Ticket 438: a closed connection (any exit of `serve`)
/// cancels every scan it started, so none reads on for a window that is gone.
pub(super) struct SearchCancel(pub(super) Vec<(String, Arc<AtomicBool>)>);
impl Drop for SearchCancel {
    fn drop(&mut self) {
        for (_, cancel) in &self.0 {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}
pub(super) struct Jobs {
    tx: std::sync::mpsc::SyncSender<serde_json::Value>,
    rx: std::sync::mpsc::Receiver<serde_json::Value>,
    pub(super) open: usize,
    cap: usize,
    lease: Arc<Lease>, // ticket 421 round 2: each job thread holds a clone
}
impl Jobs {
    pub(super) fn new(lease: Arc<Lease>) -> Self {
        Self::with_cap(lease, MAX_JOBS)
    }
    pub(super) fn with_cap(lease: Arc<Lease>, cap: usize) -> Self {
        // Room for every open job's one reply: a job thread never blocks on sending.
        let (tx, rx) = std::sync::mpsc::sync_channel(cap);
        Self {
            tx,
            rx,
            open: 0,
            cap,
            lease,
        }
    }
    /// `None` when `job` started; its reply comes from `ready`. Otherwise the refusal to send now.
    pub(super) fn spawn(
        &mut self,
        id: u64,
        job: impl FnOnce() -> Response + Send + 'static,
    ) -> Option<serde_json::Value> {
        if self.open >= self.cap {
            let response: Response = Err("too many requests in flight; try again".into());
            return Some(serde_json::json!({"id":id,"response":response}));
        }
        let tx = self.tx.clone();
        let lease = self.lease.clone();
        let started = thread::Builder::new().spawn(move || {
            let _lease = lease;
            // A panicking job still answers, so its slot is freed.
            let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job))
                .unwrap_or_else(|_| Err("request failed".into()));
            let _ = tx.send(serde_json::json!({"id":id,"response":response}));
            crate::pty::wake_windows(); // S9: the loop sends it now, not at its next timed check
        });
        if started.is_err() {
            let response: Response = Err("could not start the request; try again".into());
            return Some(serde_json::json!({"id":id,"response":response}));
        }
        self.open += 1;
        None
    }
    pub(super) fn ready(&mut self) -> Option<serde_json::Value> {
        let reply = self.rx.try_recv().ok()?;
        self.open -= 1;
        Some(reply)
    }
}

/// Q9 psn-J12-5: the tree's sub-agent reads (`read_subagents`) walk and read transcript files, which a volume macOS
/// holds behind a dialog can stall. One reader thread per connection answers them in order, off the frame loop and
/// outside the `MAX_JOBS` places: the tree asks for every running session at once. Started at the first such read; it
/// ends when the connection drops `tx` (a read stuck on the volume runs on to its end, as a job does).
pub(super) struct KidReads {
    tx: std::sync::mpsc::SyncSender<(u64, String, Option<String>)>,
    rx: std::sync::mpsc::Receiver<serde_json::Value>,
}
const KID_READS_QUEUED: usize = 64;
impl KidReads {
    pub(super) fn start(
        lease: Arc<Lease>,
        read: impl Fn(&str, Option<&str>) -> Response + Send + 'static,
    ) -> Option<Self> {
        let (tx, asks) =
            std::sync::mpsc::sync_channel::<(u64, String, Option<String>)>(KID_READS_QUEUED);
        let (done, rx) = std::sync::mpsc::channel();
        thread::Builder::new()
            .spawn(move || {
                let _lease = lease;
                for (frame, id, open) in asks {
                    let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        read(&id, open.as_deref())
                    }))
                    .unwrap_or_else(|_| Err("request failed".into()));
                    if done
                        .send(serde_json::json!({"id":frame,"response":response}))
                        .is_err()
                    {
                        break;
                    }
                    crate::pty::wake_windows();
                }
            })
            .ok()?;
        Some(Self { tx, rx })
    }
    /// `None` when queued; its reply comes from `ready`. Otherwise the refusal to send now.
    pub(super) fn ask(
        &self,
        frame: u64,
        id: String,
        open: Option<String>,
    ) -> Option<serde_json::Value> {
        let response: Response = Err("too many requests in flight; try again".into());
        (self.tx.try_send((frame, id, open)).is_err())
            .then(|| serde_json::json!({"id":frame,"response":response}))
    }
    pub(super) fn ready(&self) -> Option<serde_json::Value> {
        self.rx.try_recv().ok()
    }
}
