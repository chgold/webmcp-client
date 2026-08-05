import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startMockSite, makeTools } from './mock-site.js';
import { startClient } from './harness.js';

const results = [];
const sites = [];

function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function site(opts) {
  const s = await startMockSite(opts);
  sites.push(s);
  return s;
}

function sandboxHome(config) {
  const home = mkdtempSync(join(tmpdir(), 'webmcp-t-'));
  mkdirSync(join(home, '.webmcp-client'), { recursive: true });
  if (config) {
    writeFileSync(join(home, '.webmcp-client', 'sites.json'), JSON.stringify(config, null, 2));
  }
  return home;
}

function siteToolNames(list) {
  return list.tools.map((t) => t.name).filter((n) => !n.startsWith('webmcp_'));
}

async function testCapability() {
  const h = await startClient();
  const caps = h.serverCapabilities;
  check(
    'declares capabilities.tools.listChanged = true',
    caps?.tools?.listChanged === true,
    JSON.stringify(caps?.tools)
  );
  await h.close();
}

async function testManySitesDynamic() {
  const built = [];
  for (let i = 1; i <= 6; i++) {
    built.push(await site({ name: `site${i}`, tools: makeTools(3, `op${i}_`) }));
  }

  const h = await startClient();
  let expectedEvents = 0;

  for (const s of built) {
    const res = await h.callTool('webmcp_addSite', {
      name: s.name,
      manifest_url: s.manifestUrl,
      token: `Bearer token-${s.name}`,
    });
    check(`addSite "${s.name}" succeeded`, res.isError !== true, res.content[0].text.split('\n')[0]);
    expectedEvents++;
    const got = await h.waitForListChanged(expectedEvents);
    check(`tools/list_changed fired for "${s.name}"`, got >= expectedEvents, `${got} event(s)`);
  }

  const list = await h.listTools();
  const names = siteToolNames(list);
  check('all 6 sites x 3 tools published', names.length === 18, `${names.length} site tools`);
  check('no duplicate published names', new Set(names).size === names.length);
  check(
    'every name within MCP/Claude limits',
    names.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)),
    names.filter((n) => !/^[a-zA-Z0-9_-]{1,64}$/.test(n)).join(', ') || 'all valid'
  );

  for (const s of built) {
    const tool = names.find((n) => n.startsWith(`${s.name}_`));
    await h.callTool(tool, { q: s.name });
    const last = s.calls.at(-1);
    check(
      `"${s.name}" routes to its own backend with its own token`,
      last?.authorization === `Bearer token-${s.name}` && last?.body?.arguments?.q === s.name,
      `auth=${last?.authorization}`
    );
  }

  const removed = await h.callTool('webmcp_removeSite', { name: 'site3' });
  check('removeSite succeeded', removed.isError !== true);
  const afterRemove = siteToolNames(await h.listTools());
  check('removed site tools disappear', afterRemove.length === 15, `${afterRemove.length} site tools`);
  check('other sites unaffected', afterRemove.some((n) => n.startsWith('site4_')));

  await h.close();
}

async function testCollisions() {
  const ab = await site({
    name: 'a_b',
    tools: [{ name: 'c', description: 'from a_b', input_schema: { type: 'object', properties: {} } }],
  });
  const a = await site({
    name: 'a',
    tools: [{ name: 'b.c', description: 'from a', input_schema: { type: 'object', properties: {} } }],
  });

  const h = await startClient();
  await h.callTool('webmcp_addSite', { name: 'a_b', manifest_url: ab.manifestUrl, token: 'Bearer t1' });
  await h.callTool('webmcp_addSite', { name: 'a', manifest_url: a.manifestUrl, token: 'Bearer t2' });

  const names = siteToolNames(await h.listTools());
  check('colliding names both survive', names.length === 2, names.join(', '));
  check('colliding names are distinct', new Set(names).size === 2);

  const listText = (await h.callTool('webmcp_listSites')).content[0].text;
  check('listSites reports 1 tool for each site', (listText.match(/tools: 1/g) || []).length === 2, listText.replace(/\n/g, ' | '));

  const first = names[0];
  await h.callTool(first, {});
  const routed = ab.calls.length === 1 ? 'a_b' : a.calls.length === 1 ? 'a' : 'none';
  check('colliding tool routes to exactly one backend', routed !== 'none', `routed to ${routed}`);

  await h.close();
}

