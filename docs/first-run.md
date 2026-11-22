# First run on this Mac

An unsigned local build for the Mac that built it. No `/Applications`, no sudo, no paid signing (an optional local identity, below).

## Install

From a checkout of `main`, with Xcode Command Line Tools (`xcode-select --install`), rustup (it installs the Rust
toolchain pinned in `rust-toolchain.toml`), Node and pnpm 10 installed, and `~/.local/bin` on your PATH (`export PATH="$HOME/.local/bin:$PATH"`):

```sh
export CARGO_BUILD_JOBS=2
pnpm install --frozen-lockfile
pnpm --filter nunchiro-web build
# --config turns the bundle on; tauri.conf.json ships with bundle.active false
(cd app && pnpm exec tauri build --bundles app --config '{"bundle":{"active":true}}')
cargo install --locked -j 2 --path crates/nunchiro --root "$HOME/.local"
mkdir -p ~/Applications
rm -rf ~/Applications/Nunchiro.app
cp -R target/release/bundle/macos/Nunchiro.app ~/Applications/
cp ~/.local/bin/nunchiro ~/Applications/Nunchiro.app/Contents/MacOS/nunchiro
# A stable identity keeps the macOS Files and Folders grant across rebuilds; ad hoc otherwise (see below).
# It prints which one it used and fails, instead of installing unsigned, when the identity is there but codesign fails.
scripts/local-signing.sh sign ~/Applications/Nunchiro.app
```

The window finds the CLI next to its own executable, so both copies must be the same build:

```sh
~/.local/bin/nunchiro --version
~/Applications/Nunchiro.app/Contents/MacOS/nunchiro --version
```


## First start

Open the window; it starts the core:

```sh
open ~/Applications/Nunchiro.app
nunchiro snapshot --json
```

A session in an external-disk folder may first show "Permission needed" (below). Fallback: quit
everything (see Quit) and start the core from a terminal before opening the window:

```sh
nohup nunchiro serve >/dev/null 2>&1 &
open ~/Applications/Nunchiro.app
```

## Permission needed

macOS guards external volumes (`/Volumes/<disk>`), Desktop, Documents and Downloads per app. A core that
Nunchiro.app starts counts as the app, so until Nunchiro is allowed, its agents cannot read such a folder
(observed on this Mac, 2026-10-26: they sit blank, no macOS prompt appears). A core started from a
terminal counts as the terminal app and has no such wait.

When the core cannot open a new session's folder within 2 seconds, the window shows "Permission needed"
over that session (the agent keeps running; nothing is killed). Nunchiro never changes the setting itself:

1. Press Open Settings (System Settings > Privacy & Security > Files and Folders) and allow Nunchiro under
   Removable Volumes (or Desktop, Documents, Downloads for those folders). Or press Open Full Disk Access
   and turn it on for Nunchiro.
2. Press Restart session. It closes the blocked session and starts one in the same folder with the same
   agent, model and effort; a conversation that already had a finished turn is resumed. A shell session, or a
   worktree session with no finished turn, shows no Restart: close it and start it again in the folder the panel
   names.

A valid but slow network or external volume (over 2 s to list) can also show "Permission needed": press Restart
session once it is mounted and answering; no grant is needed.

Signing identity (once per Mac): with the self-signed identity "Nunchiro Local Code Signing" in the login
keychain, the install signs with it and the designated requirement is `identifier ... and certificate leaf = H"..."`
(`codesign -d -r-`), which stays the same across builds, so the Files and Folders grant survives a reinstall. Grant
once after the first install signed this way. Create it once; the script does nothing when the identity is already
listed (two identities with one name make `codesign` fail as ambiguous):

```sh
scripts/local-signing.sh create
```

No password prompt. The key and certificate are written to a private (0700) temporary folder, imported as a
non-exportable key and deleted on every exit path, so they live only in the keychain. The identity signs while untrusted
(`security find-identity` shows CSSMERR_TP_NOT_TRUSTED, which is expected) and the script changes no trust settings.
Remove the identity with `security delete-identity -c "Nunchiro Local Code Signing"`. Without it the install signs ad hoc: the designated
requirement is then the build's own code hash, so after each reinstall remove Nunchiro from the Files and Folders
list (the minus button) and allow it again, or turn it off and on; then press Restart session. Evidence: ticket 33
Comments, tickets 61 and 295.

