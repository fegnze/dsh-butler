import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyConsumer } from '../src/agent/consumer.ts';
import { publishWorkdir, publishedWorkdir } from '../src/host/config.ts';

const roots: string[] = [];
afterEach(() => {
  publishWorkdir(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function mounted() {
  const definitions = new Map<string, any>();
  let teardown: (() => Promise<void>) | undefined;
  let spawned = 0;
  let shutdown = 0;
  const spawner = { spawn() { spawned++; throw new Error('test spawn reached'); }, async shutdown() { shutdown++; } };
  await applyConsumer({
    tools: {
      register(definition: any) { definitions.set(definition.name, definition); return () => { definitions.delete(definition.name); }; },
      // Deliberately trap forbidden restrictions even though not in the consumer type.
      guard() { throw new Error('consumer must not install guard'); },
      restrict() { throw new Error('consumer must not install restriction'); },
    } as any,
    subprocess: {} as any,
    effect(factory) { const result = factory(); teardown = result as () => Promise<void>; return result; },
  }, {}, { spawner });
  return { definitions, dispose: () => teardown?.(), spawned: () => spawned, shutdown: () => shutdown };
}

test('consumer loads without Host, registers only read/report tools and installs no guard', async () => {
  publishWorkdir(undefined);
  const consumer = await mounted();
  expect([...consumer.definitions.keys()].sort()).toEqual(['butler_read', 'butler_report_session', 'butler_search']);
  await consumer.dispose();
  expect(consumer.definitions.size).toBe(0);
  expect(consumer.shutdown()).toBe(1);
});

test('consumer call without Host fails clearly even when BUTLER_WORKDIR is set', async () => {
  const previous = process.env.BUTLER_WORKDIR;
  process.env.BUTLER_WORKDIR = '/must-not-be-used';
  try {
    publishWorkdir(undefined);
    const consumer = await mounted();
    await expect(consumer.definitions.get('butler_read').execute({ id: 'knowledge/test' }, {})).rejects.toThrow(/Host plugin has not mounted/);
    expect(consumer.spawned()).toBe(0);
    await consumer.dispose();
  } finally {
    if (previous === undefined) delete process.env.BUTLER_WORKDIR;
    else process.env.BUTLER_WORKDIR = previous;
  }
});

test('consumer resolves the published Host workdir lazily, without initializing an instance', async () => {
  const consumer = await mounted();
  const root = mkdtempSync(join(tmpdir(), 'butler-consumer-'));
  roots.push(root);
  mkdirSync(join(root, 'faculties/journal/bin'), { recursive: true });
  // journal lookup is existence-only; the command is intercepted by the spawner.
  for (const name of ['memory', 'pipeline']) writeFileSync(join(root, 'faculties/journal/bin', name), '');
  writeFileSync(join(root, 'butler.json'), JSON.stringify({ scanRoots: ['faculties'], selfRoot: 'self', python: '/usr/bin/python' }));
  publishWorkdir(root);
  await expect(consumer.definitions.get('butler_read').execute({ id: 'knowledge/test' }, {})).rejects.toThrow(/test spawn reached/);
  expect(consumer.spawned()).toBe(1);
  expect(publishedWorkdir()).toBe(root);
  await consumer.dispose();
});

test('package exports consumer and build includes the dedicated consumer host artifact', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'));
  expect(pkg.exports['./consumer']).toBe('./dsh/consumer.js');
  const wrapper = readFileSync(join(import.meta.dir, '../dsh/consumer.js'), 'utf8');
  expect(wrapper).toContain("from './consumer-host.js'");
  expect(wrapper).toContain("['tools', 'subprocess']");
  const build = readFileSync(join(import.meta.dir, '../build.py'), 'utf8');
  expect(build).toContain("'src/agent/consumer.ts'");
  expect(build).toContain("'dsh/consumer-host.js'");
  expect(build).toContain('(CONSUMER_ENTRY, CONSUMER_OUT)');
});
