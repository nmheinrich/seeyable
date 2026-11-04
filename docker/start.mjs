// Container adapters only: executor, proxy authentication and bridge stay unchanged.
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export function createRelay(targetPort) {
  return net.createServer((incoming) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    incoming.on('error', () => upstream.destroy());
    upstream.on('error', () => incoming.destroy());
    incoming.on('close', () => upstream.destroy());
    upstream.on('close', () => incoming.destroy());
    incoming.pipe(upstream).pipe(incoming);
  });
}

export async function start({ envFile = '/run/secrets/planner-env' } = {}) {
  const settings = parseEnv(await readFile(envFile, 'utf8'));
  // Local Compose secrets preserve the source file's permissions. Read a 0600
  // host file before dropping privileges; all servers/children run as node.
  if (process.getuid?.() === 0) {
    process.setgid(1000);
    process.setuid(1000);
  }
  const fixture = await readFile(new URL('../apps/demo-survey/index.html', import.meta.url));
  const sample = http.createServer((req, res) => {
    if (!['/', '/index.html'].includes(req.url) || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : fixture);
  });
  const services = [[sample, 8765], [createRelay(6124), 16124], [createRelay(6123), 16123]];
  const children = [];
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    for (const [server] of services) server.close();
    // Docker's init forwards signals and reaps the detached bridge process.
    setTimeout(() => process.exit(code), 500).unref();
  };
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
  try {
    for (const [server, port] of services) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', resolve);
      });
      server.on('error', () => stop(1));
    }
    // Docker-only forwarding ports; compose publishes exclusively to host loopback.
    const planner = spawn(process.execPath, ['apps/planner-proxy/server.mjs'], {
      cwd: new URL('../', import.meta.url), stdio: 'inherit',
      env: { ...process.env, MODEL_API_KEY: settings.MODEL_API_KEY || '' },
    });
    children.push(planner);
    planner.on('error', () => stop(1));
    planner.on('exit', (code) => { if (!stopping) stop(code || 1); });
    console.error('[seeyable-docker] sample page: http://127.0.0.1:8765/index.html');
    console.error('[seeyable-docker] MCP: connect your client using the documented compose exec command.');
  } catch (error) {
    stop(1);
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(() => { console.error('[seeyable-docker] startup failed; check for occupied ports.'); process.exitCode = 1; });
}
