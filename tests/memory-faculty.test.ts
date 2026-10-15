import { afterAll, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromRaw } from '../src/host/config.ts';
import { createHosting } from '../src/host/hosting.ts';
import { createButlerRouter } from '../src/host/routes.ts';
import { createNodeSpawner } from './node-spawner.ts';

const PYTHON = process.env.BUTLER_TEST_PYTHON ?? '/Users/ghost/MySpace/.venv/bin/python';
const root = mkdtempSync(join(tmpdir(), 'butler-memory-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('the memory page can write cards, the profile and observations only through faculty commands', async () => {
  cpSync(join(import.meta.dir, '..', 'skeleton'), root, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  const self = join(root, 'self');
  mkdirSync(join(self, 'persona'), { recursive: true });
  writeFileSync(join(self, 'persona', 'profile.md'), '# 画像\n\n旧画像\n');
  const hosting = await createHosting(fromRaw(root, { python: PYTHON, notification: { enabled: false } }), createNodeSpawner(), 'http://localhost/myspace-butler');
  const router = createButlerRouter(hosting);
  async function call(method: string, path: string, body?: unknown) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
    let status = 0;
    let text = '';
    const res = { writeHead(code: number) { status = code; }, end(value = '') { text += value; } } as unknown as ServerResponse;
    const url = new URL(path, 'http://localhost'); await router.handle(req, res, url.pathname, url);
    return { status, body: JSON.parse(text) };
  }
  const run = (id: string, args: Record<string, string>, confirmed = true) => call('POST', `/api/faculties/journal/commands/${id}`, { confirmed, args });

  // create: the body goes through stdin, so it may be multi-line and start with "-"
  const body = '- 第一条\n- 第二条\n\n含 `反引号` 和 --flag 的一行';
  expect((await run('card-create', { id: 'rule/demo-card', title: '示例规则', body }, false)).status).toBe(409);
  const created = await run('card-create', { id: 'rule/demo-card', title: '示例规则', summary: '一句话摘要', body });
  expect(created.status).toBe(200);
  expect(created.body.exitCode).toBe(0);
  const file = join(self, 'rules', 'demo-card.md');
  expect(readFileSync(file, 'utf8')).toContain(`---\ntitle: 示例规则\nsummary: 一句话摘要\n`);
  expect(readFileSync(file, 'utf8')).toContain(body);

  // a second create must not overwrite
  const again = await run('card-create', { id: 'rule/demo-card', title: '覆盖', body: 'x' });
  expect(again.body.exitCode).toBe(1);
  expect(readFileSync(file, 'utf8')).toContain('示例规则');

  // the Host reads it back with the body
  const memory = (await call('GET', '/api/butler?section=memory')).body;
  const card = memory.cards.find((c: { id: string }) => c.id === 'rule/demo-card');
  expect(card.title).toBe('示例规则');
  expect(card.body).toBe(body);
  expect(memory.profile).toContain('旧画像');

  // update keeps approvedAt; delete moves to trash, not into the void
  const approvedAt = /approvedAt: (.+)/.exec(readFileSync(file, 'utf8'))![1];
  expect((await run('card-update', { id: 'rule/demo-card', title: '改后标题', body: '新正文' })).body.exitCode).toBe(0);
  expect(readFileSync(file, 'utf8')).toContain(`approvedAt: ${approvedAt}`);
  expect(readFileSync(file, 'utf8')).toContain('title: 改后标题');
  expect((await run('card-update', { id: 'rule/nope', title: 't', body: 'b' })).body.exitCode).toBe(1);
  expect((await run('card-delete', { id: 'rule/demo-card' })).body.exitCode).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(readdirSync(join(self, 'trash')).some((n) => n.startsWith('rule-demo-card-'))).toBe(true);
  expect((await call('GET', '/api/butler?section=memory')).body.trash).toBe(1);

  // ids are validated by the manifest before anything spawns
  for (const id of ['rule/../x', 'persona/x', 'rule/UPPER', '../rule/x']) {
    expect((await run('card-delete', { id })).status).toBe(400);
  }

  // profile: replaced as a whole, and the write is journalled
  expect((await run('profile-set', { body: '# 新画像\n\n- 内容' })).body.exitCode).toBe(0);
  expect(readFileSync(join(self, 'persona', 'profile.md'), 'utf8')).toBe('# 新画像\n\n- 内容\n');
  const journal = readFileSync(join(self, 'journal', 'JOURNAL.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(journal.filter((r) => r.tags?.includes('memory')).map((r) => r.tags[1])).toEqual(['create', 'update', 'delete', 'profile']);

  // intake from the page: source + type + text; an empty text or a bad source is refused
  expect((await run('intake', { source: 'manual', type: 'fact', body: '' } as never)).status).toBe(400);
  expect((await run('intake', { source: 'Bad Source', text: '内容' })).status).toBe(400);
  const taken = await run('intake', { source: 'manual', type: 'note', tag: 'a,b', text: '页面上记的一条\n第二行' });
  expect(taken.body.exitCode).toBe(0);
  const spool = readFileSync(join(self, 'spool', 'manual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(spool[0]).toMatchObject({ source: 'manual', type: 'note', tags: ['a', 'b'], text: '页面上记的一条\n第二行' });
  await hosting.shutdown();
});
