import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { fromRaw } from '../src/host/config.ts';
import { createCollector, type SessionInfo } from '../src/host/collector.ts';
import type { HostedProcess, Spawner } from '../src/host/hosting.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = mkdtempSync(join(tmpdir(), 'collector-recovery-')); roots.push(value); return value; }
function event(type: string, seq: number, data: unknown): unknown { return { type, seq, data }; }
function session(id: string, turn: number, text = 'turn text'): { info: SessionInfo; end: SessionEventLike } {
  const events = [event('turn/start', 0, { turn }), event('user/message', 1, { id: `user-${turn}`, source: { kind: 'user' }, content: text }), event('turn/end', 2, { turn })];
  return { info: { header: { id, cwd: '/repo' }, snapshotEvents: () => events }, end: events[2] as SessionEventLike };
}
type SessionEventLike = { type: string; seq: number; data: { turn: number } };
function spawner(results: Array<boolean | 'block'>, requests: string[] = []): Spawner {
  return { spawn(spec) {
    if (spec.argv.at(-1)?.endsWith('/pipeline')) {
      const input = typeof spec.stdin === 'object' ? spec.stdin.data : '';
      requests.push(input);
      const outcome = results.length ? results.shift()! : true;
      if (outcome === 'block') {
        let finish!: (value: { exitCode: number; signal: null }) => void;
        const done = new Promise<{ exitCode: number; signal: null }>((resolve) => { finish = resolve; });
        setTimeout(() => finish({ exitCode: 0, signal: null }), 5);
        return { pid: undefined, stdin: undefined, stdout: Readable.from([JSON.stringify({ ok: true, data: {} })]), stderr: Readable.from([]), done, terminate() {} } as HostedProcess;
      }
      const ok = outcome === true;
      return { pid: undefined, stdin: undefined, stdout: Readable.from([ok ? JSON.stringify({ ok: true, data: {} }) : '{}']), stderr: Readable.from([]), done: new Promise<{ exitCode: number; signal: null }>(resolve => setImmediate(() => resolve({ exitCode: ok ? 0 : 1, signal: null }))), terminate() {} } as HostedProcess;
    }
    return { pid: undefined, stdin: undefined, stdout: Readable.from([]), stderr: Readable.from([]), done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {} } as HostedProcess;
  } };
}

async function outboxFiles(stateDir: string): Promise<string[]> {
  try { return readdirSync(join(stateDir, 'collector-pending')).filter((name) => name.endsWith('.json')); } catch { return []; }
}

test('failed pipeline leaves an outbox and a new collector replays then clears it', async () => {
  const stateDir = root();
  const config = fromRaw(root(), { python: '/python', stateDir });
  const first = createCollector(config, spawner([false]), { debounceMs: 0 });
  await first.ready;
  const turn = session('recover', 1);
  first.onSessionEvent(turn.info, turn.end);
  await first.flush();
  expect(await outboxFiles(stateDir)).toHaveLength(1);
  first.dispose();
  const requests: string[] = [];
  const second = createCollector(config, spawner([true], requests), { debounceMs: 0 });
  await second.ready;
  await second.flush();
  expect(requests).toHaveLength(1);
  expect(await outboxFiles(stateDir)).toHaveLength(0);
  second.dispose();
});

test('continuous turns are separate durable segments and preserve complete payloads', async () => {
  const stateDir = root();
  const config = fromRaw(root(), { python: '/python', stateDir });
  const requests: string[] = [];
  const collector = createCollector(config, spawner([true, true], requests), { debounceMs: 0 });
  for (const turn of [1, 2]) { const value = session('many', turn, `text-${turn}`); collector.onSessionEvent(value.info, value.end); }
  await collector.flush();
  expect(requests).toHaveLength(2);
  expect(requests.map((raw) => JSON.parse(raw).args.messages[0].content).sort()).toEqual(['text-1', 'text-2']);
  collector.dispose();
});

test('symlink outbox entry is rejected and never followed or deleted', async () => {
  const stateDir = root();
  const pending = join(stateDir, 'collector-pending');
  const target = join(stateDir, 'personal-file');
  const config = fromRaw(root(), { python: '/python', stateDir });
  const seed = createCollector(config, spawner([false]), { debounceMs: 0 });
  await seed.ready;
  const turn = session('symlink', 1);
  seed.onSessionEvent(turn.info, turn.end);
  await seed.flush();
  seed.dispose();
  const name = (await outboxFiles(stateDir))[0];
  const original = join(pending, name);
  writeFileSync(target, readFileSync(original));
  rmSync(original);
  symlinkSync(target, original);
  const warnings: string[] = [];
  const recovered = createCollector(config, spawner([true]), { onError: (message) => warnings.push(message) });
  await recovered.ready;
  await recovered.flush();
  expect(readFileSync(target, 'utf8')).toContain('symlink');
  expect(warnings.some((message) => message.includes('拒绝非普通文件'))).toBe(true);
  recovered.dispose();
});

test('flush awaits a blocked pipeline and retries are idempotent', async () => {
  const stateDir = root();
  const config = fromRaw(root(), { python: '/python', stateDir });
  const requests: string[] = [];
  const collector = createCollector(config, spawner(['block'], requests), { debounceMs: 0 });
  const turn = session('awaits', 1);
  collector.onSessionEvent(turn.info, turn.end);
  await collector.flush();
  expect(requests).toHaveLength(1);
  await collector.flush();
  expect(requests).toHaveLength(1);
  collector.dispose();
});
