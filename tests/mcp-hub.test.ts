// Butler 统一 MCP：清单声明 → Host 懒启动 stdio 提供方 → 同一个 Streamable HTTP 端点对外。
// 真 HTTP 服务包住真 router；提供方是真子进程（tests/fixtures/fake-mcp.mjs）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fromRaw } from '../src/host/config.ts';
import { createHosting, type Hosting } from '../src/host/hosting.ts';
import { createButlerRouter, type ButlerRouter } from '../src/host/routes.ts';
import { collectMcpProviders, defaultNamespace, parseMcpDecl } from '../src/host/mcp-hub.ts';
import { scanCatalog } from '../src/host/catalog.ts';
import { createNodeSpawner } from './node-spawner.ts';

const FAKE = resolve(import.meta.dir, 'fixtures', 'fake-mcp.mjs');
let root: string; let server: Server; let host: string; let router: ButlerRouter; let hosting: Hosting;

async function writeManifest(rel: string, manifest: Record<string, unknown>) {
  await mkdir(join(root, rel), { recursive: true });
  await writeFile(join(root, rel, 'butler.json'), JSON.stringify(manifest));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'butler-mcp-'));
  await writeManifest('tools/alpha-tool', { schemaVersion: 1, kind: 'tool', id: 'alpha-tool', name: 'Alpha', mcp: { transport: 'stdio', command: [process.execPath, FAKE, 'alpha'], timeoutSec: 5 } });
  await writeManifest('services/beta', { schemaVersion: 1, kind: 'service', id: 'beta', name: 'Beta', hosted: { command: 'true' }, mcp: { transport: 'stdio', command: [process.execPath, FAKE, 'beta'], namespace: 'b' } });
  await writeManifest('tools/plain', { schemaVersion: 1, kind: 'tool', id: 'plain', name: 'Plain' });
  hosting = await createHosting(fromRaw(root, { notification: { enabled: false } }), createNodeSpawner(), 'http://127.0.0.1/myspace-butler');
  router = createButlerRouter(hosting, {});
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void router.handle(req, res, url.pathname, url).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await hosting.shutdown(); server.close(); await rm(root, { recursive: true, force: true }); });

let nextId = 1;
async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${host}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() as any : undefined };
}

