// MySpace 工作流 mini runner —— MySpace 域内服务的默认工作流规范（v1）。
// 目标：把线性/步骤化工作流统一成「可观测 + 可重试 + 幂等 + dry-run + 运行清单」，
// 并把每一步的流转事件实时推给 Dashboard 观测区（CLI / MCP 两条路径都自动触发）。
// 依赖：无（仅 Node/Bun 内置）。跨包以相对路径 import 即可。
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export type StepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';
export type RunStatus = 'running' | 'success' | 'error' | 'interrupted';

export interface RunCtx<S = Record<string, any>> {
  runId: string;
  workflow: string;
  dryRun: boolean;
  state: S;                // 跨步骤传递数据（如已解析节点、目标文件夹 id）
  log: (msg: string) => void;
  /** 当前步骤序号；agentStep 用它把会话链接和待确认挂到观测区里对应的节点上。 */
  stepIndex: number;
  /** 向观测区推一条本步骤的扩展事件（step:session / step:await）。 */
  event: (type: string, payload: Record<string, unknown>) => Promise<void>;
}
export interface StepDef<S = Record<string, any>> {
  name: string;
  run: (ctx: RunCtx<S>) => Promise<void | unknown>;
  retry?: number;              // 失败重试次数（默认 0）
  retryDelayMs?: number;       // 退避基数（默认 800ms，按次线性放大）
  continueOnError?: boolean;   // 批量型：本步失败（重试后仍失败）标 error 但不中断、后续继续跑；run 终态记 error
}
export interface WorkflowDef<S = Record<string, any>> {
  name: string;            // 稳定标识，如 feishu-sync-gdrive
  title?: string;          // 展示名，如 「飞书→GDrive 同步」
  steps: StepDef<S>[];
}
export interface RunOptions<S = Record<string, any>> {
  source?: string;         // cli | mcp | cron | …（观测区标注来源）
  /** Optional caller-owned id, used by local dashboards to return a run id before execution starts. */
  runId?: string;
  /** Audit metadata for capability/policy-aware callers. */
  actor?: string;
  capabilityId?: string;
  capabilityVersion?: number;
  proposalId?: string;
  confirmed?: boolean;
  dryRun?: boolean;
  state?: S;
  target?: string;         // 同步目标（链接/标题），仅用于展示
  observerUrl?: string;    // 默认 Dashboard；置空则不推送
  manifestDir?: string;
}
export interface RunResult<S = Record<string, any>> {
  runId: string; workflow: string; status: RunStatus; state: S;
  steps: Array<{ name: string; status: StepStatus; ms?: number; error?: string }>;
  error?: string; manifestPath?: string;
}

// 宿主地址：BUTLER_HOST_URL（宿主 exec 注入，形如 http://127.0.0.1:<dsh port>/myspace-butler）。
// 未注入即不推送——没有宿主就没有观测区，不再猜测端口。
const HOST_URL = process.env.BUTLER_HOST_URL ?? process.env.BUTLER_GUARDIAN_URL;
const DASHBOARD_EVENT_URL = HOST_URL ? `${HOST_URL.replace(/\/$/, '')}/runs/event` : undefined;
const MANIFEST_DIR = `${homedir()}/Library/Application Support/MySpace/Runs`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fire-and-forget 推事件到 Dashboard；Dashboard 不在也绝不影响流程。 */
async function emit(url: string | undefined, event: Record<string, unknown>): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...event, at: Date.now() }),
      signal: AbortSignal.timeout(1500),
    });
  } catch { /* 观测是尽力而为，失败静默 */ }
}

