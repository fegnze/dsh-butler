// Fake stdio MCP provider for the hub tests: newline-delimited JSON-RPC.
// Tools: echo (returns args + the channel env), slow (never answers), bad name.
import { createInterface } from 'node:readline';

const label = process.argv[2] ?? 'fake';
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
process.stdout.write('log line that is not JSON\n');
process.stderr.write(`started ${label}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: label, version: '1' }, instructions: `${label} own instructions` } });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'slow', description: 'never returns', inputSchema: { type: 'object', properties: {} } },
        { name: 'has space', description: 'not a valid public name' },
      ] } });
      return;
    case 'tools/call':
      if (message.params.name === 'slow') return;
      if (message.params.name === 'echo') {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ label, args: message.params.arguments, channel: process.env.BUTLER_MCP_CHANNEL ?? null, pid: process.pid }) }] } });
        return;
      }
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool' } });
      return;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'nope' } });
  }
});
