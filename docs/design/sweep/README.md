# Themes sweep (kept)

Every page and view of the window, shot in the Nunchiro Dark and Nunchiro Light themes at 1440 x 900 by
`web/tests/themes-sweep.spec.ts` (run: in `web/`, `PW_OPT_IN=shots pnpm exec playwright test tests/themes-sweep.spec.ts
--project=shots`; it writes PNGs to `.scratch/sweep`). Kept here as WebP at 1200 px wide. Before each shot the
machine's own paths read `~`. Settings pages longer than one screen have `-2`, `-3` parts.

`contrast-dark.txt` and `contrast-light.txt` are the sweep's own scan: text under 4.5:1 on its background in that
shot (page, ratio, colours, element, text). `fixes/` holds the before and after crops of the defects fixed with this
sweep.

## Pages added since mid-November (20)

| Page | Dark | Light |
|---|---|---|
| accounts-acp-signin | [dark](dark/accounts-acp-signin.webp) | [light](light/accounts-acp-signin.webp) |
| accounts-acp-signing-in | [dark](dark/accounts-acp-signing-in.webp) | [light](light/accounts-acp-signing-in.webp) |
| accounts-add | [dark](dark/accounts-add.webp) | [light](light/accounts-add.webp) |
| accounts-claude | [dark](dark/accounts-claude.webp) | [light](light/accounts-claude.webp) |
| bots-lead-header | [dark](dark/bots-lead-header.webp) | [light](light/bots-lead-header.webp) |
| bots-new | [dark](dark/bots-new.webp) | [light](light/bots-new.webp) |
| bots-page | [dark](dark/bots-page.webp) | [light](light/bots-page.webp) |
| bots-page-models | [dark](dark/bots-page-models.webp) | [light](light/bots-page-models.webp) |
| bots-roster | [dark](dark/bots-roster.webp) | [light](light/bots-roster.webp) |
| dialog-new-tab-agent-kinds | [dark](dark/dialog-new-tab-agent-kinds.webp) | [light](light/dialog-new-tab-agent-kinds.webp) |
| git-actions | [dark](dark/git-actions.webp) | [light](light/git-actions.webp) |
| pr-chip | [dark](dark/pr-chip.webp) | [light](light/pr-chip.webp) |
| pr-list | [dark](dark/pr-list.webp) | [light](light/pr-list.webp) |
| pr-view | [dark](dark/pr-view.webp) | [light](light/pr-view.webp) |
| pr-view-off | [dark](dark/pr-view-off.webp) | [light](light/pr-view-off.webp) |
| schedules-form | [dark](dark/schedules-form.webp) | [light](light/schedules-form.webp) |
| schedules-widget | [dark](dark/schedules-widget.webp) | [light](light/schedules-widget.webp) |
| state-git-actions-hover | [dark](dark/state-git-actions-hover.webp) | [light](light/state-git-actions-hover.webp) |
| team-side | [dark](dark/team-side.webp) | [light](light/team-side.webp) |
| team-wide | [dark](dark/team-wide.webp) | [light](light/team-wide.webp) |

## Every other page and state (102)

