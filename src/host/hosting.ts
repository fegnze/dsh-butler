/**
 * Process hosting seam.
 *
 * Tools and services are child processes of whoever hosts Butler. Inside DSH
 * that is the App itself, through its `subprocess` service: every child lives
 * in a managed range that the App terminates (TERM, grace, KILL) when it shuts
 * down or the plugin is unloaded, so "quit the App" and "nothing left behind"
 * are the same event. The hosting classes never touch `node:child_process`
 * themselves; they ask a {@link Spawner}, and the test suite hands them a
 * plain Node one so they run under `bun test` without a DSH around.
 */
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { scanCatalog, toServiceManifest, toToolManifest, type CatalogScan } from './catalog.ts';
import { butlerEnv, type ButlerConfig } from './config.ts';
import { createMcpHub, type McpHub } from './mcp-hub.ts';
import { ServiceManager } from './service-manager.ts';
import { Supervisor } from './supervisor.ts';

/**
 * L0 hard observation: a fact the host itself witnessed (crash, catalog
 * change). The sink forwards it to journal intake; it must never throw into
 * the hosting path, so callers go through {@link emitHostEvent}.
 */
/** Host version reported to MCP clients and /health. */
export const HOST_VERSION = '0.10.0';

export interface HostEvent {
  type: 'error' | 'note';
  /** Stable subject, e.g. `tool:<id>`, `service:<id>`, `catalog:<id>`. */
  subject: string;
  text: string;
}
export type HostEventSink = (event: HostEvent) => void;

export function emitHostEvent(sink: HostEventSink | undefined, event: HostEvent): void {
  if (!sink) return;
  try { sink(event); } catch { /* observation is best-effort; hosting must keep running */ }
}

export interface HostedOutcome {
  exitCode: number | null;
  signal: string | null;
  /** Spawn failure (ENOENT, EACCES…); the process never ran. */
  error?: Error;
}

export interface HostedSpawnSpec {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: 'ignore' | 'pipe' | { data: string };
  /** TERM-to-KILL grace. */
  graceMs: number;
}

export interface HostedProcess {
  readonly pid: number | undefined;
  readonly stdin?: Writable;
  readonly stdout: Readable | undefined;
  readonly stderr: Readable | undefined;
  /** Settles exactly once, on exit or on spawn failure; never rejects. */
  readonly done: Promise<HostedOutcome>;
  /** TERM the whole process group, KILL after the grace. Idempotent. */
  terminate(): void | Promise<void>;
}

export interface Spawner {
  spawn(spec: HostedSpawnSpec): HostedProcess;
  /** Stop and join this plugin's managed ranges, including finite commands. */
  shutdown?(): Promise<void>;
}

