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
whether it is quiet time and how many agents are working, a palette command that says the same in one line, and two
time settings. Copy the folder to `$NUNCHIRO_HOME/plugins/quiet-hours/` to try it.

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

A plugin is one approval: the hash of its whole folder (the `cache` folder aside). It starts off and not approved,
and any change to any file shows it as "Changed since approval" and stops every part until it is approved again.
Approving and turning on are the owner's: an agent can write and check a plugin, and its `plugin allow` becomes one
waiting item in the window. A plugin is approved whole (`plugin:<id>`); a part's name is never approved alone. The
sheet and `plugin allow` list every part with what it runs, its hosts, the folders it reads and whether it writes
into the message box. Turning a plugin off or removing it stops a part that is still running; removing it also
drops its approval. Script parts also need the `script_widgets` setting; a web panel needs `web_widgets`.
`plugin list` says which one is off.

## Through the API

The window and scripts use the same request, `{"op": "plugin", "action": {"do": "list"}}` (also `set`, `setting`,
`run`, `remove`), owner and window only; see [api.md](api.md). A panel is the widget `plugin__<id>__<panel>` in
`widget_list` and `widget_run`.

## Not yet

- Skills, hooks and MCP servers in a plugin (today they are extension folders, `nunchiro extensions`).
- Checks that can refuse a start or a message (`[[gate]]`) and a catalogue to install from.
