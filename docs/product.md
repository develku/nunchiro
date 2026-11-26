# Product direction

Owner's decision, 2026-11-26 (owner). This page is where builders read who Nunchiro is for, what it is not, and where it
must lead. Ordered next work is in the roadmap.

## Who it is for

One person's agent company. A solo developer on a Mac runs several coding agents at once (Claude Code and Codex, plus
ACP agents) and directs them like a small company: coding is the main department, and Assistants (mail, calendar,
inbox) are the office. Typical day: three to six agents in parallel, many permission requests and questions, a lead
agent that splits and reviews work.

## Who it is not for

- People who use one agent at a time. A terminal or Claude Desktop serves them better.
- People who want to call models with their own API key. Nunchiro never calls a model; it runs the user's own `claude`
  and `codex` installs and sign-ins.
- Windows and Linux users (maybe later; the core is macOS only today).
- Centrally managed company fleets (maybe later; no SSO, central policy or audit console).

## How it differs

As easy for multi-agent work as the peer apps, but opinionated: it carries the owner's own way of working (one queue
for everything waiting on you, a lead with a team, standing bots, handoff to a new conversation).

| Peer | What it is | Where Nunchiro differs |
|---|---|---|
| Orca | Electron workspace, richest design tools | Much lighter (Orca 1,091 MB measured, docs/research/landscape.md; Nunchiro idle 282 MiB); one approval queue across agent kinds; asks before outward actions for every agent |
| T3 Code | Electron + Node, orchestrator, ACP registry | Native core and real terminals; T3 defaults to full access with no outward gate (packages/contracts/src/providerPolicy.ts:32) |
| herdr | Rust TUI multiplexer | A GUI with chat, files, diff and cards per session, not only panes |
| Claude Desktop | Anthropic's chat app with a Code tab | Used alongside it, not instead: Claude Desktop for conversation and planning, Nunchiro to run and watch many coding agents of several kinds in one window |

## Where it must lead

1. Speed and lightness.
2. Extensibility (agents, skills, hooks, MCP, ACP).
3. Bot quality (standing teammates and Assistants that do their job well).
4. Accuracy of the multi-agent functions (the right card at the right time, nothing missed, nothing sent outward
   without the owner), including the lead and team redesign (ticket 1163).

## Measured so far

From the official scorecard (docs/measure/scorecard.html, main a04c8ec8f, 2026-11-26):

- Warm launch 0.47 s, cold launch 1.15 s, core start 0.19 s, send to agent 4.1 ms (p15 Speed 98).
- Idle memory 282 MiB, idle CPU 2.5 % (p14).
- Outward approval covers Claude, Codex and ACP sessions (p25 SE3 pass).
- Peer tasks in docs/measure/tasks.json: first-use and usability step counts against the best peer (p13, p04).

Not yet measured: missed questions per day and agent wait time, which would show the "nothing missed" claim directly.
