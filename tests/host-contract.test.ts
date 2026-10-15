import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkdir, fromRaw } from '../src/host/config.ts';
import { createSubprocessSpawner, runHostedCommand, type HostedProcess, type Spawner, type SubprocessRuntimeLike } from '../src/host/hosting.ts';

function fakeProcess(options: {
  outcome?: Promise<{ exitCode: number | null; signal: string | null }>;
  reject?: Error;
  terminate?: () => void;
} = {}): HostedProcess & { stdout: PassThrough; stderr: PassThrough } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const done = options.reject ? Promise.reject(options.reject) : options.outcome ?? Promise.resolve({ exitCode: 0, signal: null });
  return {
    pid: undefined,
    stdin: undefined,
    stdout,
    stderr,
    done,
    terminate: options.terminate ?? (() => undefined),
  };
}

function spawnerFor(child: HostedProcess): Spawner {
  return { spawn: () => child };
}

test('ensureWorkdir copies a generic skeleton once and preserves existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'butler-workdir-'));
  const skeleton = await mkdtemp(join(tmpdir(), 'butler-skeleton-'));
  try {
    await writeFile(join(skeleton, 'butler.json'), JSON.stringify({ selfRoot: 'self' }));
    await writeFile(join(skeleton, 'README.md'), 'generic\n');
    await writeFile(join(root, 'README.md'), 'owner\n');
    const first = await ensureWorkdir(root, skeleton);
    expect(first.created).toBe(true);
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('owner\n');
    expect(await readFile(join(root, 'butler.json'), 'utf8')).toContain('selfRoot');
    const second = await ensureWorkdir(root, skeleton);
    expect(second.created).toBe(false);
    await writeFile(join(root, 'butler.json'), '{ owner config }');
    const third = await ensureWorkdir(root, skeleton);
    expect(third.created).toBe(false);
    expect(await readFile(join(root, 'butler.json'), 'utf8')).toBe('{ owner config }');
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(skeleton, { recursive: true, force: true })]);
  }
});

test('runHostedCommand returns synchronous spawn failures', async () => {
  const error = new Error('spawn denied');
  const result = await runHostedCommand({ spawn: () => { throw error; } }, { argv: ['bad'], cwd: '/', graceMs: 5 }, 20);
  expect(result.error).toBe(error);
  expect(result.exitCode).toBeNull();
  expect(result.timedOut).toBe(false);
});

test('runHostedCommand converts rejected done promises into a result', async () => {
  const result = await runHostedCommand(spawnerFor(fakeProcess({ reject: new Error('provider failed') })), { argv: ['x'], cwd: '/', graceMs: 5 }, 20);
  expect(result.error?.message).toBe('provider failed');
  expect(result.exitCode).toBeNull();
});

test('runHostedCommand terminates on timeout and clears the timer', async () => {
  let terminated = 0;
  let resolveDone!: (value: { exitCode: number | null; signal: string | null }) => void;
  const child = fakeProcess({
    outcome: new Promise((resolve) => { resolveDone = resolve; }),
    terminate: () => { terminated += 1; resolveDone({ exitCode: null, signal: 'SIGTERM' }); },
  });
  const result = await runHostedCommand(spawnerFor(child), { argv: ['slow'], cwd: '/', graceMs: 5 }, 10);
  expect(result.timedOut).toBe(true);
  expect(terminated).toBe(1);
  await Bun.sleep(30);
  expect(terminated).toBe(1);
});

test('runHostedCommand keeps only the bounded tail of each stream', async () => {
  const child = fakeProcess();
  const promise = runHostedCommand(spawnerFor(child), { argv: ['output'], cwd: '/', graceMs: 5 }, 100);
  child.stdout.end('a'.repeat(2 * 1024 * 1024 + 100));
  child.stderr.end('b'.repeat(2 * 1024 * 1024 + 100));
  const result = await promise;
  expect(result.stdout).toHaveLength(2 * 1024 * 1024);
  expect(result.stderr).toHaveLength(2 * 1024 * 1024);
  expect(result.stdout.startsWith('a')).toBe(true);
  expect(result.stderr.startsWith('b')).toBe(true);
});

test('fromRaw keeps relative config paths rooted at the work directory', () => {
  const config = fromRaw('/tmp/butler', { python: '../.venv/bin/python', endpoints: {}, automations: {} });
  expect(config.python).toBe('/tmp/.venv/bin/python');
  expect(config.stateDir).toBe('/tmp/butler/.state');
  expect(config.logDir).toBe('/tmp/butler/.state/logs');
});

test('createSubprocessSpawner shutdown waits for managed handles to quiesce', async () => {
  let terminateCalls = 0;
  let resolveDone!: (value: { exitCode: number | null; signal: string | null }) => void;
  let resolveExit!: () => void;
  const runtime: SubprocessRuntimeLike = {
    spawn() {
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        done: new Promise((resolve) => { resolveDone = resolve; }),
        waitForExit: () => new Promise<boolean>((resolve) => { resolveExit = () => resolve(true); }),
        terminate: () => { terminateCalls += 1; resolveDone({ exitCode: null, signal: 'SIGTERM' }); resolveExit(); },
      };
    },
  };
  const spawner = createSubprocessSpawner(runtime);
  const child = spawner.spawn({ argv: ['long'], cwd: '/', graceMs: 10 });
  const shutdown = spawner.shutdown!();
  await Bun.sleep(5);
  expect(terminateCalls).toBe(1);
  let settled = false;
  void child.done.then(() => { settled = true; });
  await shutdown;
  expect(settled).toBe(true);
  const after = spawner.spawn({ argv: ['late'], cwd: '/', graceMs: 10 });
  const outcome = await after.done;
  expect(outcome.error?.message).toContain('shutting down');
});
