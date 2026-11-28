# Nunchiro

> **Status: pre-release, in active development.** Expect breaking changes between versions, in the app, the
> `nunchiro` command and the files it keeps. There is no support yet: issues are read, but nothing is promised.

Nunchiro is a Mac app for working with coding agents. It runs Claude Code and Codex in real terminals under a small
background service, and shows each session as a terminal, a chat, its files and its diff, in one window. Images, HTML
and Markdown that an agent writes open as cards in the chat. Every permission request and question from every agent
lands in one queue, so nothing waiting on you gets buried. Nunchiro uses your own `claude` and `codex` installs and
sign-ins; it does not call a model itself.

<!-- Screenshot: the main window with a few sessions in the tree, one chat open and one request in the queue.
     Add it as docs/screenshot.png (taken on a clean test home) and put the image line here. -->

## How it is built today

It builds and runs on macOS from source, signed on your own Mac (`scripts/local-signing.sh`: self-signed, or ad hoc
when that identity is missing; no Apple Developer ID). There is no download and no automatic update yet.

## Requirements

- macOS on Apple silicon. Intel Macs and older macOS versions are not tested.
- Claude Code (`claude`) and/or Codex (`codex`), installed and signed in by you.
- To build: Xcode Command Line Tools, rustup (it installs the toolchain pinned in `rust-toolchain.toml`), Node and
  pnpm 10.
- Optional: `gh` signed in, for pull request badges; `~/.ssh/config` entries, for agents on other Macs.

## Install from source

```sh
git clone https://github.com/nunchiro/nunchiro.git && cd nunchiro
pnpm install --frozen-lockfile
pnpm --filter nunchiro-web build
(cd app && pnpm exec tauri build --bundles app --config '{"bundle":{"active":true}}')
cargo install --locked --path crates/nunchiro --root "$HOME/.local"
mkdir -p ~/Applications && rm -rf ~/Applications/Nunchiro.app
cp -R target/release/bundle/macos/Nunchiro.app ~/Applications/
cp ~/.local/bin/nunchiro ~/Applications/Nunchiro.app/Contents/MacOS/nunchiro
scripts/local-signing.sh sign ~/Applications/Nunchiro.app
open ~/Applications/Nunchiro.app
```

Run `scripts/local-signing.sh create` once before the first install: without that identity, `sign` falls back to ad hoc
signing, and macOS may not keep folder permissions across installs.

[docs/first-run.md](docs/first-run.md) explains each step, the macOS folder permissions Nunchiro may ask for, and how
to quit and update. The `nunchiro` command is described in [docs/cli.md](docs/cli.md).

A new worktree of this repository needs its own packages and `web/dist` before `cargo test` builds the app:
`scripts/setup-worktree.sh` does both. `orca.yaml` names it as the worktree setup script, so Nunchiro offers to run it
(once you approve its text) when it creates a worktree of this project.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on GitHub-hosted runners for every pull request and every
push to `main`. A pull request is the only way into `main`. It needs two checks: the `gate` job, which passes only when
every other job passed, and `ci-guard` ([ci-guard.yml](.github/workflows/ci-guard.yml)), which holds a pull request
that changes `.github/` or the ratchet scripts until a maintainer has reviewed it.

Pull requests run in two steps, because the free plan runs only 5 macOS jobs at once. Every push runs the Linux jobs
(`lint`, `changes`). The macOS jobs run once the pull request is ready: auto-merge is turned on, or it carries the
`ready-ci` label (for a pull request under review that is not on auto-merge yet). Turning either on starts the full run,
and every later push runs the full set. Until then `gate` fails with "macOS checks run when auto-merge is on or the
ready-ci label is set", so nothing merges untested; a pull request that changes only safe docs passes without it.

- `lint` (Linux): `cargo fmt --check`, `sh -n` of the scenario scripts, `pnpm typecheck` in `web/`.
- `rust-build` (macOS): clippy with warnings as errors, doctests, and one nextest archive of every Rust test.
- `rust-test` (macOS, two runners, pull requests): the archive, split with `cargo nextest run --partition count:k/2`. A push to
  main runs the whole archive inside `rust-build` instead, to keep main runs to fewer macOS jobs.
- `app` (macOS): `scripts/check-app.sh` (the Tauri app's fmt, clippy, tests and licence notices).
- `web` (macOS): `scripts/check-cli-docs.sh`, `scripts/scenario-tests.sh`, and the Playwright core set
  (`web/tests/core-set.txt`) on Chromium through `.github/scripts/web-core.sh`.

The Rust crates use macOS system calls and do not build on Linux, so every Rust job runs on macOS. A push to `main`
only refreshes the build caches that pull requests read.

## Reporting a problem

Open an issue in this repository with what you did, what you expected and what happened, plus your macOS version and
the output of `nunchiro --version`. `nunchiro diagnose` writes a bundle of logs with secrets removed; read it before
you attach it. Please report a security problem privately through the repository's Security tab ("Report a
vulnerability"), not in a public issue; see [SECURITY.md](SECURITY.md).

## Privacy

Nunchiro has no telemetry. [PRIVACY.md](PRIVACY.md) lists every host it connects to and when.

## Contributing

Bug fixes and small, focused changes are welcome. Open an issue first; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT, see [LICENSE](LICENSE). Code adapted from other MIT projects keeps its notice: [NOTICES](NOTICES),
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the dependency licences in [licenses/](licenses/).
The licence covers the code. It does not cover the Nunchiro name or mark; a fork must use its own name and mark.