async function testDeterministicNames() {
  const ab = await site({
    name: 'a_b',
    tools: [{ name: 'c', description: 'x', input_schema: { type: 'object', properties: {} } }],
  });
  const a = await site({
    name: 'a',
    tools: [{ name: 'b.c', description: 'y', input_schema: { type: 'object', properties: {} } }],
  });

  const cfgA = { sites: { a_b: { manifest: ab.manifestUrl, token: 'Bearer t1' }, a: { manifest: a.manifestUrl, token: 'Bearer t2' } } };
  const cfgB = { sites: { a: { manifest: a.manifestUrl, token: 'Bearer t2' }, a_b: { manifest: ab.manifestUrl, token: 'Bearer t1' } } };

  const h1 = await startClient({ home: sandboxHome(cfgA) });
  const n1 = siteToolNames(await h1.listTools()).sort();
  await h1.close();

  const h2 = await startClient({ home: sandboxHome(cfgB) });
  const n2 = siteToolNames(await h2.listTools()).sort();
  await h2.close();

  check('names are stable regardless of load order', JSON.stringify(n1) === JSON.stringify(n2), `${n1} vs ${n2}`);
}

async function testLongNames() {
  const s = await site({
    name: 'averyveryverylongsitename',
    tools: [
      {
        name: 'drupal.searchNodesByContentTypeAndTaxonomyTermWithPagination',
        description: 'long',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'drupal.searchNodesByContentTypeAndTaxonomyTermWithSorting',
        description: 'also long',
        input_schema: { type: 'object', properties: {} },
      },
    ],
  });

  const h = await startClient();
  await h.callTool('webmcp_addSite', { name: s.name, manifest_url: s.manifestUrl, token: 'Bearer t' });
  const names = siteToolNames(await h.listTools());

  check('long names truncated to <= 64', names.every((n) => n.length <= 64), names.map((n) => `${n}(${n.length})`).join(', '));
  check('truncated long names stay distinct', new Set(names).size === 2);

  await h.callTool(names[0], {});
  check('truncated tool still routes to backend', s.calls.length === 1, `${s.calls.length} call(s), tool=${s.calls[0]?.body?.name}`);
  check(
    'backend receives ORIGINAL unsanitized tool name',
    s.calls[0]?.body?.name?.startsWith('drupal.'),
    s.calls[0]?.body?.name
  );

  await h.close();
}

async function testFailedReAddKeepsSite() {
  const s = await site({ name: 'keeper', tools: makeTools(2, 'k') });
  const h = await startClient();

  await h.callTool('webmcp_addSite', { name: 'keeper', manifest_url: s.manifestUrl, token: 'Bearer good' });
  const before = siteToolNames(await h.listTools());

  const bad = await h.callTool('webmcp_addSite', {
    name: 'keeper',
    manifest_url: 'http://127.0.0.1:9/manifest',
    token: 'Bearer typo',
  });
  check('failed re-add returns an error', bad.isError === true);

  const after = siteToolNames(await h.listTools());
  check('failed re-add preserves working tools', after.length === before.length && after.length === 2, `${after.length} tools`);

  await h.callTool(after[0], {});
  check('preserved site still uses the ORIGINAL good token', s.calls.at(-1)?.authorization === 'Bearer good', s.calls.at(-1)?.authorization);

  const cfg = JSON.parse(readFileSync(join(h.home, '.webmcp-client', 'sites.json'), 'utf-8'));
  check('config on disk still holds the good manifest', cfg.sites.keeper.manifest === s.manifestUrl, cfg.sites.keeper.manifest);

  await h.close();
}

