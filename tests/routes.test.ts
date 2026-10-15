import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromRaw } from '../src/host/config.ts';
import { createHosting, type Spawner } from '../src/host/hosting.ts';
import { createButlerRouter } from '../src/host/routes.ts';

// Execute the real router without opening a second HTTP host or spawning tools.
test('Host serves public API and legacy aliases, validates verbs and origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'butler-routes-'));
  const calls: string[] = [];
  const spawner: Spawner = { spawn() { throw new Error('unexpected spawn'); } };
  try {
    const hosting = await createHosting(fromRaw(root, { notification: { enabled: false } }), spawner, 'http://localhost/myspace-butler');
    for (const [kind, manager] of [['tools', hosting.supervisor], ['services', hosting.serviceManager]] as const) {
      for (const verb of ['start', 'stop', 'restart'] as const) {
        Object.assign(manager, { [verb]: (id: string) => { calls.push(`${kind}/${id}/${verb}`); return { id }; } });
      }
    }
    Object.assign(hosting.serviceManager, { statusOf: async (id: string) => ({ id }) });
    const router = createButlerRouter(hosting);
    async function request(path: string, method = 'GET', crossSite = false) {
      const req = Object.assign(Readable.from([]), { method, headers: crossSite ? { 'sec-fetch-site': 'cross-site' } : {}, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
      let status = 0;
      let body = '';
      const res = { writeHead(code: number) { status = code; }, end(value = '') { body += value; } } as unknown as ServerResponse;
      const handled = await router.handle(req, res, path, new URL(path, 'http://localhost'));
      return { handled, status, body };
    }
    for (const prefix of ['', '/api']) {
      for (const path of ['/catalog', '/overview', '/operations', '/services', '/quick-actions']) {
        const result = await request(`${prefix}${path}`);
        expect(result.handled).toBe(true);
        expect(result.status).toBe(200);
        expect(() => JSON.parse(result.body)).not.toThrow();
      }
      for (const kind of ['tools', 'services']) {
        for (const verb of ['start', 'stop', 'restart']) {
          const path = `${prefix}/${kind}/demo/${verb}`;
          expect((await request(path, 'POST')).status).toBe(200);
          expect(calls.at(-1)).toBe(`${kind}/demo/${verb}`);
          expect((await request(path)).handled).toBe(false);
        }
        expect((await request(`${prefix}/${kind}/demo/reload`, 'POST')).handled).toBe(false);
      }
    }
    expect((await request('/operations/tools/demo/start', 'POST')).status).toBe(200);
    // the hard-coded health-scan workflow is gone: no catalogue route, no run route
    expect((await request('/operations/workflows')).handled).toBe(false);
    expect((await request('/operations/workflows/workspace-health-scan/runs', 'POST')).handled).toBe(false);
    // tools register by directory; a bad directory is a 400 with the reason, never a crash
    {
      const req = Object.assign(Readable.from([JSON.stringify({ dir: '/nonexistent/tool' })]), { method: 'POST', headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
      let status = 0; let body = '';
      const res = { writeHead(code: number) { status = code; }, end(value = '') { body += value; } } as unknown as ServerResponse;
      expect(await router.handle(req, res, '/api/extensions/tool-dir', new URL('/api/extensions/tool-dir', 'http://localhost'))).toBe(true);
      expect(status).toBe(400);
      expect(body).toContain('目录不存在');
    }
    // the run observation feed stays
    expect((await request('/runs')).status).toBe(200);
    const before = calls.length;
    expect((await request('/api/tools/demo/start', 'POST', true)).status).toBe(403);
    expect(calls.length).toBe(before);
    expect((await request('/api/chat', 'POST')).handled).toBe(false);
    expect((await request('/api/agent', 'POST')).handled).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
