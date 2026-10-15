import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';


/**
 * What a direct link is allowed to open.
 *
 * Entries are user data now, so the shape — not a reviewer — has to hold the
 * security line. Every variant below compiles to a fixed argument vector for
 * `/usr/bin/open`; there is no variant that carries a command, an interpreter,
 * or a shell string, so a hand-edited config file cannot grow into arbitrary
 * execution no matter what is typed into it.
 */
export type QuickActionTarget =
  /** Reveal a local path. */
  | { kind: 'path'; path: string }
  /** Reveal a local file. */
  | { kind: 'file'; path: string }
  /** Open a path with a named application, or just launch the application. */
  | { kind: 'app'; app: string; path?: string }
  /** Hand a URL to the system handler, scheme-allowlisted. */
  | { kind: 'url'; url: string };

export interface QuickActionEntry {
  id: string;
  label: string;
  description?: string;
  category?: string;
  favorite?: boolean;
  target: QuickActionTarget;
}

/**
 * URL schemes a direct link may hand to the system.
 *
 * An allowlist rather than a denylist: macOS resolves unknown schemes through
 * whatever app claimed them, so "everything except the few I thought of" is not
 * a boundary anyone can reason about.
 */
export const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'obsidian:', 'vscode:', 'raycast:', 'shortcuts:'] as const;

/** Generic shipped entries; each instance can point them at its own work directory. */
export function defaultQuickActions(workdir = homedir()): QuickActionEntry[] {
  return [
    { id: 'finder', label: 'Butler 工作目录', target: { kind: 'path', path: workdir } },
    { id: 'terminal', label: 'Butler 终端', target: { kind: 'app', app: 'Terminal', path: workdir } },
    { id: 'wiki', label: 'Butler Wiki', target: { kind: 'url', url: 'obsidian://open?vault=Butler' } },
  ];
}

type OpenExecutor = (file: string, args: readonly string[]) => Promise<unknown>;

export interface QuickActionConfig {
  items: QuickActionEntry[];
  enabled: string[];
  order: string[];
  updatedAt?: string;
}

/** Dashboard-owned direct links: both the entries and their display order. */
export class QuickActionConfigStore {
  readonly root: string;
  readonly path: string;
  readonly workdir: string;

  constructor(
    root = process.env.BUTLER_STATE_DIR ?? join(homedir(), '.dsh', 'butler', '.state'),
    workdir = process.env.BUTLER_INSTANCE_ROOT ?? join(homedir(), '.dsh', 'butler'),
  ) {
    this.root = root;
    this.path = join(root, 'quick-actions.json');
    this.workdir = workdir;
  }

  async read(): Promise<QuickActionConfig> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return defaultQuickActionConfig(this.workdir);
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return normalizeQuickActionConfig(parsed, typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined, this.workdir);
    } catch {
      // A hand-edited file with a typo must not take the panel down. Fall back
      // to the shipped entries and leave the broken file alone for the owner
      // to look at.
      return defaultQuickActionConfig(this.workdir);
    }
  }

  async update(input: unknown): Promise<QuickActionConfig> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('直达入口配置必须是对象');
    const value = input as { items?: unknown; enabled?: unknown; order?: unknown };
    const current = await this.read();
    const items = value.items === undefined ? current.items : parseQuickActionEntries(value.items);
    const known = items.map((item) => item.id);
    const enabled = value.enabled === undefined
      ? current.enabled.filter((id) => known.includes(id))
      : parseQuickActionIds(value.enabled, 'enabled', known);
    const order = value.order === undefined
      ? current.order.filter((id) => known.includes(id))
      : parseQuickActionIds(value.order, 'order', known);
    const config = normalizeQuickActionConfig({ items, enabled, order }, new Date().toISOString());
    await this.write(config);
    return config;
  }

  private async write(config: QuickActionConfig): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

export function defaultQuickActionConfig(workdir = homedir()): QuickActionConfig {
  const items = defaultQuickActions(workdir).map(cloneEntry);
  const ids = items.map((item) => item.id);
  return { items, enabled: [...ids], order: [...ids] };
}

function cloneEntry(entry: QuickActionEntry): QuickActionEntry {
  return { id: entry.id, label: entry.label, ...(entry.description ? { description: entry.description } : {}), ...(entry.category ? { category: entry.category } : {}), ...(entry.favorite !== undefined ? { favorite: entry.favorite } : {}), target: { ...entry.target } };
}

/**
 * Validate a user-supplied entry list.
 *
 * Throws rather than filtering: a silently dropped entry reads as "the config
 * did not save", which is the same symptom as a broken write and sends you
 * looking in the wrong place.
 */
export function parseQuickActionEntries(value: unknown): QuickActionEntry[] {
  if (!Array.isArray(value)) throw new Error('items 必须是数组');
  if (value.length > 64) throw new Error('直达入口最多 64 条');
  const entries: QuickActionEntry[] = [];
  for (const raw of value) {
    const entry = parseQuickActionEntry(raw);
    if (entries.some((item) => item.id === entry.id)) throw new Error(`直达入口 id 重复：${entry.id}`);
    entries.push(entry);
  }
  return entries;
}