export interface HostedCommandResult extends HostedOutcome {
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const COMMAND_OUTPUT_LIMIT = 2 * 1024 * 1024;

/** Run a finite faculty command through the same managed subprocess seam. */
export async function runHostedCommand(
  spawner: Spawner,
  spec: HostedSpawnSpec,
  timeoutMs = 120_000,
): Promise<HostedCommandResult> {
  let child: HostedProcess;
  try {
    child = spawner.spawn({ ...spec, stdin: spec.stdin ?? 'ignore' });
  } catch (error) {
    const spawnError = error instanceof Error ? error : new Error(String(error));
    return { exitCode: null, signal: null, error: spawnError, timedOut: false, stdout: '', stderr: '' };
  }
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer | string) => { stdout = appendTail(stdout, chunk, COMMAND_OUTPUT_LIMIT); });
  child.stderr?.on('data', (chunk: Buffer | string) => { stderr = appendTail(stderr, chunk, COMMAND_OUTPUT_LIMIT); });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { void child.terminate(); } catch { /* the process may already have exited */ }
  }, timeoutMs);
  timer.unref();
  try {
    const outcome = await child.done;
    return { ...outcome, timedOut, stdout, stderr };
  } catch (error) {
    return { exitCode: null, signal: null, error: error instanceof Error ? error : new Error(String(error)), timedOut, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function appendTail(current: string, chunk: Buffer | string, limit: number): string {
  const next = current + String(chunk);
  return next.length > limit ? next.slice(-limit) : next;
}

function failedHostedProcess(error: unknown): HostedProcess {
  return {
    pid: undefined,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    done: Promise.resolve({ exitCode: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) }),
    terminate() {},
  };
}

export interface NotificationPayload {
  title: string;
  body: string;
  subtitle?: string;
  sound?: boolean;
  action?: string;
}

export type NotificationSender = (command: string[] | undefined, payload: NotificationPayload) => void;

/** Fire-and-forget notifications through the same managed subprocess seam. */
export function createNotificationSender(spawner: Spawner): NotificationSender {
  return (command, payload) => {
    const argv = command ?? ['osascript', '-e', notificationScript(payload)];
    void runHostedCommand(spawner, {
      argv,
      cwd: homedir(),
      stdin: command ? { data: JSON.stringify({ ...payload, body: payload.body.slice(0, 2000), subtitle: (payload.subtitle ?? '').slice(0, 300), action: payload.action ?? 'open-dsh' }) } : 'ignore',
      graceMs: 5_000,
    }, 15_000).then((result) => {
      if (result.error || result.timedOut || result.exitCode !== 0) console.warn('[butler] notification failed', result.error?.message ?? (result.timedOut ? 'timed out' : result.exitCode));
    });
  };
}

function notificationScript(payload: NotificationPayload): string {
  const esc = (value: string) => String(value ?? '').replace(/[\\"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
  let script = `display notification "${esc(payload.body)}" with title "${esc(payload.title)}"`;
  if (payload.subtitle) script += ` subtitle "${esc(payload.subtitle)}"`;
  if (payload.sound) script += ' sound name "Basso"';
  return script;
}

/** Shape of DSH's `ctx.subprocess` this file relies on (kept narrow on purpose). */
export interface SubprocessRuntimeLike {
  spawn(spec: {
    argv: readonly string[];
    cwd: string;
    stdio: { stdin: 'ignore' | 'pipe' | { data: string }; stdout: 'pipe'; stderr: 'pipe' };
    graceMs: number;
    env?: Record<string, string>;
  }): {
    readonly stdin: Writable | undefined;
    readonly stdout: Readable | undefined;
    readonly stderr: Readable | undefined;
    readonly done: Promise<{ exitCode: number | null; signal: string | null }>;
    waitForExit(signal?: AbortSignal): Promise<boolean>;
    terminate(): void | Promise<void>;
  };
}

/** Spawn through DSH's subprocess service: managed ranges, App-lifetime teardown. */
export function createSubprocessSpawner(runtime: SubprocessRuntimeLike): Spawner {
  const live = new Map<ReturnType<SubprocessRuntimeLike['spawn']>, Promise<void>>();
  let closed = false;
  return {
    spawn(spec) {
      if (closed) return failedHostedProcess(new Error('Butler Host is shutting down'));
      let handle: ReturnType<SubprocessRuntimeLike['spawn']>;
      const stdin = spec.stdin ?? 'ignore';
      try {
        handle = runtime.spawn({
          argv: spec.argv,
          cwd: spec.cwd,
          env: spec.env,
          stdio: { stdin, stdout: 'pipe', stderr: 'pipe' },
          graceMs: spec.graceMs,
        });
      } catch (error) {
        return {
          pid: undefined, stdin: undefined, stdout: undefined, stderr: undefined,
          done: Promise.resolve({ exitCode: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) }),
          terminate() {},
        };
      }
      const done = handle.done.then(
        (outcome) => ({ exitCode: outcome.exitCode, signal: outcome.signal }),
        (error: unknown) => ({ exitCode: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) }),
      );
      const exited = Promise.all([done, handle.waitForExit()]).then(() => undefined);
      live.set(handle, exited);
      void exited.then(() => live.delete(handle), () => live.delete(handle));
      return {
        // DSH's handle deliberately does not expose a pid (the managed range,
        // not one process, is the unit it owns). Status rows treat pid as
        // optional, so an honest `undefined` is better than a guess.
        pid: undefined,
        stdin: handle.stdin,
        stdout: handle.stdout,
        stderr: handle.stderr,
        done,
        terminate: () => { void handle.terminate(); },
      };
    },
    async shutdown() {
      closed = true;
      const pending = [...live.entries()];
      for (const [handle] of pending) {
        try { await handle.terminate(); } catch { /* provider teardown will force-stop */ }
      }
      await Promise.allSettled(pending.map(([, exited]) => exited));
    },
  };
}

/** Everything the HTTP face and the lifecycle need, wired from one config. */
export interface Hosting {
  config: ButlerConfig;
  spawner: Spawner;
  supervisor: Supervisor;
  serviceManager: ServiceManager;
  catalog: CatalogScan;
  /** Butler's single outward MCP endpoint; providers follow the catalog. */
  mcp: McpHub;
  /** Re-scan the work directory and reconcile both hosting tables. */
  rescan(): Promise<CatalogScan>;
  /** Start every `autoStart` tool and service. */
  autoStart(): void;
  /** Stop everything; what the plugin's teardown effect calls. */
  shutdown(): Promise<void>;
}

/**
 * Bring up the hosting layer for one work directory.
 *
 * `baseUrl` is where extensions reach the HTTP face (`BUTLER_HOST_URL`): inside
 * DSH that is the App's own web server plus this plugin's prefix.
 */
export async function createHosting(config: ButlerConfig, spawner: Spawner, baseUrl: string, observe?: HostEventSink): Promise<Hosting> {
  const env = hostedEnv(config, baseUrl);
  const supervisor = new Supervisor(spawner, config.logDir, env, observe);
  const serviceManager = new ServiceManager(spawner, env, observe);
  const initial = await scanCatalog(config);
  const mcp = createMcpHub({
    spawner, config, env, scan: initial, endpoint: `${baseUrl}/api/mcp`, version: HOST_VERSION,
    warn: (message) => emitHostEvent(observe, { type: 'error', subject: 'mcp', text: message }),
  });
  const hosting: Hosting = {
    config,
    spawner,
    supervisor,
    serviceManager,
    catalog: initial,
    mcp,
    async rescan() {
      const next = await scanCatalog(config);
      applyCatalog(next, config, supervisor, serviceManager);
      mcp.sync(next);
      for (const event of catalogDiff(hosting.catalog, next)) emitHostEvent(observe, event);
      hosting.catalog = next;
      return next;
    },
    autoStart() {
      supervisor.autoStart();
      serviceManager.autoStart();
    },
    async shutdown() {
      mcp.shutdown();
      supervisor.shutdown();
      serviceManager.shutdown();
      await spawner.shutdown?.();
    },
  };
  applyCatalog(hosting.catalog, config, supervisor, serviceManager);
  return hosting;
}

/** Extensions that appeared or disappeared between two scans (boot scan excluded by construction). */
export function catalogDiff(before: CatalogScan, after: CatalogScan): HostEvent[] {
  const ids = (scan: CatalogScan) => new Map([...scan.tools, ...scan.services, ...scan.faculties].map((ext) => [ext.manifest.id, ext.manifest.kind] as const));
  const old = ids(before);
  const now = ids(after);
  const events: HostEvent[] = [];
  for (const [id, kind] of now) if (!old.has(id)) events.push({ type: 'note', subject: `catalog:${id}`, text: `Butler 扫描新增 ${kind} ${id}` });
  for (const [id, kind] of old) if (!now.has(id)) events.push({ type: 'note', subject: `catalog:${id}`, text: `Butler 扫描移除 ${kind} ${id}` });
  return events;
}

/**
 * The environment every hosted child starts from.
 *
 * The App launched from Finder carries a minimal PATH, so the interpreters the
 * work directory points at are put in front of it; a tool that shells out to
 * `bun` or `python` then finds the same ones its manifest resolves to.
 */
export function hostedEnv(config: ButlerConfig, baseUrl: string): Record<string, string> {
  const extra = butlerEnv(config, { BUTLER_HOST_URL: baseUrl, BUTLER_GUARDIAN_URL: baseUrl });
  const dirs = [config.bun, config.python].filter((p): p is string => Boolean(p)).map((p) => dirname(p));
  for (const candidate of ['/opt/homebrew/bin', '/usr/local/bin']) if (!dirs.includes(candidate)) dirs.push(candidate);
  const current = (process.env.PATH ?? '').split(':').filter(Boolean);
  const path = [...dirs.filter((d) => !current.includes(d)), ...current].join(':');
  return { ...extra, PATH: path };
}

/**
 * 把扫描结果同步进托管层：新出现的注册，消失的停止并注销，仍在的保持运行态不动。
 * 这就是"目录里出现清单 → 操作台出现一行；删掉目录 → 消失"的全部机制。
 */
export function applyCatalog(scan: CatalogScan, config: ButlerConfig, supervisor: Supervisor, serviceManager: ServiceManager): void {
  const wantTools = new Map(scan.tools.flatMap((t) => {
    const manifest = toToolManifest(t, config);
    return manifest ? [[t.manifest.id, manifest] as const] : [];
  }));
  for (const id of supervisor.ids()) if (!wantTools.has(id)) supervisor.unregister(id);
  for (const [id, manifest] of wantTools) {
    if (!manifest) continue;
    if (supervisor.ids().includes(id)) supervisor.update(manifest);
    else supervisor.register(manifest);
  }

  const wantServices = new Map(scan.services.map((s) => [s.manifest.id, toServiceManifest(s, config)] as const));
  for (const id of serviceManager.ids()) if (!wantServices.has(id)) serviceManager.remove(id);
  for (const [id, manifest] of wantServices) {
    if (serviceManager.ids().includes(id)) serviceManager.update(manifest);
    else serviceManager.register(manifest);
  }
}
