import { startMockSite, makeTools } from './mock-site.js';
import { startClient } from './harness.js';
import { readFileSync } from 'fs';

const MANIFEST = process.env.WEBMCP_LIVE_MANIFEST;
const TOKEN = process.env.WEBMCP_LIVE_TOKEN;
const REFRESH = process.env.WEBMCP_LIVE_REFRESH;
const SITE = process.env.WEBMCP_LIVE_SITE || 'gold-t.co.il';
const FORUM_ID = Number(process.env.WEBMCP_FORUM_ID || 58);
const BODY_FILE = process.env.WEBMCP_POST_BODY;
const TITLE = process.env.WEBMCP_POST_TITLE;

if (!MANIFEST || !TOKEN || !BODY_FILE || !TITLE) {
  console.error('missing WEBMCP_LIVE_MANIFEST / WEBMCP_LIVE_TOKEN / WEBMCP_POST_BODY / WEBMCP_POST_TITLE');
  process.exit(2);
}

const prefix = SITE.replace(/[^a-zA-Z0-9_-]/g, '_');

async function main() {
  const companion = await startMockSite({ name: 'companion', tools: makeTools(3, 'mock') });
  const h = await startClient();

  const added = await h.callTool('webmcp_addSite', {
    name: SITE,
    manifest_url: MANIFEST,
    token: TOKEN,
    ...(REFRESH ? { refresh_token: REFRESH } : {}),
  });
  console.log('add live  :', added.content[0].text.split('\n')[0]);

  const second = await h.callTool('webmcp_addSite', {
    name: 'companion',
    manifest_url: companion.manifestUrl,
    token: 'Bearer mock',
  });
  console.log('add second:', second.content[0].text.split('\n')[0]);

  const tools = (await h.listTools()).tools.map((t) => t.name);
  console.log('published :', tools.filter((n) => n.startsWith(prefix)).length, 'live +', tools.filter((n) => n.startsWith('companion_')).length, 'mock');

  const createTool = `${prefix}_xenforo_pro_createThread`;
  if (!tools.includes(createTool)) {
    console.error(`tool ${createTool} not published. available: ${tools.join(', ')}`);
    process.exit(1);
  }

  const res = await h.callTool(createTool, {
    forum_id: FORUM_ID,
    title: TITLE,
    message: readFileSync(BODY_FILE, 'utf-8'),
  });

  console.log('\ncreateThread result:\n' + res.content[0].text.slice(0, 1200));

  await h.close();
  await companion.close();
  process.exit(res.isError ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(2);
});
