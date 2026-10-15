import { afterAll, expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerButlerTools, registerConsumerTools } from '../src/agent/tools.ts';
import type { ButlerConfig } from '../src/host/config.ts';
import type { HostedSpawnSpec, Spawner } from '../src/host/hosting.ts';

const root = mkdtempSync(join(tmpdir(), 'butler-pipeline-tools-'));
mkdirSync(join(root, 'faculties/journal/bin'), { recursive: true });
writeFileSync(join(root, 'faculties/journal/bin/memory'), '');
afterAll(() => rmSync(root, { recursive: true, force: true }));
const config = {
  instanceRoot: root, scanRoots: [join(root, 'faculties')], selfRoot: join(root, 'self'),
  python: '/usr/bin/python', stateDir: '/tmp/butler-test/state', logDir: '/tmp/butler-test/logs',
  notification: { enabled: false }, endpoints: {}, automations: {},
  collector: { enabled: false, workspaces: [], excludePresets: [], includeSubagents: false, debounceMs: 0 },
  inject: { enabled: false, workspaces: [], excludePresets: [], includeSubagents: false, maxChars: 500 },
} satisfies ButlerConfig;

function mockSpawner(response: unknown, exitCode = 0, seen: HostedSpawnSpec[] = []): Spawner {
  return { spawn(spec) {
    seen.push(spec);
    const stdout = new PassThrough(); const stderr = new PassThrough();
    const payload = JSON.stringify(exitCode === 0 ? { ok: true, data: response } : { ok: false, error: response });
    queueMicrotask(() => { stdout.end(payload); stderr.end(); });
    return {
      pid: 1, stdin: new Writable({ write(_chunk, _encoding, done) { done(); }}), stdout, stderr,
      done: new Promise((resolve) => queueMicrotask(() => resolve({ exitCode, signal: null }))), terminate() {},
    };
  }};
}

function defs(allowedScopes?: string[]) {
  const out = new Map<string, any>();
  registerConsumerTools({ tools: { register(definition) { out.set((definition as any).name, definition); return () => undefined; } } }, {
    config, allowedScopes, spawner: mockSpawner({ items: [] }),
  });
  return out;
}

test('pipeline tools use named action envelope and place required at schema root', () => {
  const out = defs();
  expect(out.get('butler_search').parameters.required).toEqual(['query']);
  expect(out.get('butler_report_session').parameters.required).toEqual(['source', 'externalSessionId', 'messages', 'segmentId', 'revision']);
  expect(out.get('butler_report_session').parameters.properties.messages.items.required).toEqual(['id', 'role', 'content', 'sequence']);
  expect(out.get('butler_report_session').parameters.properties.messages.items.properties.role.enum).toEqual(['user', 'assistant', 'system', 'tool']);
});

test('pipeline search filters returned cards by local default scope', async () => {
  const seen: HostedSpawnSpec[] = [];
  const cards = [{ id: 'a', scope: 'local', status: 'active' }, { id: 'b', scope: 'private', status: 'active' }, { id: 'c', status: 'active' }];
  const out = new Map<string, any>();
  registerConsumerTools({ tools: { register(definition) { out.set((definition as any).name, definition); return () => undefined; } } }, {
    config, spawner: mockSpawner({ items: cards }, 0, seen),
  });
  const result = JSON.parse(await out.get('butler_search').execute({ query: 'x' }));
  expect(result.items).toEqual([{ id: 'a', scope: 'local' }]);
  const request = seen[0]!;
  expect(typeof request.stdin).toBe('object');
  const envelope = JSON.parse((request.stdin as { data: string }).data);
  expect(envelope).toMatchObject({ action: 'cards.search', args: { query: 'x' } });
});

test('consumer projection keeps core body only on read and never exposes review metadata', async () => {
  const card = { id: 'a', scope: 'local', status: 'active', title: 'Core', summary: 'Index', body: 'Useful body', evidence: ['raw transcript'], contentHash: 'hash', decisionId: 'audit', path: 'internal' };
  for (const [name, payload, args] of [['butler_search', { items: [card] }, { query: 'Core' }], ['butler_read', card, { id: 'a' }]] as const) {
    const out = new Map<string, any>();
    registerConsumerTools({ tools: { register(d) { out.set((d as any).name, d); return () => {}; } } }, { config, spawner: mockSpawner(payload) });
    const result = JSON.parse(await out.get(name).execute(args));
    const value = name === 'butler_search' ? result.items[0] : result;
    for (const field of ['evidence', 'contentHash', 'decisionId', 'path']) expect(value).not.toHaveProperty(field);
    if (name === 'butler_read') expect(value.body).toBe('Useful body');
    else expect(value).not.toHaveProperty('body');
  }
});

