# Triggers

A trigger is a schedule whose time is an event: when something outside Nunchiro calls it, it starts the agent run
you set up. A build script, a CI job, a GitHub webhook or another tool can call it; nothing that calls it can change
what it runs.

## Add one

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
- One run per subject at a time: a payload's pull request or issue URL, or its `subject` or `url` field. A fire for
  a subject whose earlier run is still starting, waiting on its card or working starts nothing.
- A start a plugin's check stops or the Mac's memory holds is logged as the trigger's last fire with the reason.
- A trigger starts Claude or Codex in a known project; it never runs a shell, takes arguments or picks an account.

## Not yet

- A GitHub event read by polling with your `gh` (use a GitHub webhook to this address for now).
- Slack and Linear signatures (use `X-Nunchiro-Secret` from a relay).
- Adding triggers in the window; agents proposing a trigger.
- The address reads at most 8 requests at once, each within 10 seconds; a connection past 8 is closed unanswered.
