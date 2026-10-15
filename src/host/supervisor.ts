import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { emitHostEvent, type HostEventSink, type HostedProcess, type Spawner } from './hosting.ts';
import type { ToolManifest, ToolAction } from './registry.ts';

export type ToolHealth = 'ok' | 'unhealthy' | 'down' | 'none';

export interface ToolStatus {
  id: string;
  name: string;
  description?: string;
  icon?: import('./catalog.ts').ButlerIconView;
  panelUrl?: string;
  panelSize?: { width?: number; height?: number };
  actions?: ToolAction[];
  frequency?: 'low';
  desired: 'running' | 'stopped';
  running: boolean;
  pid?: number;
  startedAt?: number;
  restarts: number;
  lastExit?: { code: number | null; signal: string | null; at: number };
}

interface ManagedTool {
  manifest: ToolManifest;
  child?: HostedProcess;
  desired: 'running' | 'stopped';
  startedAt?: number;
  restarts: number;
  backoffMs: number;
  restartTimer?: ReturnType<typeof setTimeout>;
  restartRequested?: boolean;
  lastExit?: { code: number | null; signal: string | null; at: number };
}

const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const STABLE_RESET_MS = 5 * 60_000;
/** TERM-to-KILL grace for a tool that ignores SIGTERM. */
const GRACE_MS = 5_000;

/**
 * Hosted tools: long-running children declared by a tool manifest's `hosted`
 * block. Crash → exponential backoff respawn while desired is `running`;
 * stdout/stderr go to per-tool files and a bounded SSE replay buffer.
 */
export class Supervisor {
  private readonly tools = new Map<string, ManagedTool>();
  private readonly logDir: string;
  private readonly spawner: Spawner;
  private readonly env: Record<string, string>;
  private readonly observe?: HostEventSink;
  private readonly logs = new Map<string, Array<{ t: number; text: string }>>();
  private readonly subscribers = new Map<string, Set<ServerResponse>>();

  subscribeLog(id: string, response: ServerResponse): void {
    this.require(id);
    for (const line of this.logs.get(id) ?? []) response.write(`data: ${JSON.stringify(line)}\n\n`);
    const subscribers = this.subscribers.get(id) ?? new Set<ServerResponse>();
    this.subscribers.set(id, subscribers);
    subscribers.add(response);
    response.on('close', () => subscribers.delete(response));
  }

  private appendLog(id: string, chunk: Buffer | string): void {
    const log = this.logs.get(id) ?? [];
    for (const text of String(chunk).split('\n').filter(Boolean)) {
      const line = { t: Date.now(), text: text.slice(-8192) };
      log.push(line);
      if (log.length > 200) log.shift();
      for (const response of this.subscribers.get(id) ?? []) {
        try { if (!response.write(`data: ${JSON.stringify(line)}\n\n`)) response.end(); }
        catch { this.subscribers.get(id)?.delete(response); }
      }
    }
    this.logs.set(id, log);
  }

  /**
   * @param spawner where children come from (DSH's subprocess service in the App, plain Node in tests).
   * @param logDir per-tool log file directory.
   * @param env environment every child starts with, merged under the manifest's own `env`.
   * @param observe L0 sink for unexpected exits; requested stops are not reported.
   */
  constructor(spawner: Spawner, logDir = process.env.BUTLER_LOG_DIR ?? join(homedir(), '.dsh', 'butler', '.state', 'logs'), env: Record<string, string> = {}, observe?: HostEventSink) {
    this.spawner = spawner;
    this.logDir = logDir;
    this.env = env;
    this.observe = observe;
  }

  register(manifest: ToolManifest): void {
    this.tools.set(manifest.id, { manifest, desired: 'stopped', restarts: 0, backoffMs: BACKOFF_MIN_MS });
  }

  update(manifest: ToolManifest): void {
    const tool = this.tools.get(manifest.id);
    if (!tool) return this.register(manifest);
    tool.manifest = manifest;
  }

  ids(): string[] {
    return [...this.tools.keys()];
  }

  /** 清单消失时调用：停止进程、清定时器、移出托管表。 */
  unregister(id: string): void {
    const tool = this.tools.get(id);
    if (!tool) return;
    tool.desired = 'stopped';
    clearTimeout(tool.restartTimer);
    tool.child?.terminate();
    for (const response of this.subscribers.get(id) ?? []) response.end();
    this.subscribers.delete(id);
    this.logs.delete(id);
    this.tools.delete(id);
  }

  /** All manifests in current display/persistence order (Map insertion order). */
  manifests(): ToolManifest[] {
    return [...this.tools.values()].map((t) => t.manifest);
  }

  setFrequency(id: string, frequency?: 'low'): ToolStatus {
    const tool = this.require(id);
    tool.manifest.frequency = frequency;
    return this.statusOf(id);
  }

  /**
   * Reorder tools to match `orderedIds`. Map insertion order is the display +
   * persistence order, so we clear and re-insert. Unknown ids are ignored;
   * existing tools missing from the list keep their prior relative order at the
   * end (a stale client can never drop a tool).
   */
  reorder(orderedIds: string[]): void {
    const seen = new Set<string>();
    const next: Array<[string, ManagedTool]> = [];
    for (const id of orderedIds) {
      const tool = this.tools.get(id);
      if (tool && !seen.has(id)) { seen.add(id); next.push([id, tool]); }
    }
    for (const [id, tool] of this.tools) if (!seen.has(id)) next.push([id, tool]);
    this.tools.clear();
    for (const [id, tool] of next) this.tools.set(id, tool);
  }

