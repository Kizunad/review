import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

// The real relay credential never enters the sandbox. When a relay base URL and an
// API key are configured, runFreshClaude starts this host-side loopback proxy, points
// the sandbox at it with a per-run NONCE credential, and the proxy injects the real
// key only into requests toward the fixed relay origin. A compromised reviewer can
// read the nonce all day; the key value itself stays host-side and unreadable.
//
// The path allowlist keeps the real key from riding arbitrary endpoints a compromised
// sandbox could guess on the relay origin: only the provider API surface (messages,
// count_tokens, complete, models) plus the base-path probe the CLI issues at startup
// may be proxied; anything else is refused outright.
const ALLOWED_PATH = /^(\/|\/v1\/(messages|messages\/count_tokens|complete|models))$/;

export async function createCredentialProxy(environment) {
  const baseUrl = environment?.ANTHROPIC_BASE_URL;
  const apiKey = environment?.ANTHROPIC_API_KEY;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0
    || typeof apiKey !== 'string' || apiKey.length === 0) {
    return null;
  }
  let upstream;
  try {
    upstream = new URL(baseUrl);
  } catch {
    return null;
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') return null;
  const originPrefix = baseUrl.replace(/\/+$/, '');
  const server = http.createServer((clientRequest, clientResponse) => {
    let path;
    try {
      path = new URL(clientRequest.url ?? '/', 'http://sandbox');
    } catch {
      clientResponse.writeHead(400);
      clientResponse.end();
      return;
    }
    if (!ALLOWED_PATH.test(path.pathname)) {
      clientResponse.writeHead(403);
      clientResponse.end('path not proxied');
      return;
    }
    const headers = { ...clientRequest.headers, host: upstream.host };
    delete headers['x-api-key'];
    delete headers['authorization'];
    delete headers['connection'];
    delete headers['transfer-encoding'];
    headers['x-api-key'] = apiKey;
    const transport = upstream.protocol === 'https:' ? https : http;
    const upstreamRequest = transport.request(
      `${originPrefix}${path.pathname}${path.search}`,
      { method: clientRequest.method, headers },
      (upstreamResponse) => {
        // Strip connection-semantics headers from the upstream response: forwarding
        // the relay's keep-alive onto a client that asked for close corrupts the
        // proxy's own socket lifecycle and the next request 400s before the handler.
        const responseHeaders = { ...upstreamResponse.headers };
        delete responseHeaders['connection'];
        delete responseHeaders['keep-alive'];
        delete responseHeaders['transfer-encoding'];
        clientResponse.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(clientResponse);
      },
    );
    upstreamRequest.on('error', () => {
      if (clientResponse.headersSent) {
        clientResponse.destroy();
      } else {
        clientResponse.writeHead(502, { 'content-type': 'text/plain' });
        clientResponse.end('proxy upstream error');
      }
    });
    clientRequest.pipe(upstreamRequest);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    sandboxEnvironment: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: `claude-review-proxy-${randomUUID()}`,
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
