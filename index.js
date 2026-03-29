#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.webmcp-bridge');
const CONFIG_FILE = join(CONFIG_DIR, 'sites.json');

function sanitizeName(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// siteKey/toolName → { siteKey, originalName, siteConfig, toolsEndpoint, toolDef }
const toolMeta = new Map();

let sitesConfig = { sites: {} };
let server = null;

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig() {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    sitesConfig = { sites: {} };
    saveConfig();
    return;
  }
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    sitesConfig = JSON.parse(raw);
    if (!sitesConfig.sites) sitesConfig.sites = {};
  } catch (e) {
    console.error(`Warning: could not parse config file: ${e.message}`);
    sitesConfig = { sites: {} };
  }
}

function saveConfig() {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(sitesConfig, null, 2), 'utf-8');
}

async function fetchManifest(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function loadSiteTools(siteKey, siteConfig) {
  const manifest = await fetchManifest(siteConfig.manifest);
  const toolsEndpoint = manifest.usage?.tools_endpoint;
  const tools = manifest.usage?.tools || [];

  if (!toolsEndpoint) {
    throw new Error('manifest.usage.tools_endpoint not found');
  }

  for (const tool of tools) {
    const qualifiedName = `${sanitizeName(siteKey)}_${sanitizeName(tool.name)}`;
    toolMeta.set(qualifiedName, {
      siteKey,
      originalName: tool.name,
      siteConfig,
      toolsEndpoint,
      toolDef: tool,
    });
  }

  return tools.length;
}

function clearSiteTools(siteKey) {
  for (const [name, meta] of toolMeta.entries()) {
    if (meta.siteKey === siteKey) {
      toolMeta.delete(name);
    }
  }
}

function getMetaTools() {
  return [
    {
      name: 'webmcp_addSite',
      description:
        'Add a WebMCP site. Compatible with any WebMCP server (Drupal, WordPress, XenForo, etc.)',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Site identifier, e.g. "drupal-prod"',
          },
          manifest_url: {
            type: 'string',
            description: 'Full URL to the WebMCP manifest endpoint',
          },
          token: {
            type: 'string',
            description: 'Authorization header value, e.g. "Bearer dpc_xxx"',
          },
        },
        required: ['name', 'manifest_url', 'token'],
      },
    },
    {
      name: 'webmcp_listSites',
      description: 'List all configured WebMCP sites with their tool counts',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'webmcp_removeSite',
      description: 'Remove a WebMCP site from configuration',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Site identifier to remove',
          },
        },
        required: ['name'],
      },
    },
  ];
}

function getAllTools() {
  const siteTools = [];
  for (const [qualifiedName, meta] of toolMeta.entries()) {
    siteTools.push({
      name: qualifiedName,
      description: `[${meta.siteKey}] ${meta.toolDef.description || ''}`,
      inputSchema: meta.toolDef.parameters || { type: 'object', properties: {} },
    });
  }
  return [...getMetaTools(), ...siteTools];
}

async function notifyToolsChanged() {
  if (!server) return;
  try {
    await server.notification({ method: 'notifications/tools/list_changed' });
  } catch (e) {
    console.error(`Could not send tools/list_changed notification: ${e.message}`);
  }
}

async function handleAddSite(args) {
  const { name, manifest_url, token } = args || {};

  if (!name || !manifest_url || !token) {
    return {
      content: [{ type: 'text', text: 'Error: name, manifest_url, and token are all required.' }],
      isError: true,
    };
  }

  try {
    clearSiteTools(name);
    sitesConfig.sites[name] = { manifest: manifest_url, token };
    saveConfig();

    const toolCount = await loadSiteTools(name, sitesConfig.sites[name]);
    await notifyToolsChanged();

    return {
      content: [
        {
          type: 'text',
          text: `✓ Site "${name}" added — ${toolCount} tool(s) loaded.\nTools available as "${sanitizeName(name)}_<tool_name>".`,
        },
      ],
    };
  } catch (error) {
    delete sitesConfig.sites[name];
    saveConfig();
    clearSiteTools(name);
    return {
      content: [{ type: 'text', text: `Error adding site "${name}": ${error.message}` }],
      isError: true,
    };
  }
}

async function handleListSites() {
  const entries = Object.entries(sitesConfig.sites);

  if (entries.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No WebMCP sites configured.\nUse webmcp.addSite to add one.',
        },
      ],
    };
  }

  const lines = entries.map(([name, config]) => {
    const count = [...toolMeta.values()].filter((m) => m.siteKey === name).length;
    return `• ${name}\n  manifest: ${config.manifest}\n  tools: ${count}`;
  });

  return {
    content: [
      {
        type: 'text',
        text: `Configured WebMCP sites (${entries.length}):\n\n${lines.join('\n\n')}`,
      },
    ],
  };
}