  autoStart(): void {
    for (const tool of this.tools.values()) {
      if (tool.manifest.autoStart) this.start(tool.manifest.id);
    }
  }

  start(id: string): ToolStatus {
    const tool = this.require(id);
    tool.desired = 'running';
    clearTimeout(tool.restartTimer);
    tool.restartTimer = undefined;
    if (!tool.child) this.spawnTool(tool);
    return this.statusOf(id);
  }

  stop(id: string): ToolStatus {
    const tool = this.require(id);
    tool.desired = 'stopped';
    clearTimeout(tool.restartTimer);
    tool.restartTimer = undefined;
    tool.child?.terminate();
    return this.statusOf(id);
  }

  restart(id: string): ToolStatus {
    const tool = this.require(id);
    tool.desired = 'running';
    tool.backoffMs = BACKOFF_MIN_MS;
    if (tool.child) {
      // exit handler sees desired === 'running' and respawns after backoff
      tool.restartRequested = true;
      tool.child.terminate();
    } else {
      this.spawnTool(tool);
    }
    return this.statusOf(id);
  }

  shutdown(): void {
    for (const subscribers of this.subscribers.values()) for (const response of subscribers) response.end();
    this.subscribers.clear();
    for (const tool of this.tools.values()) {
      tool.desired = 'stopped';
      clearTimeout(tool.restartTimer);
      tool.child?.terminate();
    }
  }

  statusOf(id: string): ToolStatus {
    const tool = this.require(id);
    return {
      id: tool.manifest.id,
      name: tool.manifest.name,
      description: tool.manifest.description,
      icon: tool.manifest.icon,
      panelUrl: tool.manifest.panelUrl,
      panelSize: tool.manifest.panelSize,
      actions: tool.manifest.actions,
      frequency: tool.manifest.frequency,
      desired: tool.desired,
      running: Boolean(tool.child),
      pid: tool.child?.pid,
      startedAt: tool.startedAt,
      restarts: tool.restarts,
      lastExit: tool.lastExit,
    };
  }

  async healthOf(id: string): Promise<ToolHealth> {
    const tool = this.require(id);
    if (!tool.manifest.healthUrl) return 'none';
    try {
      const response = await fetch(tool.manifest.healthUrl, { signal: AbortSignal.timeout(2_000) });
      return response.ok ? 'ok' : 'unhealthy';
    } catch {
      return 'down';
    }
  }

  private require(id: string): ManagedTool {
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`未注册的工具：${id}`);
    return tool;
  }

  private spawnTool(tool: ManagedTool): void {
    mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    const out = createWriteStream(join(this.logDir, `${tool.manifest.id}.out.log`), { flags: 'a' });
    const err = createWriteStream(join(this.logDir, `${tool.manifest.id}.err.log`), { flags: 'a' });
    const startedAt = Date.now();
    const child = this.spawner.spawn({
      argv: tool.manifest.command,
      cwd: tool.manifest.cwd ?? process.cwd(),
      env: { ...this.env, ...tool.manifest.env },
      graceMs: GRACE_MS,
    });
    pipeTo(child.stdout, out);
    pipeTo(child.stderr, err);
    child.stdout?.on('data', (chunk) => this.appendLog(tool.manifest.id, chunk));
    child.stderr?.on('data', (chunk) => this.appendLog(tool.manifest.id, chunk));
    tool.child = child;
    tool.startedAt = startedAt;
    void child.done.then((outcome) => {
      if (outcome.error) err.write(`[butler] spawn failed: ${outcome.error.message}\n`);
      out.end();
      err.end();
      this.onExit(tool, child, startedAt, outcome.exitCode, outcome.signal);
    });
  }

  private onExit(tool: ManagedTool, child: HostedProcess, startedAt: number, code: number | null, signal: string | null): void {
    if (tool.child !== child) return;
    tool.child = undefined;
    tool.startedAt = undefined;
    tool.lastExit = { code, signal, at: Date.now() };
    if (tool.desired !== 'running') return;
    // restart() terminates on purpose and leaves desired=running; that exit is
    // requested, so only report exits the host did not ask for.
    if (!tool.restartRequested) {
      emitHostEvent(this.observe, { type: 'error', subject: `tool:${tool.manifest.id}`, text: `工具 ${tool.manifest.id} 意外退出 ${signal ?? code ?? '?'}，第 ${tool.restarts + 1} 次自动重启（${tool.backoffMs}ms 后）` });
    }
    tool.restartRequested = false;
    if (Date.now() - startedAt > STABLE_RESET_MS) tool.backoffMs = BACKOFF_MIN_MS;
    tool.restarts += 1;
    tool.restartTimer = setTimeout(() => {
      tool.restartTimer = undefined;
      if (tool.desired === 'running' && !tool.child) this.spawnTool(tool);
    }, tool.backoffMs);
    tool.backoffMs = Math.min(tool.backoffMs * 2, BACKOFF_MAX_MS);
  }
}

function pipeTo(source: NodeJS.ReadableStream | undefined, sink: WriteStream): void {
  if (!source) return;
  source.on('data', (chunk: Buffer | string) => { sink.write(chunk); });
  source.on('error', () => undefined);
}
