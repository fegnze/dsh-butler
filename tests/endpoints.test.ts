import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every run is isolated: HOME, self root and instance root all point into a
// fresh temp directory, so no real ~/.claude, ~/.codex, ~/.workbuddy or git
// hooks are ever touched.
const PYTHON = process.env.BUTLER_TEST_PYTHON ?? '/Users/ghost/MySpace/.venv/bin/python';
const SKELETON = join(import.meta.dir, '..', 'skeleton');

type Status = { id: string; installed: boolean; version: number | null; status: string; errors: string[]; lastCheck: string };

let root = '';
let inst = '';
let home = '';
let env: Record<string, string> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'butler-endpoints-'));
  inst = join(root, 'inst');
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  cpSync(SKELETON, inst, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: tmpdir(),
    HOME: home,
    BUTLER_SELF_ROOT: join(inst, 'self'),
    BUTLER_INSTANCE_ROOT: inst,
    PYTHONDONTWRITEBYTECODE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Butler Test',
    GIT_AUTHOR_EMAIL: 'butler@example.invalid',
    GIT_COMMITTER_NAME: 'Butler Test',
    GIT_COMMITTER_EMAIL: 'butler@example.invalid',
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function bin(name: string) {
  return join(inst, 'faculties', 'journal', 'bin', name);
}

function py(script: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(PYTHON, [bin(script), ...args], { env, input: input ?? '', encoding: 'utf8', timeout: 60_000 });
}

function install(args: string[]): SpawnSyncReturns<string> {
  return py('install', args);
}

function status(args: string[]): Status {
  const result = install([...args, '--json']);
  expect(result.stdout.trim()).not.toBe('');
  return JSON.parse(result.stdout) as Status;
}

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function spool(source: string): Array<Record<string, unknown>> {
  const path = join(inst, 'self', 'spool', `${source}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function registry(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(inst, 'self', 'etc', 'endpoints.json'), 'utf8')) as Record<string, unknown>;
}

function writeRegistry(value: unknown) {
  writeFileSync(join(inst, 'self', 'etc', 'endpoints.json'), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

const NOWLEDGE = 'nmem-hook stop --source nowledge';
const CLAUDE_SETTINGS = `{
    "env": { "ANTHROPIC_API_KEY": "sk-test-secret-do-not-touch" },
    "model": "opus",
    "hooks": {
        "Stop": [{"hooks": [{"command": "${NOWLEDGE}", "type": "command", "timeout": 15}], "matcher": ".*"}],
        "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo pre"}]}]
    },
    "permissions": {"allow": ["Bash(ls:*)"]}
}`;
const CODEX_HOOKS = `{"hooks":{"Stop":[{"hooks":[{"command":"${NOWLEDGE}","type":"command","timeout":15}],"matcher":".*"}]}}\n`;
const CLAUDE_RULES = '# 我的全局规则\n\n- 用户自己的内容\n';
const CODEX_RULES = 'codex rules without trailing newline';

function agentFiles(id: 'claude' | 'codex') {
  return id === 'claude'
    ? { dir: join(home, '.claude'), rules: join(home, '.claude', 'CLAUDE.md'), hooks: join(home, '.claude', 'settings.json'), rulesText: CLAUDE_RULES, hooksText: CLAUDE_SETTINGS }
    : { dir: join(home, '.codex'), rules: join(home, '.codex', 'AGENTS.md'), hooks: join(home, '.codex', 'hooks.json'), rulesText: CODEX_RULES, hooksText: CODEX_HOOKS };
}

function stopCommands(path: string): string[] {
  const data = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> } };
  return (data.hooks?.Stop ?? []).flatMap((group) => (group.hooks ?? []).map((hook) => hook.command ?? ''));
}

describe('claude/codex endpoints', () => {
  for (const id of ['claude', 'codex'] as const) {
    test(`${id}: install → check → idempotent → uninstall restores exact bytes`, () => {
      const files = agentFiles(id);
      mkdirSync(files.dir, { recursive: true });
      writeFileSync(files.rules, files.rulesText);
      writeFileSync(files.hooks, files.hooksText);
      chmodSync(files.hooks, 0o600);

      const first = install(['--target', id, '--json']);
      expect(first.status).toBe(0);
      expect((JSON.parse(first.stdout) as Status).status).toBe('ok');

      const rules = readFileSync(files.rules, 'utf8');
      expect(rules.startsWith(files.rulesText)).toBe(true);
      expect(rules).toMatch(/<!-- butler:begin v\d+ -->[\s\S]*<!-- butler:end -->/);
      const commands = stopCommands(files.hooks);
      expect(commands).toContain(NOWLEDGE);
      const owned = commands.filter((command) => command.includes('hook-intake'));
      expect(owned).toHaveLength(1);
      expect(owned[0]).toContain(`--source ${id}`);
      expect(owned[0].trimEnd().endsWith('|| true')).toBe(true);
      expect(statSync(files.hooks).mode & 0o777).toBe(0o600);
      if (id === 'claude') {
        const settings = JSON.parse(readFileSync(files.hooks, 'utf8')) as Record<string, any>;
        expect(settings.env.ANTHROPIC_API_KEY).toBe('sk-test-secret-do-not-touch');
        expect(settings.hooks.PreToolUse).toHaveLength(1);
        expect(settings.permissions.allow).toEqual(['Bash(ls:*)']);
      }
      expect(readdirSync(join(inst, '.state', 'endpoint-backups')).length).toBeGreaterThan(0);

      const check = status(['--target', id, '--check']);
      expect(check).toMatchObject({ id, installed: true, status: 'ok', errors: [] });
      expect(typeof check.version).toBe('number');
      expect(typeof check.lastCheck).toBe('string');

      const rulesAfter = readFileSync(files.rules);
      const hooksAfter = readFileSync(files.hooks);
      expect(install(['--target', id]).status).toBe(0);
      expect(readFileSync(files.rules).equals(rulesAfter)).toBe(true);
      expect(readFileSync(files.hooks).equals(hooksAfter)).toBe(true);

      const removed = install(['--target', id, '--uninstall', '--json']);
      expect(removed.status).toBe(0);
      expect((JSON.parse(removed.stdout) as Status).status).toBe('missing');
      expect(readFileSync(files.rules, 'utf8')).toBe(files.rulesText);
      expect(readFileSync(files.hooks, 'utf8')).toBe(files.hooksText);
      expect(statSync(files.hooks).mode & 0o777).toBe(0o600);

      expect(install(['--target', id, '--uninstall']).status).toBe(0);
      expect(readFileSync(files.rules, 'utf8')).toBe(files.rulesText);
      expect(readFileSync(files.hooks, 'utf8')).toBe(files.hooksText);
      expect(status(['--target', id, '--check']).status).toBe('missing');
    });
  }

  test('uninstall without any files creates nothing; install into empty home and uninstall leaves nothing', () => {
    expect(install(['--target', 'claude', '--uninstall']).status).toBe(0);
    expect(existsSync(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);

    expect(install(['--target', 'codex']).status).toBe(0);
    expect(existsSync(join(home, '.codex', 'AGENTS.md'))).toBe(true);
    expect(stopCommands(join(home, '.codex', 'hooks.json'))).toHaveLength(1);
    expect(install(['--target', 'codex', '--uninstall']).status).toBe(0);
    expect(existsSync(join(home, '.codex', 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);
    expect(install(['--target', 'codex', '--uninstall']).status).toBe(0);
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);
  });

  test('upgrades a legacy v2 block in place and keeps surrounding text', () => {
    const files = agentFiles('claude');
    mkdirSync(files.dir, { recursive: true });
    const before = '# head\n\n';
    const after = '\n## tail section\nkeep me\n';
    writeFileSync(files.rules, `${before}<!-- butler:begin v2 -->\nold port text\n<!-- butler:end -->\n${after}`);
    writeRegistry({ version: 1, targets: { claude: { kind: 'marker-block', path: '~/.claude/CLAUDE.md', driver: 'drivers/claude-block.md', endpoint_version: 2, installed: { version: 2, ts: '2026-09-22T16:56:05Z' } } } });

    expect(status(['--target', 'claude', '--check']).status).toBe('legacy');
    expect(install(['--target', 'claude']).status).toBe(0);
    const text = readFileSync(files.rules, 'utf8');
    expect(text).not.toContain('v2 -->');
    expect(text).not.toContain('old port text');
    expect(text.startsWith(before)).toBe(true);
    expect(text.endsWith(after)).toBe(true);
    expect(text.match(/butler:begin/g)).toHaveLength(1);
    expect(status(['--target', 'claude', '--check']).status).toBe('ok');

    expect(install(['--target', 'claude', '--uninstall']).status).toBe(0);
    const removed = readFileSync(files.rules, 'utf8');
    expect(removed).not.toContain('butler:');
    expect(removed).toContain('# head');
    expect(removed).toContain('keep me');
  });

  test('incomplete marker is refused with zero writes', () => {
    const files = agentFiles('claude');
    mkdirSync(files.dir, { recursive: true });
    const broken = '# rules\n<!-- butler:begin v2 -->\nno end marker\n';
    writeFileSync(files.rules, broken);
    writeFileSync(files.hooks, CLAUDE_SETTINGS);
    const registryBefore = readFileSync(join(inst, 'self', 'etc', 'endpoints.json'), 'utf8');

    const result = install(['--target', 'claude']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/marker/i);
    expect(readFileSync(files.rules, 'utf8')).toBe(broken);
    expect(readFileSync(files.hooks, 'utf8')).toBe(CLAUDE_SETTINGS);
    expect(readFileSync(join(inst, 'self', 'etc', 'endpoints.json'), 'utf8')).toBe(registryBefore);
    expect(install(['--target', 'claude', '--uninstall']).status).toBe(1);
    expect(readFileSync(files.rules, 'utf8')).toBe(broken);
    expect(status(['--target', 'claude', '--check']).status).toBe('fail');
  });

  test('corrupt hook JSON fails install and leaves the rules file untouched', () => {
    const files = agentFiles('codex');
    mkdirSync(files.dir, { recursive: true });
    writeFileSync(files.rules, CODEX_RULES);
    writeFileSync(files.hooks, '{"hooks": {"Stop": [ broken');
    const result = install(['--target', 'codex']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/JSON/);
    expect(readFileSync(files.rules, 'utf8')).toBe(CODEX_RULES);
    expect(readFileSync(files.hooks, 'utf8')).toBe('{"hooks": {"Stop": [ broken');
    expect(existsSync(join(inst, '.state', 'endpoint-backups'))).toBe(false);
    expect((registry().targets as Record<string, unknown>).codex).toBeUndefined();
  });

  test('a failing second write rolls back the first file', () => {
    const files = agentFiles('codex');
    mkdirSync(files.dir, { recursive: true });
    writeFileSync(files.rules, CODEX_RULES);
    const locked = join(root, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'hooks.json'), CODEX_HOOKS);
    chmodSync(locked, 0o500);
    const config = JSON.parse(readFileSync(join(inst, 'butler.json'), 'utf8')) as Record<string, any>;
    config.endpoints = { codex: { hookPath: join(locked, 'hooks.json') } };
    writeFileSync(join(inst, 'butler.json'), JSON.stringify(config));
    try {
      const result = install(['--target', 'codex']);
      expect(result.status).toBe(1);
      expect(readFileSync(files.rules, 'utf8')).toBe(CODEX_RULES);
      expect(readFileSync(join(locked, 'hooks.json'), 'utf8')).toBe(CODEX_HOOKS);
      expect((registry().targets as Record<string, unknown>).codex).toBeUndefined();
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test('check reports fail when the Stop hook is removed by hand', () => {
    expect(install(['--target', 'claude']).status).toBe(0);
    writeFileSync(join(home, '.claude', 'settings.json'), '{"hooks": {"Stop": []}}\n');
    const check = install(['--target', 'claude', '--check', '--json']);
    expect(check.status).toBe(1);
    const parsed = JSON.parse(check.stdout) as Status;
    expect(parsed.status).toBe('fail');
    expect(parsed.errors.join(' ')).toMatch(/Stop/);
  });
});

describe('hook-intake', () => {
  test('valid payload writes exactly one session observation', () => {
    const payload = JSON.stringify({ session_id: 'abc-123', transcript_path: '/tmp/t/abc.jsonl', cwd: '/work/proj', hook_event_name: 'Stop' });
    const result = py('hook-intake', ['--source', 'claude'], payload);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const records = spool('claude');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: 'claude', type: 'session', ref: '/tmp/t/abc.jsonl', sessionId: 'abc-123', workspace: '/work/proj' });
    expect(String(records[0].text)).toContain('claude');
    expect(String(records[0].text)).toContain('/work/proj');
  });

  test('invalid JSON, non-object payload and missing transcript_path are rejected without writes', () => {
    for (const input of ['not json', '[1,2]', '{"session_id":"x"}', '{"transcript_path":""}', '']) {
      const result = py('hook-intake', ['--source', 'codex'], input);
      expect(result.status).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    expect(spool('codex')).toHaveLength(0);
  });

  test('illegal source is refused', () => {
    for (const source of ['Claude', 'a/b', '../x', '', 'a b']) {
      const result = py('hook-intake', ['--source', source], '{"transcript_path":"/tmp/x"}');
      expect(result.status).not.toBe(0);
    }
    expect(existsSync(join(inst, 'self', 'spool')) ? readdirSync(join(inst, 'self', 'spool')).filter((name) => name.endsWith('.jsonl')) : []).toEqual([]);
  });
});

describe('workbuddy endpoint', () => {
  const skill = () => join(home, '.workbuddy', 'skills', 'butler-port', 'SKILL.md');

  test('install, check, tamper → fail, tampered uninstall refused, clean uninstall', () => {
    const legacy = join(home, '.workbuddy', 'skills', 'myspace-port');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'SKILL.md'), 'legacy skill\n');
    expect(status(['--target', 'workbuddy', '--check']).status).toBe('legacy');

    expect(install(['--target', 'workbuddy']).status).toBe(0);
    expect(readFileSync(skill(), 'utf8')).toContain('name: butler-port');
    const installed = ((registry().targets as Record<string, any>).workbuddy).installed;
    expect(installed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(status(['--target', 'workbuddy', '--check']).status).toBe('ok');
    const bytes = readFileSync(skill());
    expect(install(['--target', 'workbuddy']).status).toBe(0);
    expect(readFileSync(skill()).equals(bytes)).toBe(true);

    writeFileSync(skill(), `${bytes.toString('utf8')}\nuser edit\n`);
    expect(status(['--target', 'workbuddy', '--check']).status).toBe('fail');
    const refused = install(['--target', 'workbuddy', '--uninstall']);
    expect(refused.status).toBe(1);
    expect(existsSync(skill())).toBe(true);

    writeFileSync(skill(), bytes);
    expect(install(['--target', 'workbuddy', '--uninstall']).status).toBe(0);
    expect(existsSync(skill())).toBe(false);
    expect(readFileSync(join(legacy, 'SKILL.md'), 'utf8')).toBe('legacy skill\n');
    expect(install(['--target', 'workbuddy', '--uninstall']).status).toBe(0);
    expect(existsSync(skill())).toBe(false);
  });

  test('refuses to overwrite a foreign butler-port skill', () => {
    mkdirSync(join(home, '.workbuddy', 'skills', 'butler-port'), { recursive: true });
    writeFileSync(skill(), '---\nname: butler-port\n---\nsomeone else\n');
    const result = install(['--target', 'workbuddy']);
    expect(result.status).toBe(1);
    expect(readFileSync(skill(), 'utf8')).toBe('---\nname: butler-port\n---\nsomeone else\n');
  });
});

describe('git endpoint', () => {
  function makeRepo(name: string) {
    const repo = join(root, name);
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    return repo;
  }

  function configureRepos(repos: string[]) {
    const config = JSON.parse(readFileSync(join(inst, 'butler.json'), 'utf8')) as Record<string, any>;
    config.endpoints = { ...(config.endpoints ?? {}), git: { repos } };
    writeFileSync(join(inst, 'butler.json'), JSON.stringify(config, null, 2));
  }

  test('plain repo + core.hooksPath repo with user hook; commit observed; uninstall restores', () => {
    const plain = makeRepo('plain');
    const custom = makeRepo('custom');
    git(custom, ['config', 'core.hooksPath', '.githooks']);
    const customHooks = join(custom, '.githooks');
    mkdirSync(customHooks);
    const userHook = '#!/bin/sh\necho user-post-commit > "$(git rev-parse --show-toplevel)/user-hook-ran"\n';
    writeFileSync(join(customHooks, 'post-commit'), userHook);
    chmodSync(join(customHooks, 'post-commit'), 0o750);
    configureRepos([plain, custom]);

    const result = install(['--target', 'git', '--json']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as Status).status).toBe('ok');

    const plainHook = join(plain, '.git', 'hooks', 'post-commit');
    expect(readFileSync(plainHook, 'utf8')).toMatch(/^#!\/bin\/sh\n[\s\S]*# butler:begin[\s\S]*--source git[\s\S]*# butler:end/);
    expect(statSync(plainHook).mode & 0o111).not.toBe(0);
    const customText = readFileSync(join(customHooks, 'post-commit'), 'utf8');
    expect(customText).toContain('echo user-post-commit');
    expect(customText).toContain('# butler:begin');
    expect(statSync(join(customHooks, 'post-commit')).mode & 0o777).toBe(0o750);
    expect(existsSync(join(custom, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(status(['--target', 'git', '--check']).status).toBe('ok');

    const bytes = readFileSync(plainHook);
    expect(install(['--target', 'git']).status).toBe(0);
    expect(readFileSync(plainHook).equals(bytes)).toBe(true);

    writeFileSync(join(custom, 'a.txt'), 'hello\n');
    git(custom, ['add', 'a.txt']);
    git(custom, ['commit', '-q', '-m', 'first butler commit']);
    const sha = git(custom, ['rev-parse', 'HEAD']);
    expect(existsSync(join(custom, 'user-hook-ran'))).toBe(true);
    const records = spool('git');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: 'git', type: 'note' });
    expect(String(records[0].ref)).toBe(`git://${git(custom, ['rev-parse', '--show-toplevel'])}@${sha}`);
    expect(String(records[0].text)).toContain('first butler commit');

    expect(install(['--target', 'git', '--uninstall']).status).toBe(0);
    expect(existsSync(plainHook)).toBe(false);
    expect(readFileSync(join(customHooks, 'post-commit'), 'utf8')).toBe(userHook);
    expect(statSync(join(customHooks, 'post-commit')).mode & 0o777).toBe(0o750);
    expect(install(['--target', 'git', '--uninstall']).status).toBe(0);
    expect(existsSync(plainHook)).toBe(false);
    expect(status(['--target', 'git', '--check']).status).toBe('missing');
  });

  test('non-repository path is an error with zero writes', () => {
    const plain = makeRepo('ok-repo');
    const notRepo = join(root, 'not-a-repo');
    mkdirSync(notRepo);
    configureRepos([plain, notRepo]);
    const result = install(['--target', 'git']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/git/);
    expect(existsSync(join(plain, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  test('no configured repos is an error', () => {
    const result = install(['--target', 'git']);
    expect(result.status).toBe(1);
  });
});

describe('install CLI', () => {
  test('list and usage errors', () => {
    const list = install(['--list', '--json']);
    expect(list.status).toBe(0);
    const items = JSON.parse(list.stdout) as Status[];
    expect(items.map((item) => item.id)).toEqual(['claude', 'codex', 'workbuddy', 'git']);
    expect(items.every((item) => item.status === 'missing')).toBe(true);
    expect(install(['--list']).status).toBe(0);
    expect(install(['--target', 'nope']).status).toBe(2);
    expect(install(['--target']).status).toBe(2);
    expect(install(['--target', 'claude', '--check', '--uninstall']).status).toBe(2);
    expect(install(['--bogus']).status).toBe(2);
  });
});

describe('doctor', () => {
  function doctor() {
    const result = py('doctor', []);
    expect(result.stderr).not.toMatch(/Traceback/);
    return result;
  }

  test('empty registry: endpoints are INFO and exit 0', () => {
    writeRegistry({ version: 1, targets: {} });
    const result = doctor();
    expect(result.status).toBe(0);
    for (const id of ['claude', 'codex', 'workbuddy', 'git']) expect(result.stdout).toMatch(new RegExp(`^\\[INFO\\] 端点 ${id} `, 'm'));
    expect(result.stdout).toMatch(/spool/);
  });

  test('targets with missing fields and odd shapes do not crash', () => {
    for (const shape of [
      { version: 1, targets: { claude: {}, codex: { installed: {} }, workbuddy: 'x', git: { repos: 'nope', installed: { version: 3 } }, extra: null } },
      { version: 1, targets: [] },
      { targets: null },
      [],
      'not json at all {',
    ]) {
      writeRegistry(typeof shape === 'string' ? shape : JSON.stringify(shape));
      const result = doctor();
      expect([0, 1]).toContain(result.status ?? -1);
      expect(result.stdout).toMatch(/端点 claude/);
    }
  });

  test('legacy v1 registry with driver/path/kind entries reports WARN', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '<!-- butler:begin v2 -->\nold\n<!-- butler:end -->\n');
    writeRegistry({
      version: 1,
      targets: {
        workbuddy: { kind: 'skill-dir', path: '~/.workbuddy/skills/myspace-port', driver: 'drivers/workbuddy', endpoint_version: 2, installed: { version: 2, ts: '2026-09-22T16:56:05Z' } },
        claude: { kind: 'marker-block', path: '~/.claude/CLAUDE.md', driver: 'drivers/claude-block.md', endpoint_version: 2, installed: { version: 2, ts: '2026-09-22T16:56:05Z' } },
      },
    });
    const result = doctor();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\[WARN\] 端点 claude /m);
    expect(result.stdout).toMatch(/^\[WARN\] 端点 workbuddy /m);
    expect(result.stdout).toMatch(/^\[INFO\] 端点 git /m);
  });

  test('installed endpoint PASS, broken endpoint FAIL → exit 1', () => {
    expect(install(['--target', 'claude']).status).toBe(0);
    expect(doctor().stdout).toMatch(/^\[PASS\] 端点 claude /m);
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'block removed\n');
    const result = doctor();
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^\[FAIL\] 端点 claude /m);
  });
});
