import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromRaw } from '../src/host/config.ts';
import { createHosting, type HostEvent } from '../src/host/hosting.ts';
import { ServiceManager } from '../src/host/service-manager.ts';
import { Supervisor } from '../src/host/supervisor.ts';
import { createNodeSpawner } from './node-spawner.ts';

const spawner = createNodeSpawner();
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function tmp(): string { const root = mkdtempSync(join(tmpdir(), 'butler-l0-')); roots.push(root); return root; }
const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
};

test('supervisor reports an unexpected tool exit as an error observation, not a manual stop', async () => {
  const events: HostEvent[] = [];
  const supervisor = new Supervisor(spawner, tmp(), {}, (event) => events.push(event));
  supervisor.register({ id: 'crashy', name: 'Crashy', command: [process.execPath, '-e', 'process.exit(3)'] } as never);
  supervisor.start('crashy');
  await until(() => events.length > 0);
  supervisor.stop('crashy');
  expect(events[0]).toMatchObject({ type: 'error', subject: 'tool:crashy' });
  expect(events[0].text).toContain('crashy');
  expect(events[0].text).toContain('3');

  const quiet: HostEvent[] = [];
  const calm = new Supervisor(spawner, tmp(), {}, (event) => quiet.push(event));
  calm.register({ id: 'sleeper', name: 'Sleeper', command: [process.execPath, '-e', 'setInterval(()=>{},1000)'] } as never);
  calm.start('sleeper');
  await new Promise((resolve) => setTimeout(resolve, 100));
  calm.restart('sleeper');
  await new Promise((resolve) => setTimeout(resolve, 200));
  calm.stop('sleeper');
  await until(() => !calm.statusOf('sleeper').running);
  expect(quiet).toEqual([]);
});

test('service manager reports a crash but not a requested stop or restart', async () => {
  const events: HostEvent[] = [];
  const manager = new ServiceManager(spawner, {}, (event) => events.push(event));
  manager.register({ id: 'svc', name: 'Svc', command: 'exit 4', autoStart: false } as never);
  manager.start('svc');
  await until(() => events.length > 0);
  expect(events[0]).toMatchObject({ type: 'error', subject: 'service:svc' });

  const quiet: HostEvent[] = [];
  const calm = new ServiceManager(spawner, {}, (event) => quiet.push(event));
  calm.register({ id: 'long', name: 'Long', command: 'sleep 5', autoStart: false } as never);
  calm.start('long');
  await new Promise((resolve) => setTimeout(resolve, 300));
  calm.stop('long');
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(quiet).toEqual([]);
});

test('rescan reports added and removed extensions; the boot scan reports nothing', async () => {
  const root = tmp();
  writeFileSync(join(root, 'butler.json'), '{}');
  const addTool = (id: string) => {
    const dir = join(root, 'tools', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'butler.json'), JSON.stringify({ schemaVersion: 1, kind: 'tool', id, name: id }));
    return dir;
  };
  const kept = addTool('kept');
  const events: HostEvent[] = [];
  const hosting = await createHosting(fromRaw(root, {}), spawner, 'http://127.0.0.1:1/myspace-butler', (event) => events.push(event));
  expect(events).toEqual([]);
  addTool('fresh');
  rmSync(kept, { recursive: true });
  await hosting.rescan();
  expect(events.map((e) => [e.type, e.subject]).sort()).toEqual([['note', 'catalog:fresh'], ['note', 'catalog:kept']]);
  expect(events.find((e) => e.subject === 'catalog:fresh')?.text).toContain('新增');
  expect(events.find((e) => e.subject === 'catalog:kept')?.text).toContain('移除');
  await hosting.shutdown();
});

test('a throwing sink never breaks hosting', async () => {
  const supervisor = new Supervisor(spawner, tmp(), {}, () => { throw new Error('sink down'); });
  supervisor.register({ id: 'crashy', name: 'Crashy', command: [process.execPath, '-e', 'process.exit(1)'] } as never);
  supervisor.start('crashy');
  await until(() => supervisor.statusOf('crashy').restarts > 0);
  expect(supervisor.statusOf('crashy').restarts).toBe(1);
  supervisor.stop('crashy');
});
