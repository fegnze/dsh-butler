import { cp, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Configuration owned by one Butler work directory (`butler.json`). */
export interface ButlerConfig {
  /** Work directory; all relative paths are resolved against it. */
  instanceRoot: string;
  /** Scan roots (absolute paths) containing extension directories. */
  scanRoots: string[];
  /** Butler-owned data tree, injected as BUTLER_SELF_ROOT. */
  selfRoot: string;
  /** Root that formal-card validity checks resolve against (default: instance root), injected as BUTLER_VALIDITY_ROOT. */
  validityRoot?: string;
  /** Interpreter used when a manifest starts with `python`. */
  python?: string;
  /** Interpreter used when a manifest starts with `bun`. */
  bun?: string;
  /** Plugin state (quick actions, layout and future settings). */
  stateDir: string;
  /** Child-process logs. */
  logDir: string;
  /** Optional host notification transport. */
  notification: { enabled: boolean; command?: string[] };
  /** Optional external endpoint settings, consumed by the collector milestone. */
  endpoints: Record<string, unknown>;
  /** DSH session collector: turn/end → journal intake, filtered by cwd and preset. */
  collector: { enabled: boolean; workspaces: string[]; excludePresets: string[]; includeSubagents: boolean; debounceMs: number };
  /** agent/pre-step context injection of self/build/context.md (M3). */
  inject: { enabled: boolean; workspaces: string[]; excludePresets: string[]; includeSubagents: boolean; maxChars: number };
  /** Optional DSH automation settings, consumed by the automation milestone. */
  automations: Record<string, unknown>;
}

export const CONFIG_FILE = 'butler.json';

/**
 * The Host publishes its resolved work directory here so the agent-scoped
 * half (a separate bundle in the same process) reads the same instance
 * without a second copy of the plugin config.
 */
export const WORKDIR_KEY = Symbol.for('myspace-butler.workdir');
export function publishWorkdir(path: string | undefined): void {
  (globalThis as Record<symbol, unknown>)[WORKDIR_KEY] = path;
}
export function publishedWorkdir(): string | undefined {
  const value = (globalThis as Record<symbol, unknown>)[WORKDIR_KEY];
  return typeof value === 'string' && value ? value : undefined;
}

/** Both source modules and the bundled dsh/host.js resolve package assets here. */
export function packageRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return basename(moduleDir) === 'dsh' ? dirname(moduleDir) : resolve(moduleDir, '../..');
}

export interface RawConfig {
  scanRoots?: string[];
  selfRoot?: string;
  validityRoot?: string;
  python?: string;
  bun?: string;
  stateDir?: string;
  logDir?: string;
  endpoints?: Record<string, unknown>;
  notification?: { command?: string[]; enabled?: boolean };
  automations?: Record<string, unknown>;
  collector?: { enabled?: boolean; workspaces?: string[]; excludePresets?: string[]; includeSubagents?: boolean; debounceMs?: number };
  inject?: { enabled?: boolean; workspaces?: string[]; excludePresets?: string[]; includeSubagents?: boolean; maxChars?: number };
}

export function defaultWorkdir(): string {
  return join(homedir(), '.dsh', 'butler');
}

/** Locate a workdir's only supported config file. */
export async function locateConfig(workdir: string): Promise<{ path: string; exists: boolean }> {
  const root = resolve(expandHome(workdir));
  const path = join(root, CONFIG_FILE);
  try {
    await readFile(path);
    return { path, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, exists: false };
    throw error;
  }
}

/** Seed an unconfigured work directory, preserving every existing file. */
export async function ensureWorkdir(workdir: string, skeletonDir: string): Promise<{ path: string; created: boolean }> {
  const root = resolve(expandHome(workdir));
  const located = await locateConfig(root);
  if (located.exists) return { path: located.path, created: false };
  await mkdir(root, { recursive: true });
  await cp(skeletonDir, root, { recursive: true, force: false, errorOnExist: false });
  const initialized = await locateConfig(root);
  if (!initialized.exists) throw new Error(`初始化 Butler 工作目录失败：${initialized.path}`);
  return { path: initialized.path, created: true };
}

