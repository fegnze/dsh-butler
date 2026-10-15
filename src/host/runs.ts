// 运行观测 store：接收 workflow_runner 推送的事件，维护内存中的运行态，
// 并通过 SSE 实时广播给 Dashboard 顶部观测区。仅本机、内存级、无持久化
// （历史回看由 runner 的运行清单负责）。
// 保留策略：完成态（成功/失败/中断）常驻显示，直到「下一个任务开始」时清除
// 已完成卡（仍在运行的不清），即"被下一个任务覆盖"。
import type { ServerResponse } from 'node:http';
import type { NotificationSender } from './hosting.ts';

type StepStatus = 'pending' | 'running' | 'awaiting' | 'success' | 'error' | 'skipped';
/**
 * A step waiting for the owner in the observation area (risk=confirm delegations).
 * Only a summary and short item lines travel to the UI; the full result stays with the step.
 */
export interface StepConfirm {
  token: string; summary: string; items: string[]; sessionId?: string;
  decision?: 'approve' | 'reject'; decidedAt?: number;
}
type RunStatus = 'running' | 'success' | 'error' | 'interrupted';
interface StepRec { name: string; status: StepStatus; ms?: number; error?: string; log?: string; sessionId?: string; confirm?: StepConfirm }
interface RunRec {
  runId: string; workflow: string; title: string; source: string; dryRun: boolean;
  actor?: string; capabilityId?: string; capabilityVersion?: number; proposalId?: string; confirmed?: boolean;
  target?: string; status: RunStatus; startedAt: number; endedAt?: number; error?: string;
  currentIndex: number; steps: StepRec[]; lastEventAt: number;
}

const KEEP_DONE = 30;       // 安全上限；正常由"新任务开始清历史"控制
const STALE_MS = 90_000;    // 运行中卡超过此时长无任何事件 → 判为进程已死/被杀，清除（健康步事件间隔 < 30s）

export class RunStore {
  private readonly notify: NotificationSender;

  constructor(
    private notificationCommand: string[] | undefined,
    sender: NotificationSender,
    notificationsEnabled = true,
  ) {
    this.notify = notificationsEnabled ? sender : () => undefined;
  }
  private runs = new Map<string, RunRec>();
  private subs = new Set<ServerResponse>();

  ingest(ev: Record<string, any>): void {
    const runId = String(ev.runId ?? '');
    if (!runId) return;
    const now = ev.at ?? Date.now();
    this.sweepStale();
    if (ev.type === 'run:start') {
      const wf = String(ev.workflow ?? 'workflow');
      // 覆盖：清掉已完成历史卡；并让**同名工作流**的旧"运行中"卡被新任务取代
      //（旧的多半已死/被杀、永不收尾，否则会残留成重复卡）。不同名的并发流不受影响。
      const dropped = [...this.runs.values()].filter((r) => r.status !== 'running' || r.workflow === wf).map((r) => r.runId);
      for (const id of dropped) this.runs.delete(id);
      if (dropped.length) this.broadcastDrop(dropped);
      this.runs.set(runId, {
        runId, workflow: wf, title: String(ev.title ?? ev.workflow ?? '工作流'),
        source: String(ev.source ?? 'cli'), dryRun: !!ev.dryRun, target: ev.target ? String(ev.target) : undefined,
        actor: ev.actor ? String(ev.actor) : undefined,
        capabilityId: ev.capabilityId ? String(ev.capabilityId) : undefined,
        capabilityVersion: Number.isInteger(ev.capabilityVersion) ? ev.capabilityVersion : undefined,
        proposalId: ev.proposalId ? String(ev.proposalId) : undefined,
        confirmed: ev.confirmed === true ? true : ev.confirmed === false ? false : undefined,
        status: 'running', startedAt: now, currentIndex: -1, lastEventAt: now,
        steps: Array.isArray(ev.steps) ? ev.steps.map((s: any) => ({ name: String(s.name), status: 'pending' as StepStatus })) : [],
      });
      this.prune();
      const r = this.runs.get(runId)!;
      this.notify(this.notificationCommand, { title: '工作流 · 开始 ▶', body: r.title, subtitle: `来源 ${r.source}${r.target ? ' · ' + r.target : ''}` });
    } else {
      const run = this.runs.get(runId); if (!run) return;
      const idx = typeof ev.index === 'number' ? ev.index : -1;
      const step = idx >= 0 ? run.steps[idx] : undefined;
      if (ev.type === 'step:start' && step) { step.status = 'running'; run.currentIndex = idx; }
      else if (ev.type === 'step:log' && step) { step.log = String(ev.message ?? '').slice(0, 300); }
      // A delegation step links its Butler Session so the trace can open it.
      else if (ev.type === 'step:session' && step && typeof ev.sessionId === 'string') { step.sessionId = ev.sessionId.slice(0, 200); }
      else if (ev.type === 'step:await' && step && typeof ev.token === 'string' && ev.token) {
        step.status = 'awaiting';
        step.confirm = {
          token: ev.token.slice(0, 100),
          summary: String(ev.summary ?? '').slice(0, 500),
          items: Array.isArray(ev.items) ? ev.items.slice(0, 20).map((item: unknown) => String(item).slice(0, 300)) : [],
          ...(typeof ev.sessionId === 'string' ? { sessionId: ev.sessionId.slice(0, 200) } : {}),
        };
        this.notify(this.notificationCommand, { title: '工作流 · 待确认', body: run.title, subtitle: step.name, sound: true });
      }
      else if (ev.type === 'step:retry' && step) { step.log = `重试 #${ev.attempt}：${String(ev.error ?? '').slice(0, 160)}`; }
      else if (ev.type === 'step:end' && step) { step.status = ev.status as StepStatus; if (ev.ms != null) step.ms = ev.ms; if (ev.error) step.error = String(ev.error); }
      else if (ev.type === 'run:end') {
        run.status = (ev.status as RunStatus) ?? 'success'; run.endedAt = now; if (ev.error) run.error = String(ev.error);
        if (run.status === 'success') this.notify(this.notificationCommand, { title: '工作流 · 完成 ✓', body: run.title, subtitle: run.target });
        else if (run.status === 'error') this.notify(this.notificationCommand, { title: '工作流 · 失败 ✕', body: run.title, subtitle: run.error || '有步骤失败', sound: true });
        else if (run.status === 'interrupted') this.notify(this.notificationCommand, { title: '工作流 · 中断 ⚠', body: run.title, subtitle: run.error || '', sound: true });
      }
    }
    const run = this.runs.get(runId);
    if (run) { run.lastEventAt = now; this.broadcast(run); }
  }

