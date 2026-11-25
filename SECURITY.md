# Security

Please report a security problem privately: open this repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue for it.

Include what you did, what happened, your macOS version and the output of `nunchiro --version`. If you attach a
`nunchiro diagnose` bundle, read it first: it removes secrets it knows about, but it can still hold paths and project
names.

## Supported versions

Nunchiro is pre-release. Only the latest commit of `main` gets fixes. There is no stable release yet.

## Scope

In scope: the Nunchiro app, the `nunchiro` command and its background service, and the update path.

Out of scope: the agents Nunchiro runs (Claude Code, Codex and others). Report a problem in an agent to its vendor.
Nunchiro runs agents as your user, with the permissions you give them.

What Nunchiro sends over the network is listed in [PRIVACY.md](PRIVACY.md).
