// Executed on stdin by the host helper, using Node already inside Docker.
// No changes to client settings, bridge launch, or executor permissions.
import { resolveToken } from './apps/mcp-server/lib/hub-launch.mjs';

const root = process.env.SEEYABLE_SETUP_ROOT;
const docker = process.env.SEEYABLE_SETUP_DOCKER;
const agent = process.env.SEEYABLE_SETUP_AGENT;
if (!root || !docker || !['chatgpt', 'claude', 'claude-code', 'muse'].includes(agent)) {
  throw new Error('Missing setup paths or unsupported agent.');
}
if (process.env.SEEYABLE_BRIDGE_TOKEN) {
  throw new Error('An explicit bridge-token override is active. Use the advanced setup instructions.');
}
resolveToken({ port: 6123 }); // Same private, persistent token used by MCP clients.
const args = ['compose', '--project-directory', root, 'exec', '-T', '--user',
  'node', 'seeyable', 'node', 'apps/mcp-server/server.mjs'];
const entry = { command: docker, args };
if (agent === 'chatgpt') {
  console.log('[mcp_servers.seeyable]');
  console.log(`command = ${JSON.stringify(docker)}`);
  console.log(`args = ${JSON.stringify(args)}`);
} else if (agent === 'muse') {
  console.log(JSON.stringify({ mcp_servers: { seeyable: {
    transport: 'stdio', ...entry, enabled: true, mode: 'optional',
  } } }, null, 2));
} else if (agent === 'claude') {
  console.log(JSON.stringify({ mcpServers: { seeyable: entry } }, null, 2));
} else {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  console.log(['claude', 'mcp', 'add', '--transport', 'stdio', 'seeyable', '--',
    docker, ...args].map(quote).join(' '));
}