async function testMalformedManifests() {
  const bad = await site({
    name: 'messy',
    tools: [
      { name: 'okTool', description: 'fine', input_schema: { type: 'object', properties: { a: { type: 'string' } } } },
      { name: 'arrayProps', description: 'bad', input_schema: { type: 'object', properties: [] } },
      { name: 'nullSchema', description: 'bad', input_schema: null },
      { name: 'stringSchema', description: 'bad', input_schema: { type: 'string' } },
      { name: 'okTool', description: 'duplicate', input_schema: { type: 'object', properties: {} } },
      { description: 'nameless', input_schema: { type: 'object', properties: {} } },
      { name: 'badRequired', description: 'bad', input_schema: { type: 'object', properties: {}, required: ['ghost'] } },
    ],
  });
  const good = await site({ name: 'clean', tools: makeTools(2, 'c') });

  const h = await startClient();
  await h.callTool('webmcp_addSite', { name: 'messy', manifest_url: bad.manifestUrl, token: 'Bearer t' });
  await h.callTool('webmcp_addSite', { name: 'clean', manifest_url: good.manifestUrl, token: 'Bearer t' });

  const list = await h.listTools();
  const names = siteToolNames(list);
  check('malformed manifest does not break the tools list', names.length === 7, `${names.length} tools: ${names.join(', ')}`);
  check('clean site unaffected by the messy one', names.filter((n) => n.startsWith('clean_')).length === 2);
  check(
    'every inputSchema is a valid object schema',
    list.tools.every((t) => t.inputSchema?.type === 'object' && t.inputSchema.properties && !Array.isArray(t.inputSchema.properties)),
    'all normalized'
  );
  const badRequired = list.tools.find((t) => t.name.includes('badRequired'));
  check('dangling "required" entries stripped', badRequired?.inputSchema?.required === undefined, JSON.stringify(badRequired?.inputSchema));

  await h.close();
}

async function testStartupNotBlocking() {
  const reachable = await site({ name: 'up', tools: makeTools(1, 'u'), manifestDelayMs: 50 });
  const cfg = { sites: { up: { manifest: reachable.manifestUrl, token: 'Bearer t' } } };
  for (let i = 0; i < 5; i++) {
    cfg.sites[`blackhole${i}`] = { manifest: 'http://10.255.255.1:1/manifest', token: 'Bearer t' };
  }

  const t0 = Date.now();
  const h = await startClient({ home: sandboxHome(cfg) });
  const elapsed = Date.now() - t0;

  check('handshake not blocked by unreachable sites', elapsed < 6000, `${elapsed}ms with 5 black-holed sites`);
  const names = siteToolNames(await h.listTools());
  check('reachable site still loads', names.length === 1, names.join(', '));

  await h.close();
}

async function testRefreshPicksUpNewTools() {
  const s = await site({ name: 'growing', tools: makeTools(1, 'g') });
  const h = await startClient();
  await h.callTool('webmcp_addSite', { name: 'growing', manifest_url: s.manifestUrl, token: 'Bearer t' });
  check('starts with 1 tool', siteToolNames(await h.listTools()).length === 1);

  const s2 = await startMockSite({ name: 'growing', tools: makeTools(4, 'g') });
  sites.push(s2);
  await h.callTool('webmcp_addSite', { name: 'growing', manifest_url: s2.manifestUrl, token: 'Bearer t' });

  const refreshed = await h.callTool('webmcp_refreshSites', {});
  check('refreshSites succeeds', refreshed.isError !== true, refreshed.content[0].text.split('\n')[0]);
  check('refresh picks up new tools', siteToolNames(await h.listTools()).length === 4);

  await h.close();
}

async function testExternalConfigChange() {
  const s = await site({ name: 'external', tools: makeTools(2, 'e') });
  const home = sandboxHome({ sites: {} });
  const h = await startClient({ home });

  check('starts empty', siteToolNames(await h.listTools()).length === 0);

  writeFileSync(
    join(home, '.webmcp-client', 'sites.json'),
    JSON.stringify({ sites: { external: { manifest: s.manifestUrl, token: 'Bearer t' } } }, null, 2)
  );

  const got = await h.waitForListChanged(1, 5000);
  check('external config edit triggers list_changed', got >= 1, `${got} event(s)`);
  check('externally added site is published', siteToolNames(await h.listTools()).length === 2);

  await h.close();
}

