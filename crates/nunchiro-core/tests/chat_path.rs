use nunchiro_core::{api::*, waiting::transcript::validate_path};
use std::{fs, path::PathBuf, process::Command};
#[test]
fn chat_codex_cannot_alias_another_rollout_through_a_symlink() {
    if let Some(root) = std::env::var_os("CHAT_PATH_ROOT") {
        let root = PathBuf::from(root);
        let s = Session {
            side_chat: false,
            stopped_sends: Vec::new(),
            send_waits: Default::default(),
            side_parent: None,
            teammate: None,
            resumed_from: vec![],
            owned_from: vec![],
            level: None,
            side_split: None,
            machine: None, // v1a-06: existing fixture is local.
            id: "session-1".into(),
            kind: AgentKind::Codex,
            project: root.clone(),
            cwd: root.clone(),
            label: String::new(),
            auto_label: false,
            closed_by_command: false,
            state: SessionState::Running,
            agent_session_id: Some("conversation-1".into()),
            agent_version: None,
            untested: true,
            pid: Some(1),
            completion_seq: 0,
            attention: Box::default(),
            pending: vec![],
            send_log: vec![],
            send_queue: vec![],
            model: None,
            effort: None,
            start_commit: None,
            artifacts: None,     // v1b-07
            blocked: None,       // v1a-33
            holder_status: None, // V2-1b
            config_dir: None,    // V2-2b
            account: None,       // V2-2b
            conversation: None,  // V2-3b
            acp_agent: None,     // V2-4a
            problem: None,       // V2-5b
            without_hooks: false,
            no_history: false,
            account_tab: false,
            home_lock: false,
            home_mode: None,
            permission_mode: None,
            starting: false,
            ran_mode: None,
            mode_state: None, // CHAT-MODELIST
            parent: None,
            schedule: None,
            token_origin: None,
            closed_at: None,
            ended_at: None,
            started_at: None,
            agent_ended: false,
            limit: None,
            folder_gone: false,
            ended_ask: None,
            modes: None,
        };
        let sessions = root.join("codex/sessions");
        fs::create_dir_all(&sessions).unwrap();
        let other = sessions.join("rollout-conversation-2.jsonl");
        fs::write(&other, "private other session\n").unwrap();
        let alias = sessions.join("rollout-conversation-1.jsonl");
        std::os::unix::fs::symlink(&other, &alias).unwrap();
        assert!(
            validate_path(&s, &alias).is_err(),
            "must not resolve a claimed identity to another rollout"
        );
        assert_eq!(
            fs::read_to_string(other).unwrap(),
            "private other session\n"
        );
        return;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .join(format!("r2-path-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "chat_codex_cannot_alias_another_rollout_through_a_symlink",
        ])
        .env("CHAT_PATH_ROOT", &root)
        .env("CODEX_HOME", root.join("codex"))
        .status()
        .unwrap();
    fs::remove_dir_all(root).unwrap();
    assert!(status.success());
}
