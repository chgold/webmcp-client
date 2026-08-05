#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, watch } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';

const MAX_TOOL_NAME_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 8;
const MANIFEST_TIMEOUT_MS = 10000;
const TOKEN_REFRESH_SKEW_MS = 60000;
const AUTH_PENDING_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CLIENT_ID = 'claude-ai';
const CLIENT_ID_PREFERENCE = ['claude-ai', 'claude', 'claude_client', 'chatgpt', 'openai', 'gemini', 'google'];
const STARTUP_GRACE_MS = 2500;
const NOTIFY_DEBOUNCE_MS = 100;
const SELF_WRITE_WINDOW_MS = 750;

function log(message) {
  console.error(`[webmcp-client] ${message}`);
}

function httpFetch(url, { method = 'GET', headers = {}, body = null, timeoutMs = MANIFEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reject(new Error(`Unsupported protocol "${parsed.protocol}" in ${url}`));
    }

    const isHttps = parsed.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    };

    const req = reqFn(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          text: () => Promise.resolve(data),
          json: () => Promise.resolve(JSON.parse(data)),
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const _legacyDir = join(homedir(), '.webmcp-bridge');
const _newDir = join(homedir(), '.webmcp-client');
const CONFIG_DIR = existsSync(_legacyDir) && !existsSync(_newDir) ? _legacyDir : _newDir;
const CONFIG_FILE = join(CONFIG_DIR, 'sites.json');

function sanitizeName(s) {
  return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function shortHash(input) {
  return createHash('sha1').update(input).digest('hex').slice(0, HASH_SUFFIX_LENGTH);
}

function identityOf(siteKey, toolName) {
  return `${siteKey}\u0000${toolName}`;
}

function baseToolName(siteKey, toolName) {
  return `${sanitizeName(siteKey)}_${sanitizeName(toolName)}`;
}

// Hash is derived from the tool's own identity, never from load order, so a
// given (site, tool) pair resolves to the same published name on every restart.
function hashedToolName(siteKey, toolName, attempt = 0) {
  const salt = attempt === 0 ? identityOf(siteKey, toolName) : `${identityOf(siteKey, toolName)}\u0000${attempt}`;
  const suffix = `_${shortHash(salt)}`;
  const base = baseToolName(siteKey, toolName);
  return base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
}

function normalizeInputSchema(schema, toolName, siteKey) {
  const fallback = { type: 'object', properties: {} };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return fallback;

  const normalized = { ...schema, type: 'object' };

  if (!normalized.properties || typeof normalized.properties !== 'object' || Array.isArray(normalized.properties)) {
    if (normalized.properties !== undefined) {
      log(`Warning: tool "${toolName}"${siteKey ? ` (${siteKey})` : ''} had an invalid "properties" value; replaced with {}`);
    }
    normalized.properties = {};
  }

  if (normalized.required !== undefined) {
    const required = Array.isArray(normalized.required)
      ? normalized.required.filter((k) => typeof k === 'string' && k in normalized.properties)
      : [];
    if (required.length) normalized.required = required;
    else delete normalized.required;
  }

  return normalized;
}

function normalizeManifestTools(rawTools, siteKey) {
  const seen = new Set();
  const tools = [];

  for (const tool of Array.isArray(rawTools) ? rawTools : []) {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !tool.name.trim()) {
      log(`Warning: skipping unnamed tool from "${siteKey}"`);
      continue;
    }
    if (seen.has(tool.name)) {
      log(`Warning: skipping duplicate tool "${tool.name}" from "${siteKey}"`);
      continue;
    }
    seen.add(tool.name);
    tools.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: normalizeInputSchema(tool.input_schema || tool.inputSchema || tool.parameters, tool.name, siteKey),
    });
  }

  return tools;
}

const sites = new Map();
const toolMeta = new Map();

let sitesConfig = { sites: {} };
let server = null;
let serverReady = false;