  /**
   * The owner's answer to an awaiting step. Token-bound: the UI echoes the token it was shown,
   * so a stale card or a guessed runId cannot decide a different confirmation.
   * @returns the confirm record, or an error code.
   */
  decide(runId: string, index: number, token: string, decision: 'approve' | 'reject'): StepConfirm | 'not_found' | 'token_mismatch' | 'already_decided' {
    const step = this.runs.get(runId)?.steps[index];
    if (!step?.confirm) return 'not_found';
    if (step.confirm.token !== token) return 'token_mismatch';
    if (step.confirm.decision) return 'already_decided';
    step.confirm.decision = decision;
    step.confirm.decidedAt = Date.now();
    const run = this.runs.get(runId)!;
    run.lastEventAt = Date.now();
    this.broadcast(run);
    return step.confirm;
  }

  /** What the waiting step polls: its decision, or undefined while the owner has not answered. */
  decision(runId: string, index: number, token: string): 'approve' | 'reject' | undefined | 'not_found' {
    const confirm = this.runs.get(runId)?.steps[index]?.confirm;
    if (!confirm || confirm.token !== token) return 'not_found';
    return confirm.decision;
  }

  /** 清除"运行中但已长时间无事件"的僵尸卡（进程死/被杀、永不收尾）。 */
  private sweepStale(): void {
    const now = Date.now(); const ids: string[] = [];
    // A run waiting for the owner is alive by definition: its step keeps polling, never stale.
    for (const [id, r] of this.runs) if (r.status === 'running' && now - r.lastEventAt > STALE_MS && !r.steps.some((step) => step.status === 'awaiting')) { this.runs.delete(id); ids.push(id); }
    if (ids.length) this.broadcastDrop(ids);
  }

  /** 观测区拉快照：进行中在前，其后已完成态（常驻，不按时间淘汰）。 */
  snapshot(): RunRec[] {
    this.sweepStale();
    const all = [...this.runs.values()];
    const active = all.filter((r) => r.status === 'running').sort((a, b) => b.startedAt - a.startedAt);
    const done = all.filter((r) => r.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    return [...active, ...done];
  }

  subscribe(res: ServerResponse): void {
    this.subs.add(res);
    for (const run of this.snapshot()) this.write(res, run);
    res.on('close', () => this.subs.delete(res));
  }

  private broadcast(run: RunRec): void { for (const res of this.subs) this.write(res, run); }
  private write(res: ServerResponse, run: RunRec): void {
    try { res.write(`event: run\ndata: ${JSON.stringify(run)}\n\n`); } catch { this.subs.delete(res); }
  }
  private broadcastDrop(ids: string[]): void {
    for (const res of this.subs) { try { res.write(`event: drop\ndata: ${JSON.stringify({ ids })}\n\n`); } catch { this.subs.delete(res); } }
  }

  /** 仅按数量兜底，避免内存无限增长；正常清理由"新任务开始"触发。 */
  private prune(): void {
    const done = [...this.runs.values()].filter((r) => r.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    done.forEach((r, i) => { if (i >= KEEP_DONE) this.runs.delete(r.runId); });
  }
}
