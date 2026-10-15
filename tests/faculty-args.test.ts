import { afterAll, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromRaw } from '../src/host/config.ts';
import { createHosting } from '../src/host/hosting.ts';
import { createButlerRouter } from '../src/host/routes.ts';
import { createNodeSpawner } from './node-spawner.ts';

const PYTHON = process.env.BUTLER_TEST_PYTHON ?? '/Users/ghost/MySpace/.venv/bin/python';
const root = mkdtempSync(join(tmpdir(), 'butler-faculty-args-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('faculty commands accept only manifest-declared args; approve/reject run the real proposals command', async () => {
  cpSync(join(import.meta.dir, '..', 'skeleton'), root, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  writeFileSync(join(root, 'butler.json'), JSON.stringify({ python: PYTHON, notification: { enabled: false } }));
  const self = join(root, 'self');
  mkdirSync(join(self, 'rules'), { recursive: true });
  writeFileSync(join(self, 'rules', 'paths.md'), '1. 旧路径\n');
  const create = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ event: 'create', id, kind: 'rule', title: 't', slug: 'paths', body: '新路径', find: '旧路径', status: 'pending', createdAt: 'x', ...extra });
  writeFileSync(join(self, 'proposals.jsonl'), `${create('p-1')}\n${create('p-2')}\n`);

  const hosting = await createHosting(fromRaw(root, { python: PYTHON, notification: { enabled: false } }), createNodeSpawner(), 'http://localhost/myspace-butler');
  const router = createButlerRouter(hosting);
  async function post(path: string, body: unknown) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
    let status = 0;
    let text = '';
    const res = { writeHead(code: number) { status = code; }, end(value = '') { text += value; } } as unknown as ServerResponse;
    await router.handle(req, res, path, new URL(path, 'http://localhost'));
    return { status, body: JSON.parse(text) };
  }
  const base = '/api/faculties/journal/commands';

  expect((await post(`${base}/apply`, { args: { id: 'p-1' } })).status).toBe(409);
  for (const args of [{}, { id: '../x' }, { id: 'p-1', extra: 'x' }, { id: 7 }, { id: '--confirmed' }]) {
    const r = await post(`${base}/apply`, { confirmed: true, args });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_args');
  }
  expect((await post(`${base}/run`, { confirmed: true, args: { id: 'p-1' } })).status).toBe(400);

  const applied = await post(`${base}/apply`, { confirmed: true, args: { id: 'p-1' } });
  expect(applied.status).toBe(200);
  expect(applied.body.exitCode).toBe(0);
  expect(readFileSync(join(self, 'rules', 'paths.md'), 'utf8')).toBe('1. 新路径\n');

  // one-click reject: the id alone is enough
  const rejected = await post(`${base}/reject`, { confirmed: true, args: { id: 'p-2' } });
  expect(rejected.status).toBe(200);
  expect(rejected.body.exitCode).toBe(0);
  const lines = readFileSync(join(self, 'proposals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.filter((l) => l.event === 'status').map((l) => [l.id, l.status])).toEqual([['p-1', 'applied'], ['p-2', 'rejected']]);
  await hosting.shutdown();
});

test('a value starting with "-" is refused even when the declared pattern allows it', async () => {
  const { facultyArgs } = await import('../src/host/routes.ts');
  const command = { id: 'x', exec: [], args: [{ name: 'reason', pattern: '.{1,50}', required: true }] };
  expect(facultyArgs(command, { reason: '正常理由' })).toEqual(['--reason', '正常理由']);
  expect(() => facultyArgs(command, { reason: '--confirmed' })).toThrow();
  expect(() => facultyArgs(command, [])).toThrow();
});
