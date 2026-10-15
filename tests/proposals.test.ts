import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the real journal faculty commands against a temp copy of the skeleton.
const PYTHON = process.env.BUTLER_TEST_PYTHON ?? '/Users/ghost/MySpace/.venv/bin/python';
const SKELETON = join(import.meta.dir, '..', 'skeleton');
let root = '';
let self = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'butler-proposals-'));
  cpSync(SKELETON, root, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  self = join(root, 'self');
  mkdirSync(join(self, 'rules'), { recursive: true });
  writeFileSync(join(self, 'rules', 'tool-paths.md'), RULE);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(script: string, args: string[], input = '') {
  const result = spawnSync(PYTHON, [join(root, 'faculties', 'journal', 'bin', script), ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', BUTLER_SELF_ROOT: self, PYTHONDONTWRITEBYTECODE: '1' },
    input, encoding: 'utf8', timeout: 30_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const RULE = '---\ntitle: 工具路径\nsummary: 工具放在固定目录\n---\n\n1. 旧路径 `Tools/cli/x`。\n2. 其他。\n';
const rule = () => readFileSync(join(self, 'rules', 'tool-paths.md'), 'utf8');
const json = (r: { out: string }) => JSON.parse(r.out);
const lines = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const journal = () => lines(join(self, 'journal', 'JOURNAL.jsonl'));
function add(args: string[], body: string) {
  const r = run('proposals', ['add', ...args, '--json'], body);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  return json(r) as { id: string; status: string };
}

test('add validates kind/title/body and records a pending proposal', () => {
  const p = add(['--kind', 'rule', '--title', '修正第 1 条路径', '--slug', 'tool-paths', '--find', '旧路径 `Tools/cli/x`', '--evidence', 'dsh://s#1'], '新路径 `Butler/tools/x`');
  expect(p).toMatchObject({ status: 'pending', kind: 'rule', slug: 'tool-paths', title: '修正第 1 条路径', body: '新路径 `Butler/tools/x`', find: '旧路径 `Tools/cli/x`', evidence: ['dsh://s#1'] });
  expect(p.id).toMatch(/^p-[0-9a-z]+$/);
  expect(run('proposals', ['add', '--kind', 'weird', '--title', 't'], 'b').code).toBe(2);
  // the old name is gone, and a rule always names its card
  expect(run('proposals', ['add', '--kind', 'iron', '--title', 't', '--find', 'x'], 'b').code).toBe(2);
  expect(run('proposals', ['add', '--kind', 'rule', '--title', 't'], 'b').code).toBe(2);
  expect(run('proposals', ['add', '--kind', 'fact', '--title', ''], 'b').code).toBe(2);
  expect(run('proposals', ['add', '--kind', 'fact', '--title', 't'], '   ').code).toBe(2);
  expect(run('proposals', ['add', '--kind', 'knowledge', '--title', 't', '--slug', '../escape'], 'b').code).toBe(2);
  expect(json(run('proposals', ['list', '--json']))).toHaveLength(1);
});

test('apply requires --confirmed, edits one rule card in place and journals a decision', () => {
  const p = add(['--kind', 'rule', '--title', '修正路径', '--slug', 'tool-paths', '--find', '旧路径 `Tools/cli/x`'], '新路径 `Butler/tools/x`');
  const refused = run('proposals', ['apply', p.id]);
  expect(refused.code).toBe(2);
  expect(rule()).toContain('旧路径');
  const before = journal().length;
  const ok = run('proposals', ['apply', p.id, '--confirmed', '--json']);
  expect(ok.code).toBe(0);
  expect(json(ok)).toMatchObject({ id: p.id, status: 'applied' });
  expect(rule()).toBe(RULE.replace('旧路径 `Tools/cli/x`', '新路径 `Butler/tools/x`'));
  const decisions = journal().slice(before);
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ source: 'butler', type: 'decision', ref: `proposal://${p.id}` });
  // applying twice is refused, not repeated
  expect(run('proposals', ['apply', p.id, '--confirmed']).code).toBe(1);
  expect(journal().length).toBe(before + 1);
});

test('a stale find (text no longer present or ambiguous) fails with zero writes', () => {
  const p = add(['--kind', 'rule', '--title', 't', '--slug', 'tool-paths', '--find', '不存在的文本'], '新');
  const card = rule();
  const r = run('proposals', ['apply', p.id, '--confirmed']);
  expect(r.code).toBe(1);
  expect(r.err).toContain('find');
  expect(rule()).toBe(card);
  expect(json(run('proposals', ['list', '--json']))[0].status).toBe('pending');
  writeFileSync(join(self, 'persona', 'profile.md'), 'a X b X\n');
  const twice = add(['--kind', 'persona', '--title', 't', '--find', 'X'], 'Y');
  expect(run('proposals', ['apply', twice.id, '--confirmed']).code).toBe(1);
  expect(readFileSync(join(self, 'persona', 'profile.md'), 'utf8')).toBe('a X b X\n');
});

test('knowledge writes knowledge/<slug>.md, refuses to overwrite; fact journals; noise only closes', () => {
  const k = add(['--kind', 'knowledge', '--title', '部署流程', '--slug', 'deploy-flow'], '# 部署\n步骤');
  expect(run('proposals', ['apply', k.id, '--confirmed']).code).toBe(0);
  const card = readFileSync(join(self, 'knowledge', 'deploy-flow.md'), 'utf8');
  expect(card).toMatch(/^---\ntitle: 部署流程\nsummary: 步骤\nproposal: p-[0-9a-z]+\napprovedAt: \S+\n---\n\n# 部署\n步骤\n$/);
  const dup = add(['--kind', 'knowledge', '--title', '再来', '--slug', 'deploy-flow'], 'x');
  expect(run('proposals', ['apply', dup.id, '--confirmed']).code).toBe(1);
  expect(readFileSync(join(self, 'knowledge', 'deploy-flow.md'), 'utf8')).toBe(card);

  const f = add(['--kind', 'fact', '--title', '用户偏好'], '偏好中文');
  const before = journal().length;
  expect(run('proposals', ['apply', f.id, '--confirmed']).code).toBe(0);
  const added = journal().slice(before);
  expect(added.map((r) => r.type).sort()).toEqual(['decision', 'fact']);
  expect(added.find((r) => r.type === 'fact')?.text).toBe('偏好中文');

  const n = add(['--kind', 'noise', '--title', '无用'], '噪声');
  expect(run('proposals', ['apply', n.id, '--confirmed']).code).toBe(0);
});

test('reject needs no reason, closes the proposal and never touches the card', () => {
  const p = add(['--kind', 'rule', '--title', 't', '--slug', 'tool-paths', '--find', '旧路径 `Tools/cli/x`'], '新');
  const r = run('proposals', ['reject', p.id, '--json']);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(json(r)).toMatchObject({ status: 'rejected' });
  expect(json(r)).not.toHaveProperty('reason');
  // an optional reason is still recorded when given
  const q = add(['--kind', 'fact', '--title', 'f'], 'b');
  expect(json(run('proposals', ['reject', q.id, '--reason', '证据不足', '--json']))).toMatchObject({ status: 'rejected', reason: '证据不足' });
  expect(rule()).toContain('旧路径');
  expect(run('proposals', ['apply', p.id, '--confirmed']).code).toBe(1);
  expect(json(run('proposals', ['list', '--status', 'pending', '--json']))).toEqual([]);
  expect(run('proposals', ['reject', 'p-missing', '--reason', 'x']).code).toBe(1);
});

test('a corrupt proposals line is reported and preserved, not silently dropped', () => {
  add(['--kind', 'fact', '--title', 'ok'], 'b');
  const path = join(self, 'proposals.jsonl');
  writeFileSync(path, readFileSync(path, 'utf8') + '{broken\n');
  const r = run('proposals', ['list', '--json']);
  expect(r.code).toBe(0);
  expect(r.err).toContain('1');
  const p = add(['--kind', 'fact', '--title', 'two'], 'b');
  expect(run('proposals', ['reject', p.id, '--reason', 'x']).code).toBe(0);
  expect(readFileSync(path, 'utf8')).toContain('{broken');
});

test('distill prints journal material after the cursor and only --advance moves it', () => {
  const recs = [1, 2, 3].map((i) => JSON.stringify({ ts: `2026-10-0${i}T00:00:00Z`, source: 'dsh', type: 'note', text: `回合 ${i}` }));
  writeFileSync(join(self, 'journal', 'JOURNAL.jsonl'), recs.join('\n') + '\n');
  const first = json(run('distill', ['--json']));
  expect(first).toMatchObject({ from: 0, to: 3 });
  expect(first.records.map((r: { text: string }) => r.text)).toEqual(['回合 1', '回合 2', '回合 3']);
  expect(json(run('distill', ['--json'])).from).toBe(0);
  expect(run('distill', ['--advance', '2']).code).toBe(0);
  const next = json(run('distill', ['--json', '--limit', '5']));
  expect(next).toMatchObject({ from: 2, to: 3 });
  expect(next.records.map((r: { text: string }) => r.text)).toEqual(['回合 3']);
  expect(run('distill', ['--advance', '9']).code).toBe(2);
  expect(run('distill', ['--advance', '1']).code).toBe(2);
  const big = json(run('distill', ['--json', '--max-chars', '3']));
  expect(big.records[0].text.length).toBeLessThanOrEqual(3);
});

test('distill hands over observations only, and skips what is already marked or a commit or a session turn', () => {
  const rows = [
    { ts: '2026-10-01T00:00:00Z', source: 'codex', type: 'note', text: '观察 A' },
    { ts: '2026-10-02T00:00:00Z', source: 'git', type: 'note', tags: ['git-commit'], text: '提交' },
    { ts: '2026-10-03T00:00:00Z', source: 'dsh', type: 'session', text: '回合' },
    { ts: '2026-10-04T00:00:00Z', source: 'codex', type: 'note', text: '观察 B' },
  ];
  writeFileSync(join(self, 'journal', 'JOURNAL.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const first = json(run('distill', ['--json']));
  expect(first.to).toBe(4); // the cursor still passes the rows nobody reads
  expect(first.records.map((r: { text: string }) => r.text)).toEqual(['观察 A', '观察 B']);
  expect(first.records[0].key).toBe('journal:2026-10-01T00:00:00Z:codex');
  expect(run('memory', ['candidate-mark', first.records[0].key, '--to', 'rule', '--reason', '稳定约定']).code).toBe(0);
  expect(json(run('distill', ['--json'])).records.map((r: { text: string }) => r.text)).toEqual(['观察 B']);
});

test('report gather summarises facts; report write lands digest + outbox atomically', () => {
  writeFileSync(join(self, 'journal', 'JOURNAL.jsonl'), JSON.stringify({ ts: new Date().toISOString(), source: 'dsh', type: 'session', text: '今天' }) + '\n');
  add(['--kind', 'fact', '--title', '待决'], 'b');
  const g = json(run('report', ['gather', 'daily', '--json']));
  expect(g).toMatchObject({ kind: 'daily', pending: 1 });
  expect(g.journal).toHaveLength(1);
  expect(run('report', ['gather', 'monthly']).code).toBe(2);
  expect(run('report', ['write', 'daily'], '  ').code).toBe(2);
  const w = run('report', ['write', 'daily', '--date', '2026-10-10', '--json'], '# 日报\n内容');
  expect(w.code).toBe(0);
  expect(json(w)).toMatchObject({ name: 'daily-2026-10-10.md' });
  expect(readFileSync(join(self, 'digests', 'daily-2026-10-10.md'), 'utf8')).toBe('# 日报\n内容\n');
  expect(readFileSync(join(self, 'outbox', 'daily-2026-10-10.md'), 'utf8')).toBe('# 日报\n内容\n');
  expect(run('report', ['write', 'daily', '--date', '10/10'], 'x').code).toBe(2);
});

test('distill merges the spool first, so an observation just reported is not stuck behind a manual run', () => {
  writeFileSync(join(self, 'journal', 'JOURNAL.jsonl'), JSON.stringify({ ts: '2026-10-01T00:00:00Z', source: 'dsh', type: 'note', text: '旧' }) + '\n');
  expect(run('intake', ['--source', 'manual', '--type', 'fact', '--', '刚上报的一条']).code).toBe(0);
  expect(existsSync(join(self, 'spool', 'manual.jsonl'))).toBe(true);

  // --advance only moves the cursor: it must not merge behind the owner's back
  expect(run('distill', ['--advance', '0']).code).toBe(0);
  expect(existsSync(join(self, 'spool', 'manual.jsonl'))).toBe(true);
  expect(journal()).toHaveLength(1);

  const first = json(run('distill', ['--json']));
  expect(first.total).toBe(2);
  expect(first.records.map((r: { text: string }) => r.text)).toEqual(['旧', '刚上报的一条']);
  expect(existsSync(join(self, 'spool', 'manual.jsonl'))).toBe(false);
  expect(journal()).toHaveLength(2);
});
