# Privacy

Draft for the owner's approval (ticket 1130). Nothing in this file is approved yet.

Nunchiro has **no telemetry**: it sends no usage data, crash reports or analytics anywhere. It does not call a model
itself. When Nunchiro runs `gh`, it sets `GH_TELEMETRY=0`.

What leaves your Mac is listed below. `tests/scenario/test_outbound_hosts.py` fails when the shipped source names an
`https://` host that the tables below do not name, so a new connection cannot ship unlisted.

## What Nunchiro connects to by itself

| Host | When | What is sent |
|---|---|---|
| `registry.npmjs.org` | When the app reads the state of installed agent tools (Claude Code, Codex, Gemini CLI, opencode): at most once an hour for each installed tool | The public package name, to read its latest version |
| `github.com` | Only in the official signed release: an update check every 10 minutes for `latest.json` in this repository's GitHub Releases | A plain download request |
| `github.com` | Pull request badges and actions, through your own `gh` sign-in; "Install and restart" of a folder build reads `main` of this repository | What `gh` and `git` send for your account and repository |

## What connects only when you act

| Host | When | What is sent |
|---|---|---|
| `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`, `cdn.tailwindcss.com`, `code.jquery.com` | After you approve a script library that an artifact page names: the file is downloaded once at its pinned version, then served from the cache | A download request for that file |
| `raw.githubusercontent.com` | "Browse themes online" in the theme settings | Download requests for theme files at a pinned commit |
| `www.google.com`, `duckduckgo.com`, `www.bing.com`, `kagi.com` | A search typed in the browser widget goes to the engine you chose; pages you open there load as in any browser | Your search text |
| `claude.ai` | A claude.ai artifact link in a chat shows as a link; it opens when you click it | Nothing until you click |

## Links only

These hosts appear only as links you can click (install pages, documentation, credits) or as text. Nunchiro does not
contact them.

| Host | Why it is named |
|---|---|
| `cli.github.com`, `git-scm.com`, `gitlab.com`, `gitea.com`, `learn.microsoft.com`, `www.npmjs.com` | Install and help links in Settings > Git |
| `code.claude.com`, `docs.claude.com`, `developers.openai.com`, `pi.dev` | Agent install and documentation links |
| `platform.claude.com` | The source of the price list behind cost estimates, shown as text |
| `www.svengreb.de` | A theme credit |
| `api.cdnjs.com` | The source of the library hashes that ship with the app; read when the list was made, not at run time |

## What Nunchiro does not control

- **Your agents.** Claude Code, Codex and other agents talk to their own vendors with your own sign-in. Their traffic
  goes directly from the agent; Nunchiro does not read, proxy or change it. Each vendor's own privacy terms apply.
- **Other Macs you add.** Machines in Settings > Advanced > Machines connect over your own SSH configuration.
- **Git.** Agents and you can fetch from and push to your repositories' remotes.

Everything Nunchiro stores stays on your Mac in `~/.nunchiro`.
