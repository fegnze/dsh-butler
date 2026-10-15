/**
 * Butler MCP hub: the one MCP endpoint Butler exposes to the outside.
 *
 * Layering (see README "MCP"):
 *   - Framework: an extension that has MCP tools declares an `mcp` block in its
 *     butler.json (`transport: "stdio"` + `command`). That declaration is the
 *     whole registration; there is no second registry.
 *   - Host (this file): spawns each declared provider lazily through the same
 *     managed Spawner seam, speaks plain MCP JSON-RPC to it over stdio, and
 *     re-exposes every provider's tools as `<namespace>__<tool>` on one
 *     Streamable HTTP endpoint under the plugin prefix.
 *   - Extension: only implements a stdio MCP server. It never listens on a port
 *     for MCP and knows nothing about Butler internals; the only contract is the
 *     MCP protocol plus the `BUTLER_MCP_CHANNEL` env marker the Host sets.
 *
 * Loose coupling: the Host never imports extension code and the extension never
 * calls the Host. Replacing either side only requires honouring MCP.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { resolveArgv, type CatalogScan } from './catalog.ts';
import type { ButlerConfig } from './config.ts';
import type { HostedProcess, Spawner } from './hosting.ts';
import { McpRpcError, StdioMcpClient, type McpTool } from './mcp-stdio.ts';
import { defaultNamespace, MCP_CHANNEL_ENV, MCP_SEPARATOR, parseMcpDecl, type McpDecl } from './mcp-decl.ts';

export { defaultNamespace, MCP_CHANNEL_ENV, MCP_SEPARATOR, parseMcpDecl, type McpDecl } from './mcp-decl.ts';

export interface McpProvider {
  /** `<kind>:<extensionId>` that declared it. */
  owner: string;
  extensionId: string;
  name: string;
  namespace: string;
  dir: string;
  decl: McpDecl;
  /** Changes whenever anything that affects the child process changes. */
  signature: string;
}

const DEFAULT_CALL_TIMEOUT_SEC = 600;
const START_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;
const RESPAWN_BACKOFF_MS = 5_000;
/** How long initialize/tools/list wait for a cold provider before answering without it. */
const WARM_WAIT_MS = 8_000;
const MAX_BODY = 4 * 1024 * 1024;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** Every tool/service MCP declaration in the scan; a namespace already taken is reported, not shadowed. */
export function collectMcpProviders(scan: CatalogScan): { providers: McpProvider[]; conflicts: Array<{ owner: string; reason: string }> } {
  const providers: McpProvider[] = [];
  const conflicts: Array<{ owner: string; reason: string }> = [];
  const taken = new Map<string, string>();
  for (const { dir, manifest: m } of [...scan.tools, ...scan.services]) {
    const owner = `${m.kind}:${m.id}`;
    let decl: McpDecl | undefined;
    try { decl = parseMcpDecl(m.mcp); } catch (error) { conflicts.push({ owner, reason: (error as Error).message }); continue; }
    if (!decl) continue;
    const namespace = decl.namespace ?? defaultNamespace(m.id);
    const holder = taken.get(namespace);
    if (holder) { conflicts.push({ owner, reason: `mcp.namespace "${namespace}" 已被 ${holder} 占用` }); continue; }
    taken.set(namespace, owner);
    providers.push({ owner, extensionId: m.id, name: m.name, namespace, dir, decl, signature: JSON.stringify([dir, decl]) });
  }
  return { providers, conflicts };
}

// ── provider runtime: lazy spawn, cached tool lists, reconcile on rescan ────────
interface ProviderState {
  provider: McpProvider;
  client?: StdioMcpClient;
  starting?: Promise<StdioMcpClient>;
  tools?: McpTool[];
  lastError?: string;
  failedAt?: number;
  /** Set by a rescan: respawn at the next request once no call is in flight (picks up code changes). */
  stale?: boolean;
  inflight: number;
}

