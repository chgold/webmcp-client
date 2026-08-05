import { createServer } from 'http';
import { createHash } from 'crypto';

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function startMockSite({
  name,
  tools = [],
  manifestPath = '/manifest',
  toolsPath = '/tools',
  oauthPath = '/oauth',
  authorizePath = '/authorize',
  toolsKey = 'usage',
  requireToken = null,
  requireManifestToken = null,
  manifestDelayMs = 0,
  manifestStatus = 200,
  oauth = null,
} = {}) {
  const calls = [];
  const refreshCalls = [];
  const state = { accessToken: requireToken, refreshToken: oauth?.refreshToken ?? null };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const send = (status, payload) => {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    };

    if (url.pathname === manifestPath) {
      if (requireManifestToken && req.headers.authorization !== requireManifestToken) {
        return send(401, { error: 'manifest requires auth' });
      }
      const port = server.address().port;
      const toolsEndpoint = `http://127.0.0.1:${port}${toolsPath}`;
      const manifest = { server: { name } };
      if (oauth) {
        manifest.auth = {
          type: 'oauth2',
          flow: 'authorization_code',
          authorization_url: `http://127.0.0.1:${port}${authorizePath}`,
          token_url: `http://127.0.0.1:${port}${oauthPath}`,
          pkce_required: true,
          code_challenge_method: 'S256',
          redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
          grant_types: ['authorization_code', 'refresh_token'],
          scopes: oauth.scopes || { read: 'Read', write: 'Write' },
          registered_clients: oauth.registeredClients || { 'claude-ai': 'Claude AI' },
        };
      }
      if (toolsKey === 'usage') {
        manifest.usage = { tools_endpoint: toolsEndpoint, tools };
      } else {
        manifest.usage = { tools_endpoint: toolsEndpoint };
        manifest.tools = tools;
      }
      setTimeout(() => {
        if (manifestStatus !== 200) return send(manifestStatus, { error: 'mock failure' });
        send(200, manifest);
      }, manifestDelayMs);
      return;
    }

    if (url.pathname === authorizePath) {
      state.pkce = {
        challenge: url.searchParams.get('code_challenge'),
        method: url.searchParams.get('code_challenge_method'),
        clientId: url.searchParams.get('client_id'),
        redirectUri: url.searchParams.get('redirect_uri'),
        scope: url.searchParams.get('scope'),
        responseType: url.searchParams.get('response_type'),
        state: url.searchParams.get('state'),
      };
      return send(200, { code: oauth?.code || 'test-auth-code' });
    }

    if (url.pathname === oauthPath && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          body = Object.fromEntries(new URLSearchParams(raw));
        }
        refreshCalls.push({ body, contentType: req.headers['content-type'] });

        if (body.grant_type === 'authorization_code') {
          if (body.code !== (oauth?.code || 'test-auth-code')) {
            return send(400, { error: 'invalid_grant' });
          }
          if (!state.pkce?.challenge) {
            return send(400, { error: 'no authorization request seen' });
          }
          const expected = base64url(createHash('sha256').update(body.code_verifier || '').digest());
          if (expected !== state.pkce.challenge) {
            return send(400, { error: 'invalid_grant', detail: 'PKCE verifier does not match challenge' });
          }
          state.accessToken = 'Bearer granted-access';
          state.refreshToken = 'granted-refresh';
          return send(200, {
            access_token: 'granted-access',
            token_type: 'Bearer',
            expires_in: oauth?.expiresIn ?? 3600,
            refresh_token: state.refreshToken,
          });
        }

        if (body.grant_type !== 'refresh_token') {
          return send(400, { error: 'unsupported_grant_type' });
        }
        if (body.refresh_token !== state.refreshToken) {
          return send(400, { error: 'invalid_grant' });
        }

        const n = refreshCalls.length;
        state.accessToken = `Bearer rotated-access-${n}`;
        state.refreshToken = `rotated-refresh-${n}`;
        send(200, {
          access_token: `rotated-access-${n}`,
          token_type: 'Bearer',
          expires_in: oauth?.expiresIn ?? 3600,
          refresh_token: state.refreshToken,
        });
      });
      return;
    }

    if (url.pathname === toolsPath && req.method === 'POST') {
      if (state.accessToken && req.headers.authorization !== state.accessToken) {
        return send(401, { errors: [{ code: 'invalid_bearer_token', message: 'api_error.invalid_bearer_token' }] });
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return send(400, { error: 'bad json' });
        }
        calls.push({ site: name, body: parsed, authorization: req.headers.authorization });
        send(200, { site: name, tool: parsed.name, echo: parsed.arguments ?? null });
      });
      return;
    }

    send(404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        name,
        port,
        calls,
        refreshCalls,
        state,
        expireAccessToken: (value = 'Bearer expired-sentinel') => {
          state.accessToken = value;
        },
        authorizeUrl: `http://127.0.0.1:${port}${authorizePath}`,
        manifestUrl: `http://127.0.0.1:${port}${manifestPath}`,
        toolsUrl: `http://127.0.0.1:${port}${toolsPath}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

export function makeTools(count, prefix = 'tool') {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}${i + 1}`,
    description: `Mock tool ${prefix}${i + 1}`,
    input_schema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'query' } },
    },
  }));
}