export function parseQuickActionEntry(value: unknown): QuickActionEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('直达入口必须是对象');
  const raw = value as { id?: unknown; label?: unknown; target?: unknown };
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.id)) {
    throw new Error('直达入口 id 只能是小写字母、数字、连字符或下划线');
  }
  if (typeof raw.label !== 'string' || raw.label.trim() === '' || raw.label.length > 64) {
    throw new Error(`直达入口 ${raw.id} 的名称必须是 1–64 个字符`);
  }
  const optional = value as { description?: unknown; category?: unknown; favorite?: unknown };
  return {
    id: raw.id,
    label: raw.label.trim(),
    ...(typeof optional.description === 'string' && optional.description.trim() ? { description: optional.description.trim().slice(0, 200) } : {}),
    ...(typeof optional.category === 'string' && optional.category.trim() ? { category: optional.category.trim().slice(0, 32) } : {}),
    ...(typeof optional.favorite === 'boolean' ? { favorite: optional.favorite } : {}),
    target: parseQuickActionTarget(raw.target, raw.id),
  };
}

function parseQuickActionTarget(value: unknown, id: string): QuickActionTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`直达入口 ${id} 缺少打开目标`);
  const raw = value as { kind?: unknown; path?: unknown; app?: unknown; url?: unknown };
  if (raw.kind === 'path') return { kind: 'path', path: parsePath(raw.path, id) };
  if (raw.kind === 'file') return { kind: 'file', path: parsePath(raw.path, id) };
  if (raw.kind === 'app') {
    if (typeof raw.app !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/.test(raw.app)) {
      throw new Error(`直达入口 ${id} 的应用名无效`);
    }
    const target: QuickActionTarget = { kind: 'app', app: raw.app };
    if (raw.path !== undefined) target.path = parsePath(raw.path, id);
    return target;
  }
  if (raw.kind === 'url') return { kind: 'url', url: parseUrl(raw.url, id) };
  throw new Error(`直达入口 ${id} 的 kind 只能是 path / file / app / url`);
}

/**
 * Accept an absolute path, or `~`-relative, and reject anything `open` would
 * read as a flag.
 */
function parsePath(value: unknown, id: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`直达入口 ${id} 的路径不能为空`);
  const raw = value.trim();
  if (raw.includes('\0')) throw new Error(`直达入口 ${id} 的路径包含非法字符`);
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  // A leading '-' would be consumed by `open` as an option rather than an
  // operand. We reject instead of prefixing `--`, so the stored value always
  // means exactly what it looks like.
  if (expanded.startsWith('-')) throw new Error(`直达入口 ${id} 的路径不能以 - 开头`);
  if (!isAbsolute(expanded)) throw new Error(`直达入口 ${id} 的路径必须是绝对路径或以 ~/ 开头`);
  return normalize(expanded);
}

function parseUrl(value: unknown, id: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`直达入口 ${id} 的链接不能为空`);
  const raw = value.trim();
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error(`直达入口 ${id} 的链接格式无效`); }
  if (!(ALLOWED_URL_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    throw new Error(`直达入口 ${id} 的协议不在允许列表内：${parsed.protocol}`);
  }
  return raw;
}

function parseQuickActionIds(value: unknown, field: string, known: string[]): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !known.includes(item)) throw new Error(`${field} 包含未知直达入口`);
    if (!ids.includes(item)) ids.push(item);
  }
  return ids;
}

function normalizeQuickActionConfig(
  input: { items?: unknown; enabled?: unknown; order?: unknown },
  updatedAt?: string,
  workdir = homedir(),
): QuickActionConfig {
  // An older config file carried only enabled/order over the three built-ins.
  const items = input.items === undefined ? defaultQuickActions(workdir).map(cloneEntry) : keepValidEntries(input.items, workdir);
  const all = items.map((item) => item.id);
  const order = Array.isArray(input.order) ? input.order.filter((id): id is string => typeof id === 'string' && all.includes(id)) : all;
  const enabled = Array.isArray(input.enabled) ? input.enabled.filter((id): id is string => typeof id === 'string' && all.includes(id)) : all;
  return { items, enabled: [...new Set(enabled)], order: [...new Set([...order, ...all])], updatedAt };
}

/**
 * Reading is lenient where writing is strict: one bad entry in a hand-edited
 * file drops that entry, not the whole panel.
 */
function keepValidEntries(value: unknown, workdir = homedir()): QuickActionEntry[] {
  if (!Array.isArray(value)) return defaultQuickActions(workdir).map(cloneEntry);
  const entries: QuickActionEntry[] = [];
  for (const raw of value) {
    try {
      const entry = parseQuickActionEntry(raw);
      if (!entries.some((item) => item.id === entry.id)) entries.push(entry);
    } catch { /* skip the malformed entry, keep the rest usable */ }
  }
  return entries;
}

export function findQuickAction(config: QuickActionConfig, id: string): QuickActionEntry | undefined {
  return config.items.find((item) => item.id === id);
}

/** The exact, non-shell argument vector a target compiles to. */
export function quickActionArgs(target: QuickActionTarget): string[] {
  if (target.kind === 'path' || target.kind === 'file') return [target.path];
  if (target.kind === 'url') return [target.url];
  return target.path === undefined ? ['-a', target.app] : ['-a', target.app, target.path];
}

export async function runQuickAction(
  entry: QuickActionEntry,
  execute: OpenExecutor,
): Promise<{ ok: true; action: string; label: string }> {
  await execute('/usr/bin/open', quickActionArgs(entry.target));
  return { ok: true, action: entry.id, label: entry.label };
}
