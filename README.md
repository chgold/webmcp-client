# webmcp-client v2.0

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

### Behind NetFree or a Corporate SSL Proxy?

If you're behind NetFree (Israeli content filter) or a corporate SSL proxy, the bridge may fail with `unable to get local issuer certificate`. Fix it by setting `NODE_TLS_REJECT_UNAUTHORIZED`:

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

Three meta-tools are always available in Claude Desktop:

| Tool | Description |
|------|-------------|
| `webmcp_addSite` | Add a WebMCP site — fetches manifest, loads tools, notifies Claude |
| `webmcp_listSites` | List configured sites with tool counts |
| `webmcp_removeSite` | Remove a site and its tools |

Once a site is added, its tools appear as `{site-name}/{tool-name}`, e.g. `drupal-prod/drupal.searchNodes`.

### Pre-loading a site via CLI

```bash
node index.js --site name=drupal-prod,manifest=https://site.com/api/ai-connect/v1/manifest,token=Bearer_dpc_xxx
```

Saves the site to `~/.webmcp-client/sites.json` and loads it immediately.

### Config file

Config is stored in `~/.webmcp-client/sites.json` (new installs) or `~/.webmcp-bridge/sites.json` (existing installs — automatically detected). The file is created automatically on first run:

```json
{
  "sites": {
    "drupal-prod": {
      "manifest": "https://your-site.com/api/ai-connect/v1/manifest",
      "token": "Bearer dpc_your_token_here"
    }
  }
}
```

## Legacy Single-Site Mode

For backward compatibility, the original `--manifest` flag still works:

```bash
node index.js \
  --manifest https://your-site.com/api/ai-connect/v1/manifest \
  --token "Bearer dpc_your_token_here" \
  [--name "My Server"]
```

In this mode, tools are exposed without a site prefix (as in v1.0).

## WebMCP Compatibility

Works with any WebMCP-compliant server:
- Drupal AI Connect module
- WordPress (WebMCP plugin)
- XenForo
- Any custom WebMCP implementation

## How It Works

1. On startup, loads all sites from `~/.webmcp-client/sites.json`
2. Fetches each manifest and populates the tool registry (unreachable sites are skipped gracefully)
3. Exposes 3 meta-tools + all site tools via MCP stdio
4. When `webmcp_addSite` or `webmcp_removeSite` is called:
   - Updates the config file
   - Reloads the tool registry
   - Sends `notifications/tools/list_changed` so Claude Desktop refreshes immediately

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

## Requirements

- Node.js 18 or higher
- `@modelcontextprotocol/sdk` (included in `node_modules`)

## License

MIT
