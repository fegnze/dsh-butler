import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real build-context / card / proposals / migrate-rules against a temp skeleton copy.
// Contract: every approved card is its own file; context.md carries the profile
// plus a one-line-per-card index, never the card bodies.
const PYTHON = process.env.BUTLER_TEST_PYTHON ?? '/Users/ghost/MySpace/.venv/bin/python';
let root = '';
let self = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'butler-context-'));
  cpSync(join(import.meta.dir, '..', 'skeleton'), root, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  self = join(root, 'self');
  writeFileSync(join(self, 'persona', 'profile.md'), '# 画像\n\n主人叫阿明，偏好中文。\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(script: string, args: string[], input = '') {
  const r = spawnSync(PYTHON, [join(root, 'faculties', 'journal', 'bin', script), ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', BUTLER_SELF_ROOT: self, PYTHONDONTWRITEBYTECODE: '1' },
    input, encoding: 'utf8', timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const contextFile = () => join(self, 'build', 'context.md');
function approve(args: string[], body: string) {
  const add = run('proposals', ['add', ...args, '--json'], body);
  expect(add.err).toBe('');
  expect(add.code).toBe(0);
  const id = JSON.parse(add.out).id as string;
  const ok = run('proposals', ['apply', id, '--confirmed']);
  expect(ok.err).toBe('');
  expect(ok.code).toBe(0);
  return id;
}

test('context.md is the profile plus an index of every card, never the card bodies', () => {
  approve(['--kind', 'rule', '--title', '外发需确认', '--slug', 'confirm-outbound', '--summary', '对外发送前先经主人确认'], '邮件、消息等对外动作发出前必须得到主人确认。');
  approve(['--kind', 'knowledge', '--title', '部署流程', '--slug', 'deploy-flow'], '# 部署流程\n\n先构建再推送镜像。\n\n细节很长很长。');
  writeFileSync(join(self, 'knowledge', 'hand-written.md'), '# 手写知识\n\n第一段就是摘要。\n');
  const r = run('build-context', ['--json']);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  const text = readFileSync(contextFile(), 'utf8');
  expect(text).toContain('主人叫阿明');
  expect(text).toContain('`rule/confirm-outbound` 外发需确认 — 对外发送前先经主人确认');
  // no --summary: the first prose line of the body becomes the summary
  expect(text).toContain('`knowledge/deploy-flow` 部署流程 — 先构建再推送镜像。');
  // a card without front matter still indexes from its heading and first line
  expect(text).toContain('`knowledge/hand-written` 手写知识 — 第一段就是摘要。');
  expect(text).not.toContain('必须得到主人确认');
  expect(text).not.toContain('细节很长');
  expect(text).not.toMatch(/铁律|iron/i);
  expect(text).toContain('本实例主人认可的工作约定，不替代当前会话适用的规则');
  expect(text).not.toMatch(/~\/MySpace|AGENTS\.md/);
  expect(text).toContain(`BUTLER_SELF_ROOT=${realpathSync(self)}`);
  expect(JSON.parse(r.out)).toMatchObject({ path: realpathSync(contextFile()), rules: 1, knowledge: 2, truncated: false });
});

test('card <id> reads exactly one card; --list returns the index; bad ids are usage errors', () => {
  approve(['--kind', 'rule', '--title', '精确暂存', '--slug', 'git-exact-add'], '`git add` 一律用精确路径。');
  const card = run('card', ['rule/git-exact-add']);
  expect(card.code).toBe(0);
  expect(card.out).toContain('`git add` 一律用精确路径。');
  expect(card.out).toContain('title: 精确暂存');
  const list = run('card', ['--list', '--json']);
  expect(list.code).toBe(0);
  expect(JSON.parse(list.out)).toEqual([{ id: 'rule/git-exact-add', title: '精确暂存', summary: '`git add` 一律用精确路径。' }]);
  expect(run('card', ['profile']).out).toContain('主人叫阿明');
  expect(run('card', ['rule/missing']).code).toBe(1);
  for (const bad of ['rule/../x', 'iron', 'secret/x', 'rule/Bad']) expect(run('card', [bad]).code).toBe(2);
  // no args: the compiled context (built on demand when absent)
  const all = run('card', []);
  expect(all.code).toBe(0);
  expect(all.out).toBe(readFileSync(contextFile(), 'utf8'));
});

test('applying a rule edit rewrites only that card and refreshes the index', () => {
  approve(['--kind', 'rule', '--title', '数据只经命令', '--slug', 'data-via-commands', '--summary', '旧摘要'], '一律经 `bin/` 命令读写。');
  approve(['--kind', 'rule', '--title', '数据只经命令', '--slug', 'data-via-commands', '--find', '`bin/`'], '`Butler/faculties/journal/bin/`');
  const text = readFileSync(join(self, 'rules', 'data-via-commands.md'), 'utf8');
  expect(text).toContain('一律经 `Butler/faculties/journal/bin/` 命令读写。');
  expect(text).toContain('summary: 旧摘要');
  expect(readFileSync(contextFile(), 'utf8')).toContain('`rule/data-via-commands` 数据只经命令 — 旧摘要');
});

test('the index is bounded; the profile is never cut', () => {
  for (let i = 0; i < 60; i += 1) {
    mkdirSync(join(self, 'knowledge'), { recursive: true });
    writeFileSync(join(self, 'knowledge', `k-${String(i).padStart(2, '0')}.md`), `# 知识 ${i}\n\n${'字'.repeat(150)}\n`);
  }
  const r = run('build-context', ['--max-chars', '2000', '--json']);
  expect(r.code).toBe(0);
  const text = readFileSync(contextFile(), 'utf8');
  expect(text.length).toBeLessThanOrEqual(2000);
  expect(text).toContain('主人叫阿明');
  expect(text).toMatch(/另有 \d+ 张未列出/);
  expect(JSON.parse(r.out).truncated).toBe(true);
});

test('missing profile fails without writing', () => {
  rmSync(join(self, 'persona', 'profile.md'));
  expect(run('build-context', []).code).toBe(1);
  expect(existsSync(contextFile())).toBe(false);
});

test('migrate-rules splits a legacy numbered card into one rule card each, once', () => {
  writeFileSync(join(self, 'persona', 'iron-card.md'), [
    '# 旧卡', '', '> 说明。', '',
    '1. **团队仓库不动共享规则**：`~/work/` 下共享文件',
    '   未经批准不改一行。',
    '2. **外发即签名**：对外动作发出前需确认。', '',
  ].join('\n'));
  const r = run('migrate-rules', ['--slugs', 'team-repo-readonly,confirm-outbound', '--json']);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ migrated: ['rule/team-repo-readonly', 'rule/confirm-outbound'] });
  expect(existsSync(join(self, 'persona', 'iron-card.md'))).toBe(false);
  const card = readFileSync(join(self, 'rules', 'team-repo-readonly.md'), 'utf8');
  expect(card).toContain('title: 团队仓库不动共享规则');
  expect(card).toContain('`~/work/` 下共享文件\n未经批准不改一行。');
  // a wrapped rule keeps its whole first paragraph as the summary
  expect(card).toContain('summary: `~/work/` 下共享文件 未经批准不改一行。');
  // migrated rules keep their original numbering order in the index
  const ctx = readFileSync(contextFile(), 'utf8');
  expect(ctx.indexOf('rule/team-repo-readonly')).toBeLessThan(ctx.indexOf('rule/confirm-outbound'));
  expect(readFileSync(contextFile(), 'utf8')).toContain('`rule/confirm-outbound` 外发即签名 — 对外动作发出前需确认。');
  const journal = readFileSync(join(self, 'journal', 'JOURNAL.jsonl'), 'utf8');
  expect(journal).toContain('migrate-rules');
  // second run: nothing left to migrate, nothing rewritten
  const again = run('migrate-rules', ['--json']);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.out).migrated).toEqual([]);
  // slug count mismatch refuses with zero writes
  writeFileSync(join(self, 'persona', 'iron-card.md'), '1. **a**：x\n2. **b**：y\n');
  expect(run('migrate-rules', ['--slugs', 'only-one']).code).toBe(2);
  expect(existsSync(join(self, 'rules', 'only-one.md'))).toBe(false);
});