function rebuildToolRegistry() {
  toolMeta.clear();

  const claimCount = new Map();
  for (const [siteKey, entry] of sites) {
    for (const tool of entry.tools) {
      const base = baseToolName(siteKey, tool.name);
      claimCount.set(base, (claimCount.get(base) || 0) + 1);
    }
  }

  for (const [siteKey, entry] of sites) {
    for (const tool of entry.tools) {
      const base = baseToolName(siteKey, tool.name);
      const needsHash = base.length > MAX_TOOL_NAME_LENGTH || claimCount.get(base) > 1;

      let name = needsHash ? hashedToolName(siteKey, tool.name) : base;
      for (let attempt = 1; toolMeta.has(name); attempt++) {
        name = hashedToolName(siteKey, tool.name, attempt);
      }

      toolMeta.set(name, {
        siteKey,
        originalName: tool.name,
        toolsEndpoint: entry.toolsEndpoint,
        tool,
      });
    }
  }
}

function toolCountFor(siteKey) {
  return sites.get(siteKey)?.tools.length ?? 0;
}

function publishedNamesFor(siteKey) {
  return [...toolMeta.entries()].filter(([, m]) => m.siteKey === siteKey).map(([name]) => name);
}

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
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    sitesConfig = parsed && typeof parsed === 'object' ? parsed : { sites: {} };
    if (!sitesConfig.sites || typeof sitesConfig.sites !== 'object') sitesConfig.sites = {};
  } catch (e) {
    log(`Warning: could not parse config file, starting empty: ${e.message}`);
    sitesConfig = { sites: {} };
  }
}

let lastSelfWriteAt = 0;

function saveConfig() {
  ensureConfigDir();
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(sitesConfig, null, 2), 'utf-8');
  renameSync(tmp, CONFIG_FILE);
  lastSelfWriteAt = Date.now();
}

let notifyTimer = null;
let notifyPending = false;

function scheduleToolsChanged() {
  notifyPending = true;
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    void flushToolsChanged();
  }, NOTIFY_DEBOUNCE_MS);
  notifyTimer.unref?.();
}

async function flushToolsChanged() {
  if (!notifyPending || !server || !serverReady) return;
  notifyPending = false;
  try {
    if (typeof server.sendToolListChanged === 'function') {
      await server.sendToolListChanged();
    } else {
      await server.notification({ method: 'notifications/tools/list_changed' });
    }
  } catch (e) {
    log(`Could not send tools/list_changed notification: ${e.message}`);
  }
}

function bearer(token) {
  if (!token) return null;
  return /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
}

function pickClientId(manifest) {
  const registered = manifest?.auth?.registered_clients;
  if (registered && typeof registered === 'object' && !Array.isArray(registered)) {
    for (const preferred of CLIENT_ID_PREFERENCE) {
      if (preferred in registered) return preferred;
    }
    const first = Object.keys(registered)[0];
    if (first) return first;
  }
  return DEFAULT_CLIENT_ID;
}

async function fetchManifest(url, token) {
  const headers = {};
  const auth = bearer(token);
  if (auth) headers['Authorization'] = auth;

  const response = await httpFetch(url, { headers, timeoutMs: MANIFEST_TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('manifest is not valid JSON');
  }
}

async function resolveSite(siteKey, siteConfig) {
  const manifest = await fetchManifest(siteConfig.manifest, siteConfig.token);
  const toolsEndpoint = manifest?.usage?.tools_endpoint;
  if (!toolsEndpoint) {
    throw new Error('manifest.usage.tools_endpoint not found');
  }
  const rawTools = manifest?.usage?.tools || manifest?.tools || [];
  return {
    config: siteConfig,
    toolsEndpoint,
    tokenUrl: manifest?.auth?.token_url || null,
    clientId: pickClientId(manifest),
    tools: normalizeManifestTools(rawTools, siteKey),
  };
}

async function loadSite(siteKey, siteConfig) {
  const resolved = await resolveSite(siteKey, siteConfig);
  sites.set(siteKey, resolved);
  rebuildToolRegistry();
  return resolved.tools.length;
}

function getMetaTools() {
  return [
    {
      name: 'webmcp_addSite',
      description:
        'Add or update a WebMCP site. Compatible with any WebMCP server (Drupal, WordPress, XenForo, etc.). Any number of sites can be registered.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Site identifier, e.g. "drupal-prod"' },
          manifest_url: { type: 'string', description: 'Full URL to the WebMCP manifest endpoint' },
          token: { type: 'string', description: 'Access token, e.g. "Bearer xfa_xxx"' },
          refresh_token: {
            type: 'string',
            description:
              'Refresh token, e.g. "xfr_xxx". Strongly recommended: without it the connection stops working when the access token expires (typically after 1 hour).',
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
          name: { type: 'string', description: 'Site identifier to remove' },
        },
        required: ['name'],
      },
    },
    {
      name: 'webmcp_startAuth',
      description:
        'Begin OAuth (PKCE) authorization for a WebMCP site. Returns a URL to approve in a browser. Use this instead of webmcp_addSite when you do not already have a token.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Site identifier to register the site under' },
          manifest_url: { type: 'string', description: 'Full URL to the WebMCP manifest endpoint' },
        },
        required: ['name', 'manifest_url'],
      },
    },
    {
      name: 'webmcp_completeAuth',
      description:
        'Finish OAuth (PKCE) authorization started by webmcp_startAuth by exchanging the authorization code for tokens, then register the site.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Same site identifier passed to webmcp_startAuth' },
          code: { type: 'string', description: 'Authorization code returned by the site' },
        },
        required: ['name', 'code'],
      },
    },
    {
      name: 'webmcp_refreshSites',
      description:
        'Re-fetch manifests and refresh the tool list. Refreshes one site when "name" is given, otherwise every configured site.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional site identifier; omit to refresh all sites' },
        },
      },
    },
  ];
}

