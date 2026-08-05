import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = process.env.WEBMCP_ENTRY || join(ROOT, 'index.js');

export async function startClient({ args = [], home = null } = {}) {
  const sandboxHome = home || mkdtempSync(join(tmpdir(), 'webmcp-test-'));
  const listChangedEvents = [];
  const stderr = [];

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, ...args],
    env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'test-harness', version: '1.0.0' }, { capabilities: {} });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChangedEvents.push(Date.now());
  });

  const startedAt = Date.now();
  const attachStderr = () => transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));
  try {
    await client.connect(transport);
  } catch (e) {
    attachStderr();
    await new Promise((r) => setTimeout(r, 100));
    e.stderr = stderr.join('');
    throw e;
  }
  const connectMs = Date.now() - startedAt;

  attachStderr();

  return {
    client,
    home: sandboxHome,
    connectMs,
    listChangedEvents,
    stderr,
    serverCapabilities: client.getServerCapabilities(),
    listTools: () => client.listTools(),
    callTool: (name, args = {}) => client.callTool({ name, arguments: args }),
    waitForListChanged: async (minCount, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (listChangedEvents.length < minCount && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return listChangedEvents.length;
    },
    close: async () => {
      await client.close().catch(() => {});
      if (!home) rmSync(sandboxHome, { recursive: true, force: true });
    },
  };
}
