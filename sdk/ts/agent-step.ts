// agentStep：工作流里「需要判断的一步」交给新开的 Butler Session，结果回到确定性代码。
//
//   const plan = await agentStep(ctx, {
//     delegation: 'feishu-document-gateway/fix-dead-links',   // <extensionId>/<delegationId>，在 butler.json 声明
//     input: { dead },
//     summarize: (r) => ({ summary: `${r.fixes.length} 处修正`, items: r.fixes.map((f) => `${f.from} → ${f.to}`) }),
//     fallback: () => { throw new Error('死链无法自动修正'); },        // 委托不可用/超时/被拒绝时的静态行为
//   });
//
// risk=auto：Session 交回结果即返回。risk=confirm：在观测区挂「待确认」，主人批准才返回结果，
// 拒绝则走 fallback。Session 只出方案；采纳与写入始终由调用方代码执行。
// 依赖：无（仅 fetch）。Host 地址同 runner：BUTLER_HOST_URL。
import { randomUUID } from 'node:crypto';
import type { RunCtx } from './runner.ts';

export interface AgentStepOptions<R, F = R> {
  delegation: string;
  input: unknown;
  /** confirm 级结果在观测区展示的摘要（不传则显示 JSON 的前 300 字）。 */
  summarize?: (result: R) => { summary: string; items?: string[] };
  /** 委托不可用、失败、超时或被主人拒绝时执行；它的返回值即本次结果。 */
  fallback: (reason: AgentStepFallbackReason) => F | Promise<F>;
  /** 等主人确认的上限（默认 24 小时）；超时按拒绝处理。 */
  confirmTimeoutMs?: number;
  hostUrl?: string;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
  pollMs?: number;
}

export type AgentStepFallbackReason =
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed' | 'timeout' | 'cancelled'; message: string; sessionId?: string }
  | { kind: 'rejected'; sessionId?: string };

export interface AgentStepOutcome<R, F = R> {
  /** delegated = 采用了 Session 的结果；fallback = 走了静态行为。 */
  source: 'delegated' | 'fallback';
  value: R | F;
  sessionId?: string;
}

interface DelegationRecord { id: string; status: string; risk: 'auto' | 'confirm'; sessionId?: string; result?: unknown; error?: string }

export async function agentStep<R, F = R>(ctx: RunCtx<any>, options: AgentStepOptions<R, F>): Promise<AgentStepOutcome<R, F>> {
  const host = (options.hostUrl ?? process.env.BUTLER_HOST_URL ?? process.env.BUTLER_GUARDIAN_URL ?? '').replace(/\/$/, '');
  const http = options.fetchImpl ?? fetch;
  const fallback = async (reason: AgentStepFallbackReason, sessionId?: string): Promise<AgentStepOutcome<R, F>> => {
    ctx.log(reason.kind === 'rejected' ? '主人拒绝了方案，按原规则处理' : `委托未生效（${reason.kind}${'message' in reason ? `：${reason.message}` : ''}），按原规则处理`);
    return { source: 'fallback', value: await options.fallback(reason), ...(sessionId ? { sessionId } : {}) };
  };
  if (!host) return fallback({ kind: 'unavailable', message: '未注入 BUTLER_HOST_URL（不在 Butler 托管下运行）' });

  ctx.log('已交给 Butler 会话处理…');
  let record: DelegationRecord;
  try {
    const response = await http(`${host}/delegations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delegation: options.delegation, input: options.input }),
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) return fallback({ kind: 'unavailable', message: body?.error?.message ?? `HTTP ${response.status}` });
    record = body as DelegationRecord;
  } catch (error) {
    return fallback({ kind: 'unavailable', message: error instanceof Error ? error.message : String(error) });
  }
  if (record.sessionId) await ctx.event('step:session', { sessionId: record.sessionId });
  if (record.status !== 'submitted') {
    return fallback({ kind: record.status as 'failed' | 'timeout' | 'cancelled', message: record.error ?? record.status, sessionId: record.sessionId }, record.sessionId);
  }
  const result = record.result as R;
  if (record.risk === 'auto') return { source: 'delegated', value: result, sessionId: record.sessionId };

  // confirm：挂到观测区，等主人决定。只有主人的 UI 能写决定；本进程只轮询读取。
  const token = randomUUID();
  const shown = options.summarize ? options.summarize(result) : { summary: JSON.stringify(result).slice(0, 300) };
  await ctx.event('step:await', { token, summary: shown.summary, items: shown.items ?? [], sessionId: record.sessionId });
  const deadline = Date.now() + (options.confirmTimeoutMs ?? 24 * 3600_000);
  const poll = options.pollMs ?? 2000;
  const url = `${host}/runs/${encodeURIComponent(ctx.runId)}/steps/${ctx.stepIndex}/confirm?token=${encodeURIComponent(token)}`;
  while (Date.now() < deadline) {
    try {
      const response = await http(url);
      if (response.ok) {
        const { decision } = await response.json() as { decision: 'approve' | 'reject' | null };
        if (decision === 'approve') { ctx.log('主人已确认'); return { source: 'delegated', value: result, sessionId: record.sessionId }; }
        if (decision === 'reject') return fallback({ kind: 'rejected', sessionId: record.sessionId }, record.sessionId);
      } else if (response.status === 404) {
        // Host 重启丢了待确认：不能当作批准。
        return fallback({ kind: 'failed', message: '待确认已失效（Host 重启？）', sessionId: record.sessionId }, record.sessionId);
      }
    } catch { /* Host 短暂不可达：继续等 */ }
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
  return fallback({ kind: 'rejected', sessionId: record.sessionId }, record.sessionId);
}
