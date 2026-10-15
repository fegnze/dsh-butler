import { createConnection } from 'node:net';
import type { ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emitHostEvent, type HostEventSink, type HostedProcess, type Spawner } from './hosting.ts';
import type { ServiceManifest } from './service-registry.ts';

export type ServiceState = 'running' | 'stopped' | 'port-busy' | 'crashed';

export interface ServiceStatus {
  id: string;
  name: string;
  description?: string;
  icon?: import('./catalog.ts').ButlerIconView;
  command: string;
  cwd?: string;
  port?: number;
  /** Raw user-set URL (undefined when it should be inferred from port); for edit form round-trip. */
  url?: string;
  /** Resolved URL to open in the browser (url ?? inferred-from-port). */
  openUrl?: string;
  /** Fixed local path to open in Finder, if configured. */
  openPath?: string;
  group?: string;
  frequency?: 'low';
  autoStart: boolean;
  state: ServiceState;
  pid?: number;
  startedAt?: number;
  lastExit?: { code: number | null; signal: string | null; at: number };
}

interface LogLine {
  t: number;
  text: string;
}

interface ManagedService {
  manifest: ServiceManifest;
  child?: HostedProcess;
  desired: 'running' | 'stopped';
  pendingRestart: boolean;
  startedAt?: number;
  lastExit?: { code: number | null; signal: string | null; at: number };
  log: LogLine[];
  subscribers: Set<(line: LogLine) => void>;
}

const LOG_CAP = 200;
/** TERM-to-KILL grace for a service tree (npm → vite → …) that ignores SIGTERM. */
const GRACE_MS = 5_000;

/**
 * Hosted services: user-declared long-running commands (dev servers, local
 * stacks) run through a login shell so they see the user's interactive PATH.
 * No automatic restart on crash — these are manually managed; `restart()`
 * is the only respawn.
 */
export class ServiceManager {
  private readonly svcs = new Map<string, ManagedService>();
  private readonly spawner: Spawner;
  private readonly env: Record<string, string>;

  /**
   * @param spawner where children come from (DSH's subprocess service in the App, plain Node in tests).
   * @param env environment every child starts with, merged under the manifest's own `env`.
   * @param observe L0 sink for crashes; requested stop/restart exits are not reported.
   */
  constructor(spawner: Spawner, env: Record<string, string> = {}, private readonly observe?: HostEventSink) {
    this.spawner = spawner;
    this.env = env;
  }

  register(manifest: ServiceManifest): void {
    this.svcs.set(manifest.id, { manifest, desired: 'stopped', pendingRestart: false, log: [], subscribers: new Set() });
  }

  ids(): string[] { return [...this.svcs.keys()]; }

  autoStart(): void {
    for (const svc of this.svcs.values()) {
      if (svc.manifest.autoStart) this.start(svc.manifest.id);
    }
  }

  start(id: string): void {
    const svc = this.require(id);
    svc.desired = 'running';
    svc.lastExit = undefined; // clear crashed flag
    if (!svc.child) this.spawnSvc(svc);
  }

  stop(id: string): void {
    const svc = this.require(id);
    svc.desired = 'stopped';
    svc.child?.terminate();
  }

  restart(id: string): void {
    const svc = this.require(id);
    svc.desired = 'running';
    if (svc.child) {
      svc.pendingRestart = true;
      svc.child.terminate();
    } else {
      svc.lastExit = undefined;
      this.spawnSvc(svc);
    }
  }

  /** Add a new service (no-op if id already exists). */
  add(manifest: ServiceManifest): void {
    if (!this.svcs.has(manifest.id)) {
      this.svcs.set(manifest.id, { manifest, desired: 'stopped', pendingRestart: false, log: [], subscribers: new Set() });
    }
  }

  /** Update manifest for an existing service (or add it if new). */
  update(manifest: ServiceManifest): void {
    const existing = this.svcs.get(manifest.id);
    if (existing) {
      existing.manifest = manifest;
    } else {
      this.add(manifest);
    }
  }

  /** Stop and remove a service. */
  remove(id: string): void {
    const svc = this.svcs.get(id);
    if (!svc) return;
    svc.desired = 'stopped';
    svc.child?.terminate();
    for (const fn of svc.subscribers) fn({ t: Date.now(), text: '[服务已删除]' });
    this.svcs.delete(id);
  }

  /**
   * Reorder services to match `orderedIds`. The Map's insertion order is the
   * display + persistence order, so we clear and re-insert. Ids not present are
   * ignored; existing services missing from the list are appended in their
   * prior order (a stale client can never drop a service).
   */
  reorder(orderedIds: string[]): void {
    const seen = new Set<string>();
    const next: Array<[string, ManagedService]> = [];
    for (const id of orderedIds) {
      const svc = this.svcs.get(id);
      if (svc && !seen.has(id)) { seen.add(id); next.push([id, svc]); }
    }
    for (const [id, svc] of this.svcs) {
      if (!seen.has(id)) next.push([id, svc]);
    }
    this.svcs.clear();
    for (const [id, svc] of next) this.svcs.set(id, svc);
  }

  setFrequency(id: string, frequency?: 'low'): void {
    this.require(id).manifest.frequency = frequency;
  }

  /** Return all current manifests (for persistence). */
  manifests(): ServiceManifest[] {
    return [...this.svcs.values()].map((s) => s.manifest);
  }

  async statusOf(id: string): Promise<ServiceStatus> {
    const svc = this.require(id);
    return this.buildStatus(svc, await this.computeState(svc));
  }

