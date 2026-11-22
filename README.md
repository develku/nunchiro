# Nunchiro

Nunchiro is a Mac app for working with coding agents. It runs Claude Code and Codex in real terminals under a small
background service, and shows each session as a terminal, a chat, its files and its diff, in one window. Images, HTML
and Markdown that an agent writes open as cards in the chat. Every permission request and question from every agent
lands in one queue, so nothing waiting on you gets buried. Nunchiro uses your own `claude` and `codex` installs and
sign-ins; it does not call a model itself.

<!-- Screenshot: the main window with a few sessions in the tree, one chat open and one request in the queue.
     Add it as docs/screenshot.png (taken on a clean test home) and put the image line here. -->

## Status

Pre-release. It builds and runs on macOS from source as an unsigned local build. There is no signed download, no
automatic update, and the interfaces may still change.

## Requirements

- macOS on Apple silicon. Intel Macs and older macOS versions are not tested.
- Claude Code (`claude`) and/or Codex (`codex`), installed and signed in by you.
- To build: Xcode Command Line Tools, rustup (it installs the toolchain pinned in `rust-toolchain.toml`), Node and
  pnpm 10.
- Optional: `gh` signed in, for pull request badges; `~/.ssh/config` entries, for agents on other Macs.

## Install from source

```sh
git clone https://github.com/develku/nunchiro.git && cd nunchiro
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

[docs/first-run.md](docs/first-run.md) explains each step, the macOS folder permissions Nunchiro may ask for, and how
to quit and update. The `nunchiro` command is described in [docs/cli.md](docs/cli.md).

A new worktree of this repository needs its own packages and `web/dist` before `cargo test` builds the app:
`scripts/setup-worktree.sh` does both. `orca.yaml` names it as the worktree setup script, so Nunchiro offers to run it
(once you approve its text) when it creates a worktree of this project.

## Reporting a problem

Open an issue in this repository with what you did, what you expected and what happened, plus your macOS version and
the output of `nunchiro --version`. `nunchiro diagnose` writes a bundle of logs with secrets removed; read it before
you attach it. Please report a security problem privately through the repository's Security tab ("Report a
vulnerability"), not in a public issue.

## Licence

MIT, see [LICENSE](LICENSE). Code adapted from other MIT projects keeps its notice: [NOTICES](NOTICES),
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the dependency licences in [licenses/](licenses/).
