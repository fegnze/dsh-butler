import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromRaw } from '../src/host/config.ts';
import { createHosting, type Spawner } from '../src/host/hosting.ts';
import type { Collector, ObservationInput } from '../src/host/collector.ts';
import { createButlerRouter } from '../src/host/routes.ts';

test('/api/observe validates the body and forwards one observation to intake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'butler-observe-'));
  const spawner: Spawner = { spawn() { throw new Error('unexpected spawn'); } };
  const seen: ObservationInput[] = [];
  let queued = true;
  const collector = { observe: async (input: ObservationInput) => { seen.push(input); return queued ? { queued: true, output: '' } : { queued: false, output: '', error: 'intake 退出码 2' }; } } as unknown as Collector;
  try {
    const hosting = await createHosting(fromRaw(root, { notification: { enabled: false } }), spawner, 'http://localhost/myspace-butler');
    const router = createButlerRouter(hosting, { collector });
    async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
      let status = 0;
      let text = '';
      const res = { writeHead(code: number) { status = code; }, end(value = '') { text += value; } } as unknown as ServerResponse;
      const handled = await router.handle(req, res, path, new URL(path, 'http://localhost'));
      return { handled, status, body: text ? JSON.parse(text) : undefined };
    }

    const ok = await post('/api/observe', { source: 'claude', type: 'session', tags: ['a', 'b'], text: '回合结束', ref: '/tmp/t.jsonl' });
    expect(ok).toMatchObject({ handled: true, status: 202, body: { queued: true } });
    expect(seen).toEqual([{ source: 'claude', type: 'session', tags: ['a', 'b'], text: '回合结束', ref: '/tmp/t.jsonl' }]);

    expect((await post('/observe', { source: 'git', text: 'x' })).status).toBe(202);
    expect(seen.at(-1)).toMatchObject({ source: 'git', type: 'note' });

    const before = seen.length;
    for (const bad of [
      { text: 'no source' },
      { source: 'Bad/Source', text: 'x' },
      { source: 'ok', text: '' },
      { source: 'ok', text: 'x', type: 'weird' },
      { source: 'ok', text: 'x', tags: 'notarray' },
      { source: 'ok', text: 'x', tags: ['has,comma'] },
      { source: 'ok', text: 'x'.repeat(2_001) },
      { source: 'ok', text: 'x', ref: 7 },
    ]) {
      const result = await post('/api/observe', bad);
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('invalid_observation');
    }
    expect((await post('/api/observe', 'not json')).status).toBe(400);
    expect((await post('/api/observe', { source: 'ok', text: 'x' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(seen.length).toBe(before);

    queued = false;
    const failed = await post('/api/observe', { source: 'ok', text: 'x' });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatchObject({ code: 'intake_failed', message: 'intake 退出码 2' });

    const bare = createButlerRouter(hosting);
    const req = Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
    let status = 0;
    await bare.handle(req, { writeHead(code: number) { status = code; }, end() {} } as unknown as ServerResponse, '/api/observe', new URL('http://localhost/api/observe'));
    expect(status).toBe(503);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
