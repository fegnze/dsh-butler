import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromRaw } from '../src/host/config.ts';
import { registerButlerTools, TOOL_NAMES } from '../src/agent/tools.ts';
import { createNodeSpawner } from './node-spawner.ts';

const PYTHON = process.env.BUTLER_TEST_PYTHON ?? '/Users/ghost/MySpace/.venv/bin/python';
let root = '';
let self = '';
let tools: Map<string, any>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'butler-agent-tools-'));
  cpSync(join(import.meta.dir, '..', 'skeleton'), root, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  self = join(root, 'self');
  writeFileSync(join(self, 'journal', 'JOURNAL.jsonl'), [
    { ts: '2026-10-10T01:00:00Z', source: 'codex', type: 'note', text: '主人偏好：先给方案再动手', ref: 'dsh://s#1' },
    { ts: '2026-10-10T02:00:00Z', source: 'git', type: 'note', tags: ['git-commit'], text: '提交 abc', ref: 'git://r@abc' },
    { ts: '2026-10-10T03:00:00Z', source: 'dsh', type: 'session', text: '回合结束', ref: 'dsh://s#2' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  tools = new Map();
  const disposers: string[] = [];
  registerButlerTools({ tools: { register(def: any) { tools.set(def.name, def); return () => disposers.push(def.name); } } }, { config: fromRaw(root, { python: PYTHON }), spawner: createNodeSpawner() });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const call = (name: string, args: Record<string, unknown>) => tools.get(name).execute(args, { signal: new AbortController().signal });

test('registers exactly the Butler tool set with valid raw definitions and no decision tools', () => {
  expect([...tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
  for (const name of tools.keys()) expect(name).not.toMatch(/apply|reject|bash|write_file/);
  for (const def of tools.values()) {
    expect(typeof def.description).toBe('string');
    expect(def.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    expect(typeof def.output.render).toBe('function');
    expect(def.output.schema).toEqual({ type: 'string' });
  }
});

test('journal_read → candidate → advance: only observations are read, marks are suggestions, nothing is written to cards', async () => {
  const material = JSON.parse(await call('butler_journal_read', {}));
  // the cursor passes all three rows, but only the observation is handed to the model
  expect(material).toMatchObject({ from: 0, to: 3 });
  expect(material.records.map((r: any) => r.key)).toEqual(['journal:2026-10-10T01:00:00Z:codex']);
  const out = await call('butler_candidate', { key: material.records[0].key, to: 'profile', reason: '稳定的工作偏好' });
  expect(out).toContain('marked');
  const events = readFileSync(join(self, 'candidates.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(events).toMatchObject([{ event: 'mark', origin: material.records[0].key, to: 'profile', reason: '稳定的工作偏好' }]);
  // a mark suggests only: no card, no profile, no proposal
  expect(existsSync(join(self, 'proposals.jsonl'))).toBe(false);
  expect(JSON.parse(await call('butler_card', {}))).toEqual([]);
  // a marked record is not offered to the model again
  expect(JSON.parse(await call('butler_journal_read', {})).records).toEqual([]);
  await call('butler_distill_advance', { to: 3 });
  expect(JSON.parse(readFileSync(join(self, 'etc', 'cursor.json'), 'utf8')).distill).toBe(3);
  expect(tools.get('butler_candidate').output.render({}, 'x')).toEqual([{ type: 'text', text: 'x' }]);
});

test('butler_candidate refuses git and session records, a missing record and a bad key before writing anything', async () => {
  for (const [key, why] of [
    ['journal:2026-10-10T02:00:00Z:git', /只有观察/],
    ['journal:2026-10-10T03:00:00Z:dsh', /只有观察/],
    ['journal:2030-01-01T00:00:00Z:codex', /找不到/],
  ] as const) {
    await expect(call('butler_candidate', { key, to: 'rule', reason: 'x' })).rejects.toThrow(why);
  }
  for (const args of [
    { key: '../x', to: 'rule', reason: 'x' },
    { key: 'journal:2026-10-10T01:00:00Z:codex', to: 'fact', reason: 'x' },
    { key: 'journal:2026-10-10T01:00:00Z:codex', to: 'rule' },
    { key: '--x', to: 'rule', reason: 'x' },
  ]) await expect(call('butler_candidate', args as never)).rejects.toThrow();
  expect(existsSync(join(self, 'candidates.jsonl'))).toBe(false);
});

test('a candidate the owner dismissed is not marked again by a later distill', async () => {
  const key = 'journal:2026-10-10T01:00:00Z:codex';
  await call('butler_candidate', { key, to: 'rule', reason: '先标一次' });
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(PYTHON, [join(root, 'faculties', 'journal', 'bin', 'memory'), 'candidate-dismiss', key], { env: { PATH: process.env.PATH ?? '', BUTLER_SELF_ROOT: self }, encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(await call('butler_candidate', { key, to: 'rule', reason: '又来' })).toContain('跳过');
  expect(readFileSync(join(self, 'candidates.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
});

test('butler_card lists and reads a card in full; the Host-side promotion path is the only writer', async () => {
  const { spawnSync } = await import('node:child_process');
  const create = spawnSync(PYTHON, [join(root, 'faculties', 'journal', 'bin', 'memory'), 'card-create', 'rule/confirm-outbound', '--title', '外发需确认', '--summary', '对外发送前先确认'], { env: { PATH: process.env.PATH ?? '', BUTLER_SELF_ROOT: self }, input: '邮件、消息发出前必须得到主人确认。', encoding: 'utf8' });
  expect(create.status).toBe(0);
  expect(JSON.parse(await call('butler_card', {}))).toEqual([{ id: 'rule/confirm-outbound', title: '外发需确认', summary: '对外发送前先确认' }]);
  expect(await call('butler_card', { id: 'rule/confirm-outbound' })).toContain('邮件、消息发出前必须得到主人确认。');
  await expect(call('butler_card', { id: 'rule/missing' })).rejects.toThrow(/不存在/);
});

test('a failing faculty command surfaces its stderr as a tool error', async () => {
  await expect(call('butler_distill_advance', { to: 99 })).rejects.toThrow(/advance/);
});

test('argument validation rejects before spawning anything', async () => {
  let spawned = 0;
  const local = new Map<string, any>();
  registerButlerTools({ tools: { register(def: any) { local.set(def.name, def); return () => undefined; } } }, {
    config: fromRaw(root, { python: PYTHON }),
    spawner: { spawn() { spawned += 1; throw new Error('must not spawn'); } },
  });
  for (const [name, args] of [
    ['butler_candidate', { key: 'journal:2026-10-10T01:00:00Z:codex', to: 'fact', reason: 'x' }],
    ['butler_candidate', { key: 'journal:2026-10-10T01:00:00Z:codex', to: 'rule' }],
    ['butler_candidate', { key: 'journal:2026-10-10T01:00:00Z:codex', to: 'rule', reason: 'x', extra: 1 }],
    ['butler_candidate', { key: '../x', to: 'rule', reason: 'x' }],
    ['butler_card', { id: 'rule/../../etc' }],
    ['butler_card', { id: '--list' }],
    ['butler_card', { id: 'secret/x' }],
  ] as const) {
    await expect(local.get(name).execute(args, {})).rejects.toThrow(name);
  }
  expect(spawned).toBe(0);
});

test('agent half reads the workdir the Host published, not the generic default', async () => {
  const { publishWorkdir } = await import('../src/host/config.ts');
  const { applyAgent } = await import('../src/agent/entry.ts');
  writeFileSync(join(root, 'butler.json'), JSON.stringify({ python: PYTHON }));
  publishWorkdir(root);
  const names: string[] = [];
  let teardown: (() => Promise<void>) | undefined;
  await applyAgent({
    tools: { register(def: any) { names.push(def.name); return () => undefined; } },
    subprocess: {} as never,
    effect: ((factory: any) => { teardown = factory(); return teardown; }) as never,
  }, {}, { spawner: createNodeSpawner() });
  publishWorkdir(undefined);
  // butler_* tools plus the delegation submit tool (only usable inside a delegation session)
  expect(names.sort()).toEqual([...TOOL_NAMES, 'butler_delegation_submit'].sort());
  await teardown?.();
});

test('agent half applied before the Host publishes resolves the workdir at call time, and refuses a silent default', async () => {
  const { publishWorkdir } = await import('../src/host/config.ts');
  const { applyAgent } = await import('../src/agent/entry.ts');
  writeFileSync(join(root, 'butler.json'), JSON.stringify({ python: PYTHON }));
  publishWorkdir(undefined);
  const prevEnv = process.env.BUTLER_WORKDIR;
  delete process.env.BUTLER_WORKDIR;
  const local = new Map<string, any>();
  await applyAgent({
    tools: { register(def: any) { local.set(def.name, def); return () => undefined; } },
    subprocess: {} as never,
    effect: ((factory: any) => factory()) as never,
  }, {}, { spawner: createNodeSpawner() });
  try {
    await expect(local.get('butler_card').execute({}, {})).rejects.toThrow(/workdir/i);
    publishWorkdir(root);
    expect(JSON.parse(await local.get('butler_journal_read').execute({}, {}))).toMatchObject({ to: 3 });
  } finally {
    publishWorkdir(undefined);
    if (prevEnv !== undefined) process.env.BUTLER_WORKDIR = prevEnv;
  }
});

test('agent half never hides tools; an agent-scoped guard refuses everything outside the Butler allow-list', async () => {
  const { applyAgent, BUTLER_ALLOWED_TOOLS } = await import('../src/agent/entry.ts');
  const guards: Array<(exec: { name: string }) => string | undefined> = [];
  let restricted = 0;
  await applyAgent({
    tools: {
      register() { return () => undefined; },
      restrict() { restricted += 1; return () => undefined; },
      guard(fn: (exec: { name: string }) => string | undefined) { guards.push(fn); return () => undefined; },
    } as never,
    subprocess: {} as never,
    effect: ((factory: any) => factory()) as never,
  }, {}, { spawner: createNodeSpawner() });
  expect(restricted).toBe(0);
  expect(guards).toHaveLength(1);
  const guard = guards[0]!;
  for (const name of [...TOOL_NAMES, 'glob', 'grep', 'ask_user_question']) expect(guard({ name })).toBeUndefined();
  for (const name of ['bash', 'write', 'edit', 'schedule_create', 'spawn_teammate', 'send_message', 'team_task_create', 'mcp__nowledge_mem__memory_add', 'web_fetch']) {
    expect(guard({ name })).toMatch(/Butler/);
  }
  expect([...BUTLER_ALLOWED_TOOLS].sort()).toEqual([...TOOL_NAMES, 'glob', 'grep', 'ask_user_question'].sort());
});
