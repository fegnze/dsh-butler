import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ButlerConfig } from './config.ts';
import type { ToolManifest, ToolAction } from './registry.ts';
import type { ServiceManifest } from './service-registry.ts';
import { parseDelegations, type DelegationDecl } from './delegations.ts';
import { parseMcpDecl } from './mcp-decl.ts';

/**
 * 扩展物发现：扫描实例的 scanRoots，每个含 `butler.json` 的子目录是一个扩展物。
 *
 * 这里只做"读清单 → 分类 → 翻译成托管层认的 manifest"；不校验 schema 的每条约束
 * （那是 spec/tests 的职责），只拒绝托管层无法工作的清单，并把原因记在 `rejected`。
 */

export type ButlerKind = 'tool' | 'service' | 'faculty';

export interface ButlerHosted {
  command: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  port?: number;
  url?: string;
  openPath?: string;
  group?: string;
  autoStart?: boolean;
  restart?: 'never' | 'on-failure' | 'always';
}

export interface ButlerHealth {
  url?: string;
  exec?: string[];
  intervalMs?: number;
}

/**
 * 卡片图标的公开形态。`text`（emoji/短文字）与 `url`（http(s)、data:image、站内绝对路径）
 * 直接携带值；`file` 是图片文件，真实路径不外露，由 Host 的 icon 路由按 id 提供，`v` 是声明值的
 * 短哈希，仅用于让浏览器在图标换文件时重新取图。
 */
export type ButlerIconView =
  | { type: 'text'; value: string }
  | { type: 'url'; value: string }
  | { type: 'file'; v: string };

export interface ButlerPanelSize {
  width?: number;
  height?: number;
}

export interface ButlerActionDecl {
  label: string;
  title?: string;
  url?: string;
  mode?: 'panel' | 'post' | 'external';
}

export interface ButlerReportDecl {
  id: string;
  name: string;
  exec: string[];
  shape?: 'status' | 'list' | 'markdown';
  schedule?: string;
}

export interface ButlerCommandDecl {
  id: string;
  description?: string;
  exec: string[];
  effect?: 'read' | 'write' | 'external';
  /**
   * Caller-supplied arguments, in order. `positional` appends the value;
   * otherwise `--<name> <value>` is appended. Values must match `pattern`
   * (anchored) and may never start with `-`. Undeclared keys are rejected.
   * An arg with `stdin: true` is not an argv value at all: it is written to
   * the child's stdin, so a body may be long, multi-line or start with `-`.
   */
  args?: Array<{ name: string; pattern: string; required?: boolean; positional?: boolean; stdin?: boolean }>;
}

export interface ButlerManifest {
  schemaVersion: 1;
  kind: ButlerKind;
  id: string;
  name: string;
  description?: string;
  /** 卡片图标：图片 URL、清单目录内的图片文件，或 emoji/短文字；缺省回退为名称字母。 */
  icon?: string;
  version?: number;
  frequency?: 'low';
  hosted?: ButlerHosted;
  health?: ButlerHealth;
  panelUrl?: string;
  panelSize?: ButlerPanelSize;
  actions?: ButlerActionDecl[];
  reports?: ButlerReportDecl[];
  commands?: ButlerCommandDecl[];
  /** 可委托给 Butler Session 的判断步骤（见 delegations.ts）；仅 tool / service。 */
  delegations?: unknown;
  /** 向 Butler 统一 MCP 服务注册的 MCP 提供方（见 mcp-hub.ts）；仅 tool / service。 */
  mcp?: unknown;
}

export interface DiscoveredExtension {
  /** 清单所在目录（绝对路径）。 */
  dir: string;
  manifest: ButlerManifest;
}

export interface RejectedExtension {
  dir: string;
  reason: string;
}

export interface CatalogScan {
  tools: DiscoveredExtension[];
  services: DiscoveredExtension[];
  faculties: DiscoveredExtension[];
  rejected: RejectedExtension[];
  scannedAt: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export async function scanCatalog(config: ButlerConfig): Promise<CatalogScan> {
  const scan: CatalogScan = { tools: [], services: [], faculties: [], rejected: [], scannedAt: new Date().toISOString() };
  const seen = new Set<string>();
  for (const root of config.scanRoots) {
    let entries: string[];
    try {
      // Symlinked directories count: registering a tool that lives elsewhere
      // links it in as tools/<id> (see register-tool.ts).
      const dirents = await readdir(root, { withFileTypes: true });
      entries = [];
      for (const e of dirents) {
        if (e.isDirectory()) entries.push(e.name);
        else if (e.isSymbolicLink() && (await stat(join(root, e.name)).catch(() => null))?.isDirectory()) entries.push(e.name);
      }
    } catch {
      continue; // 扫描根不存在不是错误：实例可以只有 tools/ 没有 services/
    }
    for (const name of entries.sort()) {
      const dir = join(root, name);
      const manifestPath = join(dir, 'butler.json');
      let raw: string;
      try {
        raw = await readFile(manifestPath, 'utf8');
      } catch {
        continue; // 没有清单的目录不是扩展物，静默跳过
      }
      let manifest: ButlerManifest;
      try {
        manifest = JSON.parse(raw) as ButlerManifest;
      } catch (error) {
        scan.rejected.push({ dir, reason: `butler.json 不是合法 JSON：${(error as Error).message}` });
        continue;
      }
      const reason = validate(manifest);
      if (reason) {
        scan.rejected.push({ dir, reason });
        continue;
      }
      if (seen.has(manifest.id)) {
        scan.rejected.push({ dir, reason: `id 重复：${manifest.id}` });
        continue;
      }
      seen.add(manifest.id);
      const found = { dir, manifest };
      if (manifest.kind === 'tool') scan.tools.push(found);
      else if (manifest.kind === 'service') scan.services.push(found);
      else scan.faculties.push(found);
    }
  }
  return scan;
}

/** 托管层能否工作的最小校验；完整 schema 约束由 spec/tests 保证。 */
function validate(m: ButlerManifest): string | null {
  if (m.schemaVersion !== 1) return `schemaVersion 必须为 1，得到 ${String(m.schemaVersion)}`;
  if (!['tool', 'service', 'faculty'].includes(m.kind)) return `kind 无效：${String(m.kind)}`;
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) return `id 无效：${String(m.id)}`;
  if (typeof m.name !== 'string' || m.name.length === 0) return 'name 缺失';
  if (m.kind === 'service' && !m.hosted) return 'service 必须有 hosted';
  if (m.hosted) {
    const c = m.hosted.command;
    if (typeof c === 'string' ? c.length === 0 : !Array.isArray(c) || c.length === 0) return 'hosted.command 无效';
  }
  if (m.delegations !== undefined) {
    if (m.kind === 'faculty') return 'faculty 不支持 delegations';
    try { parseDelegations(m.delegations, `${m.kind}:${m.id}`); } catch (error) { return (error as Error).message; }
  }
  if (m.mcp !== undefined) {
    if (m.kind === 'faculty') return 'faculty 不支持 mcp';
    try { parseMcpDecl(m.mcp); } catch (error) { return (error as Error).message; }
  }
  return null;
}

