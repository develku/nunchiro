//! Registry-owned handles only; all source and cache I/O runs on the detached plan.
use super::{
    Page, Store, TESTED_VERSIONS,
    persistence::{StopSlot, Stops},
};
use crate::{
    api::{AgentKind, Session},
    store,
    waiting::transcript,
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
#[derive(Default)]
struct Slot {
    store: Mutex<Option<Store>>,
    stops: Arc<StopSlot>,
    source: Mutex<Option<PathBuf>>,
}
pub struct Cache {
    home: PathBuf,
    slots: BTreeMap<String, Arc<Slot>>,
}
impl Cache {
    pub fn new(home: &Path) -> Self {
        Self {
            home: home.into(),
            slots: BTreeMap::new(),
        }
    }
    fn slot(&mut self, id: &str) -> Result<Arc<Slot>, String> {
        if let Some(slot) = self.slots.get(id) {
            return Ok(slot.clone());
        }
        if self.slots.len() >= 64 {
            let idle = self
                .slots
                .iter()
                .find(|(_, s)| Arc::strong_count(s) == 1 && !s.stops.busy.load(Ordering::Acquire))
                .map(|(k, _)| k.clone())
                .ok_or("chat cache busy")?;
            self.slots.remove(&idle);
        }
        let slot = Arc::new(Slot::default());
        self.slots.insert(id.into(), slot.clone());
        Ok(slot)
    }
    pub fn plan_source(
        &mut self,
        meta: &Session,
        path: Option<PathBuf>,
        before: Option<u64>,
        after: Option<u64>,
    ) -> Result<ReadPlan, String> {
        if before.is_some() && after.is_some() {
            return Err("chat before and after are exclusive".into());
        }
        let id = super::session_key(meta);
        let slot = self.slot(&id)?;
        Ok(ReadPlan {
            home: self.home.clone(),
            id,
            meta: meta.clone(),
            path,
            slot,
            before,
            after,
        })
    }
    pub fn stop_plan(
        &mut self,
        meta: &Session,
        turn: String,
        text: String,
    ) -> Result<StopPlan, String> {
        let id = super::session_key(meta);
        let slot = self.slot(&id)?;
        Ok(StopPlan {
            home: self.home.clone(),
            id,
            slot,
            turn,
            text,
        })
    }
}
pub struct ReadPlan {
    home: PathBuf,
    id: String,
    pub(super) meta: Session, // v2-7: the Sessions search reads the same source
    pub(super) path: Option<PathBuf>,
    slot: Arc<Slot>,
    before: Option<u64>,
    after: Option<u64>,
}
impl ReadPlan {
    pub fn read(self) -> Result<Page, String> {
        self.read_live(None)
    }
    pub fn read_live(self, generation: Option<u64>) -> Result<Page, String> {
        let mut guard = self
            .slot
            .store
            .lock()
            .map_err(|_| "chat store unavailable")?;
        if guard.is_none() {
            *guard = Some(Store::open_with_stops(
                &self.home,
                &self.id,
                self.slot.stops.clone(),
            )?);
        }
        let chat = guard.as_mut().unwrap();
        // Ticket 212 (A5): why there is nothing to read, said by the chat module itself.
        let mut missing = None;
        if self.meta.kind != AgentKind::Shell {
            let mut source = self
                .slot
                .source
                .lock()
                .map_err(|_| "chat source unavailable")?;
            if let Some(path) = self.path {
                *source = Some(path);
            }
            if source.as_ref().is_some_and(|p| !p.exists()) {
                *source = None;
            }
            if source.is_none() {
                *source = transcript::locate(&self.meta);
            }
            if let Some(path) = source.as_ref() {
                match std::fs::symlink_metadata(path) {
                    Ok(_) => {
                        let path = transcript::validate_path(&self.meta, path)?;
                        // v1b-06: artifacts name this session's folder and data subfolder.
                        // v1b-07: the folder the core created at start; canonical like the path the agent got.
                        let artifacts = self
                            .home
                            .join("artifacts")
                            .join(self.meta.artifacts.as_deref().unwrap_or(&self.meta.id));
                        let artifacts = std::fs::canonicalize(&artifacts).unwrap_or(artifacts);
                        let ctx = super::artifacts::Context {
                            session: &self.meta.id,
                            folder: &self.meta.cwd,
                            artifacts: &artifacts,
                        };
                        chat.refresh_with(
                            self.meta.kind,
                            &path,
                            store::valid_id(&self.meta.id).then_some(&ctx),
                        )?;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        missing = Some("the agent has not written its transcript file yet")
                    }
                    Err(e) => return Err(e.to_string()),
                }
            } else {
                missing = Some(if self.meta.agent_session_id.is_none() {
                    "the agent has not reported its session id"
                } else {
                    "no transcript folder is known for this agent's account"
                });
            }
        }
        let after = if generation.is_some_and(|g| g != chat.generation()) {
            None
        } else {
            self.after
        };
        let mut page = match after {
            Some(after) => chat.since(
                self.meta.kind,
                self.meta.agent_version.as_deref(),
                TESTED_VERSIONS,
                after,
            ),
            None => chat.page(
                self.meta.kind,
                self.meta.agent_version.as_deref(),
                TESTED_VERSIONS,
                self.before,
            ),
        }?;
        page.no_transcript = missing.map(Into::into);
        Ok(page)
    }
}
pub struct StopPlan {
    home: PathBuf,
    id: String,
    slot: Arc<Slot>,
    turn: String,
    text: String,
}
impl StopPlan {
    /// At most one pending append per conversation; timeout never acknowledges undurable text.
    pub fn persist_bounded(self) -> Result<(), String> {
        let busy = Busy::claim(&self.slot.stops)?;
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        // Q9 zh-hans-J24-1: `busy` moves into the thread, so a panic there or a failed spawn (closure dropped) clears it.
        std::thread::Builder::new()
            .spawn(move || {
                let result = (|| {
                    let dir = self.home.join("chat");
                    store::private_dir(&dir)?;
                    let mut value = self
                        .slot
                        .stops
                        .value
                        .lock()
                        .map_err(|_| "Stop store unavailable")?;
                    if value.is_none() {
                        *value = Some(Stops::open(&dir, &self.id)?);
                    }
                    value.as_mut().unwrap().append(&self.turn, &self.text)
                })();
                drop(busy);
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_millis(750))
            .map_err(|_| "chat append exceeded hook wait".to_string())?
    }
}
/// The one pending append of a conversation; dropping it (also by unwinding) frees the slot.
struct Busy(Arc<StopSlot>);
impl Busy {
    fn claim(stops: &Arc<StopSlot>) -> Result<Self, String> {
        stops
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self(stops.clone()))
            .map_err(|_| "chat append already pending".into())
    }
}
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_panicking_append_frees_the_slot() {
        let stops = Arc::new(StopSlot::default());
        let busy = Busy::claim(&stops).unwrap();
        assert!(Busy::claim(&stops).is_err(), "one append at a time");
        let _ = std::thread::spawn(move || {
            let _held = busy;
            panic!("append failed");
        })
        .join();
        assert!(Busy::claim(&stops).is_ok());
    }
}
