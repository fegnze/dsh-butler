import { afterAll, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromRaw } from '../src/host/config.ts';
import { createHosting } from '../src/host/hosting.ts';
import { createButlerRouter } from '../src/host/routes.ts';
import { classifyRecord } from '../src/host/butler.ts';
import { spawnSync } from 'node:child_process';
import { createNodeSpawner } from './node-spawner.ts';

const PYTHON = process.env.BUTLER_TEST_PYTHON ?? '/Users/ghost/MySpace/.venv/bin/python';
const root = mkdtempSync(join(tmpdir(), 'butler-cards-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('records fall into three groups and only observations are promotable', () => {
  expect(classifyRecord({ source: 'git', type: 'note', tags: ['git-commit'] })).toBe('git');
  expect(classifyRecord({ source: 'dsh', type: 'session' })).toBe('session');
  expect(classifyRecord({ source: 'codex', type: 'note' })).toBe('observation');
  expect(classifyRecord({ source: 'butler', type: 'decision' })).toBe('observation');
  // a commit tagged as such is a commit whatever the source says
  expect(classifyRecord({ source: 'workbuddy', type: 'note', tags: ['git-commit'] })).toBe('git');
});

test('card order is stored by the faculty, read by the Host, and survives deletes and new cards', async () => {
  cpSync(join(import.meta.dir, '..', 'skeleton'), root, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  const self = join(root, 'self');
  mkdirSync(join(self, 'persona'), { recursive: true });
  writeFileSync(join(self, 'persona', 'profile.md'), '# 画像\n');
  mkdirSync(join(self, 'journal'), { recursive: true });
  const lines = [
    { ts: '2026-10-10T01:00:00Z', source: 'codex', type: 'note', text: '一条真正的观察' },
    { ts: '2026-10-10T02:00:00Z', source: 'git', type: 'note', tags: ['git-commit'], text: 'git 提交 x: [feat] y' },
    { ts: '2026-10-10T03:00:00Z', source: 'dsh', type: 'session', text: 'DSH 回合结束' },
  ];
  writeFileSync(join(self, 'journal', 'JOURNAL.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const hosting = await createHosting(fromRaw(root, { python: PYTHON, notification: { enabled: false } }), createNodeSpawner(), 'http://localhost/myspace-butler');
  const router = createButlerRouter(hosting);
  async function call(method: string, path: string, body?: unknown) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
    let status = 0;
    let text = '';
    const res = { writeHead(code: number) { status = code; }, end(value = '') { text += value; } } as unknown as ServerResponse;
    const url = new URL(path, 'http://localhost'); await router.handle(req, res, url.pathname, url);
    return { status, body: JSON.parse(text) };
  }
  const run = (id: string, args: Record<string, string>) => call('POST', `/api/faculties/journal/commands/${id}`, { confirmed: true, args });
  const memory = async () => (await call('GET', '/api/butler?section=memory')).body;
  const slugs = (m: { cards: Array<{ kind: string; slug: string }> }, kind: string) => m.cards.filter((c) => c.kind === kind).map((c) => c.slug);

  // groups, with true totals
  const first = await memory();
  expect(first.records.observation.total).toBe(1);
  expect(first.records.git.total).toBe(1);
  expect(first.records.session.total).toBe(1);
  expect(first.records.observation.records[0].key).toBe('journal:2026-10-10T01:00:00Z:codex');

  for (const slug of ['alpha', 'beta', 'gamma']) expect((await run('card-create', { id: `rule/${slug}`, title: slug, body: slug })).body.exitCode).toBe(0);
  expect(slugs(await memory(), 'rule')).toEqual(['alpha', 'beta', 'gamma']);

  // order is whatever the owner sent, and it is what the injected index uses too
  expect((await run('card-order', { kind: 'rule', slugs: 'gamma\nalpha\nbeta' })).body.exitCode).toBe(0);
  expect(slugs(await memory(), 'rule')).toEqual(['gamma', 'alpha', 'beta']);
  expect(JSON.parse(readFileSync(join(self, 'etc', 'card-order.json'), 'utf8')).rule).toEqual(['gamma', 'alpha', 'beta']);
  const context = readFileSync(join(self, 'build', 'context.md'), 'utf8');
  expect(context.indexOf('rule/gamma')).toBeLessThan(context.indexOf('rule/alpha'));
  expect(context.indexOf('rule/alpha')).toBeLessThan(context.indexOf('rule/beta'));

  // a new card lands after the placed ones; a deleted one just leaves the order
  expect((await run('card-create', { id: 'rule/delta', title: 'delta', body: 'delta' })).body.exitCode).toBe(0);
  expect(slugs(await memory(), 'rule')).toEqual(['gamma', 'alpha', 'beta', 'delta']);
  expect((await run('card-delete', { id: 'rule/alpha' })).body.exitCode).toBe(0);
  expect(slugs(await memory(), 'rule')).toEqual(['gamma', 'beta', 'delta']);

  // slugs that do not exist are dropped, not stored; an empty order is refused
  expect((await run('card-order', { kind: 'rule', slugs: 'beta\nghost\ngamma' })).body.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(self, 'etc', 'card-order.json'), 'utf8')).rule).toEqual(['beta', 'gamma']);
  expect(slugs(await memory(), 'rule')).toEqual(['beta', 'gamma', 'delta']);
  expect((await run('card-order', { kind: 'profile', slugs: 'x' })).status).toBe(400);
  expect((await run('card-order', { kind: 'rule', slugs: 'Bad Slug' })).status).toBe(400);

  // sections are ordered independently
  expect((await run('card-create', { id: 'knowledge/k1', title: 'k1', body: 'k1' })).body.exitCode).toBe(0);
  expect((await run('card-create', { id: 'knowledge/k2', title: 'k2', body: 'k2' })).body.exitCode).toBe(0);
  expect((await run('card-order', { kind: 'knowledge', slugs: 'k1\nk2' })).body.exitCode).toBe(0);
  expect(slugs(await memory(), 'knowledge')).toEqual(['k1', 'k2']);
  expect(slugs(await memory(), 'rule')).toEqual(['beta', 'gamma', 'delta']);

  // a damaged order file is "never reordered", not an error
  writeFileSync(join(self, 'etc', 'card-order.json'), '{not json');
  expect((await call('GET', '/api/butler?section=memory')).status).toBe(200);
});

