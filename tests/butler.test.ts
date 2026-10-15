import { expect, test } from 'bun:test';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ButlerStatusReader } from '../src/host/butler.ts';
import { createNodeSpawner } from './node-spawner.ts';

async function fixture() {
  const root = await mkdtemp('/tmp/myspace-butler-test-');
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'journal'), { recursive: true });
  await mkdir(join(root, 'spool'), { recursive: true });
  await mkdir(join(root, 'digests'), { recursive: true });
  await mkdir(join(root, 'etc'), { recursive: true });
  await writeFile(join(root, 'journal', 'JOURNAL.jsonl'), `${JSON.stringify({ ts: '2026-09-20T10:00:00Z', source: 'test', type: 'note', text: 'hello' })}\n`);
  await writeFile(join(root, 'spool', 'workbuddy.jsonl'), '{"text":"queued"}\n');
  await writeFile(join(root, 'digests', 'audit-2026-09-20.md'), '# 周检\n\n- 蒸馏候选：把重复流程写成技能\n');
  await writeFile(join(root, 'etc', 'endpoints.json'), JSON.stringify({ version: 1, targets: { codex: { kind: 'marker-block', installed: { version: 1 } } } }));
  const doctor = join(root, 'bin', 'doctor');
  await writeFile(doctor, '#!/bin/sh\nprintf "[PASS] 骨架\\n[WARN] spool 积压\\n"\n');
  await chmod(doctor, 0o755);
  return root;
}

test('Butler reader exposes read-only governance facts without writing Butler data', async () => {
  const root = await fixture();
  const reader = new ButlerStatusReader(root, join(root, 'bin', 'doctor'), createNodeSpawner());
  const status = await reader.read();
  expect(status.status).toBe('warning');
  expect(status.journal.records).toBe(1);
  expect(status.journal.latest?.source).toBe('test');
  expect(status.spool).toEqual({ records: 1, sources: 1 });
  // audit digest prose no longer counts as candidates; only proposals.jsonl does
  expect(status.candidates.count).toBe(0);
  expect(status.latestDigest?.name).toBe('audit-2026-09-20.md');
  expect(status.endpoints[0]).toMatchObject({ id: 'codex', installed: true, version: 1 });
});

test('Butler status reader returns doctor failure as error without throwing', async () => {
  const root = await fixture();
  const doctor = join(root, 'bin', 'doctor');
  await writeFile(doctor, '#!/bin/sh\nprintf "[FAIL] endpoint missing\\n"\nexit 1\n');
  await chmod(doctor, 0o755);
  const status = await new ButlerStatusReader(root, join(root, 'bin', 'doctor'), createNodeSpawner()).read();
  expect(status.status).toBe('error');
  expect(status.doctor.exitCode).toBe(1);
  expect(status.doctor.failures).toBe(1);
});

test('Butler detail reader exposes journal, spool, endpoint, doctor and config views read-only', async () => {
  const root = await fixture();
  const reader = new ButlerStatusReader(root, join(root, 'bin', 'doctor'), createNodeSpawner());
  const journal = await reader.readDetail('journal');
  const spool = await reader.readDetail('spool');
  const endpoint = await reader.readDetail('endpoint', 'codex');
  const doctor = await reader.readDetail('doctor');
  const config = await reader.readDetail('config');
  expect(journal.section).toBe('journal');
  if (journal.section === 'journal') expect(journal.records[0].text).toBe('hello');
  expect(spool.section).toBe('spool');
  if (spool.section === 'spool') {
    expect(spool.total).toBe(1);
    expect(spool.sources[0].entries[0].text).toBe('queued');
  }
  expect(endpoint.section).toBe('endpoint');
  if (endpoint.section === 'endpoint') {
    expect(endpoint.endpoint.id).toBe('codex');
    expect(endpoint.endpoint.path).toBeUndefined();
  }
  expect(doctor.section).toBe('doctor');
  if (doctor.section === 'doctor') expect(doctor.doctor.warnings).toBe(1);
  expect(config.section).toBe('config');
  if (config.section === 'config') {
    expect(config.automations.length).toBeGreaterThan(0);
    expect(config.commands.map((item) => item.name)).toEqual(['intake', 'card', 'run', 'install', 'doctor']);
    expect(config.persona.profilePath).toBe('persona/profile.md');
    expect(config.persona.rulesPath).toBe('rules');
    expect(Array.isArray(config.persona.rules)).toBe(true);
  }
});

