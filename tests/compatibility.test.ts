import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

test('DSH compatibility stays exact and does not install another host', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../bun.lock', import.meta.url), 'utf8').replace(/,\s*([}\]])/g, '$1'));
  const range = '0.2.0-rc.2 || 0.2.1-rc.2';
  expect(pkg.engines.dsh).toBe(range);
  expect(pkg.peerDependencies['@deepseek-ai/dsh-app-boot']).toBe(range);
  expect(pkg.peerDependenciesMeta['@deepseek-ai/dsh-app-boot'].optional).toBe(true);
  expect(lock.workspaces[''].peerDependencies).toEqual(pkg.peerDependencies);
  expect(lock.workspaces[''].optionalPeers).toEqual(['@deepseek-ai/dsh-app-boot']);
});
