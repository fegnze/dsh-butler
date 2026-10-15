// 端到端：SDK agentStep → Host /delegations → 假 DSH 会话（agent 调提交工具）→ 观测区待确认 → 主人决定。
// 真 HTTP 服务包住真 router 与 RunStore；只有 DSH 的 sessionController 是假的。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromRaw } from '../src/host/config.ts';
import { createHosting, type Spawner } from '../src/host/hosting.ts';
import { createButlerRouter, type ButlerRouter } from '../src/host/routes.ts';
import { submitDelegationResult } from '../src/host/delegations.ts';
import { runWorkflow } from '../sdk/ts/runner.ts';
import { agentStep } from '../sdk/ts/agent-step.ts';

let root: string; let server: Server; let host: string; let router: ButlerRouter;
let agentReply: (sessionId: string) => void = () => {};
let promptAvailable = true;
const created: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'butler-dlg-'));
  await mkdir(join(root, 'tools', 'demo'), { recursive: true });
  await writeFile(join(root, 'tools', 'demo', 'butler.json'), JSON.stringify({
    schemaVersion: 1, kind: 'tool', id: 'demo', name: 'Demo',
    delegations: [
      { id: 'explain', instructions: '解释失败原因。', risk: 'auto', timeoutSec: 10, result: { type: 'object', required: ['cause'], properties: { cause: { type: 'string' } } } },
      { id: 'fix', instructions: '提出修正。', risk: 'confirm', timeoutSec: 10, result: { type: 'object', required: ['fixes'], properties: { fixes: { type: 'array', items: { type: 'string' } } } } },
    ],
  }));
  const spawner: Spawner = { spawn() { throw new Error('no spawn in this test'); } };
  const hosting = await createHosting(fromRaw(root, { notification: { enabled: false } }), spawner, 'http://127.0.0.1/myspace-butler');
  let n = 0;
  const sessionController = {
    async create() { const sessionId = `session-${++n}`; created.push(sessionId); return { sessionId }; },
    get prompt() {
      return promptAvailable ? async (request: { sessionId: string }) => { setTimeout(() => agentReply(request.sessionId), 5); return { accepted: true as const }; } : undefined;
    },
    async cancel() { return { accepted: true }; },
  };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void router.handle(req, res, url.pathname, url).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  router = createButlerRouter(hosting, {
    hostUrl: host,
    automationHost: () => ({ schedule: { catalog: async () => [], create: async () => ({}), delete: async () => ({}) }, sessionController: sessionController as any }),
  });
});
afterAll(async () => { server.close(); await rm(root, { recursive: true, force: true }); });