function getAllTools() {
  const siteTools = [];
  for (const [name, meta] of toolMeta) {
    siteTools.push({
      name,
      description: `[${meta.siteKey}] ${meta.tool.description}`.trim(),
      inputSchema: meta.tool.inputSchema,
    });
  }
  return [...getMetaTools(), ...siteTools];
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function handleAddSite(args) {
  const { name, manifest_url, token, refresh_token } = args || {};

  if (!name || !manifest_url || !token) {
    return textResult('Error: name, manifest_url, and token are all required.', true);
  }

  const previousConfig = sitesConfig.sites[name];
  const previousSite = sites.get(name);
  const nextConfig = { manifest: manifest_url, token: bearer(token) };
  if (refresh_token) nextConfig.refresh_token = refresh_token;
  else if (previousConfig?.refresh_token) nextConfig.refresh_token = previousConfig.refresh_token;

  let resolved;
  try {
    resolved = await resolveSite(name, nextConfig);
  } catch (error) {
    const kept = previousConfig
      ? ` Existing configuration for "${name}" was kept (${toolCountFor(name)} tool(s) still available).`
      : '';
    return textResult(`Error adding site "${name}": ${error.message}.${kept}`, true);
  }

  if (resolved.tokenUrl) nextConfig.token_url = resolved.tokenUrl;
  if (resolved.clientId) nextConfig.client_id = resolved.clientId;

  sites.set(name, resolved);
  sitesConfig.sites[name] = nextConfig;

  try {
    saveConfig();
  } catch (error) {
    if (previousSite) sites.set(name, previousSite);
    else sites.delete(name);
    if (previousConfig) sitesConfig.sites[name] = previousConfig;
    else delete sitesConfig.sites[name];
    rebuildToolRegistry();
    return textResult(`Error saving configuration for "${name}": ${error.message}`, true);
  }

  rebuildToolRegistry();
  scheduleToolsChanged();

  const published = publishedNamesFor(name);
  const verb = previousConfig ? 'updated' : 'added';
  const listing = published.length ? `\nTools: ${published.join(', ')}` : '';
  const warning = nextConfig.refresh_token
    ? ''
    : '\n⚠ No refresh_token supplied — this connection will stop working once the access token expires. Re-add the site with refresh_token to keep it alive.';
  return textResult(
    `✓ Site "${name}" ${verb} — ${resolved.tools.length} tool(s) loaded. ${sites.size} site(s) connected.${listing}${warning}`
  );
}

async function handleListSites() {
  const entries = Object.entries(sitesConfig.sites);

  if (entries.length === 0) {
    return textResult('No WebMCP sites configured.\nUse webmcp_addSite to add one.');
  }

  const lines = entries.map(([name, config]) => {
    const status = sites.has(name) ? `tools: ${toolCountFor(name)}` : 'tools: unavailable (manifest not loaded)';
    const auth = config.refresh_token
      ? tokenLooksExpired(name)
        ? 'auth: access token expired — will refresh on next call'
        : 'auth: access token + refresh token'
      : 'auth: access token only (⚠ no refresh_token — will expire)';
    return `• ${name}\n  manifest: ${config.manifest}\n  ${status}\n  ${auth}`;
  });

  return textResult(`Configured WebMCP sites (${entries.length}):\n\n${lines.join('\n\n')}`);
}

async function handleRemoveSite(args) {
  const { name } = args || {};

  if (!name) return textResult('Error: name is required.', true);
  if (!sitesConfig.sites[name]) return textResult(`Error: site "${name}" not found.`, true);

  delete sitesConfig.sites[name];
  sites.delete(name);
  saveConfig();
  rebuildToolRegistry();
  scheduleToolsChanged();

  return textResult(`✓ Site "${name}" removed. ${sites.size} site(s) connected.`);
}

async function handleRefreshSites(args) {
  const { name } = args || {};
  const targets = name ? [name] : Object.keys(sitesConfig.sites);

  if (name && !sitesConfig.sites[name]) {
    return textResult(`Error: site "${name}" not found.`, true);
  }
  if (targets.length === 0) {
    return textResult('No WebMCP sites configured.');
  }

  const outcomes = await Promise.all(
    targets.map(async (siteKey) => {
      try {
        const resolved = await resolveSite(siteKey, sitesConfig.sites[siteKey]);
        sites.set(siteKey, resolved);
        return `• ${siteKey}: ${resolved.tools.length} tool(s)`;
      } catch (error) {
        return `• ${siteKey}: failed — ${error.message}`;
      }
    })
  );

  rebuildToolRegistry();
  scheduleToolsChanged();

  return textResult(`Refreshed ${targets.length} site(s):\n${outcomes.join('\n')}`);
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const pendingAuth = new Map();

async function exchangeToken(tokenUrl, grant) {
  let response = await httpFetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(grant),
  });

  // Some AI Connect deployments accept only form encoding on the token endpoint.
  if (!response.ok && response.status >= 400 && response.status < 500) {
    response = await httpFetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(grant).toString(),
    });
  }

  if (!response.ok) {
    throw new Error(`token endpoint returned HTTP ${response.status} — ${await response.text()}`);
  }

  const payload = await response.json();
  if (!payload?.access_token) {
    throw new Error('token response did not contain access_token');
  }
  return payload;
}

