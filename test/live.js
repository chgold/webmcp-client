import { startMockSite, makeTools } from './mock-site.js';
import { startClient } from './harness.js';

const MANIFEST = process.env.WEBMCP_LIVE_MANIFEST;
const TOKEN = process.env.WEBMCP_LIVE_TOKEN;
const REFRESH = process.env.WEBMCP_LIVE_REFRESH;
const SITE = process.env.WEBMCP_LIVE_SITE || 'live-site';

if (!MANIFEST || !TOKEN) {
  console.log('skipped: set WEBMCP_LIVE_MANIFEST and WEBMCP_LIVE_TOKEN to run the live check');
  process.exit(0);
}

const results = [];
function check(label, pass, detail = '') {
  results.push(pass);
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const companion = await startMockSite({ name: 'companion', tools: makeTools(3, 'mock') });
  const h = await startClient();

  const added = await h.callTool('webmcp_addSite', {
    name: SITE,
    manifest_url: MANIFEST,
    token: TOKEN,
    ...(REFRESH ? { refresh_token: REFRESH } : {}),
  });
  check('live site added', added.isError !== true, added.content[0].text.split('\n')[0]);

  const second = await h.callTool('webmcp_addSite', {
    name: 'companion',
    manifest_url: companion.manifestUrl,
    token: 'Bearer mock',
  });
  check('SECOND site added on top of the live one', second.isError !== true, second.content[0].text.split('\n')[0]);

  const tools = (await h.listTools()).tools;
  const liveNames = tools.map((t) => t.name).filter((n) => n.startsWith(`${SITE.replace(/[^a-zA-Z0-9_-]/g, '_')}_`));
  const mockNames = tools.map((t) => t.name).filter((n) => n.startsWith('companion_'));
  check('live site tools published', liveNames.length > 0, `${liveNames.length} tools`);
  check('mock site tools published alongside', mockNames.length === 3, `${mockNames.length} tools`);
  check('all names valid', tools.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name)));

  const whoami = liveNames.find((n) => n.toLowerCase().includes('getcurrentuser'));
  if (whoami) {
    const res = await h.callTool(whoami, {});
    const text = res.content[0].text;
    check('real tool call succeeded', res.isError !== true && text.includes('"success"'), text.slice(0, 160).replace(/\s+/g, ' '));
  }

  console.log(`\n${(await h.callTool('webmcp_listSites')).content[0].text}`);
  await h.close();
  await companion.close();

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} live checks passed`);
  return failed;
}

main().then((f) => process.exit(f === 0 ? 0 : 1)).catch((e) => {
  console.error('LIVE ERROR:', e);
  process.exit(2);
});
