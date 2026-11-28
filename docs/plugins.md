# Plugins

A plugin adds panels, commands and settings to Nunchiro. It is one folder with a `plugin.toml` and the files it
names; no build step and no SDK. Every part runs in the same sandbox as a script widget, and nothing runs for you
until you have reviewed the plugin's files and turned it on. The one exception is its author's `nunchiro plugin
check`, which runs each part once with no network and none of the folders the plugin asks to read.

## Make one

```sh
nunchiro plugin new hello            # writes $NUNCHIRO_HOME/plugins/hello/
nunchiro plugin check hello          # checks plugin.toml and runs each part once: no network, no extra reads
nunchiro plugin allow hello          # approve these exact files (or Review in the window)
nunchiro plugin on hello
nunchiro plugin run hello hello      # run its command now
```

A working example is in [`api/examples/plugins/quiet-hours`](api/examples/plugins/quiet-hours): a panel that shows
whether it is quiet time and how many agents are working, a palette command that says the same in one line, two time
settings, and a check that refuses new agent sessions an agent, a schedule or a token starts in quiet time. Copy the folder to `$NUNCHIRO_HOME/plugins/quiet-hours/` to try it.

## `plugin.toml`

The schema is [`api/plugin.schema.json`](api/plugin.schema.json). The first line of a starter,
`#:schema <url of that file>`, gives completion and checks in editors that read it (Taplo, Even Better TOML).
Unknown keys refuse the whole file.

```toml
id = "quiet-hours"            # the folder's name: a-z, 0-9, - and _
name = "Quiet hours"
version = "0.1.0"
about = "One line."
author = "You"                # optional
nunchiro = ">=0.1"            # optional; shown, not enforced yet

[[setting]]                   # a value set on the Plugins page; every run gets it
key = "start"
label = "Quiet from"
type = "time"                 # text, number, bool, time (HH:MM) or choice (with choices = [...])
default = "22:00"

[[panel]]                     # a panel in the Widget library
name = "now"
title = "Quiet hours"
kind = "script"               # script: prints text or JSON (an array of objects is a table); web: entry = "page.html"
command = ["/bin/sh", "panel.sh"]
interval_secs = 60
network = []                  # hosts it may reach
read = []                     # folders outside the project it may read

[[command]]                   # a row in the command palette
name = "status"
title = "Quiet hours: am I in quiet time?"
command = ["/bin/sh", "status.sh"]
show = "note"                 # note, panel, or send (the focused agent's composer, as a draft it never sends itself)

[[keybinding]]                # a shortcut for one of its commands (at most 16)
command = "status"
key = "Control+Alt+KeyQ"      # the window's key names; Control, Alt or Meta, then one key. A key the window or you
                              # already hold stays yours.

[[status]]                    # an item in the status bar (at most 2); pressing it runs its command
name = "quiet"
text = "Quiet"                # 1 to 24 characters
command = "status"            # optional
```

A panel takes the fields of a script or web widget's `widget.toml`, and every part is checked by the same rules: a
command is an argv, never a shell string or `sh -c`; it names files inside the plugin folder or a program in a
system folder (`/usr/bin`, `/bin`, ...), never `..`; text has no hidden or bidi characters. One sentence says
what is wrong.

## What a part reads and does

A part runs with its working folder set to a copy of the approved files. `$NUNCHIRO_CONTEXT` is a JSON file:

```json
{"event": "panel", "plugin": "quiet-hours", "part": "now",
 "settings": {"start": "22:00", "end": "07:00"},
 "projects": [{"name": "app"}], "sessions": [{"label": "fix-login", "project": "app", "state": "working"}]}
```

`$NUNCHIRO_PROJECT_DIR` is the project of the placement, when there is one. `$HOME` is empty and new each run; it
may write only its cache, reach only the `network` hosts, and read only the project, its cache, system tools and
`read`. A run stops after 5 seconds.

## Approval and the switch

A plugin is one approval, for what it can reach: every part, and each host, folder, message box and action a part
reaches. It starts off and not approved. A change that asks for nothing new (its scripts, its texts, a new version
from the catalogue) stays approved and stays on; the Plugins page says it changed. A change that adds a part, a host,
a folder it reads, writing into the message box or a check shows it as "Changed since approval", stops every part
until it is approved again, and Review lists what is new. An approval given before this rule asks again after any
change.
Approving and turning on are the owner's: an agent can write and check a plugin, and its `plugin allow` becomes one
waiting item in the window. A plugin is approved whole (`plugin:<id>`); a part's name is never approved alone. The
sheet and `plugin allow` list every part with what it runs, its hosts, the folders it reads and whether it writes
into the message box. Turning a plugin off or removing it stops a part that is still running; removing it also
drops its approval. Script parts also need the `script_widgets` setting; a web panel needs `web_widgets`.
`plugin list` says which one is off.

