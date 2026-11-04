import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createRelay } from './start.mjs';
import { createProxy } from '../apps/planner-proxy/lib/proxy.mjs';
import { createBridge } from '../apps/mcp-server/lib/bridge.mjs';
const require = createRequire(new URL('../apps/mcp-server/package.json', import.meta.url));
const WebSocket = require('ws');
async function relay(port) {
  const server = createRelay(port);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

test('Docker TCP adapter preserves planner token and origin checks', async () => {
  const proxy = createProxy({ port: 0, log: () => {} });
  const address = await proxy.start();
  const server = await relay(address.port);
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/status`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { Authorization: `Bearer ${proxy.token}`, Origin: 'chrome-extension://test' };
    assert.equal((await fetch(url, { headers })).status, 200);
    headers.Origin = 'https://example.com';
    assert.equal((await fetch(url, { headers })).status, 403);
  } finally {
    await proxy.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Docker TCP adapter preserves WebSocket pairing and rejection', async () => {
  const bridge = createBridge({ port: 0, log: () => {} });
  await bridge.start();
  const server = await relay(bridge.boundPort());
  try {
    const url = `ws://127.0.0.1:${server.address().port}`;
    const bad = new WebSocket(url, { origin: 'chrome-extension://test' });
    await once(bad, 'open');
    const rejected = once(bad, 'close');
    bad.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    assert.equal((await rejected)[0], 4401);
    const good = new WebSocket(url, { origin: 'chrome-extension://test' });
    await once(good, 'open');
    const reply = once(good, 'message');
    good.send(JSON.stringify({ type: 'auth', token: bridge.token }));
    assert.equal(JSON.parse(String((await reply)[0])).type, 'auth_ok');
    good.close();
    await once(good, 'close');
  } finally {
    await bridge.close();
    await new Promise(resolve => server.close(resolve));
  }
});