| Page | Dark | Light |
|---|---|---|
| artifacts | [dark](dark/artifacts.webp) | [light](light/artifacts.webp) |
| board | [dark](dark/board.webp) | [light](light/board.webp) |
| board-card-editor | [dark](dark/board-card-editor.webp) | [light](light/board-card-editor.webp) |
| board-widget-editor | [dark](dark/board-widget-editor.webp) | [light](light/board-widget-editor.webp) |
| chat | [dark](dark/chat.webp) | [light](light/chat.webp) |
| chat-edit | [dark](dark/chat-edit.webp) | [light](light/chat-edit.webp) |
| chat-late | [dark](dark/chat-late.webp) | [light](light/chat-late.webp) |
| chat-mid | [dark](dark/chat-mid.webp) | [light](light/chat-mid.webp) |
| chat-thinking | [dark](dark/chat-thinking.webp) | [light](light/chat-thinking.webp) |
| chat-tools | [dark](dark/chat-tools.webp) | [light](light/chat-tools.webp) |
| chat-top | [dark](dark/chat-top.webp) | [light](light/chat-top.webp) |
| composer | [dark](dark/composer.webp) | [light](light/composer.webp) |
| composer-menu-effort | [dark](dark/composer-menu-effort.webp) | [light](light/composer-menu-effort.webp) |
| composer-menu-file | [dark](dark/composer-menu-file.webp) | [light](light/composer-menu-file.webp) |
| composer-menu-model | [dark](dark/composer-menu-model.webp) | [light](light/composer-menu-model.webp) |
| composer-menu-permission | [dark](dark/composer-menu-permission.webp) | [light](light/composer-menu-permission.webp) |
| composer-menu-slash | [dark](dark/composer-menu-slash.webp) | [light](light/composer-menu-slash.webp) |
| crash-screen | [dark](dark/crash-screen.webp) | [light](light/crash-screen.webp) |
| decision-card | [dark](dark/decision-card.webp) | [light](light/decision-card.webp) |
| decision-deny-instruction | [dark](dark/decision-deny-instruction.webp) | [light](light/decision-deny-instruction.webp) |
| dialog-add-project | [dark](dark/dialog-add-project.webp) | [light](light/dialog-add-project.webp) |
| dialog-clone | [dark](dark/dialog-clone.webp) | [light](light/dialog-clone.webp) |
| dialog-close-notice | [dark](dark/dialog-close-notice.webp) | [light](light/dialog-close-notice.webp) |
| dialog-discard | [dark](dark/dialog-discard.webp) | [light](light/dialog-discard.webp) |
| dialog-new-project | [dark](dark/dialog-new-project.webp) | [light](light/dialog-new-project.webp) |
| dialog-new-session | [dark](dark/dialog-new-session.webp) | [light](light/dialog-new-session.webp) |
| dialog-new-worktree | [dark](dark/dialog-new-worktree.webp) | [light](light/dialog-new-worktree.webp) |
| dialog-quit | [dark](dark/dialog-quit.webp) | [light](light/dialog-quit.webp) |
| dialog-tidy | [dark](dark/dialog-tidy.webp) | [light](light/dialog-tidy.webp) |
| diff | [dark](dark/diff.webp) | [light](light/diff.webp) |
| diff-split | [dark](dark/diff-split.webp) | [light](light/diff-split.webp) |
| files-html | [dark](dark/files-html.webp) | [light](light/files-html.webp) |
| files-markdown | [dark](dark/files-markdown.webp) | [light](light/files-markdown.webp) |
| files-markdown-source | [dark](dark/files-markdown-source.webp) | [light](light/files-markdown-source.webp) |
| files-markup | [dark](dark/files-markup.webp) | [light](light/files-markup.webp) |
| files-text | [dark](dark/files-text.webp) | [light](light/files-text.webp) |
| files-tree | [dark](dark/files-tree.webp) | [light](light/files-tree.webp) |
| firstrun-import | [dark](dark/firstrun-import.webp) | [light](light/firstrun-import.webp) |
| firstrun-import-found | [dark](dark/firstrun-import-found.webp) | [light](light/firstrun-import-found.webp) |
| firstrun-import-hits | [dark](dark/firstrun-import-hits.webp) | [light](light/firstrun-import-hits.webp) |
| landing | [dark](dark/landing.webp) | [light](light/landing.webp) |
| onboarding-assistant | [dark](dark/onboarding-assistant.webp) | [light](light/onboarding-assistant.webp) |
| onboarding-keys | [dark](dark/onboarding-keys.webp) | [light](light/onboarding-keys.webp) |
| onboarding-look | [dark](dark/onboarding-look.webp) | [light](light/onboarding-look.webp) |
| onboarding-notify | [dark](dark/onboarding-notify.webp) | [light](light/onboarding-notify.webp) |
| onboarding-project | [dark](dark/onboarding-project.webp) | [light](light/onboarding-project.webp) |
| onboarding-providers | [dark](dark/onboarding-providers.webp) | [light](light/onboarding-providers.webp) |
| onboarding-session | [dark](dark/onboarding-session.webp) | [light](light/onboarding-session.webp) |
| onboarding-skills | [dark](dark/onboarding-skills.webp) | [light](light/onboarding-skills.webp) |
| pairing | [dark](dark/pairing.webp) | [light](light/pairing.webp) |
| pairing-code | [dark](dark/pairing-code.webp) | [light](light/pairing-code.webp) |
| pairing-unreachable | [dark](dark/pairing-unreachable.webp) | [light](light/pairing-unreachable.webp) |
| palette | [dark](dark/palette.webp) | [light](light/palette.webp) |
| permission-sheet | [dark](dark/permission-sheet.webp) | [light](light/permission-sheet.webp) |
| search-empty | [dark](dark/search-empty.webp) | [light](light/search-empty.webp) |
| search-hits | [dark](dark/search-hits.webp) | [light](light/search-hits.webp) |
| settings-01-general | [dark](dark/settings-01-general.webp) | [light](light/settings-01-general.webp) |
| settings-01-general-2 | [dark](dark/settings-01-general-2.webp) | [light](light/settings-01-general-2.webp) |
| settings-02-onboarding | [dark](dark/settings-02-onboarding.webp) | [light](light/settings-02-onboarding.webp) |
| settings-02-onboarding-2 | [dark](dark/settings-02-onboarding-2.webp) | [light](light/settings-02-onboarding-2.webp) |
| settings-03-appearance | [dark](dark/settings-03-appearance.webp) | [light](light/settings-03-appearance.webp) |
| settings-04-terminal | [dark](dark/settings-04-terminal.webp) | [light](light/settings-04-terminal.webp) |
| settings-05-layout | [dark](dark/settings-05-layout.webp) | [light](light/settings-05-layout.webp) |
| settings-06-notifications | [dark](dark/settings-06-notifications.webp) | [light](light/settings-06-notifications.webp) |
| settings-07-keyboard | [dark](dark/settings-07-keyboard.webp) | [light](light/settings-07-keyboard.webp) |
| settings-08-in-app-browser | [dark](dark/settings-08-in-app-browser.webp) | [light](light/settings-08-in-app-browser.webp) |
| settings-09-providers | [dark](dark/settings-09-providers.webp) | [light](light/settings-09-providers.webp) |
| settings-10-usage | [dark](dark/settings-10-usage.webp) | [light](light/settings-10-usage.webp) |
| settings-11-team | [dark](dark/settings-11-team.webp) | [light](light/settings-11-team.webp) |
| settings-12-assistants | [dark](dark/settings-12-assistants.webp) | [light](light/settings-12-assistants.webp) |
| settings-13-notes | [dark](dark/settings-13-notes.webp) | [light](light/settings-13-notes.webp) |
| settings-14-skills-hooks | [dark](dark/settings-14-skills-hooks.webp) | [light](light/settings-14-skills-hooks.webp) |
| settings-15-git-worktrees | [dark](dark/settings-15-git-worktrees.webp) | [light](light/settings-15-git-worktrees.webp) |
| settings-16-projects | [dark](dark/settings-16-projects.webp) | [light](light/settings-16-projects.webp) |
| settings-17-ssh-machines | [dark](dark/settings-17-ssh-machines.webp) | [light](light/settings-17-ssh-machines.webp) |
| settings-18-phone-and-web-access | [dark](dark/settings-18-phone-and-web-access.webp) | [light](light/settings-18-phone-and-web-access.webp) |
| settings-19-artifact-libraries | [dark](dark/settings-19-artifact-libraries.webp) | [light](light/settings-19-artifact-libraries.webp) |
| settings-19-permissions | [dark](dark/settings-19-permissions.webp) | [light](light/settings-19-permissions.webp) |
| settings-19-permissions-2 | [dark](dark/settings-19-permissions-2.webp) | [light](light/settings-19-permissions-2.webp) |
| settings-20-terminal-history | [dark](dark/settings-20-terminal-history.webp) | [light](light/settings-20-terminal-history.webp) |
| settings-21-about | [dark](dark/settings-21-about.webp) | [light](light/settings-21-about.webp) |
| side-browser | [dark](dark/side-browser.webp) | [light](light/side-browser.webp) |
| side-terminal | [dark](dark/side-terminal.webp) | [light](light/side-terminal.webp) |
| state-chat-row-hover | [dark](dark/state-chat-row-hover.webp) | [light](light/state-chat-row-hover.webp) |
| state-discard-hover | [dark](dark/state-discard-hover.webp) | [light](light/state-discard-hover.webp) |
| state-menu-item-hover | [dark](dark/state-menu-item-hover.webp) | [light](light/state-menu-item-hover.webp) |
| state-menu-project | [dark](dark/state-menu-project.webp) | [light](light/state-menu-project.webp) |
| state-onboarding-step-hover | [dark](dark/state-onboarding-step-hover.webp) | [light](light/state-onboarding-step-hover.webp) |
| state-palette-hover | [dark](dark/state-palette-hover.webp) | [light](light/state-palette-hover.webp) |
| state-search-hit-hover | [dark](dark/state-search-hit-hover.webp) | [light](light/state-search-hit-hover.webp) |
| state-tab-hover | [dark](dark/state-tab-hover.webp) | [light](light/state-tab-hover.webp) |
| state-tab-key-focus | [dark](dark/state-tab-key-focus.webp) | [light](light/state-tab-key-focus.webp) |
| state-tree-focus | [dark](dark/state-tree-focus.webp) | [light](light/state-tree-focus.webp) |
| state-tree-project-hover | [dark](dark/state-tree-project-hover.webp) | [light](light/state-tree-project-hover.webp) |
| state-tree-row-hover | [dark](dark/state-tree-row-hover.webp) | [light](light/state-tree-row-hover.webp) |
| state-widget-library-hover | [dark](dark/state-widget-library-hover.webp) | [light](light/state-widget-library-hover.webp) |
| tabs | [dark](dark/tabs.webp) | [light](light/tabs.webp) |
| terminal-tab | [dark](dark/terminal-tab.webp) | [light](light/terminal-tab.webp) |
| tree | [dark](dark/tree.webp) | [light](light/tree.webp) |
| tree-decision-line | [dark](dark/tree-decision-line.webp) | [light](light/tree-decision-line.webp) |
| widget-library | [dark](dark/widget-library.webp) | [light](light/widget-library.webp) |
| window | [dark](dark/window.webp) | [light](light/window.webp) |

