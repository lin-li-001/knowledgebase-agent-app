# Private ChatGPT Plugin Setup

The app now contains the reusable Plugin package at
`plugins/knowledge-base/`. It includes the read-only search skill and the
metadata ChatGPT needs to present the integration. The actual connection to a
user's local KB is provided by the app's MCP endpoint, not by putting a vault
path or token in this repository.

## Local app configuration

Start the desktop app with a long-lived local token:

```bash
KB_AGENT_GATEWAY_TOKEN='use-a-long-random-token' \
KB_AGENT_GATEWAY_PORT=8787 \
KB_AGENT_MCP_PORT=8788 \
pnpm dev
```

The MCP endpoint is:

```text
http://127.0.0.1:8788/mcp
```

The endpoint is intentionally bound to loopback. ChatGPT cannot reach a
loopback URL directly, so a user-controlled HTTPS MCP relay or Secure MCP
Tunnel is required for a remote ChatGPT session. The relay must forward the
Bearer token and must not log request bodies.

## ChatGPT Developer Mode

1. Open ChatGPT Settings and enable Developer Mode for the account/workspace.
2. Create an MCP app using the reachable HTTPS `/mcp` endpoint.
3. Configure the same Bearer token used by the desktop app.
4. Verify that the server exposes only `kb_search` and `kb_fetch_note`.
5. Copy the generated technical app ID, which has the form
   `plugin_asdk_app...`.

After registration, add the generated app mapping as
`plugins/knowledge-base/.app.json` and add `"apps": "./.app.json"` to
`plugins/knowledge-base/.codex-plugin/plugin.json`. Do not commit the Bearer
token, relay URL containing credentials, or any private vault path.

## Trust boundary

The gateway re-checks workspace ownership, note status, and sensitivity on
every request. Only `active`, `auto_written`, and `approved` notes with
`normal` or `personal` sensitivity can enter the external context. Markdown
remains the source of truth; SQLite and vector indexes are derived retrieval
data. `kb_propose_create_note` only creates a local `proposed` Review item;
the desktop Review flow must approve it before a Markdown file is written.

## Package layout

```text
plugins/knowledge-base/
  .codex-plugin/plugin.json
  skills/knowledge-base-search/SKILL.md
```

The app MCP implementation lives in `packages/gateway/` and is started by the
Electron host only when `KB_AGENT_GATEWAY_TOKEN` is set.
