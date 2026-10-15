import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceManager } from '../src/host/service-manager.ts';
import { readOperations } from '../src/host/operations.ts';
import { Supervisor } from '../src/host/supervisor.ts';
import { createNodeSpawner } from './node-spawner.ts';

const spawner = createNodeSpawner();

test('operations catalogue exposes public capability metadata without commands or secrets', async () => {
  const supervisor = new Supervisor(spawner, mkdtempSync(join('/tmp', 'myspace-ops-')));
  supervisor.register({
    id: 'demo-tool', name: 'Demo Tool', description: 'fixture', command: ['/bin/echo', 'private-command'],
    actions: [{ label: '打开面板', url: 'http://127.0.0.1:1234/admin' }], autoStart: false,
  });
  const services = new ServiceManager(spawner);
  services.register({ id: 'demo-service', name: 'Demo Service', command: 'echo private', port: 39876, autoStart: false });
  const snapshot = await readOperations(supervisor, services);
  expect(snapshot.tools[0]).toMatchObject({ id: 'demo-tool', capabilityId: 'tool:demo-tool', running: false, health: 'none' });
  expect(snapshot.tools[0]).not.toHaveProperty('command');
  expect(snapshot.tools[0].actions).toEqual([{ index: 0, label: '打开面板', mode: 'panel' }]);
  expect(snapshot.services[0]).toMatchObject({ id: 'demo-service', capabilityId: 'service:demo-service', state: 'stopped' });
  expect(snapshot.services[0]).not.toHaveProperty('command');
  // Workflows are not a catalogue: they are observed runs (/runs), not things listed to click.
  expect(snapshot).not.toHaveProperty('workflows');
});
