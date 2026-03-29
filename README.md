# webmcp-bridge

Meta MCP Bridge for WebMCP-compliant servers. Configure **once** in Claude Desktop, then add/remove any number of WebMCP sites dynamically — no restart required.

## Installation

```bash
npm install -g github:chgold/webmcp-bridge
```

This installs the `webmcp-bridge` command globally from GitHub.

## Claude Desktop Configuration (set once, never change)

After installing globally:

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "webmcp-bridge"
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
      "args": ["/path/to/webmcp-bridge/index.js"]
    }
  }
}
```

## Usage

### Meta Bridge Mode (default)

Start with no arguments — the bridge manages sites via `~/.webmcp-bridge/sites.json`:

```bash
node index.js
```

Three meta-tools are always available in Claude Desktop:

| Tool | Description |
|------|-------------|
| `webmcp.addSite` | Add a WebMCP site — fetches manifest, loads tools, notifies Claude |
| `webmcp.listSites` | List configured sites with tool counts |
| `webmcp.removeSite` | Remove a site and its tools |

Once a site is added, its tools appear as `{site-name}/{tool-name}`, e.g. `drupal-prod/drupal.searchNodes`.

### Pre-loading a site via CLI

```bash
node index.js --site name=drupal-prod,manifest=https://site.com/api/ai-connect/v1/manifest,token=Bearer_dpc_xxx
```

Saves the site to `~/.webmcp-bridge/sites.json` and loads it immediately.

### Config file

`~/.webmcp-bridge/sites.json` is created automatically on first run:

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

1. On startup, loads all sites from `~/.webmcp-bridge/sites.json`
2. Fetches each manifest and populates the tool registry (unreachable sites are skipped gracefully)
3. Exposes 3 meta-tools + all site tools via MCP stdio
4. When `webmcp.addSite` or `webmcp.removeSite` is called:
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

## Requirements

- Node.js 18 or higher
- `@modelcontextprotocol/sdk` (included in `node_modules`)

## License

MIT