async function testMultipleSiteFlags() {
  const s1 = await site({ name: 'flag1', tools: makeTools(2, 'f') });
  const s2 = await site({ name: 'flag2', tools: makeTools(2, 'f') });

  const h = await startClient({
    args: [
      '--site', `name=flag1,manifest=${s1.manifestUrl},token=Bearer t1`,
      '--site', `name=flag2,manifest=${s2.manifestUrl},token=Bearer t2`,
    ],
  });

  const names = siteToolNames(await h.listTools());
  check('repeated --site flags register all sites', names.length === 4, names.join(', '));
  await h.close();
}

async function testPersistenceAcrossRestart() {
  const s1 = await site({ name: 'p1', tools: makeTools(2, 'p') });
  const s2 = await site({ name: 'p2', tools: makeTools(2, 'p') });
  const home = sandboxHome({ sites: {} });

  const h1 = await startClient({ home });
  await h1.callTool('webmcp_addSite', { name: 'p1', manifest_url: s1.manifestUrl, token: 'Bearer t1' });
  await h1.callTool('webmcp_addSite', { name: 'p2', manifest_url: s2.manifestUrl, token: 'Bearer t2' });
  const before = siteToolNames(await h1.listTools()).sort();
  await h1.close();

  const h2 = await startClient({ home });
  const after = siteToolNames(await h2.listTools()).sort();
  check('sites persist across restart', JSON.stringify(before) === JSON.stringify(after), `${after.length} tools`);
  await h2.close();
}

async function testAuthenticatedManifest() {
  const s = await site({
    name: 'private',
    tools: makeTools(2, 'p'),
    requireManifestToken: 'Bearer secret-token',
  });

  const h = await startClient();
  const res = await h.callTool('webmcp_addSite', {
    name: 'private',
    manifest_url: s.manifestUrl,
    token: 'Bearer secret-token',
  });
  check('manifest fetch sends Authorization header', res.isError !== true, res.content[0].text.split('\n')[0]);
  check('auth-protected site loads its tools', siteToolNames(await h.listTools()).length === 2);
  await h.close();
}

async function testBareTokenNormalised() {
  const s = await site({ name: 'bare', tools: makeTools(1, 'b'), requireToken: 'Bearer raw-token-value' });
  const h = await startClient();
  await h.callTool('webmcp_addSite', { name: 'bare', manifest_url: s.manifestUrl, token: 'raw-token-value' });
  const names = siteToolNames(await h.listTools());
  const res = await h.callTool(names[0], {});
  check('token without "Bearer " prefix is normalised', res.isError !== true, s.calls.at(-1)?.authorization);
  await h.close();
}

async function testReactiveTokenRefresh() {
  const s = await site({
    name: 'expiring',
    tools: makeTools(1, 'e'),
    requireToken: 'Bearer initial-access',
    oauth: { refreshToken: 'initial-refresh', expiresIn: 3600 },
  });

  const h = await startClient();
  await h.callTool('webmcp_addSite', {
    name: 'expiring',
    manifest_url: s.manifestUrl,
    token: 'Bearer initial-access',
    refresh_token: 'initial-refresh',
  });

  const names = siteToolNames(await h.listTools());
  const ok = await h.callTool(names[0], {});
  check('call works with the initial token', ok.isError !== true);

  s.expireAccessToken('Bearer something-else');
  const afterExpiry = await h.callTool(names[0], {});
  check('401 triggers automatic refresh and retry', afterExpiry.isError !== true, afterExpiry.content[0].text.slice(0, 80));
  check('refresh endpoint was actually called', s.refreshCalls.length === 1, `${s.refreshCalls.length} refresh call(s)`);
  check(
    'refresh sent grant_type + refresh_token + client_id',
    s.refreshCalls[0]?.body?.grant_type === 'refresh_token' &&
      s.refreshCalls[0]?.body?.refresh_token === 'initial-refresh' &&
      Boolean(s.refreshCalls[0]?.body?.client_id),
    JSON.stringify(s.refreshCalls[0]?.body)
  );

  const cfg = JSON.parse(readFileSync(join(h.home, '.webmcp-client', 'sites.json'), 'utf-8'));
  check('rotated refresh_token persisted to disk', cfg.sites.expiring.refresh_token === 'rotated-refresh-1', cfg.sites.expiring.refresh_token);
  check('rotated access token persisted to disk', cfg.sites.expiring.token === 'Bearer rotated-access-1', cfg.sites.expiring.token);
  check('expires_at recorded', typeof cfg.sites.expiring.expires_at === 'number');

  await h.close();
}

