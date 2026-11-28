# Triggers

A trigger is a schedule whose time is an event: when something outside Nunchiro calls it, it starts the agent run
you set up. A build script, a CI job, a GitHub webhook or another tool can call it; nothing that calls it can change
what it runs.

## Add one

In the window: Schedules, then Add trigger under the list. Or from the command line:

```sh
nunchiro trigger add fixer --on cli --kind claude --project ~/code/app \
  --task "Find why the checks failed and fix it."
```

- `--on cli`: fired with `nunchiro trigger fire fixer`.
- `--on webhook`: fired at `POST http://127.0.0.1:47800/hooks/<name>`. The command reads the shared secret from
  stdin (one line, at least 16 characters), so it never shows in a process list:
  `printf '%s\n' "$SECRET" | nunchiro trigger add ci --on webhook ...`.
- `--auto` starts the run at once. Without it the trigger asks first: a card in Decisions with the trigger, the agent
  and the project, and Start, Not now and Turn this trigger off. The card stays until the start has run, so a core
  that quits right after your Start keeps it for you to press again.
- `--label`, `--model`, `--effort` as for a schedule. The project must be one Nunchiro knows.

Only the owner adds, pauses (`trigger pause`, `trigger resume`) and removes triggers; `trigger list [--json]` shows
them with their last fire. `triggers.json` is written by the core alone, each entry under the same key as the
schedules, so an entry another program wrote or changed is refused.

- `--on github --repo owner/name --event checks_failed|changes_requested|labeled [--issue-label <label>]`: read from
  GitHub with your own `gh` every 2 minutes (settings.json `triggers_poll_secs` moves it) while the trigger is on. It
  fires once for each open pull request whose checks failed or whose review asked for changes (once per head commit),
  or each open issue or pull request with the label. What is there when the core first reads it is the starting point
  and fires nothing; a core restart starts from what is there again. `gh` keeps the login; Nunchiro reads no token.
  Pull request events watch your own pull requests (`--author @me`). `--any-author` (in the window, Anyone's) watches
  everyone's: on a public repository a stranger's pull request could then start a run, and with `--auto` a run
  with your agent's rights on code the stranger wrote. A fire that is held (its cards, its hour, a run of the same
  pull request still at work) is tried again on the next read. A start that fails (the project folder is gone, the
  agent will not start) is the trigger's last fire and is not tried again until the pull request has a new head commit. A trigger paused and resumed fires what appeared
  while it was off. A `gh` that fails (not installed, not logged in) shows as the trigger's last fire.

## Fire one

```sh
nunchiro trigger fire fixer --data @build.log      # or --data - to read stdin
```

The owner can fire any trigger. For a script or another tool, make a token that can do this and nothing else:

```sh
export NUNCHIRO_TOKEN=$(nunchiro token create --scope trigger)
```

A webhook request needs the trigger's secret: GitHub's `X-Hub-Signature-256` (set the webhook's secret to the same
value) or the header `X-Nunchiro-Secret: <secret>`. The address answers `202` with no body when it takes a request,
`401` without the secret (one line in the core's log), `404` for a trigger that does not exist, `413` for a body
over 256 KB. It listens on 127.0.0.1 only, and only while a webhook trigger is on; settings.json `triggers_port`
moves it. A request is not tied to a time: one captured on its way (a proxy log, a shared tunnel) can be sent again,
within the trigger's hourly limit, so keep the secret and the tunnel private. A service on the internet reaches it only through your own tunnel (for example Tailscale Funnel or
cloudflared); Nunchiro runs no server anywhere else.

## What the session gets

The first message is your task, then what the caller sent, fenced and marked as data:

```
Find why the checks failed and fix it.

From a webhook, shown as data:
~~~~
{"action": "completed", ...}
~~~~
```

The payload is cut at 4 KB and redacted as the logs are (tokens and keys). Nothing in it is read as an instruction
or a field: it is only text after your task.

## Limits

- At most 4 fires an hour per trigger, taken as each fire arrives (fires at the same moment cannot pass it together);
  a fifth is refused with the reason and logged as the trigger's last fire. A fire whose start fails gives its place back.
- An asking trigger keeps at most 3 cards waiting in Decisions; a fire past that is held (logged as its last fire
  with the reason) and gives its hourly place back, so one busy trigger never fills the cards everything else needs. All triggers'
  waiting cards together take at most half of the owner's cards (32); a fire past that is held the same way.
- One run per subject at a time: a payload's pull request or issue URL, or its `subject` or `url` field. A fire for
  a subject whose earlier run is still starting, waiting on its card or working starts nothing.
- A start a plugin's check stops or the Mac's memory holds is logged as the trigger's last fire with the reason.
- A trigger starts Claude or Codex in a known project; it never runs a shell, takes arguments or picks an account.

## Not yet

- A GitHub mention event.
- Slack and Linear signatures (use `X-Nunchiro-Secret` from a relay).
- Agents proposing a trigger.
- The address reads at most 8 requests at once, each within 10 seconds; a connection past 8 is closed unanswered.
