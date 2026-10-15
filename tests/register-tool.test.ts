import { expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromRaw } from '../src/host/config.ts';
import { scanCatalog } from '../src/host/catalog.ts';
import { registerToolDir } from '../src/host/register-tool.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'butler-reg-'));
  await mkdir(join(root, 'tools'), { recursive: true });
  const outside = join(root, 'elsewhere', 'my-tool');
  await mkdir(outside, { recursive: true });
  return { root, outside, config: fromRaw(root, {}) };
}
const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, kind: 'tool', id: 'my-tool', name: 'My Tool', ...extra });

test('a directory outside tools/ is linked in and then discovered by the normal scan', async () => {
  const { root, outside, config } = await fixture();
  try {
    await writeFile(join(outside, 'butler.json'), manifest());
    const result = await registerToolDir(config, outside);
    expect(result).toEqual({ id: 'my-tool', name: 'My Tool', linked: true });
    const link = join(root, 'tools', 'my-tool');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(await realpath(outside));
    const scan = await scanCatalog(config);
    expect(scan.tools.map((t) => t.manifest.id)).toEqual(['my-tool']);
    // registering the same directory again is idempotent
    expect((await registerToolDir(config, outside)).linked).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a directory already under tools/ only needs a rescan', async () => {
  const { root, config } = await fixture();
  try {
    const inside = join(root, 'tools', 'my-tool');
    await mkdir(inside);
    await writeFile(join(inside, 'butler.json'), manifest());
    expect(await registerToolDir(config, inside)).toEqual({ id: 'my-tool', name: 'My Tool', linked: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses directories that are not a valid tool', async () => {
  const { root, outside, config } = await fixture();
  try {
    await expect(registerToolDir(config, outside)).rejects.toThrow('butler.json');
    await writeFile(join(outside, 'butler.json'), '{not json');
    await expect(registerToolDir(config, outside)).rejects.toThrow('JSON');
    await writeFile(join(outside, 'butler.json'), manifest({ kind: 'service', hosted: { command: 'x' } }));
    await expect(registerToolDir(config, outside)).rejects.toThrow('kind');
    await writeFile(join(outside, 'butler.json'), manifest({ id: '../x' }));
    await expect(registerToolDir(config, outside)).rejects.toThrow('id');
    await expect(registerToolDir(config, 'relative/path')).rejects.toThrow('绝对路径');
    // an existing, different tool with the same id is never overwritten
    await writeFile(join(outside, 'butler.json'), manifest());
    const other = join(root, 'tools', 'my-tool');
    await mkdir(other);
    await writeFile(join(other, 'butler.json'), manifest({ name: 'Other' }));
    await expect(registerToolDir(config, outside)).rejects.toThrow('已存在');
  } finally { await rm(root, { recursive: true, force: true }); }
});