test('endpoint list merges registry targets with doctor lines and maps every level', async () => {
  const root = await fixture();
  await writeFile(join(root, 'etc', 'endpoints.json'), JSON.stringify({ version: 1, targets: {
    claude: { kind: 'agent', installed: { version: 2 } },
    codex: { kind: 'agent', installed: { version: 3 } },
    workbuddy: { kind: 'skill', installed: { version: 3 } },
  } }));
  const doctor = join(root, 'bin', 'doctor');
  await writeFile(doctor, '#!/bin/sh\nprintf "[WARN] 端点 claude 旧版 v2\\n[PASS] 端点 codex v3 正常\\n[FAIL] 端点 workbuddy 内容被改\\n[INFO] 端点 git 未安装\\n"\nexit 1\n');
  await chmod(doctor, 0o755);
  const { endpoints } = await new ButlerStatusReader(root, doctor, createNodeSpawner()).read();
  expect(endpoints.map((item) => [item.id, item.status, item.installed])).toEqual([
    ['claude', 'legacy', true],
    ['codex', 'ok', true],
    ['workbuddy', 'fail', true],
    ['git', 'missing', false],
  ]);
});

test('health, queue and pending are separate signals; pending comes from proposals.jsonl', async () => {
  const root = await fixture();
  await writeFile(join(root, 'proposals.jsonl'), [
    { event: 'create', id: 'p-1', kind: 'rule', title: '修正路径', body: 'x', find: '旧', evidence: ['journal://1'], status: 'pending', createdAt: '2026-10-10T00:00:00Z' },
    { event: 'create', id: 'p-2', kind: 'fact', title: '已拒', body: 'y', status: 'pending', createdAt: '2026-10-10T00:00:00Z' },
    { event: 'status', id: 'p-2', status: 'rejected', reason: 'n' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n{broken\n');
  const doctor = join(root, 'bin', 'doctor');
  await writeFile(doctor, '#!/bin/sh\nprintf "[PASS] ok\\n"\n');
  await chmod(doctor, 0o755);
  const status = await new ButlerStatusReader(root, doctor, createNodeSpawner()).read();
  expect(status.health).toBe('healthy');
  expect(status.queue).toEqual({ spool: 1 });
  expect(status.pending.count).toBe(1);
  // The owner decides from the briefing page, so the item carries what will be written.
  expect(status.pending.items).toEqual([{ id: 'p-1', kind: 'rule', title: '修正路径', body: 'x', find: '旧', evidence: ['journal://1'], createdAt: '2026-10-10T00:00:00Z' }]);
  expect(status.pending.bad).toBe(1);
  // suggestions come from distill's candidates.jsonl, not from the old proposals
  expect(status.candidates).toEqual({ count: 0, promoted: 0, dismissed: 0, items: [] });
  expect(status.status).toBe('warning');

  await writeFile(doctor, '#!/bin/sh\nexit 3\n');
  const broken = await new ButlerStatusReader(root, doctor, createNodeSpawner()).read();
  expect(broken.health).toBe('error');
});

test('detail records keep provenance so the page can show and open where an observation came from', async () => {
  const root = await fixture();
  await writeFile(join(root, 'spool', 'dsh.jsonl'), JSON.stringify({
    ts: '2026-10-10T08:00:00Z', source: 'dsh', type: 'session', tags: ['dsh-turn'], text: '回合结束',
    ref: 'dsh://session-abc#27', workspace: '/w', sessionId: 'session-abc', turn: 27,
    toolsUsed: ['bash', 7], filesTouched: ['a.ts'], failed: true,
  }) + '\n');
  await writeFile(join(root, 'spool', 'git.jsonl'), JSON.stringify({
    ts: '2026-10-10T08:01:00Z', source: 'git', type: 'note', text: 'git 提交',
    ref: 'git:///w@94b8357', gitCommits: [{ sha: '94b8357', subject: 's' }],
  }) + '\n');
  const reader = new ButlerStatusReader(root, join(root, 'bin', 'doctor'), createNodeSpawner());
  const spool = await reader.readDetail('spool');
  if (spool.section !== 'spool') throw new Error('section');
  const dsh = spool.sources.find((s) => s.source === 'dsh')!.entries[0]!;
  expect(dsh).toMatchObject({ ref: 'dsh://session-abc#27', sessionId: 'session-abc', turn: 27, workspace: '/w', toolsUsed: ['bash'], filesTouched: ['a.ts'], failed: true });
  const git = spool.sources.find((s) => s.source === 'git')!.entries[0]!;
  expect(git).toMatchObject({ ref: 'git:///w@94b8357', gitCommits: [{ sha: '94b8357', subject: 's' }] });
});

test('open suggestions are counted from candidates.jsonl: a promoted, dismissed or vanished record is not open', async () => {
  const root = await fixture();
  const row = (n: number, extra: Record<string, unknown> = {}) => ({ ts: `2026-11-0${n}T00:00:00Z`, source: 'codex', type: 'note', text: `观察 ${n}`, ...extra });
  await writeFile(join(root, 'journal', 'JOURNAL.jsonl'), [row(1), row(2), row(3), row(4), { ts: '2026-11-05T00:00:00Z', source: 'git', type: 'note', tags: ['git-commit'], text: '提交' }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const key = (n: number) => `journal:2026-11-0${n}T00:00:00Z:codex`;
  await writeFile(join(root, 'candidates.jsonl'), [
    { event: 'mark', origin: key(1), to: 'rule', reason: '约定' },
    { event: 'mark', origin: key(2), to: 'knowledge', reason: '会被忽略' },
    { event: 'dismiss', origin: key(2) },
    { event: 'mark', origin: key(3), to: 'profile', reason: '会被升级' },
    { event: 'promote', origin: key(3) },
    { event: 'mark', origin: 'journal:2020-01-01T00:00:00Z:codex', to: 'rule', reason: '记录已不存在' },
    { event: 'mark', origin: 'journal:2026-11-05T00:00:00Z:git', to: 'rule', reason: '提交不可升级' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n{broken\n');
  const doctor = join(root, 'bin', 'doctor');
  await writeFile(doctor, '#!/bin/sh\nprintf "[PASS] ok\\n"\n');
  await chmod(doctor, 0o755);
  const status = await new ButlerStatusReader(root, doctor, createNodeSpawner()).read();
  expect(status.candidates).toEqual({ count: 1, promoted: 1, dismissed: 1, items: [{ key: key(1), to: 'rule', reason: '约定', ts: '2026-11-01T00:00:00Z', text: '观察 1' }] });
});

test('distill status counts what is left to read after the cursor, and only observations', async () => {
  const root = await fixture();
  const row = (n: number, extra: Record<string, unknown> = {}) => ({ ts: `2026-11-0${n}T00:00:00Z`, source: 'codex', type: 'note', text: `观察 ${n}`, ...extra });
  await writeFile(join(root, 'journal', 'JOURNAL.jsonl'), [
    row(1), row(2),
    row(3, { source: 'git', tags: ['git-commit'] }),
    row(4, { type: 'session', source: 'dsh' }),
    row(5, { source: 'butler', tags: ['memory'] }),
    row(6),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const doctor = join(root, 'bin', 'doctor');
  await writeFile(doctor, '#!/bin/sh\nprintf "[PASS] ok\\n"\n');
  await chmod(doctor, 0o755);

  // never distilled: everything is still ahead, Butler's own memory trace is not material
  const fresh = await new ButlerStatusReader(root, doctor, createNodeSpawner()).read();
  // the fixture's one spool row is merged by distill before it reads, so it counts as material too
  expect(fresh.distill).toMatchObject({ read: 0, total: 6, waiting: 4, reference: 2 });
  expect(fresh.distill.lastRunAt).toBeUndefined();

  // after the cursor moves to 2, only what follows it counts, and the cursor file's time is the last run
  await writeFile(join(root, 'etc', 'cursor.json'), JSON.stringify({ distill: 2 }));
  const moved = await new ButlerStatusReader(root, doctor, createNodeSpawner()).read();
  expect(moved.distill).toMatchObject({ read: 2, total: 6, waiting: 2, reference: 2 });
  expect(Number.isNaN(Date.parse(moved.distill.lastRunAt ?? ''))).toBe(false);

  // a cursor past the end (journal rewritten) is clamped, not negative
  await writeFile(join(root, 'etc', 'cursor.json'), JSON.stringify({ distill: 99 }));
  const clamped = await new ButlerStatusReader(root, doctor, createNodeSpawner()).read();
  expect(clamped.distill).toMatchObject({ read: 6, waiting: 1, reference: 0 });
});

test('a spool backlog no longer turns the aggregate status into a warning', async () => {
  const root = await fixture();
  const doctor = join(root, 'bin', 'doctor');
  await writeFile(doctor, '#!/bin/sh\nprintf "[PASS] ok\\n"\n');
  await chmod(doctor, 0o755);
  const status = await new ButlerStatusReader(root, doctor, createNodeSpawner()).read();
  expect(status.spool.records).toBe(1);
  expect(status.status).toBe('healthy');
});