## Catalogue themes (10)

Dracula (dark) and iTerm2 Solarized Light, imported themes.

- [dracula-appearance](catalogue/dracula-appearance.webp)
- [dracula-menu](catalogue/dracula-menu.webp)
- [dracula-palette](catalogue/dracula-palette.webp)
- [dracula-tree-hover](catalogue/dracula-tree-hover.webp)
- [dracula-window](catalogue/dracula-window.webp)
- [iterm2-solarized-light-appearance](catalogue/iterm2-solarized-light-appearance.webp)
- [iterm2-solarized-light-menu](catalogue/iterm2-solarized-light-menu.webp)
- [iterm2-solarized-light-palette](catalogue/iterm2-solarized-light-palette.webp)
- [iterm2-solarized-light-tree-hover](catalogue/iterm2-solarized-light-tree-hover.webp)
- [iterm2-solarized-light-window](catalogue/iterm2-solarized-light-window.webp)

## Fixes

| Defect | Before | After |
|---|---|---|
| Bots view, Models fold: two chevrons on each select | [dark](fixes/bots-models-select-before-dark.png), [light](fixes/bots-models-select-before-light.png) | [dark](fixes/bots-models-select-after-dark.png), [light](fixes/bots-models-select-after-light.png) |
| Team view side: Hand to the leader wrapped onto three lines | [dark](fixes/team-hand-before-dark.png), [light](fixes/team-hand-before-light.png) | [dark](fixes/team-hand-after-dark.png), [light](fixes/team-hand-after-light.png) |
| New bot: the face hint at 3.3:1 (icon token on text) | [dark](fixes/newbot-hint-before-dark.png), [light](fixes/newbot-hint-before-light.png) | [dark](fixes/newbot-hint-after-dark.png), [light](fixes/newbot-hint-after-light.png) |