function siteConfigFromTokenResponse(manifestUrl, tokenUrl, clientId, payload) {
  const config = {
    manifest: manifestUrl,
    token: bearer(payload.access_token),
    token_url: tokenUrl,
    client_id: clientId,
  };
  if (payload.refresh_token) config.refresh_token = payload.refresh_token;
  if (payload.expires_in) config.expires_at = Date.now() + payload.expires_in * 1000;
  return config;
}

async function handleStartAuth(args) {
  const { name, manifest_url } = args || {};
  if (!name || !manifest_url) {
    return textResult('Error: name and manifest_url are required.', true);
  }

  let manifest;
  try {
    manifest = await fetchManifest(manifest_url);
  } catch (error) {
    return textResult(`Error fetching manifest for "${name}": ${error.message}`, true);
  }

  const auth = manifest?.auth;
  if (!auth?.authorization_url || !auth?.token_url) {
    return textResult(
      `Error: the manifest for "${name}" does not advertise auth.authorization_url and auth.token_url. Use webmcp_addSite with a token instead.`,
      true
    );
  }

  const verifier = base64url(randomBytes(48));
  const clientId = pickClientId(manifest);
  const redirectUri = auth.redirect_uri || 'urn:ietf:wg:oauth:2.0:oob';

  const url = new URL(auth.authorization_url);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()));
  url.searchParams.set('code_challenge_method', auth.code_challenge_method || 'S256');
  url.searchParams.set('state', base64url(randomBytes(12)));
  if (auth.scopes && typeof auth.scopes === 'object' && !Array.isArray(auth.scopes)) {
    url.searchParams.set('scope', Object.keys(auth.scopes).join(' '));
  }

  pendingAuth.set(name, {
    verifier,
    manifestUrl: manifest_url,
    tokenUrl: auth.token_url,
    clientId,
    redirectUri,
    createdAt: Date.now(),
  });

  return textResult(
    `Open this URL in a browser and approve access for "${name}":\n\n${url.toString()}\n\n` +
      `Then call webmcp_completeAuth with name "${name}" and the authorization code you receive. The request expires in 15 minutes.`
  );
}

