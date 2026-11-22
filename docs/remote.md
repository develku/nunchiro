# Second machine over SSH

Each Mac runs its own core. Install the same Nunchiro version on the other Mac explicitly;
Nunchiro never installs it, enables Remote Login, edits SSH configuration, or pairs machines.
From an existing checkout on that Mac:

```sh
cargo install --locked --path crates/nunchiro --root "$HOME/.local"
```

Put `$HOME/.local/bin` on the remote login shell's PATH. The SSH command runs the relay in the remote user's login
shell (`$SHELL`, or `/bin/sh` when unset), so a Linux host without zsh works:
`sh -c 'exec "${SHELL:-/bin/sh}" -lc "exec nunchiro machine relay"'` (one-shot requests) or the same with
`relay --stream` (the channel below). The command is fixed text; the alias, host, user and port are separate
ssh arguments. Configure an SSH alias in your own
`~/.ssh/config` and verify its host key as the user before using it. Nunchiro uses `BatchMode=yes`,
`ConnectTimeout=3`, and `StrictHostKeyChecking=yes`; unknown or changed host keys fail without acceptance or prompts.
A fresh checkout needs no SSH configuration for local commands or fake-transport checks.

## Persistent channel (V2-12m-a)

What you install: Nunchiro on the remote Mac (above), an SSH alias, and its host key in `known_hosts`. Nunchiro
installs, enables and restarts nothing there.

- **ControlMaster.** The first owner snapshot (the window, or `nunchiro snapshot` outside every session) starts one
  OpenSSH ControlMaster per alias, owned by the local core. Its options go on the command line with `-o` only
  (`ControlMaster=yes`, `ControlPersist=no`, `ServerAliveInterval=15`, `ServerAliveCountMax=2`, `ControlPath=…`) next
  to the three above; your ssh config is read as always and never written, and no `-F` is passed. A session token's
  snapshot never starts one. The master and its process group end with the core; when the core dies its stdin
  closes and the remote relay exits.
- **ControlPath.** `NUNCHIRO_HOME/mux/<n>`, where `<n>` counts this core's channels (no two aliases share a socket,
  and the path stays under the macOS 103-byte socket limit). The `mux` folder is created with mode 0700. If it exists
  as a symlink, is owned by another user, or has any other mode, the channel is refused (state `down`) and the folder
  is left as it is; fix it yourself. A leftover socket in it is removed before a new master binds.
- **Pushed rows.** The master's session runs `nunchiro machine relay --stream`. It sends a hello line, then the remote
  core's session rows (with their waiting items) each time they change. The remote side reads its own core over the
  local socket every 200 ms; nothing crosses SSH unless the rows changed. The local core replaces that alias' rows
  with each line, so an item appears once however often it is sent. Snapshots no longer start SSH requests.
- **Requests.** `--machine` requests and answers ride the master (`-o ControlMaster=no -o ControlPath=…`) while it is
  up, and open their own connection otherwise. An answer leaves only for an item in the pushed rows and is taken out
  of them as it is sent, so a repeated answer is refused locally; a failed send puts it back. A push built before the
  remote applied the answer does not show the item again; once a push no longer holds it, its id is free again.
- **Answers while the channel is not up.** They still go, over their own SSH connection, from the last pushed rows.
  This is safe because the remote side checks again: the relay takes one answer per item id (it creates
  `NUNCHIRO_HOME/relay-answered/<id>` on the remote Mac once, swept after a day, and releases it whenever the answer
  did not apply: the core refused it, or the core could not be reached), and the remote queue answers only an item that
  is still pending. A claim left by a relay that died before applying does not block: if the item is still pending the
  next answer goes ahead. A retry after a lost reply whose answer did apply gets `already answered`, which counts as
  done and drops the row; if a second push after it still lists the item, the item shows again. An item the remote no longer
  holds gets
  `decision not found`, which is refused and drops the row. A local error before sending (such as recording the
  machine) leaves the item listed.
- **Reconnect.** A dropped master is retried after 1, 2, 4, 8, 16, then every 30 seconds; the first successful hello
  resets that. On each reconnect the relay sends the full current rows, so items raised during the gap arrive.
  While it is not up, the last rows stay with a problem card saying why.
- **Untrusted lines.** Each relay line is data: a malformed, unknown or repeated-hello line is dropped; rows with an
  invalid or repeated id, and items of another session, are dropped; a line over 8 MiB drops the master. No relay
  line answers or approves anything locally. ssh's stderr reaches only the status text, without control characters
  and cut to 512 characters.
