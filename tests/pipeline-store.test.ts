import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const py = '/Users/ghost/MySpace/.venv/bin/python';
const store = join(import.meta.dir, '../skeleton/faculties/journal/bin/_pipeline_store.py');
const ownedRoots: string[] = [];
afterEach(async () => {
  for (const root of ownedRoots.splice(0)) {
    // Only canonical paths created by this fixture are eligible for cleanup.
    if (!root.startsWith(await realpath(tmpdir()) + '/') || !root.split('/').at(-1)?.startsWith('pipeline-store-')) throw new Error('unexpected fixture path');
    await rm(root, { recursive: true, force: true });
  }
});
async function call(root: string, action: string, args: Record<string, unknown>) {
  const p = Bun.spawn([py, '-c', `import json,sys; sys.path.insert(0,sys.argv[2]); from _pipeline_store import Store; s=Store(sys.argv[1]); print(json.dumps(s.handle(sys.argv[3],json.loads(sys.argv[4]))))`, root, store.slice(0, store.lastIndexOf('/')), action, JSON.stringify(args)], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  if (await p.exited !== 0) throw new Error(await new Response(p.stderr).text());
  return JSON.parse(out);
}

test('Store constructor is zero-write and runs are per-file', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pipeline-store-')));
  ownedRoots.push(root);
  const before = await readdir(root);
  await call(root, 'sessions.list', {});
  expect((await readdir(root)).sort()).toEqual(before.sort());
  const ing = await call(root, 'sessions.ingest', { source: 'dsh', externalSessionId: 'x', segmentId: '0', revision: 1, messages: [{ id: 'm1', role: 'user', sequence: 1, content: 'hello' }] });
  const run = await call(root, 'distill.claim', { limit: 20, maxChars: 10000 });
  expect(run.sources[0].sourceId).toBe(ing.id);
  const files = await readdir(join(root, 'runs'));
  expect(files).toHaveLength(1); expect(files[0]).not.toBe('runs.json');
  const rec = JSON.parse(await readFile(join(root, 'runs', files[0]), 'utf8'));
  expect(rec.status).toBe('running'); expect(rec.inputManifest[0].revision).toBe(1);
});

test('ingest is idempotent and rejects same revision conflict', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pipeline-store-')));
  ownedRoots.push(root);
  const a = { source: 'dsh', externalSessionId: 'x', segmentId: '0', revision: 1, messages: [{ id: 'm1', role: 'user', sequence: 1, content: 'hello' }] };
  expect((await call(root, 'sessions.ingest', a)).idempotent).toBe(false);
  expect((await call(root, 'sessions.ingest', a)).idempotent).toBe(true);
  await expect(call(root, 'sessions.ingest', { ...a, messages: [{ id: 'm1', role: 'user', sequence: 1, content: 'changed' }] })).rejects.toThrow();
});

test('path traversal is refused', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pipeline-store-')));
  ownedRoots.push(root);
  const p = Bun.spawn([py, '-c', `import sys; sys.path.insert(0,sys.argv[2]); from _pipeline_store import Store; Store(sys.argv[1]).resolve('../escape')`, root, store.slice(0, store.lastIndexOf('/'))], { stdout: 'pipe', stderr: 'pipe' });
  expect(await p.exited).not.toBe(0);
});