  async listStatus(): Promise<ServiceStatus[]> {
    return Promise.all([...this.svcs.values()].map(async (svc) =>
      this.buildStatus(svc, await this.computeState(svc)),
    ));
  }

  /**
   * Attach an SSE response to this service's log stream.
   * Sends buffered lines immediately, then live lines as they arrive.
   */
  subscribeLog(id: string, response: ServerResponse): void {
    const svc = this.require(id);
    for (const line of svc.log) response.write(`data: ${JSON.stringify(line)}\n\n`);
    const push = (line: LogLine) => {
      try { response.write(`data: ${JSON.stringify(line)}\n\n`); }
      catch { svc.subscribers.delete(push); }
    };
    svc.subscribers.add(push);
    response.on('close', () => svc.subscribers.delete(push));
  }

  shutdown(): void {
    for (const svc of this.svcs.values()) {
      svc.desired = 'stopped';
      svc.child?.terminate();
    }
  }

  private require(id: string): ManagedService {
    const svc = this.svcs.get(id);
    if (!svc) throw new Error(`未注册的服务：${id}`);
    return svc;
  }

  private buildStatus(svc: ManagedService, state: ServiceState): ServiceStatus {
    const m = svc.manifest;
    return {
      id: m.id, name: m.name, description: m.description, icon: m.icon, command: m.command, cwd: m.cwd,
      port: m.port,
      url: m.url,
      openUrl: m.url ?? (m.port ? `http://127.0.0.1:${m.port}` : undefined),
      openPath: m.openPath,
      group: m.group, frequency: m.frequency, autoStart: m.autoStart,
      state, pid: svc.child?.pid, startedAt: svc.startedAt, lastExit: svc.lastExit,
    };
  }

  private async computeState(svc: ManagedService): Promise<ServiceState> {
    if (svc.child) return 'running';
    if (svc.desired === 'running') return 'crashed'; // desired=running but process is gone
    if (svc.manifest.port && (await isPortBusy(svc.manifest.port))) return 'port-busy';
    return 'stopped';
  }

  private pushLog(svc: ManagedService, text: string): void {
    const line: LogLine = { t: Date.now(), text };
    if (svc.log.length >= LOG_CAP) svc.log.shift();
    svc.log.push(line);
    for (const fn of svc.subscribers) fn(line);
  }

  private spawnSvc(svc: ManagedService): void {
    const startedAt = Date.now();
    // A GUI App carries a minimal PATH, and tools like npm/node often live
    // behind a version manager wired up in the user's interactive rc file. Run
    // the command through a login + interactive shell so it inherits the same
    // env the user gets in their terminal. The spawner puts it in its own
    // process group so terminate() reaches the whole tree (npm run dev → vite).
    const shell = process.env.SHELL || '/bin/zsh';
    // Node's spawn does NOT expand a leading ~ in cwd (that's a shell feature),
    // so a manifest cwd of "~" or "~/foo" must be resolved to an absolute path
    // here — otherwise spawn fails with ENOENT and the service crash-loops.
    const cwd = expandHome(svc.manifest.cwd) ?? homedir();
    const child = this.spawner.spawn({
      argv: [shell, '-l', '-i', '-c', svc.manifest.command],
      cwd,
      env: { ...this.env, ...svc.manifest.env },
      graceMs: GRACE_MS,
    });
    svc.child = child;
    svc.startedAt = startedAt;
    this.pushLog(svc, `▶ ${svc.manifest.command}`);

    const onData = (chunk: Buffer | string) => {
      for (const raw of chunk.toString().split('\n')) {
        const line = stripControl(raw);
        if (line.trim()) this.pushLog(svc, line);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    void child.done.then((outcome) => {
      if (outcome.error) this.pushLog(svc, `✖ 启动失败：${outcome.error.message}`);
      this.onExit(svc, child, outcome.exitCode, outcome.signal);
    });
  }

  private onExit(svc: ManagedService, child: HostedProcess, code: number | null, signal: string | null): void {
    if (svc.child !== child) return;
    svc.child = undefined;
    svc.startedAt = undefined;
    svc.lastExit = { code, signal, at: Date.now() };
    this.pushLog(svc, `■ 退出 ${signal ?? code ?? '?'}`);
    if (svc.desired === 'running' && !svc.pendingRestart) {
      emitHostEvent(this.observe, { type: 'error', subject: `service:${svc.manifest.id}`, text: `服务 ${svc.manifest.id} 意外退出 ${signal ?? code ?? '?'}，未自动重启` });
    }
    if (svc.pendingRestart && svc.desired === 'running') {
      svc.pendingRestart = false;
      this.pushLog(svc, '↺ 重启中…');
      setTimeout(() => { if (svc.desired === 'running' && !svc.child) this.spawnSvc(svc); }, 500);
    }
    // No auto-restart for unexpected exits — user services are manually managed.
  }
}

/**
 * Strip terminal control noise from a captured log line: CSI (colors/cursor),
 * OSC (window title / shell-integration sequences like iTerm's), and stray
 * control bytes. Tabs are preserved; newlines are already split out upstream.
 */
function stripControl(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')       // CSI: ESC [ … final
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC: ESC ] … BEL|ST
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');        // leftover control bytes (keep \t, \n)
}

/** Expand a leading ~ (or ~/…) to the user's home dir; Node's spawn won't. */
function expandHome(p?: string): string | undefined {
  if (!p) return undefined;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (busy: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(busy);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}