- **State.** `nunchiro machine status` reports, for an alias with a channel, `channel`: `state` (`connecting`, `up`,
  `reconnecting`, `down`, `version_mismatch`), `since_ms`, `error`, `local_protocol`, `remote_protocol` and
  `remote_version`, without another SSH request. Settings > Advanced > Machines (V2-12m-b) reads the same.

## Version window

Local and remote compare the relay protocol (`nunchiro_core::machines::PROTOCOL`, now 2; 1 was the v1a relay), not
the package version. The local core accepts a remote on its own protocol or the previous one. A remote on an older or
newer protocol gives `version_mismatch` with both protocols and versions, which the problem card shows; the remote
core is not restarted, its agents keep running, and no request is sent to it until a later reconnect says hello on an
accepted protocol. A v1a remote has no `--stream` relay; it shows as `version_mismatch` (protocol 1). The relay
therefore accepts requests on its own protocol and the next one; a request without a
protocol (a v1a client) still needs exactly the same package version.

```sh
nunchiro machine status [<label>]
nunchiro --machine <m> ...
nunchiro --machine macbook session start --kind claude --project '/remote/project' --label worker
nunchiro --machine macbook agent prompt worker 'Reply with OK only.' --wait --until done
nunchiro --machine macbook agent read worker
nunchiro snapshot --json
```

Replace bracketed placeholders; `machine status` without a label checks configured and remembered
aliases. It reports `reachable`, `unreachable`, or `version_mismatch`, with an error when applicable.
Both cores must be within the version window below. Each SSH request has a six-second
wall-clock bound, including subprocess descendants; longer remote operations can have completed
when a timeout is reported. Inspect status before repeating a state-changing command.
The internal relay accepts a versioned JSON request on stdin and returns one serialized API result.
Requests are capped at 512 KiB and replies at 8 MiB, like the local socket protocol.
`NUNCHIRO_SSH` overrides the executable for fixtures; it is core startup configuration.

## Session authority

Owner calls (no `NUNCHIRO_TOKEN`, from outside every Nunchiro session) carry SSH user authority; the remote
CLI the SSH relay runs is outside the remote core's sessions, so it stays the owner there. A session's CLI always authenticates
to its local core first. For remote starts, the owner must configure a project mapping in the
local `NUNCHIRO_HOME/settings.json` **before starting the core**:

```json
{
  "machines": {
    "macbook": {
      "projects": {
        "/absolute/canonical/local/project": "/absolute/remote/project"
      }
    }
  }
}
```

A session passes that mapped remote path as `--project`. An unmapped project is refused. Remote
workers are recorded locally by alias, remote session ID and remote project, with the local
session as parent. Only that parent may prompt, send keys, read, wait on, close, label or answer
the worker. Existing permission, startup-dialog, composed-input and send-log guards also run on
the remote core; startup dialogs remain deny/Esc-only. Agents never receive a remote owner token.
The existing same-user threat model remains: these grants govern callers using session tokens,
and do not contain a hostile process with the user's filesystem/SSH authority.

Remote child grants are in memory and drop on a local core restart; remote workers continue
running. The owner can inspect and close them explicitly over SSH. A restarted local session
cannot reclaim them. A remote core restart also drops its defensive parent records; the local
parent must start new workers. Already authorized visible sends may finish remotely after a local restart. No restart replays approval answers.

`Session.machine` is absent for local sessions and equals the SSH alias on remote rows. Pending
queue items remain nested in their labelled session. Local snapshots return the last pushed remote
rows immediately; the first owner snapshot starts the channel, so it can have no remote rows. After an
outage cached rows carry a problem card until the channel is up again; use `machine status` for its
state and an explicit remote read before acting. Session-token snapshots filter
remote rows by the local child registry. The window's machine group is outside this ticket.

## Verification

```sh
cargo test -j 4 --workspace
scripts/scenario/remote.sh --fake
```

The fake scenario runs named CLI/socket/PTY integration checks. Each worker test starts an
isolated local and remote core under the worktree `.scratch/`, drives `fake-ssh`, uses only the
synthetic Claude/Codex fixtures, and stops its owned cores and agents. No SSH client is invoked.
No installed Claude or Codex is launched by `--fake`.

The real scenario is deliberately gated:

```sh
NUNCHIRO_REMOTE_APPROVED=1 NUNCHIRO_REMOTE_PROJECT=/remote/project \
  NUNCHIRO_REMOTE_CODEX_HEADROOM=1 scripts/scenario/remote.sh macbook
```

Run only after coordinator approval, installation and trust/headroom review. It uses the
ticket-01 local config guard and trivial Haiku/Codex prompts; it never answers startup trust.
Its local guard cannot prove the remote user's configuration stayed unchanged. Real hardware,
remote config inspection and real-agent compatibility remain coordinator acceptance work.