async function testRefreshSurvivesRestart() {
  const s = await site({
    name: 'persist',
    tools: makeTools(1, 'r'),
    requireToken: 'Bearer first-access',
    oauth: { refreshToken: 'first-refresh', expiresIn: 3600 },
  });
  const home = sandboxHome({ sites: {} });

  const h1 = await startClient({ home });
  await h1.callTool('webmcp_addSite', {
    name: 'persist',
    manifest_url: s.manifestUrl,
    token: 'Bearer first-access',
    refresh_token: 'first-refresh',
  });
  s.expireAccessToken('Bearer gone');
  const names1 = siteToolNames(await h1.listTools());
  await h1.callTool(names1[0], {});
  await h1.close();

  const h2 = await startClient({ home });
  const names2 = siteToolNames(await h2.listTools());
  const res = await h2.callTool(names2[0], {});
  check('restarted client reuses the rotated token', res.isError !== true, res.content[0].text.slice(0, 80));
  check('no redundant refresh after restart', s.refreshCalls.length === 1, `${s.refreshCalls.length} refresh call(s)`);
  await h2.close();
}

async function testMissingRefreshTokenIsWarned() {
  const s = await site({ name: 'norefresh', tools: makeTools(1, 'n'), requireToken: 'Bearer only-access' });
  const h = await startClient();
  const res = await h.callTool('webmcp_addSite', {
    name: 'norefresh',
    manifest_url: s.manifestUrl,
    token: 'Bearer only-access',
  });
  check('addSite warns when refresh_token is missing', res.content[0].text.includes('refresh_token'), 'warning present');

  s.expireAccessToken('Bearer rotated-elsewhere');
  const names = siteToolNames(await h.listTools());
  const failed = await h.callTool(names[0], {});
  check('expired call without refresh_token gives actionable error', failed.isError === true && failed.content[0].text.includes('refresh_token'), failed.content[0].text.slice(0, 120));

  const listed = (await h.callTool('webmcp_listSites')).content[0].text;
  check('listSites flags sites lacking refresh_token', listed.includes('no refresh_token'));
  await h.close();
}

async function testConcurrentRefreshDeduped() {
  const s = await site({
    name: 'concurrent',
    tools: makeTools(4, 'c'),
    requireToken: 'Bearer start-access',
    oauth: { refreshToken: 'start-refresh', expiresIn: 3600 },
  });

  const h = await startClient();
  await h.callTool('webmcp_addSite', {
    name: 'concurrent',
    manifest_url: s.manifestUrl,
    token: 'Bearer start-access',
    refresh_token: 'start-refresh',
  });
  const names = siteToolNames(await h.listTools());
  s.expireAccessToken('Bearer nope');

  const outcomes = await Promise.all(names.map((n) => h.callTool(n, {})));
  check('all concurrent calls succeed after refresh', outcomes.every((o) => o.isError !== true), outcomes.map((o) => (o.isError ? 'ERR' : 'ok')).join(','));
  check('concurrent 401s trigger exactly one refresh', s.refreshCalls.length === 1, `${s.refreshCalls.length} refresh call(s)`);
  await h.close();
}

async function approveInBrowser(authUrl) {
  const res = await fetch(authUrl);
  const body = await res.json();
  return body.code;
}

function extractUrl(text) {
  return text.match(/https?:\/\/[^\s]+/)?.[0];
}

