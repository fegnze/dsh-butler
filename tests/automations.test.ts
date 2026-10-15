import { expect, test } from 'bun:test';
import { BUTLER_AUTOMATIONS, RETIRED_TITLES, registerAutomations, AUTOMATION_TAG } from '../src/host/automations.ts';

interface Row { sessionId: string; id: string; title: string; prompt: string; status: string; kind: string; expression?: string; timeZone?: string }

/** In-memory `ctx.schedule` + `sessionController` doubles with the real method names. */
function fakeHost(existing: Row[] = [], workspaces?: { fail?: boolean }) {
  const rows = [...existing];
  const created: Array<{ sessionId: string; request: any }> = [];
  const deleted: string[] = [];
  const sessions: Array<{ cwd?: string; workspaceId?: string; agentPreset?: string; sessionId?: string }> = [];
  const workspaceCalls: Array<{ path: string; title?: string }> = [];
  const attached: string[] = [];
  return {
    rows, created, deleted, sessions, workspaceCalls, attached,
    schedule: {
      async catalog() { return rows.map((row) => ({ sessionId: row.sessionId, id: row.id, status: row.status, record: { id: row.id, title: row.title, prompt: row.prompt, kind: row.kind, expression: row.expression, timeZone: row.timeZone } })); },
      async create(sessionId: string, request: any) { created.push({ sessionId, request }); const id = `schedule-${created.length}`; rows.push({ sessionId, id, title: request.title, prompt: request.prompt, status: 'active', kind: 'cron', expression: request.cron.expression, timeZone: request.cron.time_zone }); return { id, title: request.title }; },
      async delete(request: { sessionId: string; id: string }) { deleted.push(request.id); const i = rows.findIndex((row) => row.id === request.id); if (i >= 0) rows.splice(i, 1); return { deleted: true }; },
    },
    sessionController: {
      async create(request: any) {
        // the real controller refuses both at once
        if (request.workspaceId !== undefined && request.cwd !== undefined) throw new Error('session.create accepts workspaceId or cwd, not both');
        sessions.push(request);
        return { sessionId: 'session-new', agentPreset: request.agentPreset };
      },
    },
    ...(workspaces ? { workspaceRegistry: { async create(path: string, title?: string) { workspaceCalls.push({ path, title }); if (workspaces.fail) throw new Error('missing-dir'); return { id: 'ws-butler', async attachSession(id: string) { if (workspaces.fail) throw new Error('cwd mismatch'); attached.push(id); } }; } } } : {}),
  };
}

test('distill prompt defines the durable claim-submit-complete loop and hourly cron', () => {
  expect(BUTLER_AUTOMATIONS.map((task) => task.key)).toEqual(['distill']);
  const task = BUTLER_AUTOMATIONS[0]!;
  expect(task.title.endsWith(AUTOMATION_TAG)).toBe(true);
  expect(task.title.length).toBeLessThanOrEqual(120);
  expect(task.cron.time_zone).toBe('Asia/Shanghai');
  expect(task.cron.expression).toBe('0 * * * *');
  expect(task.cron.expression.split(' ')).toHaveLength(5);
  expect(task.prompt).toContain('butler_distill_claim');
  expect(task.prompt).toContain('runId、runToken、inputHash 和 sources');
  expect(task.prompt).toContain('butler_search');
  expect(task.prompt).toContain('butler_read');
  expect(task.prompt).toContain('butler_candidate_submit');
  expect(task.prompt).toContain('sourceId、messageIds、quote');
  expect(task.prompt).toContain('baseRevision');
  expect(task.prompt).toContain('butler_distill_complete');
  expect(task.prompt).toContain('零候选时仍须完成批次');
  expect(task.prompt).toMatch(/不得调用旧工具 journal_read、candidate-mark、advance/);
  expect(task.prompt).toMatch(/不得批准、拒绝或直接修改正式卡/);
  expect(task.prompt).not.toMatch(/butler_journal_read|butler_candidate\b|butler_distill_advance|butler_card\b/);
});

