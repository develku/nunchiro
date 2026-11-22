# Threat model: v2.5 agent browser and web access (V2.5-19)

Owner 2026-10-31: threat-model the whole evening-goal spec before the browser build. Tier: strict.
Inputs (read at main b4058c8d): ADR 0001, needs 13, 80, 82, 139, 141,
browser findings (base B: WKWebView child webview, jev-style table, WP1-WP5), the
web-access design note `docs/design/v25-web-access.md` (branch `herdr/v25-web-access-design` at 4fc4ba21, not yet on
main), `crates/nunchiro-core/src/http/mod.rs` (window gates), `server.rs` and `peer.rs` (owner socket, audit-token peer
check), `grants.rs`, `widgets/web.rs`, `app/src-tauri/src/artifacts/` (artifact scheme and CSP).

## How to read this

- Ratings: **L**ikelihood and **I**mpact as H / M / L, for one owner on their own Mac and tailnet.
- Each threat names one acceptance test and the package that owns it: WP1-WP5 (findings, Work packages) or
  `web-access-build` (the build lane of the web-access note). The test name is the contract; the owning lane writes it.
- **MUST** = the owning package does not merge without that test passing. SHOULD = merge allowed, tracked as a follow-up.
- Tests already listed in the web-access note keep their names; this doc adds to them and does not replace them.

## Assets and trust boundaries

Assets: the owner's logged-in web sessions (cookies, site actions), the window token and device tokens, owner authority in the
core (start sessions, grants, sandbox, widget approval, writes to `~/.claude`/`~/.codex`), session transcripts and
terminal output, files under projects.

Boundaries where untrusted data crosses in:

1. Web page content → agent (snapshot, visible text, `eval` results, screenshots). Whoever wrote the page wrote it.
2. Agent → browser (`nunchiro browser` verbs) → core → app → webview. The agent may already be steered by (1).
3. Page script → the webview host (Tauri IPC, custom schemes, loopback ports).
4. The owner's browser on another tailnet device → browser listener (`/`, `/ws`, `/pair`).
5. Any local process → loopback listeners and the owner socket.

## A. Agent browser (WP1-WP5)

