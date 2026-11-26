# Gate stages run from an agent session, 2026-11-26 (ticket 1160, p26 MD1)

Commit 2d2b25276 (origin/main 35f9e523d + the ticket 1160 guidance change), worktree lead/guidance-1160 on the mini.
Run by a Claude Code agent session (Claude desktop, CLAUDECODE=1). It was not a Nunchiro session: NUNCHIRO_SESSION was
unset. Started 07:34:21 AEST and ended 07:52:39 AEST, at a 1-min load of 2.7, with two other lanes on the machine.
CARGO_TARGET_DIR was on the work volume, and target/ was a symlink to it for the web stages.
The stages are those of .github/workflows/ci.yml in job order. The Rust stage is the local form of rust-build + rust-test.

| Stage | Command | Result | Time |
|---|---|---|---|
| setup | `scripts/setup-worktree.sh` | pass | 4 s |
| fmt | `cargo fmt --all --check` | pass | 2 s |
| sh -n | `sh -n` on each `scripts/scenario/*.sh` | pass | 0 s |
| typecheck | `pnpm typecheck` (web) | pass | 2 s |
| clippy | `cargo clippy --workspace --all-targets -- -D warnings` | pass | 37 s |
| Rust tests | `scripts/cargo-test-gate.sh` (nextest + doctests) | pass, 3134 of 3134 | 546 s |
| app | `scripts/check-app.sh` | first run failed, see below; rerun passed (254 + 1 + 2 tests) | 148 s; rerun 11 s warm |
| cli docs | `scripts/check-cli-docs.sh` | pass | 1 s |
| scenario | `SCENARIO_JOBS=2 scripts/scenario-tests.sh` | pass, 687 tests, 0 failing, 12 skipped | 172 s |
| web core | `WEB_CORE_WORKERS=2 .github/scripts/web-core.sh` | pass, 228 passed | 186 s |

App stage: the first run failed 5 `rc_update` tests with "current_exe() that contains a symlink". Tauri's updater
refuses a binary path that contains a symlink, and check-app.sh unsets CARGO_TARGET_DIR, so it built through the
target/ symlink. The tests and the code are fine. Without the symlink, and with
`CARGO_BUILD_TARGET_DIR=<work volume dir> scripts/check-app.sh` (check-app.sh unsets only CARGO_TARGET_DIR), the stage
passed. That rerun first touched app/src-tauri/tests/dev_load.rs and src/main.rs. Without the touch, the cached
dev_load test binary still pointed at the old symlinked binary path.
So run the app check with no target/ symlink.
