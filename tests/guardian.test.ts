import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadButlerConfig, butlerEnv } from '../src/host/config.ts';
import { createNodeSpawner } from './node-spawner.ts';
import { scanCatalog, toServiceManifest, toToolManifest, resolveArgv } from '../src/host/catalog.ts';
import { ServiceManager } from '../src/host/service-manager.ts';
import { Supervisor } from '../src/host/supervisor.ts';

const spawner = createNodeSpawner();

function instance(): string {
  const root = mkdtempSync(join(tmpdir(), 'butler-inst-'));
  writeFileSync(join(root, 'butler.json'), JSON.stringify({ python: '.venv/bin/python', bun: '/opt/bun/bin/bun', notification: { enabled: true } }));
  return root;
}
function ext(root: string, kind: string, id: string, manifest: Record<string, unknown>) {
  const dir = join(root, kind, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'butler.json'), JSON.stringify({ schemaVersion: 1, kind: kind.replace(/s$|ies$/, (m) => (m === 'ies' ? 'y' : '')), id, name: id, ...manifest }));
  return dir;
}

test('butler.json resolves relative paths against the instance root and injects exec env', async () => {
  const root = instance();
  const config = await loadButlerConfig(join(root, 'butler.json'));
  expect(config.instanceRoot).toBe(root);
  expect(config.bun).toBe('/opt/bun/bin/bun');
  expect(config.scanRoots).toEqual([join(root, 'tools'), join(root, 'services'), join(root, 'faculties')]);
  expect(config.selfRoot).toBe(join(root, 'self'));
  expect(config.python).toBe(join(root, '.venv/bin/python'));
  const env = butlerEnv(config);
  expect(env.BUTLER_BUN).toBe('/opt/bun/bin/bun');
  expect(env.BUTLER_SELF_ROOT).toBe(join(root, 'self'));
  expect(env.BUTLER_PYTHON).toBe(join(root, '.venv/bin/python'));
  expect(env.BUTLER_SDK_PY.endsWith('/dsh-butler/sdk/py')).toBe(true);
  rmSync(root, { recursive: true });
});

