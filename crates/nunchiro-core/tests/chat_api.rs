use nunchiro_core::api::*;
#[test]
fn chat_request_and_reply_are_serde_compatible() {
    let request: Request = serde_json::from_str(r#"{"op":"chat_page","id":"session-1"}"#).unwrap();
    assert!(matches!(
        request,
        Request::ChatPage {
            before: None,
            after: None,
            ..
        }
    ));
}

// Ticket 212 (A5, chat half): a session with no readable transcript says why in the chat page itself, from `chat/*`;
// `sessions.rs` only forwards the page. A page of a transcript that exists carries no reason, and the key is absent.
mod no_transcript {
    use nunchiro_core::{
        api::*,
        chat::{Cache, TESTED_VERSIONS},
    };
    use std::{fs, path::PathBuf};

    fn session(home: &std::path::Path, agent_session_id: Option<&str>) -> Session {
        Session {
            side_chat: false,
            stopped_sends: Vec::new(),
            send_waits: Default::default(),
            side_parent: None,
            teammate: None,
            resumed_from: vec![],
            owned_from: vec![],
            level: None,
            side_split: None,
            machine: None,
            id: "session-1".into(),
            kind: AgentKind::Claude,
            project: home.into(),
            cwd: home.into(),
            label: String::new(),
            auto_label: false,
            closed_by_command: false,
            state: SessionState::Running,
            agent_session_id: agent_session_id.map(Into::into),
            agent_version: Some(TESTED_VERSIONS[0].1.into()),
            untested: false,
            pid: Some(1),
            completion_seq: 0,
            attention: Box::default(),
            pending: vec![],
            send_log: vec![],
            send_queue: vec![],
            model: None,
            effort: None,
            start_commit: None,
            artifacts: None,
            blocked: None,
            holder_status: None,
            config_dir: Some(home.join("agent")),
            account: None,
            conversation: None,
            acp_agent: None,
            problem: None,
            without_hooks: false,
            no_history: false,
            account_tab: false,
            home_lock: false,
            home_mode: None,
            permission_mode: None,
            starting: false,
            at_box: false,
            draft_home: None,
            take_back: false,
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
        }
    }
    fn home(tag: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .join(format!("chat-api-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn chat_no_transcript_reason_comes_from_chat_module() {
        let home = home("reason");
        let mut cache = Cache::new(&home);
        // The agent has not reported a session id: nothing to look for.
        let s = session(&home, None);
        let page = cache
            .plan_source(&s, None, None, None)
            .unwrap()
            .read()
            .unwrap();
        assert!(page.events.is_empty());
        assert_eq!(
            page.no_transcript.as_deref(),
            Some("the agent has not reported its session id")
        );
        // A session id, but no file at the agent's transcript path.
        let s = session(&home, Some("missing-1"));
        let page = cache
            .plan_source(&s, None, None, None)
            .unwrap()
            .read()
            .unwrap();
        assert_eq!(
            page.no_transcript.as_deref(),
            Some("the agent has not written its transcript file yet")
        );
        let wire = serde_json::to_value(&page).unwrap();
        assert_eq!(
            wire["no_transcript"],
            "the agent has not written its transcript file yet"
        );
        // The file appears: the reason goes.
        let s = session(&home, Some("there-1"));
        let dir = home.join("agent/projects").join(
            home.to_string_lossy()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect::<String>(),
        );
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("there-1.jsonl"),
            "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n",
        )
        .unwrap();
        let page = cache
            .plan_source(&s, None, None, None)
            .unwrap()
            .read()
            .unwrap();
        assert!(!page.events.is_empty());
        assert_eq!(page.no_transcript, None);
        assert!(
            serde_json::to_value(&page)
                .unwrap()
                .get("no_transcript")
                .is_none()
        );
        fs::remove_dir_all(home).unwrap();
    }
}
