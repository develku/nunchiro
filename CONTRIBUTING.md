# Contributing to Nunchiro

Bug fixes and small, focused changes are welcome. Nunchiro is built by one maintainer with a team of coding agents, so
review time is the limit: a small pull request with a clear reason gets in fastest.

## Before you write code

- **Open an issue first** for anything other than a typo or an obvious bug fix. Say what you want to change and why.
  Wait for a reply before you build a new feature; a pull request for a feature with no agreed issue may be closed.
- **Security problems** go through the Security tab ("Report a vulnerability"), never a public issue. See
  [SECURITY.md](SECURITY.md).

## The pull request

- **One change per pull request.** Link its issue (`Fixes #123`).
- **Tests:** a bug fix comes with a test that failed before the fix. A new feature comes with tests of what it does.
- **Run the checks** that the [README's CI section](README.md#ci) lists for the parts you touched. Changes in `app/`
  also need `scripts/check-app.sh`.
- **Write for users** in the pull request text: what changes for someone using Nunchiro. Add a line to
  [CHANGELOG.md](CHANGELOG.md) when users can see the change.
- **Strings:** new interface text is English only for now; the other languages are filled in one pass before a release.
- **Keep files within their size limits** (`scripts/file-size-ratchet.sh`) and do not raise a ratchet baseline to make
  a check pass.

## What happens next

- CI runs on GitHub-hosted runners. A pull request from a fork waits until a maintainer approves its first run.
- A pull request merges only when the `gate` check is green. A change to `.github/` or the ratchet scripts also waits
  for a maintainer's review (the `ci-guard` check).
- Pull requests that touch approvals, sessions, the queue, authentication, the sandbox, outward actions (mail,
  calendar, posting) or updates get a closer review and are never merged automatically.
- A pull request that has had merge conflicts for 14 days with no reply may be closed; you can reopen it.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE) of this repository.