async function handleRemoveSite(args) {
  const { name } = args || {};

  if (!name) {
    return {
      content: [{ type: 'text', text: 'Error: name is required.' }],
      isError: true,
    };
  }

  if (!sitesConfig.sites[name]) {
    return {
      content: [{ type: 'text', text: `Error: site "${name}" not found.` }],
      isError: true,
    };
  }

  clearSiteTools(name);
  delete sitesConfig.sites[name];
  saveConfig();

  await notifyToolsChanged();

  return {
    content: [{ type: 'text', text: `✓ Site "${name}" removed.` }],
  };
}

async function callSiteTool(toolName, toolArgs) {
  const meta = toolMeta.get(toolName);
  if (!meta) {
    return {
      content: [{ type: 'text', text: `Error: Tool "${toolName}" not found.` }],
      isError: true,
    };
  }

  try {
    const url = `${meta.toolsEndpoint}/${meta.originalName}`;
    const headers = { 'Content-Type': 'application/json' };
    if (meta.siteConfig.token) {
      headers['Authorization'] = meta.siteConfig.token;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolArgs),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        content: [{ type: 'text', text: `Error: HTTP ${response.status} — ${errorText}` }],
        isError: true,
      };
    }

    const result = await response.json();
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error calling tool: ${error.message}` }],
      isError: true,
    };
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    manifest: null,
    token: null,
    name: null,
    site: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--manifest' && i + 1 < args.length) {
      result.manifest = args[++i];
    } else if (args[i] === '--token' && i + 1 < args.length) {
      result.token = args[++i];
    } else if (args[i] === '--name' && i + 1 < args.length) {
      result.name = args[++i];
    } else if (args[i] === '--site' && i + 1 < args.length) {
      result.site = args[++i];
    }
  }

  return result;
}

function parseSiteFlag(siteStr) {
  const result = {};
  const kvPairs = siteStr.split(/,(?=\w+=)/);
  for (const pair of kvPairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    result[key] = value;
  }
  return result;
}

async function main() {
  const cliArgs = parseArgs();

  if (cliArgs.manifest) {
    let manifest;
    try {
      manifest = await fetchManifest(cliArgs.manifest);
    } catch (error) {
      console.error(`Error fetching manifest: ${error.message}`);
      process.exit(1);
    }

    const serverName = cliArgs.name || manifest.server?.name || 'WebMCP Server';
    const toolsEndpoint = manifest.usage?.tools_endpoint;
    const tools = manifest.usage?.tools || [];
    const token = cliArgs.token;

    if (!toolsEndpoint) {
      console.error('Error: manifest.usage.tools_endpoint not found in manifest');
      process.exit(1);
    }

    server = new Server(
      { name: serverName, version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.parameters || { type: 'object', properties: {} },
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const toolArgs = request.params.arguments || {};

      const toolDef = tools.find((t) => t.name === toolName);
      if (!toolDef) {
        return {
          content: [{ type: 'text', text: `Error: Tool "${toolName}" not found` }],
          isError: true,
        };
      }

      try {
        const url = `${toolsEndpoint}/${toolName}`;
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = token;

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(toolArgs),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [{ type: 'text', text: `Error: HTTP ${response.status} - ${errorText}` }],
            isError: true,
          };
        }

        const result = await response.json();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  loadConfig();

  if (cliArgs.site) {
    const parsed = parseSiteFlag(cliArgs.site);
    if (parsed.name && parsed.manifest && parsed.token) {
      sitesConfig.sites[parsed.name] = { manifest: parsed.manifest, token: parsed.token };
      saveConfig();
      console.error(`[webmcp-bridge] Site "${parsed.name}" saved from --site flag.`);
    } else {
      console.error('[webmcp-bridge] Warning: --site requires name=...,manifest=...,token=...');
    }
  }

  for (const [siteKey, siteConfig] of Object.entries(sitesConfig.sites)) {
    try {
      const count = await loadSiteTools(siteKey, siteConfig);
      console.error(`[webmcp-bridge] Loaded ${count} tools from "${siteKey}"`);
    } catch (e) {
      console.error(`[webmcp-bridge] Warning: could not load site "${siteKey}": ${e.message}`);
    }
  }

  server = new Server(
    { name: 'WebMCP Meta Bridge', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAllTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolArgs = request.params.arguments || {};

    if (toolName === 'webmcp_addSite') return handleAddSite(toolArgs);
    if (toolName === 'webmcp_listSites') return handleListSites();
    if (toolName === 'webmcp_removeSite') return handleRemoveSite(toolArgs);

    return callSiteTool(toolName, toolArgs);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