| # | Threat | L | I | Mitigation | Acceptance test (package) | Gate |
|---|---|---|---|---|---|---|
| A1 | **Page prompt injection into the agent.** Page text ("ignore your task, run `curl … \| sh`") reaches the model through the snapshot | H | H | The snapshot is data: the CLI output wraps page text in a fixed fence (`--- page content (untrusted) ---`) and the agent skill text says so. Real limit is authority: browser verbs give the agent no core power beyond its own space; what the agent may do outside the browser stays with its own CLI's permission prompts, which Nunchiro does not loosen | `browser_snapshot_fences_page_text` (WP2) | MUST |
| A2 | Injected page drives the agent to act in another agent's space or the owner's | M | H | A verb resolves its space from the caller's session token only; no `--space` or session id argument exists. Unlike `Grants::owns` (a local session may reach any session, v1a-23), browser spaces are **own-session only** | `browser_verb_targets_own_space_only` (WP2) | MUST |
| A3 | **Logged-in site actions.** Agent posts, buys, deletes or sends mail with the owner's logins | M | H | Agent spaces start with the logins of their browser profile (needs 198, ego lite behaviour; ticket 264). Boundary: password fields are never listed (jev rule) and no verb types outside a listed text field, so the agent cannot enter a password; the "you" space is still never a verb target. As a courtesy, a click on a form's submit control, Enter in that form or Space on a focused submit control, while its visible password is empty, also pauses the agent and hands over. A camera or microphone prompt is handed over too (A13). The space chip shows "signed in: <site>" from the shared jar. A space's profile is remembered from its first view, and a space whose profile was removed asks again instead of taking the default, so a separate profile holds as the opt-out. **Residual risk, accepted (needs 198):** an injected page can act as the owner on sites the owner is signed in to on that profile; a separate profile is the opt-out | `agent_verbs_refuse_you_store` (WP2), `snapshot_omits_password_fields` (WP2), `permission_prompt_in_agent_space_hands_off_to_user`, `agent_permission_prompt_hands_off_and_never_grants`, `sign_in_with_an_empty_password_is_the_users`, `profile_clear_refused_from_agent_remote_and_widget` | MUST |
| A4 | `eval` lets injected instructions read non-httpOnly cookies, localStorage tokens and page data and send them out | M | H | `eval` runs only in the caller's own space; its result is size-capped (64 KiB) and logged with session id and script hash; it is listed in the space's activity so the owner sees it. Whether `eval` ships in WP2 at all is owner question Q1 | `browser_eval_logged_and_capped` (WP2) | MUST if `eval` ships |
| A5 | **Control channel exposure.** Another process drives a space, or a CDP/debug port appears | L | H | No TCP listener and no web inspector for agent webviews (`isInspectable = false` in release); verbs travel the owner socket (peer audit-token check, unchanged) and the existing app-core link; the CLI carries the session token only | `browser_adds_no_listen_port` (WP2: listener set before and after opening 3 spaces is equal), `agent_view_not_inspectable_in_release` (WP1) | MUST |
| A6 | A verb from a token-less process (no session) controls a space | L | M | Verbs without a session token are refused; the owner's own control is the window UI, not the CLI | `browser_verb_without_session_refused` (WP2) | MUST |
| A7 | **Per-profile data isolation.** Cookies, cache, IndexedDB, service workers leak between browser profiles | M | H | One persistent data store per profile identifier (macOS 14+); isolation is per profile, not per space: spaces on different profiles share nothing, spaces on one profile share cookies by design (needs 198). On older macOS the browser refuses to open rather than share the default store. Forget closes a space's views and leaves the shared store; a whole-profile clear is a window-only command behind an approval sheet. A profile id is validated `^[a-z0-9-]{1,32}$`; a remembered pick naming an unknown profile refuses and asks again, never the default. In debug builds with `NUNCHIRO_HOME` set, every store identifier, the built-in one included, is salted with it, so a harness never reaches the installed app's stores | `profiles_do_not_share_cookies` (selftest: cookie set on profile A is absent on B), `spaces_on_default_profile_share_cookies` (selftest), `space_forget_keeps_shared_profile_data` (selftest), `space_store_id_derives_from_profile`, `profile_clear_needs_window_approval_click`, `browser_refuses_without_store_identifier` (WP1) | MUST (first two), SHOULD (rest) |
| A8 | **Page reaches Tauri IPC or the artifact scheme.** A site in the agent webview calls `invoke`, the `nunchiro-artifact` scheme, or app commands | M | H | The browser child webview gets no Tauri capability (capability files list window labels; browser labels are in none), no `__TAURI__` injection, and no custom scheme handler; navigation to `tauri:`, `nunchiro-artifact:`, `file:` is refused | `agent_view_has_no_ipc` (WP1: page script sees no `__TAURI__`/`__TAURI_INTERNALS__`, `invoke` fails), `agent_view_refuses_app_schemes` (WP1) | MUST |
| A9 | **Page reaches the core over loopback/tailnet.** A site fetches `127.0.0.1:<window port>` or the browser listener `:7788` | M | H | Window listener: exact Host + Origin allowlist (unchanged; a site origin fails). Browser listener: Origin must equal `http://<Host>`, so a site cannot; but an agent can **navigate** its own view to `http://127.0.0.1:7788` and start a pairing that the owner may approve by habit. The agent view refuses navigation to the core's own listener ports on loopback and Tailscale addresses | `agent_view_refuses_core_ports` (WP1), and pairing sheet shows the requesting peer (W6) | MUST |
| A10 | **Snapshot tampering.** Page script overrides DOM functions so the injected snapshot lies (hides a "Delete" button label, fakes text) | M | M | Snapshot and action scripts run in an isolated `WKContentWorld`, not the page world; clicks go through native events at element coordinates the snapshot computed | `snapshot_runs_in_isolated_world` (WP2: page that redefines `Element.prototype.getBoundingClientRect` and `innerText` does not change the table) | MUST |
| A11 | **Takeover spoofing.** The agent (or page) fakes "user in control" or "hand back", or the owner's input interleaves with the agent's | L | M | Control flips only on native events the app did not synthesize (tracked by the app's own event tag); "Hand back" is app chrome, not page content, and no verb presses it; one serial queue per space (ticket 998 L10, B9: the core hands out a space's next job only after the app answered its last, and each space has its own worker, so spaces run side by side but one space's actions never interleave); agent actions queued during takeover are dropped | `agent_input_does_not_flip_control`, `user_input_pauses_agent`, `queued_actions_dropped_on_takeover` (WP3), `spaces_run_side_by_side_one_job_each` (998 L10) | MUST |
| A12 | **Annotation input.** Page-controlled element text and attributes go into the composer and from there into a prompt (prompt injection by the owner's own hand) | M | M | The annotation block quotes page text in a fenced, length-capped field (500 chars per element) with the selector and URL; it fills the composer and is **never auto-sent**; no HTML is rendered from it | `annotation_never_auto_sends`, `annotation_quotes_and_caps_page_text` (WP4) | MUST |
| A13 | Downloads, file pickers, camera, mic, location, notifications, pop-ups from a site in the agent view | M | M | Deny by default in the WKWebView delegates, except that the first camera or microphone request of a page load in an agent space pauses the agent and hands over (A3): no site-list row applies, no agent verb answers it, and further requests before a navigation are denied without a handoff. This claims no working prompt: Info.plist has no usage strings, so nothing is granted today; ticket 351 owns them (owner 11-09: off by default, the user can turn them on in Settings); pop-ups open as a new tab in the same space or are refused; downloads refused in the first cut | `agent_view_denies_media_downloads_popups` (WP1) | SHOULD |
| A14 | Secrets copied into transcripts: snapshots, visible text and screenshots of logged-in pages land in agent transcripts (and in a cloud model's context) | H | M | Password fields omitted (A3); viewport-only default limits how much is read; screenshots are a separate verb the agent must call. Remaining exposure is inherent to letting a cloud agent read a page; stated, not mitigated | `snapshot_viewport_only_by_default` (WP2) | SHOULD |
| A15 | Resource exhaustion: an agent opens many spaces or tabs and takes the Mac's memory (the mini also runs live trading) | M | M | Cap spaces per session (2) and tabs per space (8); idle space suspended after 10 min | `browser_space_and_tab_caps` (WP2) | SHOULD |
| A16 | WP5 measure runs touch the owner's real logged-in sites | L | M | Measure scripts run against the local fixture and public pages by default; the owner's sites only with an explicit flag and in a dedicated space | `measure_defaults_to_fixture` (WP5) | SHOULD |
| A17 | Lifted code (Orca, jev-ultrafast, ego SDK) carries hidden behaviour or a licence problem (needs 141) | L | M | MIT only, LICENSE re-checked at the copied commit, upstream file named in header and NOTICES; lifted JS reviewed line by line for network calls | `notices_list_lifted_browser_code` (WP2, WP4: each lifted file's header names upstream, NOTICES has the line) | MUST |
| A18 | **App origin in the agent view receives the window token.** The builder's page-load handler runs for every webview, the agent view's included, and trusted any page at `http://tauri.localhost` (no port) or the dev-load origin. An agent with a listener on loopback :80 (`nunchiro browser goto`) or a site (link, 302, page script) sends the view there and the page reads `window.__NUNCHIRO__`: owner authority over the core (audit S1, ticket 189) | M | H | Two layers, each enough alone: the boot script goes only to the `main` label (`gets_boot`, `main.rs`); `view::allow` refuses `tauri.localhost` and `nunchiro-artifact.localhost` at any port, in any case and with a trailing dot, and in dev-load builds the dev server origin, with the A9 refusal path | `boot_only_for_main_label`, `agent_view_refuses_own_origins`, `agent_view_refuses_dev_origin` (unit); `agent_view_never_receives_window_token`, `agent_view_token_absent_everywhere`, `own_origin_http_tauri_localhost_false_on_macos`, `main_window_still_trusts_tauri_scheme` (unit, the `http` arm is Windows-only), `main_window_still_boots` (`scripts/browser-selftest.py`; V2.5-41) | MUST |

A15 follow-up (WP2 built 2026-10-31): one space per session, 8 tabs per space, 4 verbs in flight per space and 8 in total (`browser_global_pending_cap`); the cap of 2 spaces per session and the 10-minute idle suspend are not built yet.

## B. Web access (`web-access-build`)

The web-access note's T1-T12 and its section 7 tests stand. This section adds what that note does not cover and marks gates.

| # | Threat | L | I | Mitigation | Acceptance test | Gate |
|---|---|---|---|---|---|---|
| W1 | **Token theft via XSS.** The device token sits in `localStorage`; any script on that origin reads it | M | H | Strict CSP on every response (`default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`), no inline script, no third-party origin; artifacts and web widgets are **not** served on this origin (they stay on `nunchiro-artifact`); agent-written Markdown and terminal text render through the same escaping as the window (no `dangerouslySetInnerHTML` on agent text) | `browser_responses_carry_csp` (every path incl. 404), `browser_bundle_has_no_inline_script` (build check), `browser_origin_serves_no_artifacts` | MUST |
| W2 | Token theft from another origin on the same host: a page on `http://100.x:<other port>` shares nothing (origins include the port), but a page on the **same** origin would. Nothing else may be served on `<addr>:7788` | L | H | The listener serves only the embedded bundle (no file paths, no user content) | `browser_serves_only_embedded_assets` (traversal, `%2e%2e`, unknown path → 404) | MUST |
| W3 | **DNS rebinding / Host + Origin.** Rebinding name, other port, `null` origin, the window's `tauri://localhost` | M | H | Exact Host to bound IP literal or `localhost` on loopback; Origin = `http://<Host>` exactly | note's `browser_refuses_wrong_host`, `browser_refuses_foreign_origin` | MUST |
| W4 | **`tailscale serve` / Funnel or a local reverse proxy** in front of the port: the proxy connects from 127.0.0.1, so the peer check passes, and Funnel makes it public | L | H | The Host check refuses `*.ts.net` and any name but `localhost` (so a proxied request is 403); Settings warns if `tailscale serve status` is not checked (first cut: documented, not detected) | `browser_refuses_tsnet_host_on_loopback` | MUST |
| W5 | **Tailscale-only bind.** Binds `0.0.0.0`, a LAN IP, or another VPN's CGNAT address | M | H | Per-address bind from `getifaddrs`, ranges `100.64.0.0/10` and `fd7a:115c:a1e0::/48`; peer re-check after accept; another `utun` VPN in CGNAT is covered by pairing (note T6) | note's `browser_binds_loopback_and_tailscale_only`, `browser_refuses_peer_outside_ranges` | MUST |
| W6 | **Pairing phishing.** Another tailnet device (or an agent's own browser view, A9) starts a pairing while the owner expects one | M | H | Code match on the Mac sheet; sheet shows peer IP and "this Mac (loopback)" plainly; a loopback pairing is labelled "from this Mac: could be an agent"; no auto-approve | note's `pair_needs_mac_approval`, plus `pair_sheet_labels_loopback_peer` | MUST |
| W7 | **http vs ts.net https, insecure-context limits.** `http://100.x:7788` is not a secure context: `crypto.subtle`, `crypto.randomUUID`, Clipboard write, service workers, Notifications, `navigator.share` are missing; tests on `localhost` (a secure context) would not catch it | H | M | The browser-role bundle uses only APIs available in insecure contexts (feature-checked, no crash); copy buttons fall back to `execCommand('copy')` or hide. HTTPS via `tailscale cert` stays out of the first cut (note section 9). Plain HTTP over Tailscale is encrypted by WireGuard, so the gap is browser features, not sniffing (T11) | `browser-insecure-context-loads` (Playwright on `http://127.0.0.2:<port>` or a non-localhost alias: page renders, pairs, answers; no console error) | MUST |
| W8 | **Browser role escalation.** A browser connection reaches owner-only requests | M | H | Deny-by-default allowlist before dispatch, new variant fails until classified | note's `browser_role_allowlist_table` | MUST |
| W9 | `SendText` from a lost or stolen phone gives a typed prompt to an agent that runs with the owner's tools; effectively owner-level reach | M | H | Per-device revoke, every action noticed on the Mac (note T5, needs 80); `SendText` itself is owner question Q2 of the note (not reopened here); `SendText` passes control bytes (Ctrl-C, a lone Esc) to the session, the same as the window's, and each one is noticed on the Mac; any ESC sequence is refused at the browser gate, since Shift+Tab is one and can reach Bypass permissions (ticket 362) | note's `browser_answer_noticed_on_mac`, `revoke_closes_live_connection` | MUST |
| W10 | Terminal output and chat pages shown to a device contain secrets | M | M | Only paired devices; `Read`/watch stays in the allowlist by the owner's option A; stated, not mitigated | none (accepted risk) | n/a |
| W11 | Window token leaks to the browser path | L | H | Separate listener and token store; window token never sent or accepted | note's `browser_refuses_window_token`, `window_gates_unchanged` | MUST |
| W12 | Device store read from disk | L | M | `sha256(token)` only, 0600, atomic write | note's `device_store_holds_hash_only_0600` | MUST |
| W13 | Pairing flood, connection flood starving the Mac window | M | L | 3 pending, 5 min, 10 failures/IP/hour; own authed cap (8) | note's `pair_limits_pending_and_failures`, plus `browser_cap_does_not_starve_window` | SHOULD |

## C. Core and app boundaries touched by both

| # | Threat | L | I | Mitigation | Acceptance test (package) | Gate |
|---|---|---|---|---|---|---|
| C1 | **Owner socket.** New browser verbs or pairing requests weaken the peer check (uid + audit token, `peer.rs`) or add a token-less path | L | H | New requests go through the existing `Caller` resolution; pairing answers, device list and revoke are window-only (`WindowAuth` path); no new socket | `pair_answer_window_only` (web-access-build), `browser_verbs_use_session_caller` (WP2) | MUST |
| C2 | **Grants.** A browser verb or browser-role frame widens a grant (approval level, artifact network grant, board source, ACP agent) | L | H | Neither path has a grant request in its allowlist; grant requests stay window/token-less-CLI only as today | covered by `browser_role_allowlist_table` (web-access-build) and `browser_verbs_cannot_grant` (WP2) | MUST |
| C3 | **Widget boundary.** Web widgets or artifacts end up served on the browser-listener origin or in an agent webview, where they would share the token origin or reach a live site's cookies | L | H | Artifacts and widgets stay on `nunchiro-artifact` with their CSP (`connect-src 'none'` by default) inside the app; the browser listener shows "open on the Mac"; the agent view refuses the scheme (A8) | `browser_origin_serves_no_artifacts` (web-access-build), `agent_view_refuses_app_schemes` (WP1) | MUST |
| C4 | **App-core link.** The new browser forward messages let the core (or a session through it) make the app do something outside the browser (open a window, run a command) | L | H | One typed message set for browser verbs; the app's handler matches on those variants only and on a space it already created. Ticket 998 L9 (B8): an element number acts only on the element it was given to (a per-document id, never given twice in a space, checked in the page in the same call as the action); a stale or other-page number is refused with `ref_stale` / `page_moved` before any input, so a renumbered page never turns a verb onto another element | `app_browser_link_typed_variants_only` (WP2), `numbers_belong_to_the_page_they_came_from` and live `stable_ref_hits_same_element_or_is_refused` (998 L9) | MUST |
| C5 | **Agent config writes.** WP2 installs a `nunchiro browser` skill or instructions into `~/.claude` / `~/.codex` | M | M | Any such write is strict-layer: owner-visible, opt-in, reversible, and reviewed as such | `browser_skill_install_opt_in` (WP2, only if it writes agent config) | MUST if written |
| C6 | Core logs carry tokens or page content | L | M | Device id and session id only; no token, no snapshot text in logs | `browser_logs_carry_no_token` (web-access-build), `browser_logs_carry_no_page_text` (WP2) | SHOULD |

## MUST list by package

- **WP1** (store tests replaced by ticket 264): `profiles_do_not_share_cookies`, `agent_view_not_inspectable_in_release`,
  `spaces_on_default_profile_share_cookies`, `agent_view_has_no_ipc`, `agent_view_refuses_app_schemes`, `agent_view_refuses_core_ports`.
- **WP2**: `browser_snapshot_fences_page_text`, `browser_verb_targets_own_space_only`, `agent_verbs_refuse_you_store`,
  `snapshot_omits_password_fields`, `browser_eval_logged_and_capped` (if `eval` ships), `browser_adds_no_listen_port`,
  `browser_verb_without_session_refused`, `snapshot_runs_in_isolated_world`, `browser_verbs_use_session_caller`,
  `browser_verbs_cannot_grant`, `app_browser_link_typed_variants_only`, `notices_list_lifted_browser_code`,
  `browser_skill_install_opt_in` (if it writes agent config).
- **WP3**: `agent_input_does_not_flip_control`, `user_input_pauses_agent`, `queued_actions_dropped_on_takeover`.
- **WP4**: `annotation_never_auto_sends`, `annotation_quotes_and_caps_page_text`, `notices_list_lifted_browser_code`.
- **WP5**: none MUST.
- **web-access-build**: every MUST in section B, plus `pair_answer_window_only`, `browser_origin_serves_no_artifacts`,
  `pair_sheet_labels_loopback_peer`, `browser-insecure-context-loads`, `browser_refuses_tsnet_host_on_loopback`,
  `browser_responses_carry_csp`, `browser_bundle_has_no_inline_script`, `browser_serves_only_embedded_assets`.

A WP2 or web-access-build merge also needs the strict-layer security review (AGENTS.md); these tests are its floor, not
a replacement.

## What this does not cover

- Safety of the agent's own actions outside the browser (shell, file edits): that is the agent CLI's permission model
  and Nunchiro's queue, unchanged here.
- Model-level defences against prompt injection: none is claimed. The mitigation is authority limits, not detection.
- A malicious process running as the owner's own user: it can already read the core's memory, files and Keychain items the owner
  unlocked; loopback and socket checks do not stop it.
- The owner token's scope for browser jobs: a detached process of the same user outside every session that reads `core.token` is the owner, so it can call `browser_next` / `browser_done` and take or answer any space's jobs (the peer check refuses this only from inside a session).
- Tailscale itself (tailnet ACLs, node keys, a compromised coordination server), WebKit engine bugs, and macOS
  sandbox escapes.
- A Chromium sidecar (engine 2): it adds CDP, a debug port and its own profile; it needs its own threat model if WP5
  calls for it.
- v3 phone tiers (start, create, Face ID), a native phone app, iroh transport, HTTPS via `tailscale cert`.
- Remote machines' cores and forwarded sessions (V1A-06) driving browsers on another Mac.
- The site-side consequences of automation (terms of service, bot detection).

## Owner answers

- 2026-10-31 the owner ("추천으로"): Q1 no `eval` in WP2; add later behind the space activity log. Q2 an agent drives only its own space.
- 2026-11-09 the owner (ticket 362): sessions the owner starts run with full access by default. Full access is same-user trust: an agent under it can edit Nunchiro's own settings file, and no file guard is claimed.
