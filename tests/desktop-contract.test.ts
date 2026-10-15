import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const executable = process.env.BUTLER_ELECTRON ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
// Electron's asar reader is needed: the desktop distribution omits .d.ts files.
test.skipIf(!existsSync(executable))('actual desktop package retains subprocess and webServer runtime seams', () => {
  const code = `
    const fs = require('fs');
    const root = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/';
    const result = {};
    for (const name of ['dsh-subprocess', 'dsh-subprocess-local', 'dsh-host-webserver']) {
      result[name] = { version: JSON.parse(fs.readFileSync(root + name + '/package.json')).version,
        code: fs.readFileSync(root + name + '/lib/index.js', 'utf8') };
    }
    console.log(JSON.stringify(result));
  `;
  const result = spawnSync(executable, ['--expose-internals', '-e', code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15000,
  });
  expect(result.status).toBe(0);
  const packages = JSON.parse(result.stdout);
  expect(packages['dsh-subprocess'].code).toContain('super(ctx, "subprocess")');
  const local = packages['dsh-subprocess-local'].code;
  for (const marker of ['spawn(spec)', 'handle.terminate()', 'handle.waitForExit()', 'handle.done.catch', 'disposeManagedProcesses()']) expect(local).toContain(marker);
  const web = packages['dsh-host-webserver'].code;
  for (const marker of ['register(route)', 'route.kind === "exact"', 'this.exact.get(pathname)', '!pathname.startsWith(`${prefix}/`)']) expect(web).toContain(marker);
});
