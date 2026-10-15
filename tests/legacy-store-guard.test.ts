import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PYTHON = process.env.BUTLER_TEST_PYTHON ?? '/Users/ghost/MySpace/.venv/bin/python';
const SKELETON = join(import.meta.dir, '..', 'skeleton');
let root = '';
let self = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'butler-legacy-store-'));
  cpSync(SKELETON, root, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  self = join(root, 'self');
  writeFileSync(join(self, 'persona', 'profile.md'), '# Profile\n旧画像\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(script: string, args: string[], input = '') {
  const result = spawnSync(PYTHON, [join(root, 'faculties', 'journal', 'bin', script), ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', BUTLER_SELF_ROOT: self, PYTHONDONTWRITEBYTECODE: '1' },
    input, encoding: 'utf8', timeout: 30_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const marker = () => join(self, 'etc', 'knowledge-store.json');
const card = () => join(self, 'knowledge', 'card.md');

test('missing marker preserves legacy writes and reads', () => {
  expect(run('memory', ['card-create', 'knowledge/card', '--title', '旧 CLI'], '知识正文').code).toBe(0);
  expect(readFileSync(card(), 'utf8')).toContain('知识正文');
  expect(run('card', ['knowledge/card']).code).toBe(0);
  expect(existsSync(marker())).toBe(false);
});

test('wiki mode blocks formal memory and proposal writes without changing bytes', () => {
  writeFileSync(card(), 'unchanged card bytes\n');
  writeFileSync(join(self, 'persona', 'profile.md'), 'unchanged profile bytes\n');
  writeFileSync(marker(), JSON.stringify({ version: 1, active: 'wiki' }));
  const cardBefore = readFileSync(card());
  const profileBefore = readFileSync(join(self, 'persona', 'profile.md'));
  const create = run('memory', ['card-create', 'knowledge/new', '--title', '新'], '新内容');
  expect(create.code).not.toBe(0);
  expect(create.err).toContain('Wiki');
  expect(existsSync(join(self, 'knowledge', 'new.md'))).toBe(false);
  expect(run('memory', ['card-update', 'knowledge/card', '--title', '改'], '替换').code).not.toBe(0);
  expect(run('memory', ['card-delete', 'knowledge/card']).code).not.toBe(0);
  expect(run('memory', ['card-order', 'knowledge'], 'card').code).not.toBe(0);
  expect(run('memory', ['profile-set'], '画像变更').code).not.toBe(0);
  expect(run('memory', ['profile-append'], '追加画像').code).not.toBe(0);
  expect(readFileSync(card())).toEqual(cardBefore);
  expect(readFileSync(join(self, 'persona', 'profile.md'))).toEqual(profileBefore);

  const add = run('proposals', ['add', '--kind', 'rule', '--title', '新规则', '--slug', 'new-rule', '--json'], '正文');
  expect(add.code).toBe(0); // proposals remain available
  const id = JSON.parse(add.out).id as string;
  const beforeProposals = readFileSync(join(self, 'proposals.jsonl'));
  const apply = run('proposals', ['apply', id, '--confirmed']);
  expect(apply.code).not.toBe(0);
  expect(apply.err).toContain('Wiki');
  expect(readFileSync(join(self, 'proposals.jsonl'))).toEqual(beforeProposals);
  expect(existsSync(join(self, 'rules', 'new-rule.md'))).toBe(false);

  const fact = run('proposals', ['add', '--kind', 'fact', '--title', '观察', '--json'], '候选事实');
  const factId = JSON.parse(fact.out).id as string;
  expect(run('proposals', ['apply', factId, '--confirmed']).code).toBe(0); // journal fact is not a personal card write
});

test('corrupt or unknown marker rejects formal writes but keeps candidate and read paths usable', () => {
  writeFileSync(marker(), '{broken');
  const refused = run('memory', ['card-create', 'knowledge/nope', '--title', '拒绝'], '正文');
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain('损坏');
  expect(existsSync(join(self, 'knowledge', 'nope.md'))).toBe(false);
  writeFileSync(join(self, 'journal', 'JOURNAL.jsonl'), JSON.stringify({ ts: '2026-10-01T00:00:00Z', source: 'dsh', type: 'note', text: '线索' }) + '\n');
  expect(run('distill', ['--json']).code).toBe(0);
  expect(run('memory', ['candidate-mark', 'journal:2026-10-01T00:00:00Z:dsh', '--to', 'knowledge', '--reason', '保留线索']).code).toBe(0);
  expect(run('memory', ['candidate-dismiss', 'journal:2026-10-01T00:00:00Z:dsh']).code).toBe(0);
  writeFileSync(marker(), JSON.stringify({ version: 1, active: 'something-else' }));
  expect(run('memory', ['profile-set'], 'x').code).not.toBe(0);

  writeFileSync(marker(), JSON.stringify({ version: 1, active: 'wiki' }));
  writeFileSync(join(self, 'persona', 'iron-card.md'), '1. **old**：body\n');
  const ironBefore = readFileSync(join(self, 'persona', 'iron-card.md'));
  const migration = run('migrate-rules', []);
  expect(migration.code).not.toBe(0);
  expect(migration.err).toContain('Wiki');
  expect(readFileSync(join(self, 'persona', 'iron-card.md'))).toEqual(ironBefore);
  expect(existsSync(join(self, 'rules', 'rule-1.md'))).toBe(false);
});
