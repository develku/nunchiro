# Nunchiro local API

Everything the CLI, the MCP server and the window do goes through one local API of the Nunchiro core. A script or
another tool can call it directly. Its full shape is published as a JSON Schema (draft 2020-12):
[`api/nunchiro-api.schema.json`](api/nunchiro-api.schema.json), also printed by `nunchiro api schema`. The schema is
written from the core's own Rust types by a test, and the build fails when the two differ, so it is never stale.

## The socket

The core listens on the unix socket `$NUNCHIRO_HOME/core.sock` (`NUNCHIRO_HOME` defaults to `~/.nunchiro`). A call is
one connection: write one JSON line, the envelope, and read one JSON line back, the response.

```json
{"token": "<token>", "request": {"op": "agent_list"}}
```

The response is `{"Ok": <reply>}` or `{"Err": "<one sentence>"}`. A reply has a `type` that names its shape
(`snapshot`, `events`, ...). In the schema, the envelope is `$defs/Envelope`, the request `$defs/Request` (one variant
per `op`), and the response `$defs/Response`; the root accepts any line on the wire.

`nunchiro events` keeps its connection open and prints one event per line, `$defs/Event` (see [cli.md](cli.md#events)).

## Who is calling

- **The owner.** The token in `$NUNCHIRO_HOME/core.token` (only the user can read that file) makes the caller the
  owner, the same as the CLI run in a terminal.
- **An outside tool.** A token the owner made with `nunchiro token create --scope read|supervised|full`, sent as
  `token`. The core keeps only its hash; its scope and project limit what it may call ([cli.md](cli.md#outside-callers)).
- **An agent.** A process inside a Nunchiro session is that session's caller whatever token it sends: the core judges
  the connecting process itself.

A refusal is an `Err` such as `operation not granted to a read token`.

## Stable and window operations

Each request variant in the schema carries `x-stability`:

- `stable`: an outside token may call it. Kept compatible: a field may be added with a default, nothing is renamed or
  removed without a deprecation in the changelog.
- `window`: the window's own operations (files, chat history, approvals, the board, settings). They may change in
  any release; a token is refused them.

Stable operations: `list`, `snapshot`, `events`, `agent_list`, `agent_get`, `agent_read`, `read`, `room_check`,
`room_thread`, `room_answer`, `worktree`, `start`, `agent_prompt`, `agent_send`, `send_text`, `cancel_send`,
`room_send`, `room_reply`, `close`.

A test calls every operation in the schema with a `supervised` token: the stable ones pass the scope check and every
window one is refused, so this list matches what a token can really do.

## Example client

[`api/examples/agents.py`](api/examples/agents.py) lists the agents of a running core with the Python standard
library only:

```sh
export NUNCHIRO_TOKEN=$(nunchiro token create --scope read)
python3 docs/api/examples/agents.py
```

For another language, generate types from the schema with any JSON Schema tool (for example `quicktype` or
`datamodel-code-generator`).
