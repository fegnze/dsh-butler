import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromRaw } from '../src/host/config.ts';
import { createHosting, type HostedProcess, type HostedSpawnSpec, type Spawner } from '../src/host/hosting.ts';
import { markAuthenticatedDesktopRequest } from '../src/host/card-pipeline.ts';
import { createButlerRouter } from '../src/host/routes.ts';

const candidate = { id: 'c1', revision: 2, contentHash: 'hash-2', title: 'T', summary: 'S', body: 'B', evidence: [] };

function pipelineSpawner(options: { mode?: 'ok' | 'business-error' | 'exit-failure' | 'truncated' } = {}): Spawner & { calls: HostedSpawnSpec[] } {
  const calls: HostedSpawnSpec[] = [];
  return {
    calls,
    spawn(spec) {
      calls.push(spec);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const input = JSON.parse(typeof spec.stdin === 'object' && 'data' in spec.stdin ? spec.stdin.data : '{}') as { action: string; args: Record<string, unknown> };
      const mode = options.mode ?? 'ok';
      const payload = mode === 'truncated'
        ? 'x'.repeat(2 * 1024 * 1024 + 1)
        : mode === 'business-error'
          ? JSON.stringify({ ok: false, error: { code: 'revision_conflict', message: '版本冲突', currentRevision: 3 } })
          : input.action === 'candidates.get'
            ? JSON.stringify({ ok: true, data: candidate })
            : JSON.stringify({ ok: true, data: { action: input.action, args: input.args } });
      const done = Promise.resolve({ exitCode: mode === 'exit-failure' ? 1 : 0, signal: null });
      queueMicrotask(() => { stdout.end(payload); stderr.end(); });
      return { pid: undefined, stdin: undefined, stdout, stderr, done, terminate() {} } satisfies HostedProcess;
    },
  };
}

function req(path: string, body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    headers: { host: 'localhost:1234', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    url: path,
  }) as unknown as IncomingMessage;
}

async function call(router: ReturnType<typeof createButlerRouter>, path: string, body: unknown, headers: Record<string, string> = {}, authenticated = false) {
  const request = req(path, body, headers);
  if (authenticated) markAuthenticatedDesktopRequest(request);
  let status = 0; let text = '';
  const response = {
    writeHead(code: number) { status = code; },
    end(value = '') { text += value; },
  } as unknown as ServerResponse;
  const handled = await router.handle(request, response, path, new URL(path, 'http://localhost'));
  return { handled, status, body: JSON.parse(text) as any };
}

async function routerWith(spawner: Spawner) {
  const root = await mkdtemp(join(tmpdir(), 'butler-pipeline-route-'));
  const hosting = await createHosting(fromRaw(root, { python: '/tmp/python', notification: { enabled: false } }), spawner, 'http://localhost/myspace-butler');
  return { root, router: createButlerRouter(hosting, { hostUrl: 'http://localhost:1234/myspace-butler' }) };
}

const uiHeaders = { origin: 'http://localhost:1234', 'sec-fetch-site': 'same-origin', 'x-butler-review': '1' };