test('promoting a record writes a card that remembers where it came from, and the record shows it', async () => {
  const self = join(root, 'self');
  const origin = 'journal:2026-10-10T01:00:00Z:codex';
  const hosting = await createHosting(fromRaw(root, { python: PYTHON, notification: { enabled: false } }), createNodeSpawner(), 'http://localhost/myspace-butler');
  const router = createButlerRouter(hosting);
  async function call(method: string, path: string, body?: unknown) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
    let status = 0;
    let text = '';
    const res = { writeHead(code: number) { status = code; }, end(value = '') { text += value; } } as unknown as ServerResponse;
    const url = new URL(path, 'http://localhost'); await router.handle(req, res, url.pathname, url);
    return { status, body: JSON.parse(text) };
  }
  const run = (id: string, args: Record<string, string>) => call('POST', `/api/faculties/journal/commands/${id}`, { confirmed: true, args });
  expect((await run('card-create', { id: 'knowledge/from-record', title: '来自记录', body: '一条真正的观察', origin })).body.exitCode).toBe(0);
  expect(readFileSync(join(self, 'knowledge', 'from-record.md'), 'utf8')).toContain(`origin: ${origin}\n`);
  const memory = (await call('GET', '/api/butler?section=memory')).body;
  expect(memory.cards.find((c: { id: string }) => c.id === 'knowledge/from-record').origin).toBe(origin);
  const source = memory.records.observation.records.find((r: { key: string }) => r.key === origin);
  expect(source.promotedTo).toBe('knowledge/from-record');
  // every other record is left unmarked
  expect(memory.records.observation.records.filter((r: { promotedTo?: string }) => r.promotedTo)).toHaveLength(1);
  // an edit keeps the origin
  expect((await run('card-update', { id: 'knowledge/from-record', title: '改了标题', body: '新正文' })).body.exitCode).toBe(0);
  expect(readFileSync(join(self, 'knowledge', 'from-record.md'), 'utf8')).toContain(`origin: ${origin}\n`);
  // an origin that is not a record handle is refused before any script runs
  expect((await run('card-create', { id: 'knowledge/bad', title: 'x', body: 'x', origin: '../../etc/passwd' })).status).toBe(400);
  expect(existsSync(join(self, 'knowledge', 'bad.md'))).toBe(false);
});

test('two records in the same second from the same source get distinct handles that never shift', async () => {
  const { mkdtempSync: mk, writeFileSync: wf, mkdirSync: md } = await import('node:fs');
  const { ButlerStatusReader } = await import('../src/host/butler.ts');
  const dir = mk(join(tmpdir(), 'butler-keys-'));
  md(join(dir, 'journal'), { recursive: true });
  const row = (text: string) => JSON.stringify({ ts: '2026-10-10T09:34:08Z', source: 'codex', type: 'note', text });
  wf(join(dir, 'journal', 'JOURNAL.jsonl'), [row('第一条'), row('第二条')].join('\n') + '\n');
  const reader = new ButlerStatusReader(dir, '/nonexistent', { spawn() { throw new Error('read-only'); } } as never);
  const keyed = async () => {
    const detail = await reader.readDetail('memory');
    if (detail.section !== 'memory') throw new Error('wrong section');
    return Object.fromEntries(detail.records.observation.records.map((r) => [r.text, r.key]));
  };
  const before = await keyed();
  expect(before['第一条']).toBe('journal:2026-10-10T09:34:08Z:codex');
  expect(before['第二条']).toBe('journal:2026-10-10T09:34:08Z:codex#1');
  // a later append does not renumber what is already there
  wf(join(dir, 'journal', 'JOURNAL.jsonl'), [row('第一条'), row('第二条'), row('第三条')].join('\n') + '\n');
  const after = await keyed();
  expect(after['第一条']).toBe(before['第一条']);
  expect(after['第二条']).toBe(before['第二条']);
  expect(after['第三条']).toBe('journal:2026-10-10T09:34:08Z:codex#2');
  rmSync(dir, { recursive: true, force: true });
});