const owner = () => ({ 'content-type': 'application/json', origin: host, 'sec-fetch-site': 'same-origin', 'x-butler-review': '1' });
async function awaitingStep(runId: string) {
  for (let i = 0; i < 200; i++) {
    const step = router.runs.snapshot().find((run) => run.runId === runId)?.steps.find((s: any) => s.status === 'awaiting') as any;
    if (step) return step;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('step never awaited');
}
// host is only known after beforeAll, so build the runner options lazily.
const opts = () => ({ observerUrl: `${host}/runs/event`, manifestDir: join(tmpdir(), 'butler-dlg-manifests') });

describe('agentStep 端到端', () => {
  test('auto：会话提交即返回结果，观测区步骤挂上会话链接', async () => {
    agentReply = (sessionId) => submitDelegationResult(sessionId, { cause: '缺少 node_modules' });
    let outcome: any;
    const run = await runWorkflow({ name: 'demo-auto', steps: [{ name: '诊断', run: async (ctx) => {
      outcome = await agentStep(ctx, { delegation: 'demo/explain', input: { log: 'x' }, hostUrl: host, fallback: () => ({ cause: 'fallback' }) });
    } }] }, opts());
    expect(run.status).toBe('success');
    expect(outcome).toMatchObject({ source: 'delegated', value: { cause: '缺少 node_modules' } });
    const step: any = router.runs.snapshot().find((r) => r.runId === run.runId)?.steps[0];
    expect(step.sessionId).toBe(outcome.sessionId);
  });

  test('confirm：主人批准后才返回会话结果', async () => {
    agentReply = (sessionId) => submitDelegationResult(sessionId, { fixes: ['a → b'] });
    const runId = `confirm-${Date.now()}`;
    const running = runWorkflow({ name: 'demo-confirm', steps: [{ name: '修正', run: async (ctx) => {
      ctx.state.outcome = await agentStep(ctx, { delegation: 'demo/fix', input: {}, hostUrl: host, pollMs: 10,
        summarize: (r: any) => ({ summary: `${r.fixes.length} 处`, items: r.fixes }), fallback: () => 'fallback' });
    } }] }, { ...opts(), runId });
    const step = await awaitingStep(runId);
    expect(step.confirm).toMatchObject({ summary: '1 处', items: ['a → b'] });
    // SDK 进程（无 Origin、无 review 头）不能替主人决定
    const forged = await fetch(`${host}/runs/${runId}/steps/0/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', token: step.confirm.token }) });
    expect(forged.status).toBe(403);
    // token 不对也不行
    const wrong = await fetch(`${host}/runs/${runId}/steps/0/confirm`, { method: 'POST', headers: owner(), body: JSON.stringify({ decision: 'approve', token: 'guess' }) });
    expect(wrong.status).toBe(409);
    const ok = await fetch(`${host}/runs/${runId}/steps/0/confirm`, { method: 'POST', headers: owner(), body: JSON.stringify({ decision: 'approve', token: step.confirm.token }) });
    expect(ok.status).toBe(200);
    const run = await running;
    expect(run.state.outcome).toMatchObject({ source: 'delegated', value: { fixes: ['a → b'] } });
    // 不能重复决定
    const again = await fetch(`${host}/runs/${runId}/steps/0/confirm`, { method: 'POST', headers: owner(), body: JSON.stringify({ decision: 'reject', token: step.confirm.token }) });
    expect(again.status).toBe(409);
  });

  test('confirm：主人拒绝 → 走 fallback', async () => {
    agentReply = (sessionId) => submitDelegationResult(sessionId, { fixes: ['x'] });
    const runId = `reject-${Date.now()}`;
    const running = runWorkflow({ name: 'demo-reject', steps: [{ name: '修正', run: async (ctx) => {
      ctx.state.outcome = await agentStep(ctx, { delegation: 'demo/fix', input: {}, hostUrl: host, pollMs: 10, fallback: (reason) => `fallback:${reason.kind}` });
    } }] }, { ...opts(), runId });
    const step = await awaitingStep(runId);
    await fetch(`${host}/runs/${runId}/steps/0/confirm`, { method: 'POST', headers: owner(), body: JSON.stringify({ decision: 'reject', token: step.confirm.token }) });
    expect((await running).state.outcome).toMatchObject({ source: 'fallback', value: 'fallback:rejected' });
  });

  test('DSH 不支持 prompt → 503，agentStep 走 fallback（流程不中断）', async () => {
    promptAvailable = false;
    try {
      let outcome: any;
      await runWorkflow({ name: 'demo-old-app', steps: [{ name: '诊断', run: async (ctx) => {
        outcome = await agentStep(ctx, { delegation: 'demo/explain', input: {}, hostUrl: host, fallback: (reason) => reason.kind });
      } }] }, opts());
      expect(outcome).toMatchObject({ source: 'fallback', value: 'unavailable' });
    } finally { promptAvailable = true; }
  });

  test('未声明的委托 → fallback；不在 Butler 托管下（无 Host）→ fallback', async () => {
    const results: string[] = [];
    await runWorkflow({ name: 'demo-missing', steps: [{ name: 's', run: async (ctx) => {
      results.push((await agentStep(ctx, { delegation: 'demo/nope', input: {}, hostUrl: host, fallback: (r) => r.kind })).value as string);
      results.push((await agentStep(ctx, { delegation: 'demo/explain', input: {}, hostUrl: '', fallback: (r) => r.kind })).value as string);
    } }] }, opts());
    expect(results).toEqual(['unavailable', 'unavailable']);
  });

  test('每次委托都是新会话', () => {
    expect(new Set(created).size).toBe(created.length);
  });
});
