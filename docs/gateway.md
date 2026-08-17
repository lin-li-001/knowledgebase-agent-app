# Knowledge Base Gateway

The desktop app can expose a read-only HTTP gateway for a private ChatGPT
Action or MCP bridge. It is opt-in and remains disabled unless
`KB_AGENT_GATEWAY_TOKEN` is set.

```bash
KB_AGENT_GATEWAY_TOKEN='use-a-long-random-token' \
KB_AGENT_GATEWAY_PORT=8787 \
KB_AGENT_MCP_PORT=8788 \
pnpm dev
```

The server binds to `127.0.0.1` and exposes:

- `GET /health`
- `POST /v1/search` with `{ "query": "...", "limit": 8 }`
- `POST /v1/notes/fetch` with `{ "noteId": "..." }`

The same token also starts a read-only MCP endpoint at `/mcp` on
`KB_AGENT_MCP_PORT` (default `8788`). It advertises `kb_search` and
`kb_fetch_note` for ChatGPT-compatible MCP clients.

Protected routes require:

```http
Authorization: Bearer <token>
```

The gateway never accepts arbitrary filesystem paths. It returns only notes
that belong to the active workspace, have an accepted status, and have
`normal` or `personal` sensitivity. `private` and `restricted` notes are not
placed into external ChatGPT context. Pending, blocked, and rejected content
is excluded as well.

The gateway supports an audit callback for the host app. The callback records
the operation, workspace, note id or query length, result count, outcome, and
timestamp; it does not record query or note body text.

The Markdown workspace remains the source of truth. SQLite and the vector
index are used only for retrieval. MCP exposes one non-destructive proposal
action, `kb_propose_create_note`: it requires an explicit save intent plus a
conversation summary and key facts, stores a `proposed` Review item, and
returns its ID. It never writes a Markdown file. The local app must approve
that Review item before a note is created. There are no direct create, update,
move, or delete tools. The MCP connection does not automatically receive the
complete ChatGPT transcript.