Trade-off (accepted for a single-user local tool, ticket 61): `-T /usr/bin/codesign` lets any process running as you
sign with this identity without a prompt, and the designated requirement trusts any binary signed with it under
Nunchiro's identifier, so such a binary would inherit Nunchiro's Files and Folders grants. Grant Removable Volumes
(and the folders you need), not Full Disk Access.

## First session

In the window, start a Claude session in a folder Claude already trusts. A trust dialog
for a new folder stays yours to answer. From a terminal:

```sh
nunchiro session start --kind claude --model haiku --project <folder>
# <id> is session.id in the JSON line the start command above prints
nunchiro session send-text <id> 'Reply with OK only.' && nunchiro session send-keys <id> enter
```

## Machines over SSH

Add remote Macs in Settings > Advanced > Machines using your own OpenSSH aliases. Install Nunchiro on
each remote Mac yourself. Configured keys come from `ssh -G`; the fingerprint comes from
known_hosts. These are configured keys, not proof of which key a connection used.

`ssh -G` evaluates the user's OpenSSH `Match exec` rules and can execute the commands those rules specify,
even while displaying configuration. Nunchiro edits no SSH config and never automatically accepts host keys.
Remove only forgets the alias in Nunchiro's stores.

## Quit

"Quit and stop all agents" in the window, or `nunchiro serve stop --yes`. Closing only the window
leaves the core and its agents running. Any later `nunchiro` command (even `nunchiro snapshot --json`) starts the core
again.

## Update

Run `nunchiro serve stop --yes` and quit the app, pull `main`, then repeat Install. It is a manual reinstall; nothing updates itself.

## Uninstall

`nunchiro serve stop --yes` first. Then:

```sh
rm -rf ~/Applications/Nunchiro.app
rm -f ~/.local/bin/nunchiro
rm -f ~/Library/LaunchAgents/dev.nunchiro.app.login.plist   # only if you turned on start-at-login
```

Warning: `~/.nunchiro` holds session records, and `~/.nunchiro/worktrees` may hold uncommitted
work from agent worktrees. Check each before you delete anything there, and check `worktrees_dir` in `~/.nunchiro/settings.json` if you set it.
Removing a worktree folder by hand leaves a stale entry; run `git worktree prune` in the source repo.
Nunchiro's hook settings live under `~/.nunchiro`; it does not edit `~/.claude` or `~/.codex`. The steps above leave `~/.nunchiro` alone.

## Developing the web UI in the real app

A debug build of the window can load the web UI from this checkout instead of its embedded copy (ticket 172), so a
web-only change shows in the real WKWebView without rebuilding the app:

```sh
cargo build -p nunchiro                       # the CLI the dev app starts its core with
(cd app/src-tauri && cargo build)             # once; debug only
home=$(mktemp -d)                             # never ~/.nunchiro: the dev app refuses it
NUNCHIRO_HOME=$home NUNCHIRO_BIN=$PWD/target/debug/nunchiro NUNCHIRO_WEB=web/dist \
  app/src-tauri/target/debug/nunchiro-app
# after a web edit:
pnpm --filter nunchiro-web build              # then Develop > Reload UI (Cmd+R) in the app
```

`NUNCHIRO_WEB` takes a folder inside this checkout (read at each request) or a dev server on loopback
(`http://localhost:5173` from `pnpm --filter nunchiro-web dev`). With a dev server, start from a home whose core is not
running yet: the app hands the core that origin when it starts it. Anything else, a missing `NUNCHIRO_HOME`, or
`~/.nunchiro` stops the app with exit code 2. A release build (`tauri build`) has no such code and
refuses the variable.

Warning: dev-server mode gives the page served on that port full IPC and the window token, and the config CSP may not
apply: run only your own dev server, on a port nothing else uses.
