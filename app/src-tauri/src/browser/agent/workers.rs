//! The space workers: one thread per space that runs its jobs in order, bounded and retired when idle.
use super::*;

/// Ticket 998 L10 round 2 (security MUST): space workers are bounded. A worker goes after WORKER_IDLE without a job, when
/// its space is forgotten (`retire`), or to make room for a new space (the longest idle first); its thread ends when its
/// sender is dropped. A worker with a job queued or running is never retired, so a space's jobs keep their order and
/// one space's slow job still never holds another's. The core lets at most 8 jobs be in flight, so 16 leaves room for
/// spaces whose jobs outlived their waiters.
pub(super) const WORKERS_MAX: usize = 16;
/// An agent working in a space sends its next verb within a model turn; a space quiet this long has likely ended.
pub(super) const WORKER_IDLE: Duration = Duration::from_secs(60);
pub(super) const WORKERS_BUSY: &str =
    "The browser is busy with other sessions' commands; wait for them, then try again";

pub(super) struct Worker {
    tx: mpsc::Sender<Value>,
    /// Jobs handed to it and not yet answered.
    jobs: Arc<AtomicUsize>,
    /// When it was last handed a job.
    last: Instant,
}

pub(super) static WORKERS: Mutex<Vec<(String, Worker)>> = Mutex::new(Vec::new());
/// Worker threads alive (the bound test reads it).
pub(super) static LIVE: AtomicUsize = AtomicUsize::new(0);

impl Worker {
    pub(super) fn idle(&self) -> bool {
        self.jobs.load(Ordering::SeqCst) == 0
    }

    /// A thread that runs its jobs in order and ends once its sender is dropped and its jobs are done.
    fn spawn(run: &(impl Fn(Value) + Clone + Send + 'static), now: Instant) -> Worker {
        let (tx, rx) = mpsc::channel::<Value>();
        let jobs = Arc::new(AtomicUsize::new(0));
        let (run, left) = (run.clone(), jobs.clone());
        LIVE.fetch_add(1, Ordering::SeqCst);
        thread::spawn(move || {
            for job in rx {
                run(job);
                left.fetch_sub(1, Ordering::SeqCst);
            }
            LIVE.fetch_sub(1, Ordering::SeqCst);
        });
        Worker {
            tx,
            jobs,
            last: now,
        }
    }
}

/// Drops the workers idle for WORKER_IDLE.
pub(super) fn prune(list: &mut Vec<(String, Worker)>, now: Instant) {
    list.retain(|(_, w)| !w.idle() || now.duration_since(w.last) < WORKER_IDLE);
}

/// Hands `job` to `space`'s worker, starting one if needed. `Err(job)`: WORKERS_MAX workers all have jobs.
pub(super) fn hand(
    list: &mut Vec<(String, Worker)>,
    space: &str,
    job: Value,
    now: Instant,
    run: &(impl Fn(Value) + Clone + Send + 'static),
) -> Result<(), Value> {
    let at = match list.iter().position(|(s, _)| s == space) {
        Some(at) => at,
        None => {
            if list.len() >= WORKERS_MAX {
                let oldest = list
                    .iter()
                    .enumerate()
                    .filter(|(_, (_, w))| w.idle())
                    .min_by_key(|(_, (_, w))| w.last)
                    .map(|(i, _)| i);
                match oldest {
                    Some(i) => drop(list.swap_remove(i)),
                    None => return Err(job),
                }
            }
            list.push((space.to_string(), Worker::spawn(run, now)));
            list.len() - 1
        }
    };
    let w = &mut list[at].1;
    w.jobs.fetch_add(1, Ordering::SeqCst);
    w.last = now;
    if let Err(mpsc::SendError(job)) = w.tx.send(job) {
        // The worker panicked: a new one takes this job.
        *w = Worker::spawn(run, now);
        w.jobs.fetch_add(1, Ordering::SeqCst);
        let _ = w.tx.send(job);
    }
    Ok(())
}
