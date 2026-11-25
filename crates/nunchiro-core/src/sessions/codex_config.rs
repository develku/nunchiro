//! Whether a Codex config holds only what Codex itself writes, so Nunchiro's hooks may be the only ones.
use super::*;
pub(super) fn codex_hooks_exclusive(cwd: &Path, project: &Path, config_dir: Option<&Path>) -> bool {
    #[cfg(test)]
    if let Some(answer) = IN_HOOKS_CHECK.take() {
        return answer(); // Q9 en-b-J7-2: a test answers without the owner's ~/.codex
    }
    // Require absence rather than interpret evolving Codex config/plugin schemas.
    let absent = |path: PathBuf| matches!(fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    let home = crate::accounts::config_home(AgentKind::Codex, config_dir); // v2-2b
    let Some(home) = home.filter(|home| home.is_absolute()) else {
        return false;
    };
    let clear = |dir: PathBuf| {
        absent(dir.join("hooks.json"))
            && absent(dir.join("plugins"))
            && (absent(dir.join("config.toml")) || codex_written_config(&dir.join("config.toml")))
    };
    clear(home)
        && [cwd, project]
            .iter()
            .all(|path| path.ancestors().all(|parent| clear(parent.join(".codex"))))
}
/// Ticket 690 r2: the `[tui]` and `[notice]` keys of Codex 0.161.0 (the `Tui` and `Notice` field lists in its binary); a
/// key a later Codex adds there withholds the hooks until it is checked and listed here.
const CODEX_TUI_KEYS: [&str; 27] = [
    "notifications",
    "notification_method",
    "notification_condition",
    "animations",
    "screen_reader_detection_done",
    "effects",
    "rendering",
    "show_tooltips",
    "show_server_version_notice",
    "auto_recap",
    "disable_paste_burst",
    "question_esc_back",
    "raw_output_mode",
    "fullscreen_transcript",
    "copy_on_select",
    "right_click_paste",
    "status_line",
    "status_line_use_colors",
    "terminal_title",
    "theme",
    "pet",
    "pet_anchor",
    "session_picker_view",
    "resume_cwd",
    "keymap",
    "model_availability_nux",
    "terminal_resize_reflow_max_rows",
];
const CODEX_NOTICE_KEYS: [&str; 8] = [
    "hide_full_access_warning",
    "hide_world_writable_warning",
    "fast_default_opt_out",
    "hide_rate_limit_model_nudge",
    "hide_gpt5_1_migration_prompt",
    "hide_gpt-5.1-codex-max_migration_prompt",
    "model_migrations",
    "external_config_migration_prompts",
];
/// Ticket 760 r2: every key path Codex 0.161's config schema (`codex-rs/core/config.schema.json` at `rust-v0.161.0`, the
/// `RawMcpServerConfig` and `ModelProviderInfo` field counts match the binary's) defines under the six usual keys. `*`
/// is a name the person picks (a server, a provider, a header), `[]` an entry of a list of tables. A path not listed
/// here, such as a field a later Codex adds, withholds the hooks until it is checked and listed.
const CODEX_USUAL_KEYS: [&str; 88] = [
    "approval_policy",
    "approval_policy.granular.mcp_elicitations",
    "approval_policy.granular.request_permissions",
    "approval_policy.granular.rules",
    "approval_policy.granular.sandbox_approval",
    "approval_policy.granular.skill_approval",
    "mcp_servers.*.args",
    "mcp_servers.*.auth",
    "mcp_servers.*.bearer_token_env_var",
    "mcp_servers.*.command",
    "mcp_servers.*.cwd",
    "mcp_servers.*.default_tools_approval_mode",
    "mcp_servers.*.disabled_tools",
    "mcp_servers.*.enabled",
    "mcp_servers.*.enabled_tools",
    "mcp_servers.*.env.*",
    "mcp_servers.*.env_http_headers.*",
    "mcp_servers.*.env_vars",
    "mcp_servers.*.env_vars.[]",
    "mcp_servers.*.env_vars.[].name",
    "mcp_servers.*.env_vars.[].source",
    "mcp_servers.*.environment_id",
    "mcp_servers.*.http_headers.*",
    "mcp_servers.*.http_headers_helper",
    "mcp_servers.*.name",
    "mcp_servers.*.oauth.authorization_server_issuer",
    "mcp_servers.*.oauth.callback_port",
    "mcp_servers.*.oauth.callback_url",
    "mcp_servers.*.oauth.client_id",
    "mcp_servers.*.oauth.client_secret",
    "mcp_servers.*.oauth_resource",
    "mcp_servers.*.omit_tools_from",
    "mcp_servers.*.required",
    "mcp_servers.*.scopes",
    "mcp_servers.*.startup_readiness",
    "mcp_servers.*.startup_timeout_ms",
    "mcp_servers.*.startup_timeout_sec",
    "mcp_servers.*.supports_parallel_tool_calls",
    "mcp_servers.*.tool_input_schema_max_bytes",
    "mcp_servers.*.tool_timeout_sec",
    "mcp_servers.*.tools.*.approval_mode",
    "mcp_servers.*.tools.*.output_token_limit",
    "mcp_servers.*.url",
    "model_provider",
    "model_providers.*.auth.args",
    "model_providers.*.auth.command",
    "model_providers.*.auth.cwd",
    "model_providers.*.auth.refresh_interval_ms",
    "model_providers.*.auth.timeout_ms",
    "model_providers.*.aws.auth_refresh.args",
    "model_providers.*.aws.auth_refresh.command",
    "model_providers.*.aws.auth_refresh.timeout_ms",
    "model_providers.*.aws.credential_export.args",
    "model_providers.*.aws.credential_export.command",
    "model_providers.*.aws.credential_export.timeout_ms",
    "model_providers.*.aws.profile",
    "model_providers.*.aws.region",
    "model_providers.*.base_url",
    "model_providers.*.env_http_headers.*",
    "model_providers.*.env_key",
    "model_providers.*.env_key_instructions",
    "model_providers.*.experimental_bearer_token",
    "model_providers.*.gateway_oauth.authorization_url",
    "model_providers.*.gateway_oauth.client_id",
    "model_providers.*.gateway_oauth.delivery.kind",
    "model_providers.*.gateway_oauth.delivery.name",
    "model_providers.*.gateway_oauth.delivery.scheme",
    "model_providers.*.gateway_oauth.redirect_port",
    "model_providers.*.gateway_oauth.resource",
    "model_providers.*.gateway_oauth.scopes",
    "model_providers.*.gateway_oauth.token_url",
    "model_providers.*.http_headers.*",
    "model_providers.*.model_catalog_url",
    "model_providers.*.name",
    "model_providers.*.query_params.*",
    "model_providers.*.request_max_retries",
    "model_providers.*.requires_openai_auth",
    "model_providers.*.stream_idle_timeout_ms",
    "model_providers.*.stream_max_retries",
    "model_providers.*.supports_standalone_web_search",
    "model_providers.*.supports_websockets",
    "model_providers.*.websocket_connect_timeout_ms",
    "model_providers.*.wire_api",
    "sandbox_mode",
    "sandbox_workspace_write.exclude_slash_tmp",
    "sandbox_workspace_write.exclude_tmpdir_env_var",
    "sandbox_workspace_write.network_access",
    "sandbox_workspace_write.writable_roots",
];
/// Ticket 760 r2: `value` at `path` holds only key paths listed in `CODEX_USUAL_KEYS`; an empty table or list counts as
/// its key too, so even an empty unknown one withholds.
fn usual_keys(path: &[&str], value: &toml::Value) -> bool {
    let listed = |leaf: bool| {
        CODEX_USUAL_KEYS.iter().any(|known| {
            let n = known.split('.').count();
            (if leaf {
                n == path.len()
            } else {
                n > path.len()
            }) && known.split('.').zip(path).all(|(k, p)| k == "*" || k == *p)
        })
    };
    let deeper = |key: &str, value: &toml::Value| {
        let mut next = path.to_vec();
        next.push(key);
        usual_keys(&next, value)
    };
    match value {
        toml::Value::Table(table) => {
            listed(false) && table.iter().all(|(key, value)| deeper(key, value))
        }
        toml::Value::Array(items) => {
            listed(true)
                && items
                    .iter()
                    .all(|item| !item.is_table() || deeper("[]", item))
        }
        _ => listed(true),
    }
}
fn sub_keys(value: &toml::Value, known: &[&str]) -> bool {
    value
        .as_table()
        .is_some_and(|table| table.keys().all(|key| known.contains(&key.as_str())))
}
/// Ticket 690: Codex writes `config.toml` itself at the first folder trust (`[projects."<dir>"] trust_level`) and for
/// its screens (`[tui]`, `[notice]`), and keeps a `/model` choice there. A regular file of at most 1 MiB that holds only
/// those keys (and, under `[tui]` and `[notice]`, only the 0.161 keys) cannot add a hook, so it does not withhold
/// Nunchiro's; any other key (`hooks`, `plugins`, `profile`, `features` and every key a later Codex adds) still does.
/// Ticket 760: nor do the keys a person's own file usually holds, `mcp_servers`, `model_provider`, `model_providers`,
/// `approval_policy`, `sandbox_mode` and `sandbox_workspace_write`: in Codex 0.161 hooks come only from `hooks` (its
/// events and `hooks.state` trust), `hooks.json` and plugins, and none of these six fields' types (`McpServerConfig`,
/// `ModelProviderInfo`, `SandboxWorkspaceWrite`, two enums) holds a hook, so Codex reads no hook under them whatever
/// they hold. Ticket 760 r2: only with the key paths 0.161 defines under them (`CODEX_USUAL_KEYS`), so a hook field a
/// later Codex adds there cannot pass unread.
fn codex_written_config(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > 1 << 20 {
        return false;
    }
    let Some(table) = fs::read_to_string(path)
        .ok()
        .and_then(|text| text.parse::<toml::Table>().ok())
    else {
        return false;
    };
    table.iter().all(|(key, value)| match key.as_str() {
        "projects" => value.as_table().is_some_and(|projects| {
            projects.values().all(|project| {
                project.as_table().is_some_and(|keys| {
                    keys.iter()
                        .all(|(key, value)| key == "trust_level" && value.is_str())
                })
            })
        }),
        "tui" => sub_keys(value, &CODEX_TUI_KEYS),
        "notice" => sub_keys(value, &CODEX_NOTICE_KEYS),
        "model" | "model_reasoning_effort" => value.is_str(),
        "mcp_servers"
        | "model_provider"
        | "model_providers"
        | "approval_policy"
        | "sandbox_mode"
        | "sandbox_workspace_write" => usual_keys(&[key.as_str()], value),
        _ => false,
    })
}
