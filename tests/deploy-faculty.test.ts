import { afterAll, expect, test } from 'bun:test';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PYTHON = '/Users/ghost/MySpace/.venv/bin/python';
const plugin = join(import.meta.dir, '..');
const helper = join(plugin, 'deploy-faculty.py');
const temp = mkdtempSync(join(tmpdir(), 'deploy-faculty-'));
const sourceCopy = join(temp, 'source');
const instances = join(temp, 'instances');
mkdirSync(sourceCopy);
mkdirSync(instances);
// Keep fixture independent from concurrently developed production modules.
const fixturePipeline = join(sourceCopy, 'pipeline');
writeFileSync(fixturePipeline, '# test controlled source\nVALUE = 1\n');
for (const name of ['_legacy_guard.py', 'memory', 'proposals', 'migrate-rules']) {
  writeFileSync(join(sourceCopy, name), `# synthetic ${name}\nVALUE = 2\n`);
}
// CLI source stays fixed to the plugin skeleton; isolate tests in a copied checkout.
const testPlugin = join(temp, 'plugin');
mkdirSync(testPlugin);
cpSync(join(plugin, 'deploy-faculty.py'), join(testPlugin, 'deploy-faculty.py'));
mkdirSync(join(testPlugin, 'skeleton', 'faculties', 'journal', 'bin'), { recursive: true });
const testHelper = join(testPlugin, 'deploy-faculty.py');
const testBin = join(testPlugin, 'skeleton', 'faculties', 'journal', 'bin');
const testPipeline = join(testBin, 'pipeline');
for (const name of ['pipeline', '_legacy_guard.py', 'memory', 'proposals', 'migrate-rules']) {
  writeFileSync(join(testBin, name), readFileSync(join(sourceCopy, name)));
}
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function instance(name: string) {
  const root = join(instances, name);
  mkdirSync(join(root, 'faculties', 'journal', 'bin'), { recursive: true });
  writeFileSync(join(root, 'butler.json'), '{}\n');
  return root;
}
function run(root: string, apply = false, sourceAvailable = true) {
  const args = [testHelper, '--workdir', root, ...(apply ? ['--apply'] : [])];
  if (!sourceAvailable) rmSync(testPipeline, { force: true });
  const result = spawnSync(PYTHON, args, { encoding: 'utf8' });
  return { ...result, json: JSON.parse(result.stdout || '{}') };
}

test('dry-run makes zero changes; apply installs; repeat is idempotent', () => {
  const root = instance('normal');
  const before = lstatSync(join(root, 'faculties', 'journal', 'bin')).mtimeMs;
  const dry = run(root);
  expect(dry.status).toBe(0);
  expect(dry.json.mode).toBe('dry-run');
  expect(dry.json.counts.install).toBe(5);
  expect(existsSync(join(root, 'faculties', 'journal', 'bin', 'pipeline'))).toBe(false);
  expect(existsSync(join(root, '.state'))).toBe(false);
  expect(lstatSync(join(root, 'faculties', 'journal', 'bin')).mtimeMs).toBe(before);
  expect(run(root, true).status).toBe(0);
  expect(readFileSync(join(root, 'faculties', 'journal', 'bin', 'pipeline'), 'utf8')).toContain('VALUE = 1');
  expect(readFileSync(join(root, 'faculties', 'journal', 'bin', 'memory'), 'utf8')).toContain('VALUE = 2');
  const again = run(root);
  expect(again.status).toBe(0);
  expect(again.json.counts['skip-identical']).toBe(5);
});

test('rejects tampering and path escape', () => {
  const changed = instance('tampered');
  expect(run(changed, true).status).toBe(0);
  writeFileSync(join(changed, 'faculties', 'journal', 'bin', 'pipeline'), 'user change\n');
  const refused = run(changed);
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('目标冲突');

  const escaped = instance('escaped');
  const outside = join(instances, 'outside-bin');
  mkdirSync(outside);
  rmSync(join(escaped, 'faculties', 'journal', 'bin'), { recursive: true });
  symlinkSync(outside, join(escaped, 'faculties', 'journal', 'bin'));
  const traversal = run(escaped);
  expect(traversal.status).not.toBe(0);
  expect(traversal.stderr).toContain('符号链接');
});

test('rejects unknown legacy target changes', () => {
  const root = instance('unknown-legacy');
  writeFileSync(join(root, 'faculties', 'journal', 'bin', 'memory'), 'locally changed legacy\n');
  const result = run(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('目标冲突');
});

test('upgrades exact known legacy baseline target', () => {
  const root = instance('known-legacy');
  // KNOWN_LEGACY_HEAD_HASHES pins the last unguarded legacy scripts (the parent of aadc56a,
  // which replaced them with guarded versions); HEAD no longer holds that baseline.
  const head = spawnSync('git', ['show', 'aadc56a^:butler-plugin/skeleton/faculties/journal/bin/memory'], { encoding: 'utf8' });
  expect(head.status).toBe(0);
  writeFileSync(join(root, 'faculties', 'journal', 'bin', 'memory'), head.stdout);
  const result = run(root);
  expect(result.status).toBe(0);
  expect(result.json.counts['upgrade-known-legacy']).toBe(1);
  expect(run(root, true).status).toBe(0);
  expect(readFileSync(join(root, 'faculties', 'journal', 'bin', 'memory'), 'utf8')).toContain('VALUE = 2');
});

test('reports absent source pipeline instead of succeeding', () => {
  const root = instance('no-source');
  const result = run(root, false, false);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('暂无pipeline模块');
  expect(existsSync(join(root, '.state'))).toBe(false);
});