describe('manifest standard', () => {
  test('parseMcpDecl accepts stdio and rejects self-exposed transports', () => {
    expect(parseMcpDecl(undefined)).toBeUndefined();
    expect(parseMcpDecl({ transport: 'stdio', command: ['bun', 'x'] })).toEqual({ transport: 'stdio', command: ['bun', 'x'] });
    expect(() => parseMcpDecl({ transport: 'http', url: 'http://127.0.0.1:1/mcp' })).toThrow('只支持 stdio');
    expect(() => parseMcpDecl({ transport: 'stdio', command: [] })).toThrow('command');
    expect(() => parseMcpDecl({ transport: 'stdio', command: ['a'], namespace: 'a__b' })).toThrow('__');
    expect(() => parseMcpDecl({ transport: 'stdio', command: ['a'], namespace: 'Bad' })).toThrow('namespace');
    expect(() => parseMcpDecl({ transport: 'stdio', command: ['a'], timeoutSec: 1 })).toThrow('timeoutSec');
  });

  test('default namespace is the id with dashes as underscores', () => {
    expect(defaultNamespace('feishu-document-gateway')).toBe('feishu_document_gateway');
    expect(defaultNamespace('9lives')).toBe('x9lives');
  });

  test('catalog rejects a bad mcp block and a faculty mcp', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'butler-mcp-cat-'));
    try {
      await mkdir(join(dir, 'tools', 'bad'), { recursive: true });
      await writeFile(join(dir, 'tools', 'bad', 'butler.json'), JSON.stringify({ schemaVersion: 1, kind: 'tool', id: 'bad', name: 'Bad', mcp: { transport: 'sse', url: 'x' } }));
      await mkdir(join(dir, 'faculties', 'f'), { recursive: true });
      await writeFile(join(dir, 'faculties', 'f', 'butler.json'), JSON.stringify({ schemaVersion: 1, kind: 'faculty', id: 'f', name: 'F', mcp: { transport: 'stdio', command: ['a'] } }));
      const scan = await scanCatalog(fromRaw(dir, {}));
      expect(scan.rejected.map((r) => r.reason).sort()).toEqual(['faculty 不支持 mcp', 'mcp.transport 目前只支持 stdio（工具不得自行对外监听 MCP）']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('a duplicate namespace is reported, never shadowed', () => {
    const ext = (id: string) => ({ dir: `/x/${id}`, manifest: { schemaVersion: 1 as const, kind: 'tool' as const, id, name: id, mcp: { transport: 'stdio', command: ['a'], namespace: 'same' } } });
    const { providers, conflicts } = collectMcpProviders({ tools: [ext('one'), ext('two')], services: [], faculties: [], rejected: [], scannedAt: '' });
    expect(providers.map((p) => p.extensionId)).toEqual(['one']);
    expect(conflicts).toEqual([{ owner: 'tool:two', reason: 'mcp.namespace "same" 已被 tool:one 占用' }]);
  });
});

describe('unified endpoint', () => {
  test('initialize advertises tools and lists providers', async () => {
    const { status, body } = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(status).toBe(200);
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.serverInfo.name).toBe('butler');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toContain('alpha_tool__*');
    expect(body.result.instructions).toContain('b__*');
    expect(body.result.instructions).toContain('alpha own instructions');
  });

  test('notifications get 202 with no body', async () => {
    const res = await fetch(`${host}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(res.status).toBe(202);
  });

  test('tools/list aggregates every provider under its namespace', async () => {
    const { body } = await rpc('tools/list');
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['alpha_tool__echo', 'alpha_tool__slow', 'b__echo', 'b__slow']);
    expect(body.result.tools.find((t: any) => t.name === 'b__echo').description).toBe('[Beta] echo back');
  });

  test('tools/call routes to the owning provider with the channel marker', async () => {
    const a = await rpc('tools/call', { name: 'alpha_tool__echo', arguments: { text: 'hi' } });
    const b = await rpc('tools/call', { name: 'b__echo', arguments: { text: 'yo' } });
    const pa = JSON.parse(a.body.result.content[0].text);
    const pb = JSON.parse(b.body.result.content[0].text);
    expect(pa).toMatchObject({ label: 'alpha', args: { text: 'hi' }, channel: 'butler-hub' });
    expect(pb).toMatchObject({ label: 'beta', args: { text: 'yo' } });
    // Providers stay warm: a second call reuses the same child.
    const again = JSON.parse((await rpc('tools/call', { name: 'alpha_tool__echo', arguments: {} })).body.result.content[0].text);
    expect(again.pid).toBe(pa.pid);
  });

  test('unknown tools are protocol errors; a provider timeout is a tool error', async () => {
    expect((await rpc('tools/call', { name: 'nope__echo' })).body.error.code).toBe(-32602);
    expect((await rpc('tools/call', { name: 'alpha_tool__missing' })).body.error.code).toBe(-32602);
    const slow = await rpc('tools/call', { name: 'alpha_tool__slow', arguments: {} });
    expect(slow.body.result.isError).toBe(true);
    expect(slow.body.result.content[0].text).toContain('超时');
  }, 15_000);

  test('status reports providers and rejected tool names', async () => {
    const res = await fetch(`${host}/api/mcp/status`);
    const body = await res.json() as any;
    expect(body.endpoint).toBe('http://127.0.0.1/myspace-butler/api/mcp');
    const alpha = body.providers.find((p: any) => p.namespace === 'alpha_tool');
    expect(alpha.state).toBe('ready');
    expect(alpha.rejectedTools).toEqual(['has space']);
  });

  test('status ?owner narrows to one extension and ?warm starts it, with tool descriptions for settings views', async () => {
    // beta may still be cold here only if no earlier test touched it; warm=1 must make it ready either way.
    const res = await fetch(`${host}/api/mcp/status?owner=${encodeURIComponent('service:beta')}&warm=1`);
    const body = await res.json() as any;
    expect(body.providers.map((p: any) => p.owner)).toEqual(['service:beta']);
    const beta = body.providers[0];
    expect(beta.extensionId).toBe('beta');
    expect(beta.state).toBe('ready');
    expect(beta.toolDetails.map((t: any) => t.name)).toEqual(['b__echo', 'b__slow']);
    expect(typeof beta.toolDetails[0].description).toBe('string');
    const none = await (await fetch(`${host}/api/mcp/status?owner=${encodeURIComponent('tool:plain')}`)).json() as any;
    expect(none.providers).toEqual([]);
  });

  test('GET is 405 (stateless hub, no server stream)', async () => {
    expect((await fetch(`${host}/api/mcp`)).status).toBe(405);
  });

  test('cross-site requests are refused before reaching the hub', async () => {
    const { status } = await rpc('tools/list', undefined, { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' });
    expect(status).toBe(403);
  });

  test('rescan respawns an unchanged provider at the next idle request', async () => {
    const pid = async () => JSON.parse((await rpc('tools/call', { name: 'alpha_tool__echo', arguments: {} })).body.result.content[0].text).pid;
    const before = await pid();
    await hosting.rescan();
    const after = await pid();
    expect(after).not.toBe(before);
    expect(await pid()).toBe(after);
  });

  test('rescan drops a removed provider and closes its child', async () => {
    await rm(join(root, 'services', 'beta'), { recursive: true, force: true });
    await hosting.rescan();
    const { body } = await rpc('tools/list');
    expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(['alpha_tool__echo', 'alpha_tool__slow']);
  });
});