/** 扫描结果里所有 tool / service 声明的委托，键为 `<extensionId>/<delegationId>`。 */
export function collectDelegations(scan: CatalogScan): Map<string, DelegationDecl> {
  const out = new Map<string, DelegationDecl>();
  for (const { manifest: m } of [...scan.tools, ...scan.services]) {
    for (const decl of parseDelegations(m.delegations, `${m.kind}:${m.id}`)) out.set(`${m.id}/${decl.id}`, decl);
  }
  return out;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico)$/i;

/** 卡片图标可服务的图片扩展名 → Content-Type。 */
export const ICON_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
};

/**
 * 把清单里的 `icon` 字符串归类。空串/非字符串视为未配置，返回 undefined（卡片回退到字母）。
 * 判定顺序：URL / data:image / 站内绝对路径 → 图片文件（扩展名） → 其余当作 emoji/短文字。
 */
export function iconView(raw: unknown): ButlerIconView | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return { type: 'url', value };
  if (IMAGE_EXT.test(value)) return { type: 'file', v: createHash('sha256').update(value).digest('hex').slice(0, 8) };
  return { type: 'text', value: value.slice(0, 8) };
}

/** 清单内相对路径以清单目录为基准。 */
function resolveIn(dir: string, p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  return isAbsolute(p) ? p : resolve(dir, p);
}

/** exec/command 向量：`bun` 保留给托管层解析；`python` 替换为实例解释器；相对脚本路径按清单目录解析。 */
export function resolveArgv(dir: string, argv: string[], config: ButlerConfig): string[] {
  const [head, ...rest] = argv;
  let executable = head;
  if (head === 'python' && config.python) executable = config.python;
  else if (head === 'bun' && config.bun) executable = config.bun;
  else if (head !== 'bun' && !isAbsolute(head) && (head.startsWith('./') || head.startsWith('../') || head.includes('/'))) executable = resolve(dir, head);
  const args = rest.map((a) => (a.startsWith('./') || a.startsWith('../') ? resolve(dir, a) : a));
  return [executable, ...args];
}

/**
 * tool（含托管块）→ Supervisor 认的 ToolManifest。
 * 没有 hosted 的 tool 不进 Supervisor（它只有 actions，没有常驻进程）。
 */
export function toToolManifest(found: DiscoveredExtension, config: ButlerConfig): ToolManifest | null {
  const { dir, manifest: m } = found;
  if (!m.hosted) return null;
  const command = typeof m.hosted.command === 'string'
    ? ['/bin/sh', '-lc', m.hosted.command]
    : resolveArgv(dir, m.hosted.command, config);
  const actions: ToolAction[] | undefined = m.actions?.filter((a) => a.url).map((a) => ({
    label: a.label,
    title: a.title,
    url: a.url!,
    ...(a.mode === 'post' ? { method: 'POST' as const } : {}),
    ...(a.mode === 'external' ? { target: 'external' as const } : {}),
  }));
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    icon: iconView(m.icon),
    command,
    cwd: resolveIn(dir, m.hosted.cwd) ?? dir,
    env: m.hosted.env,
    healthUrl: m.health?.url ?? (m.hosted.port ? `http://127.0.0.1:${m.hosted.port}/health/live` : undefined),
    panelUrl: m.panelUrl,
    panelSize: m.panelSize,
    actions,
    frequency: m.frequency,
    autoStart: m.hosted.autoStart ?? false,
  };
}

/** service → ServiceManager 认的 ServiceManifest。 */
export function toServiceManifest(found: DiscoveredExtension, config: ButlerConfig): ServiceManifest {
  const { dir, manifest: m } = found;
  const hosted = m.hosted!;
  const command = typeof hosted.command === 'string'
    ? hosted.command
    : resolveArgv(dir, hosted.command, config).map(shellQuote).join(' ');
  return {
    id: m.id,
    name: m.name,
    ...(m.description?.trim() ? { description: m.description.trim() } : {}),
    ...(iconView(m.icon) ? { icon: iconView(m.icon) } : {}),
    command,
    cwd: resolveIn(dir, hosted.cwd) ?? dir,
    port: hosted.port,
    url: hosted.url,
    openPath: resolveIn(dir, hosted.openPath),
    env: hosted.env,
    group: hosted.group,
    frequency: m.frequency,
    autoStart: hosted.autoStart ?? false,
  };
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