## Checks (`[[gate]]`)

A check runs before an action and may refuse it, at two places only:

- `on = "session.start.before"`: before every new agent session: the owner's CLI and window, an agent's or a
  token's start (also a resumed conversation, and a start sent to or from another machine), a teammate's seat that
  is not open yet, a new conversation, the Reviewer a lead's task starts, a schedule. A plain terminal is not checked,
  nor a conversation the owner or a schedule resumes.
- `on = "prompt.send.before"`: before a message an agent, a schedule or a token sends is delivered: `agent prompt`,
  `agent send`, `session send-text`, Send now, room sends and replies, a schedule's task, and the same sent through
  another machine. What the owner types in the window or in their own terminal never reaches a check. A `nunchiro`
  command run inside a Nunchiro terminal tab is that session's request, as every command there is (the core cannot
  tell a person typing in that tab from a program the session runs), so it is checked like an agent's.

```toml
[[gate]]
name = "starts"
on = "session.start.before"
command = ["/bin/sh", "gate.sh"]
on_error = "allow"            # or "refuse" (the default): what no answer, a crash or bad JSON means
```

`$NUNCHIRO_CONTEXT` holds `event`, `asker` (`owner`, `agent`, `schedule`, `token`, `trigger`), `settings`, and `start` (`kind`,
`project`, `worktree`, `label`) or `to` and `text`. The check prints one line:

```json
{"allow": true}
{"allow": false, "reason": "Quiet hours until 07:00."}
{"allow": true, "text": "the message to deliver instead"}
```

Checks run for plugins that are on and approved as they are now, plugins in id order and checks in manifest order;
the first refusal ends it. A check has 5 seconds; then it is stopped and `on_error` decides. All the checks of one
action have 10 seconds together, waiting for a check's turn included; a check that gets no time counts as one that
did not answer, and its `on_error` decides, so the caller always hears back within the budget. Each run gets its own input, and two runs of one
check take turns. The window's starts run off its frame loop while a start check is on. A refused owner start
says `<plugin> stopped this start: <reason>` with Start anyway (`agent start --anyway` in a terminal); an agent, a
schedule or a token gets the sentence and cannot pass it. A replaced message (at most 16 KB) is delivered instead of
the original and says "Changed by <plugin>" where the window shows it: the room message and the agent's chat. A
session's send row (`nunchiro snapshot --json`) also keeps the original; a room message keeps only the plugin's name,
since the room is what every seat in it reads and the original there would deliver the words the plugin took out. A
schedule's changed task leaves a line in the core's log. With `on_error = "allow"`, a check that got no time in a
busy action is skipped: the core's log says so, and the Plugins page counts the skipped checks. A check cannot answer a permission, skip an outward card or widen
anything: allow, refuse and replacement text are its only outputs. With no plugin on, nothing is run.

## Browse and install

Plugins, Browse plugins (or `nunchiro plugin catalog`) lists the catalogue: `plugins/catalog.json` of the Nunchiro
repository on GitHub. Each entry pins a plugin to one commit and lists every file with its SHA-256. Install (or
`nunchiro plugin install <id>`) downloads exactly those files at that commit and writes `plugins/<id>` only when every
hash matches; one file changed after the catalogue was made installs nothing. An installed plugin is off and not
approved, so it runs nothing until you review it. When the catalogue has a newer version, the button says Update;
the old folder moves to `plugins/.removed/` and the new one asks for approval again.

The catalogue also keeps a kill list (`plugins/kill-list.json`): a plugin found harmful, every copy or only some
commits, with the reason. A plugin on it is not installed, and an installed copy is turned off, says why on the
Plugins page and cannot be turned on. Nunchiro reads the list on each install and again every 6 hours while a plugin
from the catalogue is installed; a list it cannot read leaves the last one it read in force.

The catalogue holds Nunchiro's own examples for now. It is a folder of the main repository, read from GitHub the
way a separate catalogue repository would be; `scripts/plugin-catalog.py` writes it.

## Through the API

The window and scripts use the same request, `{"op": "plugin", "action": {"do": "list"}}` (also `set`, `setting`,
`run`, `remove`, `catalog`, `install`), owner and window only; see [api.md](api.md). A panel is the widget `plugin__<id>__<panel>` in
`widget_list` and `widget_run`.

## Not yet

- Skills, hooks and MCP servers in a plugin (today they are extension folders, `nunchiro extensions`).
- Plugins from outside the catalogue by a git URL and commit; submissions to the catalogue.