async function testPkceOAuthFlow() {
  const s = await site({
    name: 'oauth-site',
    tools: makeTools(3, 'o'),
    requireToken: 'Bearer nothing-yet',
    oauth: { refreshToken: 'unused', expiresIn: 3600 },
  });

  const h = await startClient();
  const started = await h.callTool('webmcp_startAuth', { name: 'oauth-site', manifest_url: s.manifestUrl });
  check('startAuth succeeds', started.isError !== true, started.content[0].text.split('\n')[0]);

  const authUrl = extractUrl(started.content[0].text);
  check('startAuth returns an authorization URL', Boolean(authUrl), authUrl);

  const code = await approveInBrowser(authUrl);
  check('authorization request carried PKCE S256 challenge', s.state.pkce?.method === 'S256' && Boolean(s.state.pkce?.challenge), JSON.stringify(s.state.pkce?.method));
  check('authorization request carried client_id and response_type', s.state.pkce?.clientId === 'claude-ai' && s.state.pkce?.responseType === 'code', s.state.pkce?.clientId);
  check('authorization request carried scopes', Boolean(s.state.pkce?.scope), s.state.pkce?.scope);

  const completed = await h.callTool('webmcp_completeAuth', { name: 'oauth-site', code });
  check('completeAuth succeeds (server verified the PKCE verifier)', completed.isError !== true, completed.content[0].text.split('\n')[0]);

  const names = siteToolNames(await h.listTools());
  check('OAuth-registered site publishes its tools', names.length === 3, names.join(', '));

  const called = await h.callTool(names[0], {});
  check('tool call works with the granted token', called.isError !== true, s.calls.at(-1)?.authorization);

  const cfg = JSON.parse(readFileSync(join(h.home, '.webmcp-client', 'sites.json'), 'utf-8'));
  check('granted tokens persisted', cfg.sites['oauth-site'].token === 'Bearer granted-access' && cfg.sites['oauth-site'].refresh_token === 'granted-refresh');
  check('token_url and client_id recorded', Boolean(cfg.sites['oauth-site'].token_url) && cfg.sites['oauth-site'].client_id === 'claude-ai');

  s.expireAccessToken('Bearer stale');
  const afterExpiry = await h.callTool(names[0], {});
  check('OAuth-registered site refreshes like any other', afterExpiry.isError !== true, `${s.refreshCalls.length} refresh call(s)`);

  await h.close();
}

async function testOAuthRejectsBadCode() {
  const s = await site({ name: 'oauth-bad', tools: makeTools(1, 'x'), oauth: { refreshToken: 'u' } });
  const h = await startClient();

  const noPending = await h.callTool('webmcp_completeAuth', { name: 'oauth-bad', code: 'whatever' });
  check('completeAuth without startAuth is rejected', noPending.isError === true, noPending.content[0].text.slice(0, 70));

  const started = await h.callTool('webmcp_startAuth', { name: 'oauth-bad', manifest_url: s.manifestUrl });
  await approveInBrowser(extractUrl(started.content[0].text));

  const bad = await h.callTool('webmcp_completeAuth', { name: 'oauth-bad', code: 'wrong-code' });
  check('completeAuth with wrong code is rejected', bad.isError === true, bad.content[0].text.slice(0, 70));
  check('rejected auth registers no site', siteToolNames(await h.listTools()).length === 0);

  await h.close();
}

async function testStartAuthWithoutOAuthManifest() {
  const s = await site({ name: 'plain', tools: makeTools(1, 'p') });
  const h = await startClient();
  const res = await h.callTool('webmcp_startAuth', { name: 'plain', manifest_url: s.manifestUrl });
  check('startAuth explains when a site has no OAuth block', res.isError === true && res.content[0].text.includes('webmcp_addSite'), res.content[0].text.slice(0, 90));
  await h.close();
}

async function main() {
  await testCapability();
  await testManySitesDynamic();
  await testCollisions();
  await testDeterministicNames();
  await testLongNames();
  await testFailedReAddKeepsSite();
  await testMalformedManifests();
  await testStartupNotBlocking();
  await testRefreshPicksUpNewTools();
  await testExternalConfigChange();
  await testMultipleSiteFlags();
  await testPersistenceAcrossRestart();
  await testAuthenticatedManifest();
  await testBareTokenNormalised();
  await testReactiveTokenRefresh();
  await testRefreshSurvivesRestart();
  await testMissingRefreshTokenIsWarned();
  await testConcurrentRefreshDeduped();
  await testPkceOAuthFlow();
  await testOAuthRejectsBadCode();
  await testStartAuthWithoutOAuthManifest();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log(`Failures:\n${failed.map((f) => `  - ${f.label}`).join('\n')}`);
  return failed.length;
}

main()
  .then(async (failures) => {
    await Promise.all(sites.map((s) => s.close()));
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error('HARNESS ERROR:', e);
    await Promise.all(sites.map((s) => s.close()));
    process.exit(2);
  });
