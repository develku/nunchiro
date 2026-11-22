# Reuse ledger

Every file that carries code, data or markup lifted or adapted from another project, with the upstream repo, path and
commit. Rule (needs 141): only MIT code is copied; Apache-2.0 sources give concepts only (`Kind` = `idea`); AGPL, GPL,
Elastic and unclear-licence sources give ideas only, and an `idea` row names no local file that holds their code.
CC0 material may be copied too (owner approval 2026-11-10); each use still gets a row with its source, licence and what was
taken, though CC0 asks for no `NOTICES` line.
`scripts/check-reuse-ledger.sh` fails when a file carries an upstream header this table lacks, when a `code` row names a
source that is neither MIT nor CC0, when a listed path is missing, or when a non-CC0 `code` row's source has no line in
`NOTICES`.

Columns: `Kind` is `code` (copied or adapted into the local file) or `idea` (read, not copied). `Licence at commit` is the
licence recorded in `THIRD_PARTY_NOTICES.md` for the pinned commit, copied from there (not re-fetched when this ledger was
written). Shipped bundle notices stay in `THIRD_PARTY_NOTICES.md` and `licenses/`.

| Local path | Kind | Upstream repo | Upstream path | Commit | Licence at commit |
|---|---|---|---|---|---|
| `crates/nunchiro-core/src/pty.rs` | code | Zeron | `crates/engine/src/terminals.rs` | `4231cb7b017d95e45f676fa80539fba30a1e75e5` | MIT |
| `crates/nunchiro-core/src/holder/local.rs` | code | Zeron | `crates/engine/src/terminals.rs` | `4231cb7b017d95e45f676fa80539fba30a1e75e5` | MIT |
| `crates/nunchiro-core/src/http/mod.rs` | code | Zeron | `crates/rpc/src/server.rs`, `ws.rs` | `4231cb7b017d95e45f676fa80539fba30a1e75e5` | MIT |
| `crates/nunchiro-core/src/server.rs` | idea | Zeron | `crates/rpc/src/server.rs`, `ws.rs` | `4231cb7b017d95e45f676fa80539fba30a1e75e5` | MIT |
| `crates/nunchiro-core/src/queue/mod.rs` | code | Synara | `packages/shared/src/kanban.ts` | `29b11e1` | MIT |
| `crates/nunchiro-core/src/usage.rs` | code | Orca | `src/main/claude-usage/*` | `2eb0bb63` | MIT |
| `crates/nunchiro-core/src/account_signin.rs` | code | Orca | `src/main/claude-accounts/{claude-sign-in-browser,claude-pasted-code-login,claude-login-session}.ts`, `src/main/codex-accounts/codex-login-auth-url.ts` | `0cee6cbd` | MIT |
| `web/src/tree/ProjectTools.tsx` | code | Orca | `src/renderer/src/components/sidebar/AddRepoCloneStep.tsx` | `2eb0bb63` | MIT |
| `web/src/tree/ProjectTools.tsx` | idea | T3 Code | `apps/web/src/components/ProjectCloneToastCoordinator.tsx` | `d14ace8` | MIT |
| `crates/nunchiro-core/src/projects/clone.rs` | idea | Orca | `src/main/git/repo-clone-path.ts`, `src/main/ipc/repos/repo-clone-lifecycle.ts` | `2eb0bb63` | MIT |
| `crates/nunchiro-core/src/projects/clone.rs` | idea | T3 Code | `apps/server/src/sourceControl/SourceControlRepositoryService.ts` | `d14ace8` | MIT |
| `web/src/tree/ProjectTools.tsx` | idea | Orca | `src/renderer/src/components/sidebar/add-repo-local-start-actions.ts`, `src/renderer/src/components/sidebar/AddRepoStartSteps.tsx` | `2eb0bb63` | MIT |
| `web/src/firstrun/Landing.tsx` | idea | Orca | `src/renderer/src/components/Landing.tsx` | `2eb0bb63` | MIT |
| `crates/nunchiro-core/src/codex_reset.rs` | code | Orca | `src/main/codex-cli/codex-read-only-app-server-args.ts`, `src/main/rate-limits/{codex-rpc-rate-limit-probe,codex-fetcher,codex-reset-credit-client}.ts` | 1.4.214 (no commit) | MIT |
| `web/src/usage/CodexResets.tsx` | code | Orca | `src/renderer/src/components/status-bar/CodexSwitcherMenu.tsx` | 1.4.214 (no commit) | MIT |
| `web/src/usage/UsageDetail.tsx` | code | Orca | `src/renderer/src/components/stats/{usage-overview-daily-series,usage-overview-model}.ts`, `usage-overview-sections.tsx` | 1.4.214 (no commit) | MIT |
| `crates/nunchiro-core/tests/fixtures/orca/claude-permission-approve-deny-hooks.jsonl` | code | Orca | `src/shared/__fixtures__/claude-permission-approve-deny-hooks.jsonl` | `2eb0bb63` | MIT |
| `crates/nunchiro-core/tests/fixtures/orca/claude-permission-approve-deny-hooks.meta.json` | code | Orca | `src/shared/__fixtures__/claude-permission-approve-deny-hooks.meta.json` | `2eb0bb63` | MIT |
| `crates/nunchiro-core/tests/http_auth.rs` | idea | Orca | `config/scripts/websocket-server-bind-scan.ts` | `2eb0bb63` | MIT |
| `crates/nunchiro-core/src/chat/mod.rs` | code | claude-code-viewer | `src/lib/conversation-schema/**` | `9367cf006be9965c954e6cd36526f2195dce67ea` | MIT |
| `app/src-tauri/src/artifacts/mod.rs` | code | MonoCode | `src-tauri/src/artifacts.rs` | `26465c6` | MIT |
| `app/src-tauri/src/passwd.rs` | code | MonoCode | `src-tauri/src/lib.rs` | `26465c6` | MIT |
| `web/src/diff/patch.ts` | code | MonoCode | `src/features/source-control/model/unifiedDiff.ts` | `26465c6` | MIT |
| `web/src/files/highlight.ts` | code | MonoCode | `src/features/files/editor/codeHighlightEngine.ts` | `26465c6` | MIT |
| `web/src/images/Chips.tsx` | code | MonoCode | `src/features/sessions/ui/AttachmentChip.tsx` | `26465c6` | MIT |
| `web/src/images/Thumbnail.tsx` | code | MonoCode | `src/features/sessions/ui/AttachmentChip.tsx` | `26465c6` | MIT |
| `web/src/images/Thumbnail.tsx` | code | T3 Code | `apps/web/src/components/chat/ComposerImageThumbnail.tsx` | `d14ace8` | MIT |
| `web/src/board/drop.ts` | code | bb | `plugins/tasks/views/board/drop-position.ts` | `5e1acd765039e874643f34c4d35409e58484e408` | MIT |
| `web/src/themes/catalog/catalog.gen.ts` | code | iTerm2-Color-Schemes | `ghostty/` | `04a98db045eb5d71c2247ca6c050ab97290d081c` | MIT (collection; each theme its own, see `web/src/themes/catalog/NOTICES.md`) |
| `web/src/files/sprite.ts` | code | Octicons | `icons/*-16.svg` | `9a274e212ee25c400ff666ce25a57866b7eacc25` | MIT |
| `web/src/files/sprite.ts` | code | Seti-UI | `icons/*.svg` | `2d6c5e68b4ded73c92dac291845ee44e1182d511` | MIT |
| `web/src/icons/Icon.tsx` | code | Octicons | `icons/*-16.svg` | `9a274e212ee25c400ff666ce25a57866b7eacc25` | MIT |
| `web/src/chrome/icons.tsx` | code | Octicons | `icons/*-16.svg` | `9a274e212ee25c400ff666ce25a57866b7eacc25` | MIT |
| `web/src/pane/browser/annotate/output.ts` | code | Orca | `src/renderer/src/components/browser-pane/annotate/browser-annotation-output.ts` | `2eb0bb63` | MIT |
| `app/src-tauri/src/browser/snapshot.js` | code | jev-ultrafast | `jev_ultrafast/snapshot.js` | `1231850a` | MIT |
| `web/src/chat/promptHistory.ts` | code | T3 Code | `apps/web/src/components/chat/composerPromptHistory.ts` | local source copy (no commit) | MIT |
| `web/src/chat/ComposerMenu.tsx` | idea | T3 Code | `apps/web/src/components/chat/useComposerCommandKey.ts`, `apps/web/src/components/chat/composerSlashCommandSearch.ts` | local source copy (no commit) | MIT |
| `web/src/terminal/links.ts` | code | Orca | `src/renderer/src/components/terminal-pane/wrapped-terminal-link-ranges.ts` | 1.4.214 (no commit) | MIT |
| `crates/nunchiro-core/src/user_commands.rs` | idea | Orca | `src/main/skills/claude-plugin-skill-sources.ts` | 1.4.214 (no commit) | MIT |
| `crates/nunchiro-core/src/user_commands.rs` | idea | T3 Code | `apps/server/src/provider/Drivers/ClaudeSkills.ts` | local source copy (no commit) | MIT |
| `web/src/chat/blob-store.ts` | code | Orca | `src/renderer/src/components/native-chat/native-chat-composer-draft-indexeddb.ts` | 1.4.214 (source copy of 2026-10-27, no commit) | MIT |
| `web/src/chat/stash.ts` | idea | T3 Code | `apps/web/src/promptStashStore.ts` | 0.1.2 (source copy, no commit) | MIT |
| `web/src/files/FilesTree.tsx` | idea | Orca | `src/renderer/src/components/right-sidebar/FileExplorerRow.tsx` | 1.4.214 (source copy of 2026-10-27, no commit) | MIT |
| `web/src/chat/Rows.tsx` | idea | Orca | `src/renderer/src/components/native-chat/native-chat-rewind-eligibility.ts` | `2eb0bb63` | MIT |
| `web/src/chat/useComposerSend.ts` | idea | T3 Code | `apps/web/src/components/chat/TimelineUserMessageRow.tsx` | `d14ace8` | MIT |
| `web/src/chat/ComposerWidget.tsx` | idea | T3 Code | `apps/web/src/components/chat/ComposerPrimaryActions.tsx` | `d14ace8` | MIT |
| `web/src/settings/accounts/updates.tsx` | code | T3 Code | `apps/web/src/components/settings/ProviderInstanceCard.tsx`, `apps/web/src/components/ProviderUpdatesAction.tsx`, `apps/web/src/components/ProviderUpdateLaunchNotification.logic.ts`, `apps/server/src/provider/providerMaintenanceCommandCoordinator.ts` | `d14ace8` | MIT |
| `web/src/diff/diffCollapse.ts` | code | T3 Code | `apps/web/src/lib/diffCollapse.ts` | `d14ace8` | MIT |
| `web/src/diff/lineNote.ts` | code | Orca | `src/shared/diff-comments-format.ts` | `2eb0bb63` | MIT |
| `web/src/diff/PatchView.tsx` | idea | T3 Code | `apps/web/src/components/diffs/DiffCommentAnnotation.tsx`, `commentSubmitShortcut.ts` | `d14ace8` | MIT |
| `web/src/diff/Stack.tsx` | idea | Orca | `src/renderer/src/components/github-item-dialog/inspect-pull-request/pr-files-combined-diff-viewer.tsx` | `2eb0bb63` | MIT |
| `web/src/chat/LimitBand.tsx` | code | T3 Code | `apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx` | local source copy (no commit) | MIT |
| `web/src/chrome/SessionFacts.tsx` | idea | Orca | `src/renderer/src/components/status-bar/UsageRosterPanel.tsx` | 1.4.214 (no commit) | MIT |
| `web/src/diff/Diff.tsx` | idea | T3 Code | `apps/web/src/components/DiffPanel.tsx` | `d14ace8` | MIT |
| `crates/nunchiro-core/src/diff/mod.rs` | idea | T3 Code | `apps/web/src/components/DiffPanel.tsx` | `d14ace8` | MIT |
| `web/src/queue/notify.tsx` | code | Orca | `src/shared/notification-burst-cooldown.ts` | `2eb0bb63` | MIT |
| `web/src/sound.ts` | idea | T3 Code | `apps/web/src/threadNotifications.ts` | `d14ace8` | MIT |
| `web/src/diff/gitAction.ts` | code | T3 Code | `apps/web/src/components/GitActionsControl.logic.ts` | local source copy (no commit) | MIT |
| `web/src/diff/gitAction.ts` | idea | Orca | `src/shared/source-control-primary-action-decision.ts` | local source copy (no commit) | MIT |
| `crates/nunchiro-core/src/worktree_clean.rs` | idea | Orca | `src/main/github/pr-head-tracking-ref.ts`, `src/main/runtime/runtime-local-worktree-create-base.ts` | local source copy (no commit) | MIT |
| `crates/nunchiro-core/src/worktree_clean.rs` | idea | T3 Code | `apps/server/src/git/GitManager.ts` | local source copy (no commit) | MIT |
| `web/src/tree/Tidy.tsx` | idea | T3 Code | `apps/web/src/components/settings/StorageSettings.tsx` | local source copy (no commit) | MIT |
| `web/src/pr/fixPrompt.ts` | code | Orca | `src/shared/pr-checks-fix-prompt.ts` | local source copy (no commit) | MIT |
| `crates/nunchiro-core/src/pr/mod.rs` | idea | Orca | `src/main/github/client/lookup/pr-branch-lookup.ts`, `src/main/github/client/check/pr-checks-response-mapping.ts` | local source copy (no commit) | MIT |
| `app/src-tauri/src/cli_install.rs` | code | Orca | `src/main/cli/cli-command-inspection.ts`, `src/shared/cli-install-types.ts` | local source copy (no commit) | MIT |
| `app/src-tauri/src/permissions.rs` | code | Orca | `src/main/macos-full-disk-access-status.ts` | local source copy (no commit) | MIT |
| `web/src/board/prFacts.ts` | code | T3 Code | `apps/web/src/components/pullRequest/pullRequestIcons.tsx` | `d14ace8233ad3cf7856b6b834824f888240d67a1` | MIT |
| `web/src/board/prFacts.ts` | code | Orca | `src/renderer/src/components/pr-check-counts.ts` | `2eb0bb637dff41925d8ffa22ff9054ab656e4816` | MIT |
| `web/src/board/watch.ts` | code | Orca | `src/renderer/src/components/dashboard-popout/`, `dashboard/dashboard-row-bucket.ts` | `0cee6cbd` | MIT |
| `web/src/composer-drafts.ts` | code | T3 Code | `apps/web/src/composerDraftStore.ts`, `apps/web/src/lib/storage.ts` | local source copy (no commit) | MIT |
| `web/src/features/browser-prefs.tsx` | idea | Orca | `src/renderer/src/components/settings/Browser*Setting.tsx` | local source copy (no commit) | MIT |
| `web/src/features/browser-profiles.tsx` | idea | T3 Code | `IntegrationsSettings.tsx`, `AuthorizedClientsSettings.tsx` | local source copy (no commit) | MIT |
| `web/src/features/browser-profiles.tsx` | idea | Orca | `BrowserSessionCookiesSection.tsx` | local source copy (no commit) | MIT |
| `web/src/features/diff-options.tsx` | idea | Orca | `src/renderer/src/components/settings/{CollapseUnchangedRegionsSetting,DiffShowWhitespaceSetting,EditorWordWrapSetting}.tsx` | local source copy (no commit) | MIT |
| `web/src/features/extensions.tsx` | idea | Orca | `McpConfigSection.tsx`, `PluginDevelopmentSection.tsx` | local source copy (no commit) | MIT |
| `web/src/features/link-routing.tsx` | idea | Orca | `src/renderer/src/components/settings/BrowserLinkRouting*Setting.tsx` | local source copy (no commit) | MIT |
| `web/src/features/macos-perms.tsx` | code | Orca | `src/renderer/src/components/settings/DeveloperPermissionsPane.tsx`, `src/main/ipc/developer-permissions.ts` | local source copy (no commit) | MIT |
| `web/src/features/registry.ts` | idea | Orca | `src/renderer/src/components/settings/settings-navigation-foundations.ts` | local source copy (no commit) | MIT |
| `web/src/features/small-rows.tsx` | idea | Orca | `NotificationHostToggles.tsx`, `RecentTabOrderControl.tsx` | local source copy (no commit) | MIT |
| `web/src/features/small-rows.tsx` | idea | T3 Code | `ProjectDefaultsSettings.tsx` | local source copy (no commit) | MIT |
| `web/src/features/terminal.tsx` | idea | Orca | `src/renderer/src/components/settings/Terminal*Section.tsx` | local source copy (no commit) | MIT |
| `web/src/pane/browser/view/failure.ts` | code | Orca | `src/shared/browser-load-failure.ts` | local source copy (no commit) | MIT |
| `web/src/settings/accounts/sections.tsx` | code | T3 Code | `ProviderModelsSection.tsx`, `customModelEditor.logic.ts` | local source copy (no commit) | MIT |
| `web/src/settings/agents/newDefaults.ts` | idea | T3 Code | `ProjectDefaultsSettings.tsx`, `modelSelection.ts`, `providerInstances.ts` | local source copy (no commit) | MIT |
| `web/src/settings/shell/errors.tsx` | idea | Orca | `src/renderer/src/components/settings/accounts-pane-action-errors.ts` | local source copy (no commit) | MIT |
| `web/src/settings/shell/Row.tsx` | idea | T3 Code | `settingsLayout.tsx` | local source copy (no commit) | MIT |
| `web/src/settings/useFeatureSetting.ts` | idea | T3 Code | `packages/shared/src/serverSettings.ts` | local source copy (no commit) | MIT |
| `web/src/Terminal.tsx` | idea | Orca | `terminal-pane/mouse-hide-while-typing.ts`, `lib/pane-manager/focus-follows-mouse.ts` | local source copy (no commit) | MIT |
| `web/src/terminal/options.ts` | idea | Orca | `TerminalInteractionSection.tsx`, `TerminalMacKeyboardSection.tsx`, `TerminalCursorAppearanceSection.tsx`, `TerminalAdvancedTypographyControls.tsx`, `TerminalRenderingSection.tsx`, `TerminalWindowSection.tsx`, `pane-terminal-options.ts`, `terminal-appearance.ts` | local source copy (no commit) | MIT |
| `web/src/tree/AgentLogo.tsx` | code | Orca | `src/renderer/src/components/status-bar/icons.tsx`, `src/renderer/src/lib/agent-catalog.tsx` | local source copy (no commit) | MIT |
| `web/src/settings/git/logos.tsx` | code | Octicons | `mark-github` (no path stated) | 19.15.0 (no commit) | MIT |
| `web/src/settings/git/logos.tsx` | code | Simple Icons | `icons/git.svg`, `icons/gitlab.svg`, `icons/forgejo.svg`, `icons/bitbucket.svg` (path data only, drawn in `currentColor`; sources in `docs/design/settings-1103/notes.md`; CC0 covers the drawings, not the brands: the marks stay their owners' trademarks and only name each service next to its text name) | 13.21.0 (no commit) | CC0-1.0 |

## Concept-only sources (no local file holds their code)

From `docs/research/lift-map.md`: vibe-kanban (Apache-2.0) board and PTY, Emdash (Apache-2.0) image paste, `@pierre/diffs`
(Apache-2.0, a dependency, not copied), cmux (GPL), Superset (Elastic) and herdr (Apache-2.0, commit titles read) are
ideas only. They have no row above on purpose: a row naming one as `code` makes the check fail.
