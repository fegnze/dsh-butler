import { afterAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountButler } from '../src/host/entry.ts';
import type { SubprocessRuntimeLike } from '../src/host/hosting.ts';

const PYTHON = '/Users/ghost/MySpace/.venv/bin/python';
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** Test-only DSH subprocess stand-in over Node; production uses ctx.subprocess. */
const pipelineRequests: string[] = [];
const subprocess: SubprocessRuntimeLike = {
  spawn(spec) {
    if (spec.argv.at(-1)?.endsWith('/pipeline')) {
      const stdin = spec.stdio.stdin;
      if (typeof stdin === 'object') pipelineRequests.push(stdin.data);
      const done = Promise.resolve({ exitCode: 0, signal: null });
      return { stdin: undefined, stdout: Readable.from([JSON.stringify({ ok: true, data: { accepted: true } })]), stderr: Readable.from([]), done, waitForExit: async () => true, terminate: () => undefined };
    }
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdin = spec.stdio.stdin;
    if (typeof stdin === 'object') child.stdin.end(stdin.data); else child.stdin.end();
    const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
      child.on('error', () => resolve({ exitCode: null, signal: null }));
    });
    return { stdin: undefined, stdout: child.stdout, stderr: child.stderr, done, waitForExit: async () => { await done; return true; }, terminate: () => { child.kill('SIGTERM'); } };
  },
};

test('mountButler subscribes session/event to the collector and unsubscribes on teardown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'butler-entry-'));
  roots.push(root);
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let unsubscribed = 0;
  let teardown: (() => Promise<void>) | undefined;
  const warnings: string[] = [];
  await mountButler({
    webServer: { port: 1, register: () => () => undefined },
    subprocess,
    effect: (factory) => { const result = factory() as unknown as Promise<() => Promise<void>> | (() => Promise<void>); teardown = result as () => Promise<void>; return result as never; },
    on: (event, handler) => { handlers.set(event, handler); return () => { unsubscribed += 1; handlers.delete(event); }; },
    logger: { warn: (...args) => warnings.push(args.join(' ')), error: () => undefined },
  }, { workdir: root, createMessage: (input) => input });
  // A generic skeleton workdir has no python configured; point it at the pinned venv.
  const config = JSON.parse(readFileSync(join(root, 'butler.json'), 'utf8'));
  expect(config.collector).toMatchObject({ enabled: true, excludePresets: ['butler'] });
  expect(handlers.has('session/event')).toBe(true);
  expect(handlers.has('agent/pre-step')).toBe(true);
  await teardown?.();
  expect(unsubscribed).toBe(2);
  expect(handlers.size).toBe(0);
});

test('mounted collector writes a debounced DSH turn into the instance spool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'butler-entry-'));
  roots.push(root);
  let handler: ((...args: any[]) => unknown) | undefined;
  let teardown: (() => Promise<void>) | undefined;
  // Pre-create the workdir config so the skeleton copy keeps our python/debounce.
  const { cpSync } = await import('node:fs');
  cpSync(join(import.meta.dir, '..', 'skeleton'), root, { recursive: true });
  const config = JSON.parse(readFileSync(join(root, 'butler.json'), 'utf8'));
  writeFileSync(join(root, 'butler.json'), JSON.stringify({ ...config, python: PYTHON, collector: { ...config.collector, debounceMs: 0 } }));
  await mountButler({
    webServer: { port: 1, register: () => () => undefined },
    subprocess,
    effect: (factory) => { teardown = factory() as never; return teardown as never; },
    on: (event, h) => { if (event === 'session/event') handler = h; return () => undefined; },
  }, { workdir: root });
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 0, data: { id: 'm', role: 'user', content: [{ type: 'text', text: '真实挂载路径' }], source: { kind: 'user' } } },
    { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  handler?.({ header: { id: 'mounted', cwd: '/w' }, snapshotEvents: () => events }, events[2]);
  for (let i = 0; i < 100 && pipelineRequests.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const request = JSON.parse(pipelineRequests.at(-1)!);
  expect(request).toMatchObject({ action: 'sessions.ingest', args: { source: 'dsh', externalSessionId: 'mounted', segmentId: 'dsh://mounted#1', captureMode: 'transcript', revision: 1 } });
  expect(request.args.messages).toEqual([{ id: 'm', role: 'user', content: '真实挂载路径', sequence: 1 }]);
  await teardown?.();
});

test('mountButler publishes the work directory (not butler.json) and the agent half resolves the same instance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'butler-entry-'));
  roots.push(root);
  const { cpSync } = await import('node:fs');
  cpSync(join(import.meta.dir, '..', 'skeleton'), root, { recursive: true });
  const config = JSON.parse(readFileSync(join(root, 'butler.json'), 'utf8'));
  writeFileSync(join(root, 'butler.json'), JSON.stringify({ ...config, python: PYTHON }));
  const { publishedWorkdir } = await import('../src/host/config.ts');
  let teardown: (() => Promise<void>) | undefined;
  await mountButler({
    webServer: { port: 1, register: () => () => undefined },
    subprocess,
    effect: (factory) => { const result = factory() as never; teardown = result; return result; },
    on: () => () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
  }, { workdir: root });
  expect(publishedWorkdir()).toBe(root);
  const { applyAgent } = await import('../src/agent/entry.ts');
  const tools = new Map<string, any>();
  await applyAgent({ tools: { register(def: any) { tools.set(def.name, def); return () => undefined; } }, subprocess, effect: ((f: any) => f()) as never });
  expect(JSON.parse(await tools.get('butler_card').execute({}, {}))).toEqual([]);
  await teardown?.();
  expect(publishedWorkdir()).toBeUndefined();
});

test('inject.enabled=false registers no pre-step hook', async () => {
  const root = mkdtempSync(join(tmpdir(), 'butler-entry-'));
  roots.push(root);
  const { cpSync } = await import('node:fs');
  cpSync(join(import.meta.dir, '..', 'skeleton'), root, { recursive: true });
  const config = JSON.parse(readFileSync(join(root, 'butler.json'), 'utf8'));
  writeFileSync(join(root, 'butler.json'), JSON.stringify({ ...config, inject: { enabled: false } }));
  const events: string[] = [];
  let teardown: (() => Promise<void>) | undefined;
  await mountButler({
    webServer: { port: 1, register: () => () => undefined },
    subprocess,
    effect: (factory) => { const result = factory() as never; teardown = result; return result; },
    on: (event) => { events.push(event); return () => undefined; },
    logger: { warn: () => undefined, error: () => undefined },
  }, { workdir: root, createMessage: (input) => input });
  expect(events).toEqual(['session/event']);
  await teardown?.();
});