test('catalog scan discovers every kind, rejects broken manifests and duplicate ids, ignores dirs without a manifest', async () => {
  const root = instance();
  const config = await loadButlerConfig(join(root, 'butler.json'));
  ext(root, 'tools', 'alpha', { hosted: { command: ['bun', 'src/cli.ts', 'serve'], port: 40001, autoStart: true }, panelUrl: 'http://127.0.0.1:40001/admin', panelSize: { width: 1200, height: 800 }, actions: [{ label: '开', url: 'http://127.0.0.1:40001/x' }] });
  ext(root, 'tools', 'pure', { actions: [{ label: '页', url: 'http://x/', mode: 'external' }] });
  ext(root, 'services', 'svc', { hosted: { command: 'npm run dev', cwd: '/tmp', port: 5174 } });
  ext(root, 'faculties', 'journal', { commands: [{ id: 'intake', exec: ['python', './bin/intake'], effect: 'write' }], reports: [{ id: 'doctor', name: 'D', exec: ['./bin/doctor', '--json'] }] });
  ext(root, 'services', 'nohost', {});                         // service 必须有 hosted
  ext(root, 'tools', 'dup', { id: 'alpha' });                  // id 重复
  mkdirSync(join(root, 'tools', 'plain-dir'), { recursive: true }); // 无清单
  writeFileSync(join(root, 'tools', 'plain-dir', 'README.md'), '');
  const dir = join(root, 'tools', 'broken'); mkdirSync(dir); writeFileSync(join(dir, 'butler.json'), '{ nope');

  const scan = await scanCatalog(config);
  expect(scan.tools.map((t) => t.manifest.id)).toEqual(['alpha', 'pure']);
  expect(scan.services.map((s) => s.manifest.id)).toEqual(['svc']);
  expect(scan.faculties.map((f) => f.manifest.id)).toEqual(['journal']);
  expect(scan.rejected.map((r) => r.reason)).toEqual(expect.arrayContaining([
    expect.stringContaining('不是合法 JSON'),
    expect.stringContaining('id 重复'),
    'service 必须有 hosted',
  ]));
  expect(scan.rejected).toHaveLength(3);

  // 翻译：hosted tool → Supervisor manifest；flow 型 action 不进 Supervisor 的 actions
  const alpha = toToolManifest(scan.tools[0], config)!;
  // 相对脚本路径保持相对：托管层以清单目录为 cwd 启动
  expect(alpha.command).toEqual(['/opt/bun/bin/bun', 'src/cli.ts', 'serve']);
  expect(alpha.cwd).toBe(join(root, 'tools/alpha'));
  expect(alpha.healthUrl).toBe('http://127.0.0.1:40001/health/live');
  expect(alpha.panelSize).toEqual({ width: 1200, height: 800 });
  expect(alpha.actions).toEqual([{ label: '开', title: undefined, url: 'http://127.0.0.1:40001/x' }]);
  expect(alpha.autoStart).toBe(true);
  const supervisor = new Supervisor(spawner, mkdtempSync(join(tmpdir(), 'msd-logs-')));
  supervisor.register(alpha);
  expect(supervisor.statusOf('alpha').panelSize).toEqual({ width: 1200, height: 800 });
  // 无 hosted 的 tool 不进 Supervisor
  expect(toToolManifest(scan.tools[1], config)).toBeNull();
  // service shell 字符串原样透传
  const svc = toServiceManifest(scan.services[0], config);
  expect(svc).toMatchObject({ id: 'svc', command: 'npm run dev', cwd: '/tmp', port: 5174, autoStart: false });
  // python → 实例解释器；相对脚本 → 清单目录
  expect(resolveArgv(scan.faculties[0].dir, ['python', './bin/intake'], config)).toEqual([join(root, '.venv/bin/python'), join(root, 'faculties/journal/bin/intake')]);
  expect(resolveArgv(scan.faculties[0].dir, ['./bin/doctor', '--json'], config)).toEqual([join(root, 'faculties/journal/bin/doctor'), '--json']);
  rmSync(root, { recursive: true });
});

test('service status exposes a configured local open path', async () => {
  const manager = new ServiceManager(spawner);
  manager.register({ id: 'skin', name: 'ChatGPT Skin', command: 'true', openPath: '~/Library/Application Support/ChatGPTSkin/theme', autoStart: false });
  expect((await manager.statusOf('skin')).openPath).toBe('~/Library/Application Support/ChatGPTSkin/theme');
});

test('supervisor starts, reports and stops a child process', async () => {
  const supervisor = new Supervisor(spawner, mkdtempSync(join(tmpdir(), 'msd-logs-')));
  supervisor.register({ id: 'sleeper', name: 'Sleeper', command: ['/bin/sleep', '30'], autoStart: false });
  const started = supervisor.start('sleeper');
  expect(started.running).toBe(true);
  expect(started.pid).toBeGreaterThan(0);
  supervisor.stop('sleeper');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stopped = supervisor.statusOf('sleeper');
  expect(stopped.running).toBe(false);
  expect(stopped.desired).toBe('stopped');
});

test('supervisor.unregister stops the child and forgets the tool', async () => {
  const supervisor = new Supervisor(spawner, mkdtempSync(join(tmpdir(), 'msd-logs-')));
  supervisor.register({ id: 'gone', name: 'Gone', command: ['/bin/sleep', '30'], autoStart: false });
  const pid = supervisor.start('gone').pid!;
  supervisor.unregister('gone');
  expect(supervisor.ids()).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(() => process.kill(pid, 0)).toThrow();
});

test('supervisor restarts a crashed tool while desired state is running', async () => {
  const supervisor = new Supervisor(spawner, mkdtempSync(join(tmpdir(), 'msd-logs-')));
  supervisor.register({ id: 'flaky', name: 'Flaky', command: ['/bin/sleep', '0.05'], autoStart: false });
  supervisor.start('flaky');
  await new Promise((resolve) => setTimeout(resolve, 2_600));
  const status = supervisor.statusOf('flaky');
  expect(status.restarts).toBeGreaterThanOrEqual(1);
  supervisor.shutdown();
});
