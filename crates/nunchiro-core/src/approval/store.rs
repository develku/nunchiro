//! `approvals.json` under NUNCHIRO_HOME: `{"version":1,"approvals":[{kind?,name,level,hash,granted_at_ms}]}`.
//! One entry per (subject kind, name); omitted kind is widget, explicit source is an integration source.
//! Atomic, 0600; a file that is invalid or newer is an error and is never rewritten. Unknown top-level
//! fields are kept (additive versions).
use super::{Level, SubjectKind, valid_name};
use crate::store::{READ_MAX, write_capped};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Approval {
    // v1b-17: legacy grants are widgets; preserve their serialization.
    #[serde(default, skip_serializing_if = "is_widget")]
    pub kind: SubjectKind,
    pub name: String,
    pub level: Level,
    pub hash: String,
    pub granted_at_ms: u64,
    /// A plugin's access when it was approved (`plugins::access`): a later change that asks for nothing beyond it
    /// stays approved. Empty for every other subject and for a grant older than this field.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub access: Vec<String>,
}

// v1b-17
fn is_widget(kind: &SubjectKind) -> bool {
    *kind == SubjectKind::Widget
}

#[derive(Serialize, Deserialize)]
pub struct Approvals {
    version: u32,
    approvals: Vec<Approval>,
    #[serde(flatten)]
    rest: serde_json::Map<String, serde_json::Value>,
}

pub fn load(home: &Path) -> Result<Approvals, String> {
    let bytes = match crate::store::read_regular(&home.join("approvals.json")) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Approvals {
                version: 1,
                approvals: vec![],
                rest: Default::default(),
            });
        }
        Err(e) => return Err(e.to_string()),
    };
    let invalid = |e: String| format!("invalid approvals store: {e}");
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
    if !value.is_object() {
        return Err(invalid("expected an object".into()));
    }
    let stored: Approvals = serde_json::from_value(value).map_err(|e| invalid(e.to_string()))?;
    if stored.version != 1 {
        return Err("unsupported approvals store version".into());
    }
    let mut names = HashSet::new();
    for a in &stored.approvals {
        let hex = a.hash.len() == 64 && a.hash.bytes().all(|c| c.is_ascii_hexdigit());
        if !valid_name(&a.name) || !names.insert((a.kind, &a.name)) || !hex {
            return Err("invalid approvals store relationship".into());
        }
    }
    Ok(stored)
}

impl Approvals {
    pub fn find(&self, kind: SubjectKind, name: &str) -> Option<&Approval> {
        self.approvals
            .iter()
            .find(|a| a.kind == kind && a.name == name)
    }
    pub fn set(&mut self, approval: Approval) {
        self.approvals
            .retain(|a| a.kind != approval.kind || a.name != approval.name);
        self.approvals.push(approval);
    }
    /// Forgets the grant of (`kind`, `name`), if there is one.
    pub fn remove(&mut self, kind: SubjectKind, name: &str) {
        self.approvals.retain(|a| a.kind != kind || a.name != name);
    }
    pub fn save(&self, home: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        write_capped(&home.join("approvals.json"), &bytes, READ_MAX)
    }
}