test('pipeline read verifies returned card scope and nested validation rejects before spawn', async () => {
  let spawned = 0;
  const spawner: Spawner = { spawn(spec) { spawned++; return mockSpawner({ id: 'x', scope: 'private', status: 'active' }).spawn(spec); } };
  const out = new Map<string, any>();
  registerConsumerTools({ tools: { register(definition) { out.set((definition as any).name, definition); return () => undefined; } } }, { config, spawner });
  await expect(out.get('butler_report_session').execute({ source: 'x', externalSessionId: 'y', segmentId: 'turn-1', revision: 1, messages: [{ id: 'm', role: 'user', content: 'ok' }] })).rejects.toThrow(/sequence/);
  expect(spawned).toBe(0);
  await expect(out.get('butler_read').execute({ id: 'x' })).rejects.toThrow(/returned card scope/);
});

const session = { source: 'dsh', externalSessionId: 's1', segmentId: 'turn-1', revision: 1, messages: [{ id: 'm1', role: 'user', content: 'hello', sequence: 0 }] };
const candidate = {
  runId: 'r1', runToken: 'secret', inputHash: 'hash', kind: 'knowledge', operation: 'create',
  title: 'Title', summary: 'Summary', body: 'Body', rationale: 'Reason', scope: 'local',
  evidence: [{ sourceId: 's1', messageIds: ['m1'] }],
};
test('every new tool executes mock spawn with exact action and bounded JSON envelope', async () => {
  const seen: HostedSpawnSpec[] = [];
  const out = new Map<string, any>();
  const spawner: Spawner = { spawn(spec) {
    const request = JSON.parse((spec.stdin as { data: string }).data);
    const response = request.action === 'cards.search' ? { items: [] } : { id: 'x', scope: 'local', status: 'active' };
    return mockSpawner(response, 0, seen).spawn(spec);
  }};
  registerButlerTools({ tools: { register(definition) { out.set((definition as any).name, definition); return () => undefined; } } }, { config, spawner });
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['butler_search', 'cards.search', { query: 'x' }], ['butler_read', 'cards.read', { id: 'x' }],
    ['butler_report_session', 'sessions.ingest', session], ['butler_distill_claim', 'distill.claim', { limit: 5 }],
    ['butler_source_read', 'sessions.read', { id: 's1' }], ['butler_candidate_submit', 'candidates.submit', candidate],
    ['butler_distill_complete', 'distill.complete', { runId: 'r1', runToken: 'secret', inputHash: 'hash', candidateIds: [] }],
  ];
  for (const [name, action, args] of cases) {
    await out.get(name).execute(args);
    const request = seen.at(-1)!;
    expect(request.argv).toEqual([config.python, join(root, 'faculties/journal/bin/pipeline')]);
    expect(request.env?.BUTLER_SELF_ROOT).toBe(config.selfRoot);
    expect(JSON.parse((request.stdin as { data: string }).data)).toEqual({ action, args });
    const required: string[] = out.get(name).parameters.required ?? [];
    for (const field of required) {
      const invalid = { ...args }; delete invalid[field];
      const count = seen.length;
      await expect(out.get(name).execute(invalid)).rejects.toThrow(/missing/);
      expect(seen.length).toBe(count);
    }
  }
  expect([...out.keys()].some((name) => /approve|reject/.test(name))).toBe(false);
  for (const evidence of [[{ sourceId: 's1' }], [{ sourceId: 's1', messageIds: ['m1'], extra: true }], [{ sourceId: 's1', messageIds: [12] }]]) {
    const count = seen.length;
    await expect(out.get('butler_candidate_submit').execute({ ...candidate, evidence })).rejects.toThrow();
    expect(seen.length).toBe(count);
  }
});

