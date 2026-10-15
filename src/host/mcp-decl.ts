/**
 * The `mcp` block of butler.json: the Butler Framework MCP registration standard.
 * Dependency-free so the catalog can validate it without importing the hub.
 */
/** One `mcp` block from an extension's butler.json. */
export interface McpDecl {
  transport: 'stdio';
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Prefix of the public tool names; defaults to the extension id with `-` → `_`. */
  namespace?: string;
  /** Upper bound for one tools/call (default 600s). */
  timeoutSec?: number;
}

/** Env marker the Host sets for every MCP child; extensions may refuse to serve without it. */
export const MCP_CHANNEL_ENV = 'BUTLER_MCP_CHANNEL';
export const MCP_SEPARATOR = '__';
const NAMESPACE = /^[a-z][a-z0-9_]{0,23}$/;
export const MAX_CALL_TIMEOUT_SEC = 3600;

/** Parse and check one extension's `mcp` block; undefined when absent, throws on a bad block. */
export function parseMcpDecl(raw: unknown): McpDecl | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mcp 必须是对象');
  const m = raw as Record<string, unknown>;
  if (m.transport !== 'stdio') throw new Error('mcp.transport 目前只支持 stdio（工具不得自行对外监听 MCP）');
  if (!Array.isArray(m.command) || m.command.length === 0 || m.command.some((p) => typeof p !== 'string' || !p)) throw new Error('mcp.command 必须是非空字符串数组');
  if (m.cwd !== undefined && (typeof m.cwd !== 'string' || !m.cwd)) throw new Error('mcp.cwd 必须是非空字符串');
  if (m.env !== undefined && (!m.env || typeof m.env !== 'object' || Array.isArray(m.env) || Object.values(m.env).some((v) => typeof v !== 'string'))) throw new Error('mcp.env 必须是字符串字典');
  if (m.namespace !== undefined && (typeof m.namespace !== 'string' || !NAMESPACE.test(m.namespace))) throw new Error('mcp.namespace 须匹配 ^[a-z][a-z0-9_]{0,23}$');
  if (m.namespace !== undefined && (m.namespace as string).includes(MCP_SEPARATOR)) throw new Error('mcp.namespace 不得包含 "__"');
  const timeout = m.timeoutSec === undefined ? undefined : Number(m.timeoutSec);
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 5 || timeout > MAX_CALL_TIMEOUT_SEC)) throw new Error(`mcp.timeoutSec 须为 5–${MAX_CALL_TIMEOUT_SEC} 的整数`);
  return {
    transport: 'stdio',
    command: m.command as string[],
    ...(m.cwd !== undefined ? { cwd: m.cwd as string } : {}),
    ...(m.env !== undefined ? { env: m.env as Record<string, string> } : {}),
    ...(m.namespace !== undefined ? { namespace: m.namespace as string } : {}),
    ...(timeout !== undefined ? { timeoutSec: timeout } : {}),
  };
}

export function defaultNamespace(extensionId: string): string {
  let ns = extensionId.replace(/-+/g, '_').replace(/_+$/, '');
  if (!/^[a-z]/.test(ns)) ns = `x${ns}`;
  return ns.slice(0, 24).replace(/_+$/, '');
}
