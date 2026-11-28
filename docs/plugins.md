# Plugins

A plugin adds panels, commands, settings, shortcuts, status bar items and checks to Nunchiro. It is one folder with a
`plugin.toml` and the files it names; no build step and no SDK. Every part runs in the same sandbox as a script
widget, and nothing runs for you until you have reviewed the plugin's files and turned it on. The one exception is
its author's `nunchiro plugin check`, which runs each part once with no network and none of the folders the plugin
asks to read.

This page is for anyone who writes a plugin, for themselves or for others: it walks through a first plugin, then
lists every field, what each part may do, what the owner approves, how to test, and how a plugin gets into the
catalogue. The commands are in [cli.md](cli.md#plugins).

## Quick start (5 minutes)

You need the `nunchiro` command (see [first-run.md](first-run.md)) and the `script_widgets` setting on (Settings >
Layout in the window, or `"script_widgets": true` in `$NUNCHIRO_HOME/settings.json`): script parts run only while it
is on. To try things without touching your own setup, point `NUNCHIRO_HOME` at an empty folder; the commands below
then start and use a core of their own for that folder (`nunchiro serve stop --yes` stops it).

**1. Make a starter.** `--with` picks the parts (`panel`, `command`, `setting`, `gate`; all four by default):

```console
$ nunchiro plugin new hello --with command,setting
created ~/.nunchiro/plugins/hello: edit plugin.toml, run `nunchiro plugin check hello`, then review and turn it on in Settings > Plugins (or `nunchiro plugin allow hello` and `nunchiro plugin on hello`)
```

(The line names the full path of your `NUNCHIRO_HOME`.) It writes `plugin.toml` and `command.sh`, and never replaces a file. The manifest:

```toml
#:schema https://raw.githubusercontent.com/develku/nunchiro/main/docs/api/plugin.schema.json
id = "hello"
name = "hello"
version = "0.1.0"
about = "What this plugin does, in one line."

[[setting]]
key = "greeting"
label = "Greeting"
type = "text"
default = "Hello"

[[command]]
name = "hello"
title = "Say hello"
command = ["/bin/sh", "command.sh"]
show = "note"
```

**2. Check it.** `plugin check` reads `plugin.toml` by the core's rules and runs each part once:

```console
$ nunchiro plugin check hello
hello 0.1.0 (0 panels, 1 commands, 1 settings)
ok	hello	Hello from a plugin command.
```

**3. Edit it.** Make the command count the agents that are working. Replace `command.sh` with:

```sh
#!/bin/sh
# Prints the greeting setting and how many agent sessions are working.
greeting=$(/usr/bin/sed -n 's/.*"greeting":"\([^"]*\)".*/\1/p' "$NUNCHIRO_CONTEXT")
working=$(/usr/bin/grep -o '"state":"working"' "$NUNCHIRO_CONTEXT" | /usr/bin/wc -l | /usr/bin/tr -d ' ')
echo "${greeting:-Hello}: $working agents working."
```

```console
$ nunchiro plugin check hello
hello 0.1.0 (0 panels, 1 commands, 1 settings)
ok	hello	Hello: 0 agents working.
```

**4. Approve and turn it on.** A new plugin is off and not approved. `plugin allow` prints what each part runs and
reaches, then approves the files as they are now (Review on the Plugins page does the same):

```console
$ nunchiro plugin list
hello	off	not approved
$ nunchiro plugin allow hello
command hello: /bin/sh command.sh
  network: none; reads beyond its project: none
approved plugin hello
$ nunchiro plugin on hello
hello	on	approved
```

**5. Run it.** The command is now a row in the command palette ("Say hello"); from a terminal:

```console
$ nunchiro plugin run hello hello
Hello: 0 agents working.
```

**6. Change it.** Editing a script keeps a plugin without a check approved. Adding access asks again, and every part
stops until you approve it:

```console
$ echo '# a comment' >> ~/.nunchiro/plugins/hello/command.sh
$ nunchiro plugin list
hello	on	approved
$ # add network = ["api.github.com"] to the [[command]] table
$ nunchiro plugin list
hello	on	changed since approval
$ nunchiro plugin run hello hello
nunchiro: needs approval: plugin changed since it was approved
```

A working example with every kind of part is in [`api/examples/plugins/quiet-hours`](api/examples/plugins/quiet-hours):
a panel that shows whether it is quiet time and how many agents are working, a palette command that says the same in
one line, two time settings, and a check that refuses new agent sessions an agent, a schedule or a token starts in
quiet time. Install it with `nunchiro plugin install quiet-hours`, or copy the folder to
`$NUNCHIRO_HOME/plugins/quiet-hours/`.

## `plugin.toml`

The schema is [`api/plugin.schema.json`](api/plugin.schema.json); it is generated from the core's own types, so it is
the source of truth for field names and types. The first line of a starter, `#:schema <url of that file>`, gives
completion and checks in editors that read it (Taplo, Even Better TOML). Unknown keys refuse the whole file, and the
file is at most 64 KB.

```toml
id = "quiet-hours"            # the folder's name: a-z, 0-9, - and _ (up to 64, not starting with - or _, no __)
name = "Quiet hours"
version = "0.1.0"
about = "One line."
author = "You"                # optional; shown on the approval sheet ("unknown" without it)
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
key = "Meta+Alt+KeyQ"         # the window's key names; Meta always (so no terminal or typed key is taken), then
                              # one key. A key the window or you already hold stays yours.

[[status]]                    # an item in the status bar (at most 2), shown with the plugin mark; pressing it
                              # runs its command. A change of its text asks for approval again.
name = "quiet"
text = "Quiet"                # 1 to 24 characters
command = "status"            # optional

[[gate]]                      # a check before an action; see "Checks" below
name = "starts"
on = "session.start.before"
command = ["/bin/sh", "gate.sh"]
on_error = "allow"
```

| Table | Fields (required in bold) | Notes |
| --- | --- | --- |
| top level | **`id`**, **`name`**, **`version`**, `about`, `author`, `nunchiro` | `id` must equal the folder's name. |
| `[[setting]]` | **`key`**, **`label`**, **`type`**, `default`, `choices` | `default` must be a value of `type`; a `choice` needs `choices`. A text value is at most 1000 bytes. |
| `[[panel]]` | **`name`**, **`kind`**, `title`, `command` (script), `entry` (web), `interval_secs`, `network`, `read` | The fields of a widget's `widget.toml`. |
| `[[command]]` | **`name`**, **`command`**, `title`, `show`, `network`, `read` | `show` defaults to `note`. |
| `[[gate]]` | **`name`**, **`on`**, **`command`**, `title`, `on_error`, `network`, `read` | `on_error` defaults to `refuse`. |
| `[[keybinding]]` | **`command`**, **`key`** | `command` names one of its commands. |
| `[[status]]` | **`name`**, **`text`**, `command` | `command` names one of its commands. |

Panels, commands and checks are its parts: at most 32 together, each name unique among them, a-z, 0-9, `-` and `_`
with no `__`, and the id and a part's name together up to 54 characters. Every part is checked by the rules of a
widget's manifest: a command is an argv, never a shell string or `sh -c`; it starts with a file inside the plugin
folder or a program in a system folder (`/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, `/opt/homebrew/bin`,
`/usr/local/bin`); no argument names a path outside the plugin folder (so `/dev/null` belongs in a script, not in
the argv); text has no hidden or bidi characters. One sentence says what is wrong.

## What a part reads and does

A part runs with its working folder set to a copy of the approved files. `$NUNCHIRO_CONTEXT` is a JSON file:

```json
{"event": "panel", "plugin": "quiet-hours", "part": "now",
 "settings": {"start": "22:00", "end": "07:00"},
 "projects": [{"name": "app"}], "sessions": [{"label": "fix-login", "project": "app", "state": "working"}]}
```

`event` is `panel` or `command` (a check gets its own, below). `settings` holds each setting's stored value, else its
default. `$NUNCHIRO_PROJECT_DIR` is the project of the placement, when there is one (`plugin run` runs with none).
`$NUNCHIRO_CACHE` is the part's own folder that lasts between runs (at most 64 MiB; it is `cache/<part>` in the
plugin folder, and a top-level `cache` folder is never part of what is approved, so do not ship files in one).
`$HOME` is empty and new each run; a part may write only its cache, reach only its `network` hosts (HTTPS on port
443, public addresses only, through the sandbox's proxy), and read only the project, its cache, system tools and its
`read` folders. A run stops after 5 seconds, and its output is capped at 1 MiB.

What each part does with its output:

- **Script panel**: what it prints is shown in the panel, every `interval_secs` while the panel is shown. Plain text
  is shown as text; JSON is shown as JSON, and an array of objects as a table (at most 500 rows and 64 columns).
- **Web panel**: `kind = "web"` and `entry = "page.html"` serve that file from the plugin folder as a web widget. It
  needs the `web_widgets` setting as well (`"web_widgets": true` in `settings.json`).
- **Command**: a row in the command palette, also run by its shortcut, its status item or `nunchiro plugin run`.
  `show = "note"` shows its output as a note, `show = "panel"` in a panel, and `show = "send"` puts it into the
  focused agent's message box as a draft for you to send. A draft is at most 4000 characters, with no hidden
  characters and no line that starts a slash or shell command; otherwise nothing goes into the message box and the
  run says why.
- **Setting**: a field on the Plugins page; every run of every part gets its value in `settings`.
- **Shortcut** and **status item**: ways to run one of its commands.
- **Check**: may refuse an action or replace a message (below).

Programs: use `/bin/sh` and the tools of `/bin` and `/usr/bin` by their full path, or a binary you ship in the folder.
A tool that needs files outside the sandbox does not run in it: on a Mac with developer tools, `/usr/bin/python3` is a
stub that loads Xcode and fails with `file system sandbox blocked open()`.

## Approval and the switch

A plugin is one approval, for what it can reach: every part, and each host, folder, message box and action a part
reaches. It starts off and not approved. A change that asks for nothing new (its scripts, its texts, a removed part,
a new version from the catalogue) stays approved and stays on; the Plugins page says it changed (`"updated": true` in
`plugin list --json`). A change that adds a part, a host, a folder it reads, writing into the message box, a
shortcut, a status item or a new status text, or a check shows it as "Changed since approval", stops every part until
it is approved again, and Review lists what is new. An approval given before this rule asks again after any change.
A plugin with a check asks again after any change, its scripts included, because a check reads and can replace every
message agents, schedules and tokens send. The access lines also name each part's command line, a panel's interval,
what a failing check does and the author.

| A change of | Plugin without a check | Plugin with a check |
| --- | --- | --- |
| a script, a title, `about`, `version`; a removed part | stays approved | asks again |
| a new part, host (`network`), folder (`read`), `show = "send"`, shortcut, status item or status text; a part's `command` argv, a panel's `interval_secs` or kind, a check's `on` or `on_error`, the `author` | asks again | asks again |

Approving and turning on are the owner's: an agent can write and check a plugin, and its `plugin allow` becomes one
waiting item in the window. A plugin is approved whole (`plugin:<id>`); a part's name is never approved alone. The
sheet and `plugin allow` list every part with what it runs, its hosts, the folders it reads and whether it writes
into the message box. Turning a plugin off or removing it stops a part that is still running; removing it also
drops its approval. Script parts also need the `script_widgets` setting; a web panel needs `web_widgets`.
`plugin list` says which one is off (`approved, needs the web_widgets setting`).

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

`plugin check` runs a check on a made-up input: a start by an `agent` of kind `claude` in `/tmp/sample-project`, or
a message from an `agent` to `sample` saying `A sample message.`, and prints whether it allowed or refused it.

## Test it: `plugin check`

`nunchiro plugin check <id>` works before and without an approval, and inside an agent session too: it touches only
the plugin's folder. It reads `plugin.toml` by the same rules as the core, then runs each script panel, command and
check once in the sandbox with no network, no `read` folders, no projects and no sessions, and the current settings.
A web panel is only checked for its entry file. It prints one line per part and exits 1 when any part failed:

```console
$ nunchiro plugin check quiet-hours
Quiet hours 0.1.0 (1 panels, 1 commands, 2 settings)
ok	now	[{"now":"22:57","quiet from":"22:00","until":"07:00","quiet":"yes","agents working":0}]
ok	status	Quiet time until 07:00; 0 agents still working.
ok	starts	refused the sample: Quiet hours until 07:00.
```

With `script_widgets` off, each script part says `checked, not run: script widgets are off (Settings > Layout)`.
A part that needs its network can only fail here (`curl: (56) CONNECT tunnel failed, response 403`); try it with
`plugin run` after approving it.

What it says, and what to do:

| `plugin check` says | Fix |
| --- | --- |
| ``invalid plugin.toml: unknown field `colour`, expected one of ...`` | A misspelt or unsupported key; the schema lists every field. |
| `plugin.toml id "other" is not its folder's name "t1"` | Rename the folder or the `id`. |
| `go: inline script (-c) for sh is refused; put the script in a file in the plugin folder` | Move the script into a file and run `["/bin/sh", "go.sh"]`. |
| `go: command path "../x.sh" is outside the plugin folder; name a file in the folder, or as the program a binary in /usr/bin, ...` | Keep every file the argv names in the folder; write other paths inside a script. |
| `failed go sandbox command failed: /bin/sh: missing.sh: No such file or directory` | The file is missing or misnamed. |
| `failed go sandbox command failed: ... (file system sandbox blocked open())` | The program reads outside the sandbox; use another one (see Programs above). |
| `failed slow timed out after 5 s` | Make the part faster, or keep its slow work in the cache between runs. |
| `failed g answered "yes", not {"allow": true\|false, "reason": "..."}` | A check prints exactly one JSON answer. |
| `failed web entry page.html is missing` | Add the web panel's entry file. |
| `shortcut "Control+KeyQ" is invalid or repeated: use modifiers with Meta among them, then one key, as Meta+Shift+KeyH` | Add `Meta`; use one key code (`KeyA`-`KeyZ`, `Digit0`-`Digit9`, `F1`-`F12`, `Comma`, `Enter`, `ArrowUp`, ...). |
| `status item s: its text is 1 to 24 plain characters` | Shorten the text. |
| `choice setting mode needs choices` | Add `choices = ["a", "b"]`. |
| `setting at default: not a time value` | Write the default as its type: time is `HH:MM` (`"07:00"`). |

After the check, approve and run it for real: `plugin run <id> <command>` runs a command now with its network and
folders, and prints its output or the error (`plugin <id> has no command <name>`, `plugin <id> is off`, `needs
approval: plugin changed since it was approved`).

## Browse and install: the catalogue

Plugins, Browse plugins in the window (or `nunchiro plugin catalog`) lists the catalogue: `plugins/catalog.json` of
the Nunchiro repository on GitHub. Each entry pins a plugin to one commit and lists every file with its SHA-256.
Install (or `nunchiro plugin install <id>`) downloads exactly those files at that commit and writes `plugins/<id>`
only when every hash matches; one file changed after the catalogue was made installs nothing. An installed plugin is
off and not approved, so it runs nothing until you review it. When the catalogue has a newer version, the button says
Update; the old folder moves to `plugins/.removed/` and the new one asks for approval again.

```console
$ nunchiro plugin catalog
quiet-hours	0.1.0	Quiet hours: Shows whether it is quiet time and which agents are still working.
$ nunchiro plugin install quiet-hours
installed plugin quiet-hours: off; it runs nothing until you review it with `nunchiro plugin allow quiet-hours` and turn it on with `nunchiro plugin on quiet-hours`
```

The catalogue also keeps a kill list (`plugins/kill-list.json`): a plugin found harmful, every copy or only some
commits, with the reason. A plugin on it is not installed, and an installed copy is turned off, says why on the
Plugins page and cannot be turned on. Nunchiro reads the list on each install and again every 6 hours while a plugin
from the catalogue is installed; a list it cannot read leaves the last one it read in force.

The catalogue holds Nunchiro's own examples for now. It is a folder of the main repository, read from GitHub the
way a separate catalogue repository would be. An entry is made by `scripts/plugin-catalog.py <plugin folder>`, run on
`main` after the plugin's folder has landed: it pins the last commit that changed the folder and hashes every file.
A catalogued plugin is at most 50 files of up to 256 KB each. There is no submission process for outside plugins
yet; to share one now, share its folder, which the receiver copies to `$NUNCHIRO_HOME/plugins/<id>/` and reviews like
any other.

## Through the API

The window and scripts use the same request, `{"op": "plugin", "action": {"do": "list"}}` (also `set`, `setting`,
`run`, `remove`, `catalog`, `install`), owner and window only; see [api.md](api.md). `setting` (`id`, `key`,
`value`) is the only way to set a value outside the Plugins page. A panel is the widget `plugin__<id>__<panel>` in
`widget_list` and `widget_run`.

## Limits and what a plugin never does

- Parts: 32 panels, commands and checks; 16 shortcuts; 2 status items; `plugin.toml` up to 64 KB.
- Each run: 5 seconds, 1 MiB of output, 64 MiB of cache; all the checks of one action, 10 seconds.
- A plugin never answers a permission prompt, approves itself, sends a message by itself (a draft waits for you),
  skips an outward card, reads your home folder or other projects unless the owner approved those `read` folders, or
  reaches a host it did not declare.
- A plugin's keys never take one the window or you already hold, nor one without `Meta`.
- Not in a plugin today: Claude plugins as they are, hooks, MCP servers (local or remote) and skills. Skills, hooks and
  MCP servers are extension folders today (`nunchiro extensions`). Plugin skills are proposed in
  [pull request #208](https://github.com/nunchiro/nunchiro/pull/208) and are not merged.
- Not yet: plugins from outside the catalogue by a git URL and commit; submissions to the catalogue.