async function handleCompleteAuth(args) {
  const { name, code } = args || {};
  if (!name || !code) {
    return textResult('Error: name and code are required.', true);
  }

  const pending = pendingAuth.get(name);
  if (!pending) {
    return textResult(`Error: no pending authorization for "${name}". Call webmcp_startAuth first.`, true);
  }
  if (Date.now() - pending.createdAt > AUTH_PENDING_TTL_MS) {
    pendingAuth.delete(name);
    return textResult(`Error: the authorization request for "${name}" expired. Call webmcp_startAuth again.`, true);
  }

  let payload;
  try {
    payload = await exchangeToken(pending.tokenUrl, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    });
  } catch (error) {
    return textResult(`Error completing authorization for "${name}": ${error.message}`, true);
  }

  const previousConfig = sitesConfig.sites[name];
  const previousSite = sites.get(name);
  const nextConfig = siteConfigFromTokenResponse(pending.manifestUrl, pending.tokenUrl, pending.clientId, payload);

  let resolved;
  try {
    resolved = await resolveSite(name, nextConfig);
  } catch (error) {
    return textResult(`Authorized "${name}" but could not load its manifest: ${error.message}`, true);
  }

  sites.set(name, resolved);
  sitesConfig.sites[name] = nextConfig;

  try {
    saveConfig();
  } catch (error) {
    if (previousSite) sites.set(name, previousSite);
    else sites.delete(name);
    if (previousConfig) sitesConfig.sites[name] = previousConfig;
    else delete sitesConfig.sites[name];
    rebuildToolRegistry();
    return textResult(`Error saving configuration for "${name}": ${error.message}`, true);
  }

  pendingAuth.delete(name);
  rebuildToolRegistry();
  scheduleToolsChanged();

  const published = publishedNamesFor(name);
  const listing = published.length ? `\nTools: ${published.join(', ')}` : '';
  const warning = nextConfig.refresh_token
    ? ''
    : '\n⚠ The server returned no refresh_token, so this connection will stop working when the access token expires.';
  return textResult(
    `✓ Site "${name}" authorized — ${resolved.tools.length} tool(s) loaded. ${sites.size} site(s) connected.${listing}${warning}`
  );
}

const inFlightRefresh = new Map();

function tokenUrlFor(siteKey) {
  return sitesConfig.sites[siteKey]?.token_url || sites.get(siteKey)?.tokenUrl || null;
}

function clientIdFor(siteKey) {
  return sitesConfig.sites[siteKey]?.client_id || sites.get(siteKey)?.clientId || DEFAULT_CLIENT_ID;
}

async function performRefresh(siteKey) {
  const siteConfig = sitesConfig.sites[siteKey];
  if (!siteConfig?.refresh_token) {
    throw new Error('no refresh_token stored for this site');
  }

  const tokenUrl = tokenUrlFor(siteKey);
  if (!tokenUrl) {
    throw new Error('manifest does not advertise auth.token_url');
  }

  const grant = {
    grant_type: 'refresh_token',
    refresh_token: siteConfig.refresh_token,
    client_id: clientIdFor(siteKey),
  };

  const payload = await exchangeToken(tokenUrl, grant);

  siteConfig.token = bearer(payload.access_token);
  // The server revokes the old pair on every refresh, so a rotated refresh_token
  // must be persisted immediately or the site becomes permanently unauthenticated.
  if (payload.refresh_token) siteConfig.refresh_token = payload.refresh_token;
  siteConfig.expires_at = payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined;
  siteConfig.token_url = tokenUrl;
  siteConfig.client_id = clientIdFor(siteKey);

  saveConfig();

  const site = sites.get(siteKey);
  if (site) site.config = siteConfig;

  log(`Refreshed access token for "${siteKey}"`);
  return siteConfig;
}

function refreshSiteToken(siteKey) {
  if (inFlightRefresh.has(siteKey)) return inFlightRefresh.get(siteKey);
  const pending = performRefresh(siteKey).finally(() => inFlightRefresh.delete(siteKey));
  inFlightRefresh.set(siteKey, pending);
  return pending;
}

function tokenLooksExpired(siteKey) {
  const expiresAt = sitesConfig.sites[siteKey]?.expires_at;
  return typeof expiresAt === 'number' && Date.now() >= expiresAt - TOKEN_REFRESH_SKEW_MS;
}

