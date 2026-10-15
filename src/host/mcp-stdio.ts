/**
 * Minimal MCP client over a managed child's stdio (newline-delimited JSON-RPC,
 * the MCP stdio transport). No SDK dependency: the Host bundle stays a plain
 * `bun build` of our own modules, and the Host only needs initialize,
 * tools/list, tools/call and the list_changed notification.
 */
import type { HostedProcess } from './hosting.ts';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  title?: string;
  outputSchema?: Record<string, unknown>;
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export class McpRpcError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) { super(message); }
}

export class StdioMcpClient {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, Pending>();
  private closedError: Error | undefined;
  /** Last stderr lines, for diagnostics only. */
  readonly stderrTail: string[] = [];
  onToolsChanged: (() => void) | undefined;
  serverInfo: { name?: string; version?: string } | undefined;
  instructions: string | undefined;

  constructor(readonly child: HostedProcess) {
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk: Buffer | string) => this.feed(String(chunk)));
    child.stderr?.on('data', (chunk: Buffer | string) => {
      for (const line of String(chunk).split('\n')) if (line.trim()) this.stderrTail.push(line.slice(0, 500));
      while (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    child.stdin?.on?.('error', () => undefined);
    void child.done.then((outcome) => {
      const why = outcome.error?.message ?? `退出码 ${outcome.exitCode ?? '-'}${outcome.signal ? ` / ${outcome.signal}` : ''}`;
      this.fail(new Error(`MCP 进程已结束（${why}）${this.stderrTail.length ? `：${this.stderrTail.slice(-3).join(' | ')}` : ''}`));
    });
  }

  get closed(): boolean { return this.closedError !== undefined; }

  async initialize(timeoutMs: number): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'butler-mcp-hub', version: '1' },
    }, timeoutMs) as { serverInfo?: { name?: string; version?: string }; instructions?: string };
    this.serverInfo = result?.serverInfo;
    this.instructions = typeof result?.instructions === 'string' ? result.instructions : undefined;
    this.notify('notifications/initialized');
  }

  async listTools(timeoutMs: number): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs) as { tools?: McpTool[]; nextCursor?: string };
      for (const tool of result?.tools ?? []) if (tool && typeof tool.name === 'string') tools.push(tool);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name: string, args: unknown, timeoutMs: number): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs);
  }

  close(): void {
    this.fail(new Error('MCP 连接已关闭'));
    try { void this.child.terminate(); } catch { /* already gone */ }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        reject(new Error(`MCP ${method} 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.closedError) return;
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  private write(message: unknown): void {
    try {
      const stdin = this.child.stdin;
      if (!stdin) throw new Error('MCP 进程没有 stdin');
      stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 64 * 1024 * 1024) { this.fail(new Error('MCP 输出单行过大')); return; }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); } catch { continue; } // stray log lines on stdout are ignored
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        // Server→client requests (sampling, roots, ping): the Host offers no client capabilities.
        const reply = message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Butler MCP hub 不提供客户端能力' } };
        this.write(reply);
      } else if (message.method === 'notifications/tools/list_changed') {
        this.onToolsChanged?.();
      }
      return;
    }
    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = message.error as { code?: number; message?: string; data?: unknown } | undefined;
    if (error) pending.reject(new McpRpcError(error.message ?? 'MCP 错误', error.code ?? -32603, error.data));
    else pending.resolve(message.result);
  }

  private fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); }
  }
}