test('scope allowlist filters omitted scope and rejects disallowed explicit scope before spawn', async () => {
  const seen: HostedSpawnSpec[] = []; const out = new Map<string, any>();
  registerConsumerTools({ tools: { register(definition) { out.set((definition as any).name, definition); return () => undefined; } } }, {
    config, allowedScopes: ['team'], spawner: mockSpawner({ items: [{ id: 'a', scope: 'team', status: 'active' }, { id: 'b', scope: 'local', status: 'active' }] }, 0, seen),
  });
  expect(JSON.parse(await out.get('butler_search').execute({ query: 'x' })).items).toEqual([{ id: 'a', scope: 'team' }]);
  await expect(out.get('butler_search').execute({ query: 'x', scope: 'local' })).rejects.toThrow(/scope not allowed/);
  expect(seen).toHaveLength(1);
});

test('missing python errors explicitly for legacy and pipeline tools without spawning', async () => {
  let spawned = 0; const out = new Map<string, any>();
  registerButlerTools({ tools: { register(definition) { out.set((definition as any).name, definition); return () => undefined; } } }, {
    config: { ...config, python: undefined }, spawner: { spawn() { spawned++; throw new Error('must not spawn'); } },
  });
  for (const [name, args] of [['butler_journal_read', {}], ['butler_search', { query: 'x' }]] as const) {
    await expect(out.get(name).execute(args)).rejects.toThrow(/config.python is required/);
  }
  expect(spawned).toBe(0);
});

test('pipeline business errors are decoded from stdout even with nonzero exit', async () => {
  const out = new Map<string, any>();
  registerConsumerTools({ tools: { register(definition) { out.set((definition as any).name, definition); return () => undefined; } } }, {
    config, spawner: mockSpawner({ code: 'not_found', message: 'missing' }, 1),
  });
  await expect(out.get('butler_read').execute({ id: 'x' })).rejects.toThrow(/not_found: missing/);
});

test('consumers never receive archived or suspended cards, and cannot ask for them', async () => {
  const seen: HostedSpawnSpec[] = [];
  const items = [
    { id: 'ok', scope: 'local', status: 'active', usable: true, validity: null, title: 'Usable' },
    { id: 'old', scope: 'local', status: 'archived', usable: false, body: 'archived body' },
    { id: 'stale', scope: 'local', status: 'active', usable: false, validity: { state: 'suspended', reasons: [{ code: 'check_failed' }] } },
  ];
  const out = new Map<string, any>();
  registerConsumerTools({ tools: { register(d) { out.set((d as any).name, d); return () => {}; } } }, { config, spawner: mockSpawner({ items }, 0, seen) });
  expect(JSON.parse(await out.get('butler_search').execute({ query: 'x' })).items.map((c: any) => c.id)).toEqual(['ok']);
  // includeInactive is an owner-UI argument; the model schema refuses it before spawning.
  const count = seen.length;
  await expect(out.get('butler_search').execute({ query: 'x', includeInactive: true })).rejects.toThrow(/unknown argument/);
  await expect(out.get('butler_read').execute({ id: 'old', includeInactive: true })).rejects.toThrow(/unknown argument/);
  expect(seen.length).toBe(count);
  for (const card of items.slice(1)) {
    const reader = new Map<string, any>();
    registerConsumerTools({ tools: { register(d) { reader.set((d as any).name, d); return () => {}; } } }, { config, spawner: mockSpawner(card) });
    await expect(reader.get('butler_read').execute({ id: card.id })).rejects.toThrow(/card_unavailable/);
  }
});

test('candidate submit separates visibility from applicability and accepts checks/conflict', () => {
  const out = new Map<string, any>();
  registerButlerTools({ tools: { register(d) { out.set((d as any).name, d); return () => {}; } } }, { config, spawner: mockSpawner({}) });
  const params = out.get('butler_candidate_submit').parameters;
  expect(params.required).not.toContain('scope');
  expect(params.properties.scope.pattern).toBe('^[a-z][a-z0-9-]{0,31}$');
  expect(params.properties.appliesTo.type).toBe('string');
  expect(params.properties.checks.items.properties.type.enum).toEqual(['path', 'quote']);
  expect(params.properties.conflict.type).toBe('string');
});