test('same-origin UI prepares and approves while no-Origin SDK cannot review', async () => {
  const spawner = pipelineSpawner();
  const { root, router } = await routerWith(spawner);
  try {
    const prepared = await call(router, '/pipeline', { action: 'review.prepare', args: { id: 'c1', revision: 2, contentHash: 'hash-2' } }, uiHeaders);
    expect(prepared.status).toBe(200);
    expect(prepared.body.ok).toBe(true);
    expect(typeof prepared.body.data.reviewToken).toBe('string');
    const token = prepared.body.data.reviewToken;
    const approved = await call(router, '/api/pipeline', { action: 'candidates.approve', args: { id: 'c1', revision: 2, contentHash: 'hash-2', reviewToken: token, idempotencyKey: 'idem-1', baseRevision: 1 } }, uiHeaders);
    expect(approved.status).toBe(200);
    expect(approved.body.data.args.actor).toBe('human-ui');
    const noOrigin = await call(router, '/pipeline', { action: 'review.prepare', args: { id: 'c1', revision: 2, contentHash: 'hash-2' } }, { 'sec-fetch-site': 'same-origin', 'x-butler-review': '1' });
    expect(noOrigin.status).toBe(403);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('desktop proxy requires verified Host admission, not just spoofable headers', async () => {
  const { root, router } = await routerWith(pipelineSpawner());
  const headers = { 'x-butler-review': '1', 'x-butler-desktop': 'dsh-app://app', cookie: 'dsh-auth-test=fake' };
  const body = { action: 'candidates.edit', args: { id: 'c1', expectedRevision: 2, body: 'draft' } };
  try {
    expect((await call(router, '/pipeline', body, headers)).status).toBe(403);
    expect((await call(router, '/pipeline', body, headers, true)).status).toBe(200);
    expect((await call(router, '/pipeline', body, { ...headers, origin: 'http://evil.example' }, true)).status).toBe(403);
    expect((await call(router, '/pipeline', body, { ...headers, 'sec-fetch-site': 'cross-site' }, true)).status).toBe(403);
    const prepared = await call(router, '/pipeline', { action: 'review.prepare', args: candidate }, headers, true);
    expect(prepared.status).toBe(200);
    expect((await call(router, '/pipeline', { action: 'candidates.reject', args: { ...candidate, reviewToken: prepared.body.data.reviewToken, idempotencyKey: 'desktop-reject' } }, headers, true)).status).toBe(200);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('desktop missing Fetch Metadata still requires explicit matching Origin', async () => {
  const { root, router } = await routerWith(pipelineSpawner());
  const body = { action: 'candidates.edit', args: { id: 'c1', expectedRevision: 2, title: 'Updated' } };
  try {
    expect((await call(router, '/pipeline', body, { origin: 'http://localhost:1234', 'x-butler-review': '1' })).status).toBe(200);
    expect((await call(router, '/pipeline', body, { 'x-butler-review': '1' })).status).toBe(403);
    expect((await call(router, '/pipeline', body, { origin: 'http://evil.example', 'x-butler-review': '1' })).status).toBe(403);
    expect((await call(router, '/pipeline', body, { origin: 'http://localhost:1234' })).status).toBe(403);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cross-site, stale hash, token binding, replay and forbidden actions are rejected', async () => {
  const spawner = pipelineSpawner();
  const { root, router } = await routerWith(spawner);
  try {
    expect((await call(router, '/pipeline', { action: 'review.prepare', args: { id: 'c1', revision: 2, contentHash: 'hash-2' } }, { ...uiHeaders, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call(router, '/pipeline', { action: 'review.prepare', args: { id: 'c1', revision: 2, contentHash: 'stale' } }, uiHeaders)).status).toBe(409);
    const prepared = await call(router, '/pipeline', { action: 'review.prepare', args: { id: 'c1', revision: 2, contentHash: 'hash-2' } }, uiHeaders);
    const token = prepared.body.data.reviewToken;
    const changedId = await call(router, '/pipeline', { action: 'candidates.approve', args: { id: 'other', revision: 2, contentHash: 'hash-2', reviewToken: token, idempotencyKey: 'idem-1' } }, uiHeaders);
    expect(changedId.status).toBe(403);
    const first = await call(router, '/pipeline', { action: 'candidates.reject', args: { id: 'c1', revision: 2, contentHash: 'hash-2', reviewToken: token, idempotencyKey: 'idem-2', reason: 'no' } }, uiHeaders);
    expect(first.status).toBe(200);
    const conflictingReplay = await call(router, '/pipeline', { action: 'candidates.reject', args: { id: 'c1', revision: 2, contentHash: 'hash-2', reviewToken: token, idempotencyKey: 'idem-3', reason: 'different' } }, uiHeaders);
    expect(conflictingReplay.status).toBe(409);
    expect((await call(router, '/pipeline', { action: 'distill.complete', args: {} }, uiHeaders)).status).toBe(403);
    expect((await call(router, '/pipeline', { action: 'nope', args: {} }, uiHeaders)).status).toBe(400);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review token expires and concurrent identical requests share one mutation', async () => {
  const spawner = pipelineSpawner();
  const { root, router } = await routerWith(spawner);
  const originalNow = Date.now;
  try {
    const binding = { id: 'c1', revision: 2, contentHash: 'hash-2' };
    const prepared = await call(router, '/pipeline', { action: 'review.prepare', args: binding }, uiHeaders);
    const mutation = { action: 'candidates.approve', args: { ...binding, reviewToken: prepared.body.data.reviewToken, idempotencyKey: 'parallel' } };
    const results = await Promise.all([call(router, '/pipeline', mutation, uiHeaders), call(router, '/pipeline', mutation, uiHeaders)]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(spawner.calls.filter(spec => JSON.parse((spec.stdin as { data: string }).data).action === 'candidates.approve')).toHaveLength(1);
    Date.now = () => originalNow() + 121_000;
    expect((await call(router, '/pipeline', mutation, uiHeaders)).status).toBe(403);
  } finally {
    Date.now = originalNow;
    await rm(root, { recursive: true, force: true });
  }
});

test('maps business errors and process failures without exposing credentials', async () => {
  const business = pipelineSpawner({ mode: 'business-error' });
  const { root: root1, router: router1 } = await routerWith(business);
  try {
    const result = await call(router1, '/pipeline', { action: 'cards.read', args: { id: 'c1' } });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('revision_conflict');
  } finally { await rm(root1, { recursive: true, force: true }); }
  const failed = pipelineSpawner({ mode: 'exit-failure' });
  const { root: root2, router: router2 } = await routerWith(failed);
  try {
    const result = await call(router2, '/pipeline', { action: 'cards.read', args: { token: 'secret' } });
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('secret');
  } finally { await rm(root2, { recursive: true, force: true }); }
  const truncated = pipelineSpawner({ mode: 'truncated' });
  const { root: root3, router: router3 } = await routerWith(truncated);
  try {
    expect((await call(router3, '/pipeline', { action: 'cards.read', args: {} })).body.error.code).toBe('pipeline_output_truncated');
  } finally { await rm(root3, { recursive: true, force: true }); }
});
