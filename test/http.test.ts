// The HTTP transport: a real listener on an ephemeral port, driven by the
// SDK's Streamable HTTP client — with the right token (works), no token (401),
// the wrong token (401), and refused at startup without a token at all.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { checkBearer, parseListen, startHttp } from '../src/http.ts';
import { configFromEnv, createServer } from '../src/index.ts';

const TOKEN = 'sh-test-token-9f2a';

async function serve(token: string | undefined) {
  const logs: string[] = [];
  const h = await startHttp({
    listen: '127.0.0.1:0',
    token,
    serverFactory: () => createServer(),
    log: (l) => logs.push(l),
  });
  return { ...h, logs };
}

function client(url: string, token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  return { transport, client: new Client({ name: 'http-test', version: '0' }) };
}

test('with the token: a client connects, lists tools and prices over HTTP', async () => {
  const h = await serve(TOKEN);
  try {
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.match(h.logs[0] ?? '', /listening on .*bearer auth/);
    const { transport, client: c } = client(h.url, TOKEN);
    await c.connect(transport);
    const { tools } = await c.listTools();
    assert.ok(tools.some((t) => t.name === 'price_usage'));
    const r = await c.callTool({
      name: 'price_usage',
      arguments: { quantity: '1234567', rate: '0.00012', currency: 'USD' },
    });
    assert.match((r.content as Array<{ text?: string }>).map((x) => x.text ?? '').join(''), /amount\s+1\.48 USD/);
    await c.close();
  } finally {
    await h.close();
  }
});

test('without the token, or with the wrong one: 401 and no MCP session', async () => {
  const h = await serve(TOKEN);
  try {
    const none = client(h.url);
    await assert.rejects(() => none.client.connect(none.transport), /unauthorized|401/);
    const wrong = client(h.url, `${TOKEN}x`);
    await assert.rejects(() => wrong.client.connect(wrong.transport), /unauthorized|401/);
    // a raw request shows the challenge header
    const res = await fetch(h.url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /Bearer realm="billing-kit-mcp"/);
    assert.equal(h.logs.filter((l) => l.includes('http 401')).length >= 3, true);
    // anything but /mcp is 404 (checked before auth, leaks nothing)
    const other = await fetch(h.url.replace('/mcp', '/health'));
    assert.equal(other.status, 404);
  } finally {
    await h.close();
  }
});

test('refuses to listen without a token', async () => {
  await assert.rejects(() => serve(undefined), /needs BILLING_KIT_MCP_TOKEN/);
  await assert.rejects(() => serve('   '), /needs BILLING_KIT_MCP_TOKEN/);
});

test('checkBearer is exact, case-insensitive on the scheme, and false on any mismatch', () => {
  assert.equal(checkBearer(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(checkBearer(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(checkBearer(`  Bearer   ${TOKEN}  `, TOKEN), true);
  assert.equal(checkBearer(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(checkBearer(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN), false);
  assert.equal(checkBearer(TOKEN, TOKEN), false, 'scheme required');
  assert.equal(checkBearer(`Basic ${TOKEN}`, TOKEN), false);
  assert.equal(checkBearer(undefined, TOKEN), false);
  assert.equal(checkBearer('', TOKEN), false);
});

test('parseListen accepts :port, port, host:port and [v6]:port; rejects the rest', () => {
  assert.deepEqual(parseListen(':3100'), { host: undefined, port: 3100 });
  assert.deepEqual(parseListen('3100'), { host: undefined, port: 3100 });
  assert.deepEqual(parseListen('127.0.0.1:0'), { host: '127.0.0.1', port: 0 });
  assert.deepEqual(parseListen('[::1]:8080'), { host: '::1', port: 8080 });
  assert.throws(() => parseListen('nope'), /expects :port/);
  assert.throws(() => parseListen(':70000'), /out of range/);
});

test('configFromEnv reads --http (bare, spaced, =) and BILLING_KIT_MCP_TOKEN', () => {
  assert.equal(configFromEnv({}).http, undefined);
  assert.equal(configFromEnv({}, ['--http']).http, ':3100');
  assert.equal(configFromEnv({}, ['--http', ':4000']).http, ':4000');
  assert.equal(configFromEnv({}, ['--http=127.0.0.1:4000']).http, '127.0.0.1:4000');
  assert.equal(configFromEnv({}, ['--http', '--allow-writes']).http, ':3100');
  assert.equal(configFromEnv({ BILLING_KIT_MCP_TOKEN: ' t ' }).token, 't');
});