export async function locateButlerConfig(startDir = process.cwd()): Promise<string> {
  if (process.env.BUTLER_CONFIG) return resolve(process.env.BUTLER_CONFIG);
  if (process.env.BUTLER_INSTANCE_ROOT) return (await locateConfig(process.env.BUTLER_INSTANCE_ROOT)).path;
  let dir = resolve(startDir);
  for (;;) {
    const found = await locateConfig(dir);
    if (found.exists) return found.path;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到 ${CONFIG_FILE}：请设置 BUTLER_CONFIG 或 BUTLER_INSTANCE_ROOT`);
}

export async function loadButlerConfig(path?: string): Promise<ButlerConfig> {
  const configPath = path ?? (await locateButlerConfig());
  const instanceRoot = dirname(configPath);
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as RawConfig;
  return fromRaw(instanceRoot, raw);
}

export function fromRaw(instanceRoot: string, raw: RawConfig): ButlerConfig {
  const abs = (value: string) => isAbsolute(value) ? value : resolve(instanceRoot, expandHome(value));
  const scanRoots = (raw.scanRoots ?? ['tools', 'services', 'faculties']).map(abs);
  const notification = raw.notification ?? {};
  if (notification.command !== undefined && (!Array.isArray(notification.command) || notification.command.length === 0 || notification.command.some((value) => typeof value !== 'string' || !value))) {
    throw new Error('notification.command 必须是非空命令数组');
  }
  return {
    instanceRoot,
    scanRoots,
    selfRoot: abs(raw.selfRoot ?? 'self'),
    validityRoot: abs(raw.validityRoot ?? '.'),
    python: raw.python ? abs(raw.python) : undefined,
    bun: raw.bun ? abs(raw.bun) : undefined,
    stateDir: raw.stateDir ? abs(raw.stateDir) : join(instanceRoot, '.state'),
    logDir: raw.logDir ? abs(raw.logDir) : join(instanceRoot, '.state', 'logs'),
    notification: { enabled: notification.enabled !== false, command: notification.command },
    endpoints: raw.endpoints ?? {},
    collector: {
      enabled: raw.collector?.enabled !== false,
      workspaces: Array.isArray(raw.collector?.workspaces) ? raw.collector.workspaces : [],
      excludePresets: Array.isArray(raw.collector?.excludePresets) ? raw.collector.excludePresets : ['butler'],
      includeSubagents: raw.collector?.includeSubagents === true,
      debounceMs: typeof raw.collector?.debounceMs === 'number' && raw.collector.debounceMs >= 0 ? raw.collector.debounceMs : 2_000,
    },
    inject: {
      enabled: raw.inject?.enabled !== false,
      workspaces: Array.isArray(raw.inject?.workspaces) ? raw.inject.workspaces : [],
      excludePresets: Array.isArray(raw.inject?.excludePresets) ? raw.inject.excludePresets : ['butler'],
      includeSubagents: raw.inject?.includeSubagents === true,
      maxChars: typeof raw.inject?.maxChars === 'number' && raw.inject.maxChars >= 500 ? raw.inject.maxChars : 8_000,
    },
    automations: raw.automations ?? {},
  };
}

/** Environment forwarded explicitly to a Butler extension child. */
export function butlerEnv(config: ButlerConfig, extra: Record<string, string> = {}): Record<string, string> {
  const sdkPath = join(packageRoot(), 'sdk', 'py');
  const env: Record<string, string> = {
    BUTLER_SELF_ROOT: config.selfRoot,
    BUTLER_INSTANCE_ROOT: config.instanceRoot,
    BUTLER_VALIDITY_ROOT: config.validityRoot ?? config.instanceRoot,
    BUTLER_STATE_DIR: config.stateDir,
    BUTLER_LOG_DIR: config.logDir,
    BUTLER_SDK_PY: sdkPath,
    // Kept as compatibility aliases for existing extensions while the generic
    // names become the documented contract.
    BUTLER_GUARDIAN_STATE_DIR: config.stateDir,
    BUTLER_GUARDIAN_LOG_DIR: config.logDir,
  };
  if (config.python) env.BUTLER_PYTHON = config.python;
  if (config.bun) env.BUTLER_BUN = config.bun;
  return { ...env, ...extra };
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}
