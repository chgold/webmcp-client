# webmcp-client v2.1

Meta MCP Client for WebMCP-compliant servers. Configure **once** in any MCP client, then add/remove any number of WebMCP sites dynamically. No restart required.

**Legacy alias:** `webmcp-bridge` still works for backwards compatibility.

## Installation

```bash
npm install -g github:chgold/webmcp-client
```

This installs the `webmcp-client` command globally from GitHub.

## Claude Desktop Configuration (set once, never change)

After installing globally:

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "webmcp-client"
    }
  }
}
```

Or if you cloned the repo manually, point to the `index.js` directly:

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "node",
      "args": ["/path/to/webmcp-client/index.js"]
    }
  }
}
```

### Behind a Corporate SSL Proxy?

If you're behind an SSL proxy, the bridge may fail with `unable to get local issuer certificate`. Fix it by setting `NODE_TLS_REJECT_UNAUTHORIZED`:

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "webmcp-client",
      "env": {
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

## Usage

### Meta Client Mode (default)

Start with no arguments — the client manages sites via `~/.webmcp-client/sites.json`:

```bash
node index.js
```

Four meta-tools are always available in Claude Desktop:

| Tool | Description |
|------|-------------|
| `webmcp_addSite` | Add **or update** a WebMCP site — fetches manifest, loads tools, notifies the client. Takes `name`, `manifest_url`, `token`, and (strongly recommended) `refresh_token` |
| `webmcp_listSites` | List configured sites with tool counts |
| `webmcp_removeSite` | Remove a site and its tools |
| `webmcp_refreshSites` | Re-fetch manifests for one site (`name`) or all sites, picking up newly added tools |

Once a site is added, its tools appear as `{site_name}_{tool_name}`, e.g. `drupal-prod_drupal_searchNodes`.

### Tokens and automatic refresh

Access tokens are typically short-lived (about 1 hour). **Always pass `refresh_token` in addition to
`token`** — otherwise the site stops working once the access token expires:

```
webmcp_addSite
  name:          "gold-t.co.il"
  manifest_url:  "https://gold-t.co.il/api/aiconnect-manifest"
  token:         "Bearer xfa_..."
  refresh_token: "xfr_..."
```

With a refresh token stored, the client:

- refreshes proactively when the access token is within a minute of expiry,
- refreshes reactively on a `401`/`403` and transparently retries the call once,
- reads the token endpoint from the manifest's `auth.token_url` and picks a `client_id` from
  `auth.registered_clients` (preferring `claude-ai`),
- **persists the rotated `refresh_token` immediately** — the server revokes the old pair on each
  refresh, so this is what keeps the connection alive long-term,
- de-duplicates concurrent refreshes, so parallel tool calls trigger exactly one token exchange.

`webmcp_listSites` shows the auth state of every site and warns about any site missing a refresh token.

The manifest itself is also fetched with the `Authorization` header, so sites that protect their
manifest endpoint can be registered too. A token pasted without the `Bearer ` prefix is normalized
automatically.

### Tool naming

Published tool names are constrained to `[A-Za-z0-9_-]` with a 64-character maximum, which is the
strictest limit across MCP clients. The client guarantees:

- **No collisions.** If two sites would produce the same published name (e.g. site `a_b` + tool `c`
  vs. site `a` + tool `b.c`), *both* get a short identity hash appended so neither is lost.
- **Length safety.** Names longer than 64 characters are truncated and hash-suffixed.
- **Stability.** The hash is derived from the `(site, tool)` pair only — never from load order — so a
  tool keeps the same published name across restarts and regardless of the order sites were added.

The original, unmodified tool name is always what gets sent to the site's `tools_endpoint`.

### Pre-loading sites via CLI

```bash
node index.js --site name=drupal-prod,manifest=https://site.com/api/ai-connect/v1/manifest,token=Bearer_dpc_xxx
```

`--site` may be repeated to register several sites at once:

```bash
node index.js \
  --site name=site-a,manifest=https://a.com/manifest,token=Bearer_aaa \
  --site name=site-b,manifest=https://b.com/manifest,token=Bearer_bbb
```

Sites are saved to `~/.webmcp-client/sites.json` and loaded immediately.

### Config file

Config is stored in `~/.webmcp-client/sites.json` (new installs) or `~/.webmcp-bridge/sites.json` (existing installs — automatically detected). The file is created automatically on first run:

```json
{
  "sites": {
    "drupal-prod": {
      "manifest": "https://your-site.com/api/ai-connect/v1/manifest",
      "token": "Bearer dpc_your_token_here",
      "refresh_token": "dpr_your_refresh_token_here",
      "token_url": "https://your-site.com/api/aiconnect-oauth",
      "client_id": "claude-ai",
      "expires_at": 1785000000000
    }
  }
}
```

`token_url`, `client_id` and `expires_at` are filled in automatically from the manifest and the token
responses — you only need to supply `manifest`, `token` and `refresh_token`.

## Legacy Single-Site Mode

For backward compatibility, the original `--manifest` flag still works:

```bash
node index.js \
  --manifest https://your-site.com/api/ai-connect/v1/manifest \
  --token "Bearer dpc_your_token_here" \
  [--name "My Server"]
```

In this mode, tools are exposed without a site prefix (as in v1.0).

> **Changed in v2.1:** single-site mode now posts `{"name": "...", "arguments": {...}}` to the bare
> `tools_endpoint`, matching meta-client mode and the WebMCP convention. Previously it posted the raw
> arguments to `{tools_endpoint}/{tool_name}`. Tool names are also sanitized and length-capped here,
> so tools containing `.` are no longer rejected by strict clients.

## WebMCP Compatibility

Works with any WebMCP-compliant server:
- Drupal AI Connect module
- WordPress (WebMCP plugin)
- XenForo
- Any custom WebMCP implementation

## How It Works

1. On startup, reads all sites from `~/.webmcp-client/sites.json`
2. Fetches every manifest **in parallel**. The MCP handshake is never delayed more than ~2.5s, so
   slow or unreachable sites can't stall client startup — they finish loading in the background and
   announce themselves when ready.
3. Declares `capabilities.tools.listChanged = true` and exposes 4 meta-tools + all site tools via MCP stdio
4. When sites change (`webmcp_addSite`, `webmcp_removeSite`, `webmcp_refreshSites`, or an external
   edit to `sites.json`):
   - Updates the config file atomically (temp file + rename)
   - Rebuilds the whole tool registry from scratch
   - Sends `notifications/tools/list_changed` so the client refreshes immediately

### Multi-site guarantees

- **Unlimited sites.** Any number of sites can be registered; each tool routes to its own site with
  that site's own token.
- **Failure isolation.** An unreachable site, a malformed manifest, or an invalid tool schema affects
  only that site — every other site keeps working.
- **Non-destructive updates.** If re-adding an existing site fails (typo'd URL, expired token), the
  previously working configuration and its tools are preserved rather than wiped.
- **Cross-process sync.** `sites.json` is watched, so a site added from one MCP client appears in
  other running clients without a restart.

## Getting a Token (Drupal)

```bash
drush --uri=http://your-site.com php:eval "
\$t = \Drupal::service('ai_connect.oauth_service')->createAccessToken('ai-agent-default', 1, ['read','write']);
echo \$t['access_token'];
"
```

## MCP Client Compatibility

webmcp-client implements the MCP stdio transport and works with **any MCP-compatible client**:

| Client | Platform | Notes |
|--------|----------|-------|
| **Claude Desktop** | Desktop app | Full support, recommended |
| **Cursor** | IDE | Add to MCP settings |
| **Continue.dev** | VS Code / JetBrains | Add to `~/.continue/config.json` |
| **Windsurf** | IDE | Add to MCP settings |
| **Cline** | VS Code extension | Add to MCP settings |
| **Zed** | Editor | Add to settings.json |
| **Any MCP stdio client** | Various | Works with any client supporting stdio transport |

### Configuring in Other Clients

The configuration is always the same pattern. Point to the `webmcp-client` command:

```json
{
  "command": "webmcp-client"
}
```

Refer to your client's MCP documentation for the exact config file location.

### Continue.dev (`~/.continue/config.json`)

```json
{
  "mcpServers": [
    {
      "name": "webmcp",
      "command": "webmcp-client",
      "env": { "NODE_TLS_REJECT_UNAUTHORIZED": "0" }
    }
  ]
}
```

> **Note:** Continue.dev uses an array for `mcpServers` instead of an object (unlike Cline, Cursor, and other clients).

## Tests

```bash
npm install
npm test
```

The suite spins up mock WebMCP servers and a real MCP stdio client, then exercises multi-site
registration, name collisions, name-length truncation, malformed manifests, failed re-adds, startup
with unreachable sites, external config edits, persistence across restarts, authenticated manifest
fetches, and the full token-refresh lifecycle (proactive, reactive, rotation persistence and
concurrent de-duplication).

Two optional checks:

```bash
# replay a captured real-world manifest through two simultaneous sites
npm run test:replay

# end-to-end against a real WebMCP site (credentials via env, never committed)
WEBMCP_LIVE_MANIFEST="https://your-site/api/aiconnect-manifest" \
WEBMCP_LIVE_TOKEN="Bearer xfa_..." \
WEBMCP_LIVE_REFRESH="xfr_..." \
WEBMCP_LIVE_SITE="your-site" \
npm run test:live
```

## Requirements

- Node.js 18 or higher
- `@modelcontextprotocol/sdk` (included in `node_modules`)

## License

MIT
