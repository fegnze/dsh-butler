import { expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import { createWikiContextLoader } from '../src/host/wiki-context.ts';
import { fromRaw } from '../src/host/config.ts';
import type { Spawner } from '../src/host/hosting.ts';

function fixture(items: unknown[]) {
  const spawner: Spawner = {
    spawn: () => ({
      pid: undefined, stdin: undefined,
      stdout: Readable.from([JSON.stringify({ ok: true, data: { items } })]), stderr: Readable.from([]),
      done: new Promise(resolve => setImmediate(() => resolve({ exitCode: 0, signal: null }))), terminate() {},
    }),
  };
  return createWikiContextLoader(fromRaw('/tmp/butler-wiki-context', { python: '/test/python' }), spawner);
}

test('Wiki context projects only active approved cards and stable versions', async () => {
  const load = fixture([
    { id: 'knowledge-a', kind: 'knowledge', revision: 1, title: 'A', summary: '概要', status: 'active', body: '全文不应注入' },
    { id: 'rule-b', kind: 'rule', revision: 2, title: 'B', summary: '旧', status: 'archived' },
    { id: 'rule-c', kind: 'rule', revision: 1, title: 'C', summary: '暂停', status: 'active', usable: false, validity: { state: 'suspended' } },
  ]);
  const value = await load();
  expect(value.text).toContain('knowledge-a');
  expect(value.text).not.toContain('rule-b');
  expect(value.text).not.toContain('rule-c');
  expect(value.text).not.toContain('全文不应注入');
  expect(value.text).toContain('不代表历史画像');
  expect((await load()).revision).toBe(value.revision);
  const changed = await fixture([{ id: 'knowledge-a', kind: 'knowledge', revision: 2, title: 'A', status: 'active' }])();
  expect(changed.revision).not.toBe(value.revision);
});

test('Empty Wiki is explicit; invalid index fails rather than inventing a profile', async () => {
  expect((await fixture([])()).text).toContain('暂无有效正式卡');
  await expect(fixture([{ title: 'missing-id' }])()).rejects.toThrow('identity');
});