function canRefresh(siteKey) {
  return Boolean(sitesConfig.sites[siteKey]?.refresh_token && tokenUrlFor(siteKey));
}

function postTool(endpoint, token, originalName, toolArgs) {
  const headers = { 'Content-Type': 'application/json' };
  const auth = bearer(token);
  if (auth) headers['Authorization'] = auth;
  return httpFetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: originalName, arguments: toolArgs }),
  });
}

async function callSiteTool(toolName, toolArgs) {
  const meta = toolMeta.get(toolName);
  if (!meta) {
    return textResult(`Error: Tool "${toolName}" not found.`, true);
  }

  const { siteKey } = meta;

  try {
    if (tokenLooksExpired(siteKey) && canRefresh(siteKey)) {
      await refreshSiteToken(siteKey).catch((e) => log(`Proactive refresh failed for "${siteKey}": ${e.message}`));
    }

    let response;
    let alreadyRefreshed = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const tokenUsed = sitesConfig.sites[siteKey]?.token;
      response = await postTool(meta.toolsEndpoint, tokenUsed, meta.originalName, toolArgs);

      const unauthorized = response.status === 401 || response.status === 403;
      if (!unauthorized || !canRefresh(siteKey)) break;

      // A concurrent call may have already rotated the token; retry with the
      // current one rather than burning a second (rotation-revoking) refresh.
      if (sitesConfig.sites[siteKey]?.token !== tokenUsed) continue;
      if (alreadyRefreshed) break;

      try {
        await refreshSiteToken(siteKey);
        alreadyRefreshed = true;
      } catch (refreshError) {
        return textResult(
          `Error: authentication failed for "${siteKey}" and the token could not be refreshed — ${refreshError.message}. Re-add the site with a fresh token and refresh_token.`,
          true
        );
      }
    }

    if (!response.ok) {
      const body = await response.text();
      const hint =
        (response.status === 401 || response.status === 403) && !canRefresh(siteKey)
          ? ` (no refresh_token stored for "${siteKey}" — re-add the site with both token and refresh_token)`
          : '';
      return textResult(`Error: HTTP ${response.status} — ${body}${hint}`, true);
    }

    return textResult(await response.text());
  } catch (error) {
    return textResult(`Error calling tool: ${error.message}`, true);
  }
}

function syncSitesFromConfig() {
  const configured = new Set(Object.keys(sitesConfig.sites));
  let changed = false;

  for (const siteKey of [...sites.keys()]) {
    if (!configured.has(siteKey)) {
      sites.delete(siteKey);
      changed = true;
    }
  }

  const pending = [];
  for (const [siteKey, config] of Object.entries(sitesConfig.sites)) {
    const current = sites.get(siteKey);
    if (current && current.config.manifest === config.manifest && current.config.token === config.token) {
      continue;
    }
    pending.push(
      loadSite(siteKey, config)
        .then(() => scheduleToolsChanged())
        .catch((e) => log(`Warning: could not load site "${siteKey}": ${e.message}`))
    );
  }

  if (changed) {
    rebuildToolRegistry();
    scheduleToolsChanged();
  }

  return pending;
}

function watchConfigFile() {
  let debounce = null;
  try {
    const watcher = watch(CONFIG_DIR, (_event, filename) => {
      if (filename && filename !== 'sites.json') return;
      // Ignore the change event caused by our own saveConfig().
      if (Date.now() - lastSelfWriteAt < SELF_WRITE_WINDOW_MS) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        loadConfig();
        void Promise.all(syncSitesFromConfig());
      }, 200);
      debounce.unref?.();
    });
    watcher.unref?.();
  } catch (e) {
    log(`Config watching unavailable: ${e.message}`);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { manifest: null, token: null, name: null, sites: [] };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--manifest' && i + 1 < args.length) result.manifest = args[++i];
    else if (args[i] === '--token' && i + 1 < args.length) result.token = args[++i];
    else if (args[i] === '--name' && i + 1 < args.length) result.name = args[++i];
    else if (args[i] === '--site' && i + 1 < args.length) result.sites.push(args[++i]);
  }

  return result;
}

