import { startMockSite, makeTools } from './mock-site.js';
import { startClient } from './harness.js';
import { readFileSync } from 'fs';

const { WEBMCP_LIVE_MANIFEST: MANIFEST, WEBMCP_LIVE_TOKEN: TOKEN, WEBMCP_LIVE_REFRESH: REFRESH } = process.env;
const SITE = process.env.WEBMCP_LIVE_SITE || 'gold-t.co.il';
const THREAD_ID = Number(process.env.WEBMCP_THREAD_ID);
const BODY_FILE = process.env.WEBMCP_POST_BODY;

if (!MANIFEST || !TOKEN || !THREAD_ID || !BODY_FILE) {
  console.error('need WEBMCP_LIVE_MANIFEST, WEBMCP_LIVE_TOKEN, WEBMCP_THREAD_ID, WEBMCP_POST_BODY');
  process.exit(2);
}

const prefix = SITE.replace(/[^a-zA-Z0-9_-]/g, '_');

async function main() {
  const companion = await startMockSite({ name: 'companion', tools: makeTools(3, 'mock') });
  const h = await startClient();

  await h.callTool('webmcp_addSite', {
    name: SITE,
    manifest_url: MANIFEST,
    token: TOKEN,
    ...(REFRESH ? { refresh_token: REFRESH } : {}),
  });
  await h.callTool('webmcp_addSite', {
    name: 'companion',
    manifest_url: companion.manifestUrl,
    token: 'Bearer mock',
  });

  const tools = (await h.listTools()).tools.map((t) => t.name);
  console.log(`registered: ${tools.filter((n) => n.startsWith(prefix)).length} live + ${tools.filter((n) => n.startsWith('companion_')).length} mock`);

  const replyTool = `${prefix}_xenforo_pro_replyToThread`;
  if (!tools.includes(replyTool)) {
    console.error(`missing ${replyTool}`);
    process.exit(1);
  }

  const res = await h.callTool(replyTool, {
    thread_id: THREAD_ID,
    message: readFileSync(BODY_FILE, 'utf-8'),
  });
  console.log(`via tool  : ${replyTool}`);
  console.log(res.content[0].text.slice(0, 700));

  await h.close();
  await companion.close();
  process.exit(res.isError ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(2);
});