export interface McpProviderStatus {
  owner: string;
  extensionId: string;
  name: string;
  namespace: string;
  state: 'idle' | 'starting' | 'ready' | 'error';
  tools: string[];
  /** Public name + first line of the description, for settings views. */
  toolDetails: Array<{ name: string; description: string }>;
  error?: string;
  rejectedTools?: string[];
}

export interface McpHub {
  /** Reconcile with a fresh scan: providers removed or changed are closed. */
  sync(scan: CatalogScan): void;
  /** Handle one request at the hub's path (already trusted by the router). */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** `owner` (`<kind>:<id>`) narrows to one extension; `warm` starts providers first (bounded wait). */
  status(options?: { owner?: string; warm?: boolean }): Promise<{ endpoint: string; providers: McpProviderStatus[]; conflicts: Array<{ owner: string; reason: string }> }>;
  shutdown(): void;
}

const PUBLIC_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function createMcpHub(deps: {
  spawner: Spawner;
  config: ButlerConfig;
  /** Base env for children (hostedEnv). */
  env: Record<string, string>;
  scan: CatalogScan;
  /** Public URL of the endpoint, for status and instructions. */
  endpoint: string;
  version: string;
  now?: () => number;
  warn?: (message: string) => void;
}): McpHub {
  const now = deps.now ?? Date.now;
  const states = new Map<string, ProviderState>();
  let conflicts: Array<{ owner: string; reason: string }> = [];

  const sync = (scan: CatalogScan) => {
    const next = collectMcpProviders(scan);
    conflicts = next.conflicts;
    const wanted = new Map(next.providers.map((p) => [p.namespace, p]));
    for (const [namespace, state] of states) {
      const replacement = wanted.get(namespace);
      if (!replacement || replacement.signature !== state.provider.signature) {
        state.client?.close();
        states.delete(namespace);
      } else {
        state.stale = true;
        state.failedAt = undefined;
      }
    }
    for (const [namespace, provider] of wanted) if (!states.has(namespace)) states.set(namespace, { provider, inflight: 0 });
  };
  sync(deps.scan);

  const spawnClient = async (state: ProviderState): Promise<StdioMcpClient> => {
    const { provider } = state;
    const argv = resolveArgv(provider.dir, provider.decl.command, deps.config);
    const cwd = provider.decl.cwd ? (isAbsolute(provider.decl.cwd) ? provider.decl.cwd : resolve(provider.dir, provider.decl.cwd)) : provider.dir;
    let child: HostedProcess;
    try {
      child = deps.spawner.spawn({ argv, cwd, env: { ...deps.env, ...provider.decl.env, [MCP_CHANNEL_ENV]: 'butler-hub' }, stdin: 'pipe', graceMs: 5_000 });
    } catch (error) {
      throw new Error(`无法启动 MCP 进程：${(error as Error).message}`);
    }
    const client = new StdioMcpClient(child);
    client.onToolsChanged = () => { if (state.client === client) state.tools = undefined; };
    try {
      await client.initialize(START_TIMEOUT_MS);
      state.tools = await client.listTools(LIST_TIMEOUT_MS);
    } catch (error) {
      client.close();
      throw error;
    }
    void child.done.then(() => { if (state.client === client) { state.client = undefined; state.tools = undefined; } });
    return client;
  };

  const ensure = async (state: ProviderState): Promise<StdioMcpClient> => {
    if (state.stale && state.inflight === 0 && !state.starting) {
      state.stale = false;
      state.client?.close();
      state.client = undefined;
      state.tools = undefined;
    }
    if (state.client && !state.client.closed) {
      if (!state.tools) state.tools = await state.client.listTools(LIST_TIMEOUT_MS);
      return state.client;
    }
    if (state.starting) return state.starting;
    if (state.failedAt !== undefined && now() - state.failedAt < RESPAWN_BACKOFF_MS) throw new Error(state.lastError ?? 'MCP 提供方不可用');
    state.starting = spawnClient(state).then(
      (client) => { state.client = client; state.lastError = undefined; state.failedAt = undefined; return client; },
      (error: unknown) => {
        state.lastError = error instanceof Error ? error.message : String(error);
        state.failedAt = now();
        deps.warn?.(`[butler] mcp ${state.provider.owner}: ${state.lastError}`);
        throw error;
      },
    ).finally(() => { state.starting = undefined; });
    return state.starting;
  };

  const exposed = (state: ProviderState) => {
    // Public names must satisfy the strictest common client rule (OpenAI: ^[A-Za-z0-9_-]{1,64}$).
    const ok: McpTool[] = [];
    const rejected: string[] = [];
    for (const tool of state.tools ?? []) {
      if (PUBLIC_TOOL_NAME.test(`${state.provider.namespace}${MCP_SEPARATOR}${tool.name}`)) ok.push(tool);
      else rejected.push(tool.name);
    }
    return { ok, rejected };
  };

  /** Start every provider; wait at most WARM_WAIT_MS — slow ones keep starting and join the next list. */
  const warm = (all: ProviderState[]) => Promise.race([
    Promise.allSettled(all.map((state) => ensure(state))),
    new Promise((done) => setTimeout(done, WARM_WAIT_MS).unref?.()),
  ]);

  const listAll = async () => {
    const all = [...states.values()];
    await warm(all);
    const tools: Array<Record<string, unknown>> = [];
    for (const state of all) {
      for (const tool of exposed(state).ok) {
        tools.push({
          ...tool,
          name: `${state.provider.namespace}${MCP_SEPARATOR}${tool.name}`,
          description: `[${state.provider.name}] ${tool.description ?? ''}`.trim(),
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        });
      }
    }
    return tools;
  };

  const call = async (publicName: string, args: unknown): Promise<unknown> => {
    const split = publicName.indexOf(MCP_SEPARATOR);
    const namespace = split > 0 ? publicName.slice(0, split) : '';
    const toolName = split > 0 ? publicName.slice(split + MCP_SEPARATOR.length) : '';
    const state = states.get(namespace);
    if (!state || !toolName) throw new McpRpcError(`未知工具：${publicName}`, -32602);
    let client: StdioMcpClient;
    try { client = await ensure(state); } catch (error) { return toolError(`${state.provider.name} 的 MCP 服务不可用：${(error as Error).message}`); }
    if (!state.tools?.some((t) => t.name === toolName)) {
      state.tools = await client.listTools(LIST_TIMEOUT_MS).catch(() => state.tools);
      if (!state.tools?.some((t) => t.name === toolName)) throw new McpRpcError(`未知工具：${publicName}`, -32602);
    }
    const timeoutMs = (state.provider.decl.timeoutSec ?? DEFAULT_CALL_TIMEOUT_SEC) * 1000;
    state.inflight++;
    try {
      return await client.callTool(toolName, args, timeoutMs);
    } catch (error) {
      if (error instanceof McpRpcError && error.code === -32602) throw error;
      return toolError(`${publicName} 调用失败：${(error as Error).message}`);
    } finally {
      state.inflight--;
    }
  };

  const instructions = () => {
    const lines = [...states.values()].map((s) => {
      const own = s.client?.instructions?.replace(/\s+/g, ' ').trim().slice(0, 600);
      return `- ${s.provider.namespace}${MCP_SEPARATOR}*：${s.provider.name}${own ? `。${own}` : ''}`;
    });
    return [
      'Butler 统一 MCP 服务：本机 Butler Framework 体系内各工具的 MCP 能力经此聚合对外。工具名格式为 <命名空间>__<工具名>。',
      ...(lines.length ? ['已注册的提供方：', ...lines] : ['当前没有工具注册 MCP。']),
    ].join('\n');
  };

  const rpc = async (message: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
    const id = message.id;
    const isRequest = id !== undefined && id !== null;
    const method = message.method;
    if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
      return isRequest || id === null ? { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } } : undefined;
    }
    if (!isRequest) return undefined; // notifications: initialized, cancelled… nothing to do in a stateless hub
    const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>;
    try {
      switch (method) {
        case 'initialize': {
          // Warm providers so their own instructions reach the client; failures stay per-provider.
          await warm([...states.values()]);
          const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSIONS[0];
          return ok(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked!) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'butler', title: 'Butler', version: deps.version },
            instructions: instructions(),
          });
        }
        case 'ping': return ok(id, {});
        case 'tools/list': return ok(id, { tools: await listAll() });
        case 'tools/call': {
          if (typeof params.name !== 'string') return fail(id, -32602, 'tools/call 缺少 name');
          return ok(id, await call(params.name, params.arguments));
        }
        case 'resources/list': return ok(id, { resources: [] });
        case 'resources/templates/list': return ok(id, { resourceTemplates: [] });
        case 'prompts/list': return ok(id, { prompts: [] });
        default: return fail(id, -32601, `不支持的方法：${method}`);
      }
    } catch (error) {
      if (error instanceof McpRpcError) return fail(id, error.code, error.message);
      return fail(id, -32603, error instanceof Error ? error.message : String(error));
    }
  };

  return {
    sync,
    async handle(request, response) {
      if (request.method === 'GET' || request.method === 'DELETE') {
        // Stateless hub: no server-initiated SSE stream and no sessions to end.
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method Not Allowed' } }));
        return;
      }
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
      let body: unknown;
      try { body = JSON.parse(await readRaw(request)); } catch {
        writeJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return;
      }
      const batch = Array.isArray(body);
      const messages = (batch ? body : [body]) as Array<Record<string, unknown>>;
      if (messages.length === 0 || messages.some((m) => !m || typeof m !== 'object')) {
        writeJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }); return;
      }
      const replies = (await Promise.all(messages.map(rpc))).filter((r): r is Record<string, unknown> => Boolean(r));
      if (replies.length === 0) { response.writeHead(202); response.end(); return; }
      writeJson(response, 200, batch ? replies : replies[0]);
    },
    async status(options = {}) {
      const selected = [...states.values()].filter((state) => !options.owner || state.provider.owner === options.owner);
      // A settings view wants the real tool list, which only exists once the provider has started.
      if (options.warm) await warm(selected);
      const providers: McpProviderStatus[] = [];
      for (const state of selected) {
        const view = exposed(state);
        providers.push({
          owner: state.provider.owner,
          extensionId: state.provider.extensionId,
          name: state.provider.name,
          namespace: state.provider.namespace,
          state: state.starting ? 'starting' : state.client && !state.client.closed ? 'ready' : state.lastError ? 'error' : 'idle',
          tools: view.ok.map((t) => `${state.provider.namespace}${MCP_SEPARATOR}${t.name}`),
          toolDetails: view.ok.map((t) => ({ name: `${state.provider.namespace}${MCP_SEPARATOR}${t.name}`, description: firstLine(t.description) })),
          ...(state.lastError ? { error: state.lastError } : {}),
          ...(view.rejected.length ? { rejectedTools: view.rejected } : {}),
        });
      }
      return { endpoint: deps.endpoint, providers, conflicts: options.owner ? conflicts.filter((c) => c.owner === options.owner) : conflicts };
    },
    shutdown() {
      for (const state of states.values()) state.client?.close();
      states.clear();
    },
  };
}

function ok(id: unknown, result: unknown) { return { jsonrpc: '2.0', id, result }; }
function fail(id: unknown, code: number, message: string) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n').find((l) => l.trim()) ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line.trim();
}
function toolError(text: string) { return { content: [{ type: 'text', text }], isError: true }; }

function writeJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function readRaw(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += next.byteLength;
      if (size > MAX_BODY) { request.destroy(); reject(new Error('请求体过大')); return; }
      chunks.push(next);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