function parseSiteFlag(siteStr) {
  const result = {};
  for (const pair of siteStr.split(/,(?=\w+=)/)) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    result[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return result;
}

async function runLegacySingleSiteMode(cliArgs) {
  let manifest;
  try {
    manifest = await fetchManifest(cliArgs.manifest);
  } catch (error) {
    log(`Error fetching manifest: ${error.message}`);
    process.exit(1);
  }

  const toolsEndpoint = manifest?.usage?.tools_endpoint;
  if (!toolsEndpoint) {
    log('Error: manifest.usage.tools_endpoint not found in manifest');
    process.exit(1);
  }

  const serverName = cliArgs.name || manifest.server?.name || 'WebMCP Server';
  const tools = normalizeManifestTools(manifest?.usage?.tools || manifest?.tools || [], serverName);
  const byPublishedName = new Map();
  for (const tool of tools) {
    let name = sanitizeName(tool.name).slice(0, MAX_TOOL_NAME_LENGTH);
    for (let attempt = 0; byPublishedName.has(name); attempt++) {
      const suffix = `_${shortHash(`${tool.name}\u0000${attempt}`)}`;
      name = sanitizeName(tool.name).slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
    }
    byPublishedName.set(name, tool);
  }

  server = new Server({ name: serverName, version: '2.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...byPublishedName].map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byPublishedName.get(request.params.name);
    if (!tool) return textResult(`Error: Tool "${request.params.name}" not found`, true);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (cliArgs.token) headers['Authorization'] = cliArgs.token;

      const response = await httpFetch(toolsEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: tool.name, arguments: request.params.arguments || {} }),
      });

      if (!response.ok) {
        return textResult(`Error: HTTP ${response.status} - ${await response.text()}`, true);
      }
      return textResult(await response.text());
    } catch (error) {
      return textResult(`Error: ${error.message}`, true);
    }
  });

  await server.connect(new StdioServerTransport());
  serverReady = true;
}

async function main() {
  const cliArgs = parseArgs();

  if (cliArgs.manifest) {
    await runLegacySingleSiteMode(cliArgs);
    return;
  }

  loadConfig();

  for (const siteStr of cliArgs.sites) {
    const parsed = parseSiteFlag(siteStr);
    if (parsed.name && parsed.manifest && parsed.token) {
      sitesConfig.sites[parsed.name] = {
        manifest: parsed.manifest,
        token: bearer(parsed.token),
        ...(parsed.refresh_token ? { refresh_token: parsed.refresh_token } : {}),
      };
      log(`Site "${parsed.name}" saved from --site flag.`);
    } else {
      log('Warning: --site requires name=...,manifest=...,token=...');
    }
  }
  if (cliArgs.sites.length) saveConfig();

  const loading = Object.entries(sitesConfig.sites).map(([siteKey, siteConfig]) =>
    loadSite(siteKey, siteConfig)
      .then((count) => {
        log(`Loaded ${count} tool(s) from "${siteKey}"`);
        scheduleToolsChanged();
      })
      .catch((e) => log(`Warning: could not load site "${siteKey}": ${e.message}`))
  );

  await Promise.race([
    Promise.allSettled(loading),
    new Promise((resolve) => setTimeout(resolve, STARTUP_GRACE_MS).unref?.()),
  ]);

  // Deliberately the low-level Server rather than McpServer: McpServer runs every
  // tool's inputSchema through normalizeObjectSchema/toJsonSchemaCompat, which expects
  // Zod. Our schemas are raw JSON Schema proxied from remote manifests, so they would
  // all degrade to an empty schema and lose their parameters.
  server = new Server(
    { name: 'WebMCP Meta Client', version: '2.2.0' },
    { capabilities: { tools: { listChanged: true } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getAllTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolArgs = request.params.arguments || {};

    if (toolName === 'webmcp_addSite') return handleAddSite(toolArgs);
    if (toolName === 'webmcp_listSites') return handleListSites();
    if (toolName === 'webmcp_removeSite') return handleRemoveSite(toolArgs);
    if (toolName === 'webmcp_startAuth') return handleStartAuth(toolArgs);
    if (toolName === 'webmcp_completeAuth') return handleCompleteAuth(toolArgs);
    if (toolName === 'webmcp_refreshSites') return handleRefreshSites(toolArgs);

    return callSiteTool(toolName, toolArgs);
  });

  await server.connect(new StdioServerTransport());
  serverReady = true;

  void Promise.allSettled(loading).then(() => flushToolsChanged());
  watchConfigFile();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