/** 运行一个工作流：顺序执行步骤，逐步推送事件、重试、并落运行清单。 */
export async function runWorkflow<S extends Record<string, any> = Record<string, any>>(
  def: WorkflowDef<S>,
  opts: RunOptions<S> = {},
): Promise<RunResult<S>> {
  const runId = opts.runId?.trim() || randomUUID().slice(0, 8);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runId)) throw new Error('runId 格式无效');
  const url = opts.observerUrl === undefined ? DASHBOARD_EVENT_URL : opts.observerUrl || undefined;
  const source = opts.source ?? 'cli';
  const dryRun = !!opts.dryRun;
  const state = (opts.state ?? {}) as S;
  const started = Date.now();
  const steps = def.steps.map((s) => ({ name: s.name, status: 'pending' as StepStatus, ms: undefined as number | undefined, error: undefined as string | undefined }));

  await emit(url, {
    type: 'run:start', runId, workflow: def.name, title: def.title ?? def.name, source, dryRun, target: opts.target,
    actor: opts.actor, capabilityId: opts.capabilityId, capabilityVersion: opts.capabilityVersion,
    proposalId: opts.proposalId, confirmed: opts.confirmed, steps: steps.map((s) => ({ name: s.name })),
  });

  let runStatus: RunStatus = 'running';
  let runError: string | undefined;
  let hadError = false; const failedNames: string[] = [];
  try {
    for (let i = 0; i < def.steps.length; i++) {
      const def_i = def.steps[i]; const rec = steps[i];
      rec.status = 'running';
      const t0 = Date.now();
      await emit(url, { type: 'step:start', runId, index: i, name: rec.name });
      const ctx: RunCtx<S> = { runId, workflow: def.name, dryRun, state, stepIndex: i, log: (msg) => { void emit(url, { type: 'step:log', runId, index: i, name: rec.name, message: String(msg).slice(0, 300) }); }, event: (type, payload) => emit(url, { ...payload, type, runId, index: i, name: rec.name }) };
      const maxTry = 1 + (def_i.retry ?? 0);
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxTry; attempt++) {
        try { await def_i.run(ctx); lastErr = undefined; break; }
        catch (e) {
          lastErr = e;
          if (attempt < maxTry) { await emit(url, { type: 'step:retry', runId, index: i, name: rec.name, attempt, error: String(e).slice(0, 200) }); await sleep((def_i.retryDelayMs ?? 800) * attempt); }
        }
      }
      rec.ms = Date.now() - t0;
      if (lastErr) {
        rec.status = 'error'; rec.error = String((lastErr as Error)?.message ?? lastErr).slice(0, 300);
        await emit(url, { type: 'step:end', runId, index: i, name: rec.name, status: 'error', ms: rec.ms, error: rec.error });
        if (def_i.continueOnError) { hadError = true; failedNames.push(rec.name); continue; } // 批量：记错、继续
        for (let j = i + 1; j < steps.length; j++) { steps[j].status = 'skipped'; await emit(url, { type: 'step:end', runId, index: j, name: steps[j].name, status: 'skipped' }); }
        runStatus = 'error'; runError = rec.error;
        throw lastErr;
      }
      rec.status = 'success';
      await emit(url, { type: 'step:end', runId, index: i, name: rec.name, status: 'success', ms: rec.ms });
    }
    // 全部步骤跑完：若有 continueOnError 步失败，则终态 error（但没有中断）
    if (hadError) { runStatus = 'error'; runError = `${failedNames.length} 步失败：${failedNames.slice(0, 5).join('、')}${failedNames.length > 5 ? ' …' : ''}`; }
    else runStatus = 'success';
  } catch { /* runError 已置 */ if (runStatus === 'running') runStatus = 'error'; }

  const result: RunResult<S> = { runId, workflow: def.name, status: runStatus, state, steps, error: runError };
  // 运行清单（本地持久化，便于回看历史；不入 git）
  try {
    const dir = opts.manifestDir ?? MANIFEST_DIR; await mkdir(dir, { recursive: true });
    // Workflow names are normally registered constants, but callers can supply
    // a definition directly. Keep a malformed name from escaping manifestDir.
    const manifestStem = def.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 96) || 'workflow';
    const manifestPath = `${dir}/${manifestStem}-${new Date(started).toISOString().replace(/[:.]/g, '-')}-${runId}.json`;
    await writeFile(manifestPath, JSON.stringify({
      runId,
      workflow: def.name,
      title: def.title,
      source,
      actor: opts.actor,
      capabilityId: opts.capabilityId,
      capabilityVersion: opts.capabilityVersion,
      proposalId: opts.proposalId,
      confirmed: opts.confirmed,
      dryRun,
      target: opts.target,
      startedAt: started,
      endedAt: Date.now(),
      status: runStatus,
      error: runError,
      steps,
    }, null, 2));
    result.manifestPath = manifestPath;
  } catch { /* 清单失败不影响结果 */ }

  await emit(url, { type: 'run:end', runId, status: runStatus, error: runError, ms: Date.now() - started });
  return result;
}