test('registers all automation tasks in a fresh butler-preset session at the instance root', async () => {
  const host = fakeHost();
  const result = await registerAutomations(host as never, { cwd: '/w/Butler' });
  expect(host.sessions).toEqual([{ cwd: '/w/Butler', agentPreset: 'butler' }]);
  expect(result).toMatchObject({ sessionId: 'session-new', created: 1, kept: 0, removed: 0 });
  expect(host.created.every((item) => item.sessionId === 'session-new')).toBe(true);
  expect(host.created.map((item) => item.request.title)).toEqual(BUTLER_AUTOMATIONS.map((task) => task.title));
  expect(host.created[0]!.request).toEqual({ title: BUTLER_AUTOMATIONS[0]!.title, prompt: BUTLER_AUTOMATIONS[0]!.prompt, cron: BUTLER_AUTOMATIONS[0]!.cron });
});

test('is idempotent: a second run keeps identical tasks and reuses their session', async () => {
  const host = fakeHost();
  await registerAutomations(host as never, { cwd: '/w/Butler' });
  const again = await registerAutomations(host as never, { cwd: '/w/Butler' });
  expect(again).toMatchObject({ sessionId: 'session-new', created: 0, kept: 1, removed: 0 });
  expect(host.sessions).toHaveLength(1);
  expect(host.created).toHaveLength(1);
});

test('replaces a task whose prompt drifted and leaves foreign tasks alone', async () => {
  const stale = BUTLER_AUTOMATIONS[0]!;
  const host = fakeHost([
    { sessionId: 's-old', id: 'old-distill', title: stale.title, prompt: 'outdated', status: 'active', kind: 'cron', expression: stale.cron.expression, timeZone: 'Asia/Shanghai' },
    { sessionId: 's-old', id: 'mine', title: '我的提醒', prompt: 'x', status: 'active', kind: 'at' },
  ]);
  const result = await registerAutomations(host as never, { cwd: '/w/Butler' });
  expect(host.deleted).toEqual(['old-distill']);
  expect(result).toMatchObject({ sessionId: 's-old', created: 1, removed: 1 });
  expect(host.sessions).toHaveLength(0); // reused the session that already carried a Butler task
  expect(host.rows.some((row) => row.id === 'mine')).toBe(true);
});

test('the retired daily, weekly and audit shifts are removed from an installed copy, and only those', async () => {
  expect(RETIRED_TITLES).toEqual(['日报 · Butler', '周报 · Butler', '周检 · Butler']);
  const keep = BUTLER_AUTOMATIONS[0]!;
  const host = fakeHost([
    { sessionId: 's-old', id: 'kept-distill', title: keep.title, prompt: keep.prompt, status: 'active', kind: 'cron', expression: keep.cron.expression, timeZone: 'Asia/Shanghai' },
    { sessionId: 's-old', id: 'old-daily', title: '日报 · Butler', prompt: 'x', status: 'active', kind: 'cron', expression: '45 18 * * 1-4', timeZone: 'Asia/Shanghai' },
    { sessionId: 's-old', id: 'old-weekly', title: '周报 · Butler', prompt: 'x', status: 'inactive', kind: 'cron', expression: '45 18 * * 5', timeZone: 'Asia/Shanghai' },
    { sessionId: 's-old', id: 'old-audit', title: '周检 · Butler', prompt: 'x', status: 'active', kind: 'cron', expression: '15 10 * * 1', timeZone: 'Asia/Shanghai' },
    { sessionId: 's-old', id: 'mine', title: '日报', prompt: 'x', status: 'active', kind: 'at' },
  ]);
  const result = await registerAutomations(host as never, { cwd: '/w/Butler' });
  expect(host.deleted.sort()).toEqual(['old-audit', 'old-daily', 'old-weekly']);
  expect(result).toMatchObject({ created: 0, kept: 1, removed: 3 });
  expect(host.rows.map((row) => row.id).sort()).toEqual(['kept-distill', 'mine']);
  // distillation submits complete candidates only; approval and formal-card writes stay out of scope
  expect(keep.prompt).toContain('butler_candidate_submit');
  expect(keep.prompt).toContain('butler_distill_complete');
  expect(keep.prompt).not.toMatch(/butler_approve|butler_card_write|butler_distill_advance/);
});

