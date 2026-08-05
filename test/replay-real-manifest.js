import { readFileSync } from 'fs';
import { startMockSite } from './mock-site.js';
import { startClient } from './harness.js';

const MANIFEST = process.env.WEBMCP_MANIFEST_FIXTURE || new URL('./fixtures/gold-t-manifest.json', import.meta.url).pathname;

const sites = [];
async function site(opts) {
  const s = await startMockSite(opts);
  sites.push(s);
  return s;
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
  const tools = manifest.usage?.tools || manifest.tools || [];
  console.log(`entry: ${process.env.WEBMCP_ENTRY || 'index.js (current)'}`);
  console.log(`replaying ${tools.length} real tools per site\n`);

  const first = await site({ name: 'gold-t.co.il', tools, toolsKey: 'top' });
  const second = await site({ name: 'second-site.example', tools, toolsKey: 'top' });

  const h = await startClient();

  const step = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      console.log(`  ${label}: THREW ${e.message}`);
      return null;
    }
  };

  const base = await step('list', () => h.listTools());
  console.log(`before any site      : ${base ? base.tools.length : 'ERROR'} tools`);

  const add1 = await step('add1', () =>
    h.callTool('webmcp_addSite', { name: 'gold-t.co.il', manifest_url: first.manifestUrl, token: 'Bearer xfa_test' })
  );
  console.log(`addSite #1           : ${add1 ? (add1.isError ? 'ERROR ' + add1.content[0].text : 'ok') : 'THREW'}`);

  const afterOne = await step('list1', () => h.listTools());
  console.log(`after site #1        : ${afterOne ? afterOne.tools.length : 'ERROR'} tools`);

  const add2 = await step('add2', () =>
    h.callTool('webmcp_addSite', { name: 'second-site.example', manifest_url: second.manifestUrl, token: 'Bearer xfa_test2' })
  );
  console.log(`addSite #2           : ${add2 ? (add2.isError ? 'ERROR ' + add2.content[0].text : 'ok') : 'THREW'}`);

  const afterTwo = await step('list2', () => h.listTools());
  console.log(`after site #2        : ${afterTwo ? afterTwo.tools.length : 'ERROR'} tools`);

  const events = await h.waitForListChanged(2, 3000);

  if (afterTwo) {
    const names = afterTwo.tools.map((t) => t.name);
    const bad = names.filter((n) => !/^[a-zA-Z0-9_-]{1,64}$/.test(n));
    const badSchema = afterTwo.tools.filter(
      (t) => t.inputSchema?.type !== 'object' || !t.inputSchema.properties || Array.isArray(t.inputSchema.properties)
    );
    console.log(`invalid names        : ${bad.length ? bad.join(', ') : 'none'}`);
    console.log(`invalid schemas      : ${badSchema.length ? badSchema.map((t) => t.name).join(', ') : 'none'}`);
    console.log(`duplicate names      : ${names.length - new Set(names).size}`);
    console.log(`list_changed events  : ${events}`);
    console.log(`\npublished:\n${names.map((n) => `  ${n}`).join('\n')}`);
  }

  await h.close();
}

main()
  .then(async () => {
    await Promise.all(sites.map((s) => s.close()));
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('HARNESS ERROR:', e);
    await Promise.all(sites.map((s) => s.close()));
    process.exit(2);
  });