test('a suggested record shows its suggestion until the owner promotes or dismisses it, through the real Host', async () => {
  const self = join(root, 'self');
  const base = { source: 'codex', type: 'note' };
  writeFileSync(join(self, 'journal', 'JOURNAL.jsonl'), [
    { ts: '2026-11-01T01:00:00Z', ...base, text: '甲：升成规则' },
    { ts: '2026-11-01T02:00:00Z', ...base, text: '乙：升进身份资料' },
    { ts: '2026-11-01T03:00:00Z', ...base, text: '丙：不用升级' },
    { ts: '2026-11-01T04:00:00Z', ...base, text: '丁：没标记也被直接升级' },
    { ts: '2026-11-01T05:00:00Z', source: 'git', type: 'note', tags: ['git-commit'], text: '提交' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const hosting = await createHosting(fromRaw(root, { python: PYTHON, notification: { enabled: false } }), createNodeSpawner(), 'http://localhost/myspace-butler');
  const router = createButlerRouter(hosting);
  async function call(method: string, path: string, body?: unknown) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
    let status = 0;
    let text = '';
    const res = { writeHead(code: number) { status = code; }, end(value = '') { text += value; } } as unknown as ServerResponse;
    const url = new URL(path, 'http://localhost'); await router.handle(req, res, url.pathname, url);
    return { status, body: JSON.parse(text) };
  }
  const run = (id: string, args: Record<string, string>) => call('POST', `/api/faculties/journal/commands/${id}`, { confirmed: true, args });
  const mark = (key: string, to: string, reason: string) => spawnSync(PYTHON, [join(root, 'faculties', 'journal', 'bin', 'memory'), 'candidate-mark', key, `--to=${to}`, `--reason=${reason}`], { env: { PATH: process.env.PATH ?? '', BUTLER_SELF_ROOT: self }, encoding: 'utf8' });
  const [a, b, c, d] = ['01', '02', '03', '04'].map((h) => `journal:2026-11-01T${h}:00:00Z:codex`);
  expect(mark(a, 'rule', '稳定约定').status).toBe(0);
  expect(mark(b, 'profile', '个人偏好').status).toBe(0);
  expect(mark(c, 'knowledge', '先标上').status).toBe(0);
  const read = async () => (await call('GET', '/api/butler?section=memory')).body.records.observation.records as Array<{ key: string; candidate?: { to: string; reason: string }; promotedTo?: string }>;
  let records = await read();
  expect(records.find((r) => r.key === a)?.candidate).toEqual({ to: 'rule', reason: '稳定约定' });
  expect(records.find((r) => r.key === d)?.candidate).toBeUndefined();
  // the git record is never offered, and the faculty refuses to mark it
  expect(mark('journal:2026-11-01T05:00:00Z:git', 'rule', 'x').status).not.toBe(0);
  expect((await read()).some((r) => r.key === 'journal:2026-11-01T05:00:00Z:git')).toBe(false);

  // promote to a rule card: suggestion closes, the record shows where it went
  expect((await run('card-create', { id: 'rule/from-a', title: '甲', body: '甲', origin: a })).body.exitCode).toBe(0);
  // promote into the identity card
  expect((await run('profile-append', { origin: b, line: '乙的偏好' })).body.exitCode).toBe(0);
  expect(readFileSync(join(self, 'persona', 'profile.md'), 'utf8')).toContain('- 乙的偏好');
  // dismiss one; promote one that never had a suggestion
  expect((await run('candidate-dismiss', { origin: c })).body.exitCode).toBe(0);
  expect((await run('card-create', { id: 'knowledge/from-d', title: '丁', body: '丁', origin: d })).body.exitCode).toBe(0);
  records = await read();
  expect(records.find((r) => r.key === a)).toMatchObject({ promotedTo: 'rule/from-a' });
  expect(records.find((r) => r.key === a)?.candidate).toBeUndefined();
  expect(records.find((r) => r.key === b)).toMatchObject({ promotedTo: 'profile' });
  expect(records.find((r) => r.key === b)?.candidate).toBeUndefined();
  expect(records.find((r) => r.key === c)?.candidate).toBeUndefined();
  expect(records.find((r) => r.key === c)?.promotedTo).toBeUndefined();
  expect(records.find((r) => r.key === d)).toMatchObject({ promotedTo: 'knowledge/from-d' });
  // none of the four comes back to distill, and neither do Butler's own memory decisions
  const out = spawnSync(PYTHON, [join(root, 'faculties', 'journal', 'bin', 'distill'), '--json'], { env: { PATH: process.env.PATH ?? '', BUTLER_SELF_ROOT: self }, encoding: 'utf8' });
  expect(JSON.parse(out.stdout).records).toEqual([]);
  // a bad handle is refused by the manifest before the faculty runs
  expect((await run('candidate-dismiss', { origin: '../x' })).status).toBe(400);
});