test('cron expressions are already in dsh-schedule canonical form, so idempotence holds on the real store', async () => {
  const path = '/tmp/dshapp/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js';
  if (!(await Bun.file(path).exists())) return; // App bundle extracted only on dev machines
  const { canonicalizeCronExpression } = await import(path);
  for (const task of BUTLER_AUTOMATIONS) expect(canonicalizeCronExpression(task.cron.expression)).toBe(task.cron.expression);
});

test('POST /automations registers at the instance root, and answers 503 without the schedule bundle', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Readable } = await import('node:stream');
  const { fromRaw } = await import('../src/host/config.ts');
  const { createHosting } = await import('../src/host/hosting.ts');
  const { createButlerRouter } = await import('../src/host/routes.ts');
  const root = await mkdtemp(join(tmpdir(), 'butler-automations-'));
  const hosting = await createHosting(fromRaw(root, { notification: { enabled: false } }), { spawn() { throw new Error('no spawn'); } }, 'http://localhost/myspace-butler');
  const host = fakeHost();
  let available = true;
  const router = createButlerRouter(hosting, { automationHost: () => (available ? host as never : undefined) });
  async function post() {
    const req = Object.assign(Readable.from([]), { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } }) as never;
    let status = 0; let text = '';
    const res = { writeHead(code: number) { status = code; }, end(value = '') { text += value; } } as never;
    await router.handle(req, res, '/api/automations', new URL('/api/automations', 'http://localhost'));
    return { status, body: JSON.parse(text) };
  }
  const ok = await post();
  expect(ok).toMatchObject({ status: 200, body: { created: 1 } });
  expect(host.sessions).toEqual([{ cwd: hosting.config.instanceRoot, agentPreset: 'butler' }]);
  available = false;
  expect((await post()).status).toBe(503);
});

test('catalog rows are accepted both flat (as the live App returns them) and nested under record', async () => {
  const flat = fakeHost([]);
  (flat.schedule as { catalog: () => Promise<unknown> }).catalog = async () => [
    { id: 'r1', sessionId: 's-old', status: 'active', kind: 'cron', title: `日报 ${AUTOMATION_TAG}`, prompt: 'x', expression: '45 18 * * 1-4', timeZone: 'Asia/Shanghai' },
    { id: 'r2', sessionId: 's-old', status: 'active', kind: 'cron', title: 'someone else', prompt: 'y' },
  ];
  const deleted: string[] = [];
  (flat.schedule as { delete: (r: { sessionId: string; id: string }) => Promise<unknown> }).delete = async (r) => { deleted.push(`${r.sessionId}/${r.id}`); return {}; };
  const result = await registerAutomations(flat as never, { cwd: '/w/Butler' });
  expect(deleted).toEqual(['s-old/r1']);
  expect(result.removed).toBe(1);
  expect(flat.created).toHaveLength(1);
});

test('a catalog row without an id or session is reported by its field names', async () => {
  const host = fakeHost([]);
  (host.schedule as { catalog: () => Promise<unknown> }).catalog = async () => [{ title: 'x', weird: 1 }];
  await expect(registerAutomations(host as never, { cwd: '/w/Butler' })).rejects.toThrow(/缺少 id 或 sessionId，字段：title,weird/);
  (host.schedule as { catalog: () => Promise<unknown> }).catalog = async () => ({ tasks: [] });
  await expect(registerAutomations(host as never, { cwd: '/w/Butler' })).rejects.toThrow(/没有返回数组/);
});
