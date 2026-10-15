import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile as readTextFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { collectDelegations, ICON_MIME, iconView, resolveArgv, type CatalogScan } from './catalog.ts';
import { butlerEnv, type ButlerConfig } from './config.ts';
import { createNotificationSender, HOST_VERSION, hostedEnv, runHostedCommand, type Hosting, type Spawner } from './hosting.ts';
import type { ServiceManager } from './service-manager.ts';
import type { Supervisor } from './supervisor.ts';
import { findQuickAction, QuickActionConfigStore, runQuickAction, type QuickActionConfig } from './quick-actions.ts';
import { RunStore } from './runs.ts';
import { ButlerStatusReader, type ButlerDetailSection } from './butler.ts';
import { readOperations } from './operations.ts';
import { createLayoutHandler } from './layout.ts';
import type { Collector, ObservationInput } from './collector.ts';
import { butlerSessionTarget, registerAutomations, type AutomationHost, readAutomationStatus } from './automations.ts';
import { createDelegationRunner, type DelegationRunner } from './delegations.ts';
import { registerToolDir } from './register-tool.ts';
import { assertReviewRequest, createPipelineEndpoint } from './card-pipeline.ts';

const VERSION = HOST_VERSION;

export interface RouterOptions {
  /** Host-owned fixed direct-link preferences; injectable for fixtures. */
  quickActionStore?: QuickActionConfigStore;
  /** Base URL injected into faculty commands and the doctor process. */
  hostUrl?: string;
  /** Reader for the `self/` tree; defaults to the config's selfRoot. */
  butler?: ButlerStatusReader;
  /** Journal intake path behind `/api/observe`; absent means the route answers 503. */
  collector?: Pick<Collector, 'observe'>;
  /** DSH schedule + session controller, resolved per request; undefined when the schedule bundle is off. */
  automationHost?: () => AutomationHost | undefined;
}

export interface ButlerRouter {
  delegations: DelegationRunner;
  /** Dispatch one request whose path is already relative to the mount prefix (`/health`, `/tools/x/start`…). Returns false when nothing matched. */
  handle(request: IncomingMessage, response: ServerResponse, pathname: string, url: URL): Promise<boolean>;
  runs: RunStore;
  butler: ButlerStatusReader;
}

/**
 * The HTTP face of the host, as a router rather than a server.
 *
 * Inside DSH the App's own web server owns the socket and hands this router
 * every request under the plugin's prefix; the paths below are therefore
 * relative (`/health`). Browser calls stay same-origin; SDK calls are loopback.
 * `trustedRequest` rejects cross-site Origin/Sec-Fetch-Site requests in addition
 * to the App's authentication boundary.
 */
export function createButlerRouter(hosting: Hosting, options: RouterOptions = {}): ButlerRouter {
  const { supervisor, serviceManager, config, spawner } = hosting;
  const runs = new RunStore(config.notification.command, createNotificationSender(spawner), config.notification.enabled);
  const butler = options.butler ?? new ButlerStatusReader(
    config.selfRoot,
    join(config.instanceRoot, 'faculties', 'journal', 'bin', 'doctor'),
    spawner,
    options.hostUrl ? hostedEnv(config, options.hostUrl) : butlerEnv(config),
  );
  const quickActions = options.quickActionStore ?? new QuickActionConfigStore(config.stateDir, config.instanceRoot);
  const layout = createLayoutHandler(config.stateDir);
  const pipeline = createPipelineEndpoint(config, spawner, { hostUrl: options.hostUrl });
  // Delegations reach DSH's session service through the same per-request automationHost read;
  // without `prompt` (older App) the route answers 503 and callers run their fallback.
  const delegations = createDelegationRunner({
    sessions: () => {
      const controller = options.automationHost?.()?.sessionController;
      return controller?.prompt ? { create: controller.create.bind(controller), prompt: controller.prompt.bind(controller), ...(controller.cancel ? { cancel: controller.cancel.bind(controller) } : {}) } : undefined;
    },
    declarations: () => collectDelegations(hosting.catalog),
    sessionTarget: () => butlerSessionTarget(options.automationHost?.() ?? {}, config.instanceRoot),
  });

  const handle = async (request: IncomingMessage, response: ServerResponse, pathname: string, url: URL): Promise<boolean> => {
    try {
      if (!trustedRequest(request)) {
        send(response, 403, { error: { code: 'forbidden', message: '仅允许本机同源请求' } });
        return true;
      }
      // Preserve the M0 public /api/* contract; existing same-origin clients
      // may keep their prefix-relative URLs during the migration.
      pathname = pathname.replace(/^\/api(?=\/|$)/, '') || '/';
      // The browser uses /operations/tools|services/<id>/<verb>, while the
      // SDK/direct surface uses /tools|services. Both resolve to one handler.
      pathname = pathname.replace(/^\/operations\/(tools|services)\//, '/$1/');

      // ── card pipeline ────────────────────────────────────────────────
      // /api is stripped above, so both /pipeline and /api/pipeline work.
      if (pathname === '/pipeline' && request.method === 'POST') {
        try {
          const body = await readBody(request);
          const result = await pipeline.handle(request, body);
          send(response, result.status, result.envelope);
        } catch {
          // JSON parser/spawn exception details may contain credentials.
          send(response, 400, { ok: false, error: { code: 'invalid_request', message: '请求不是有效的有界 JSON 对象' } });
        }
        return true;
      }

      // ── unified MCP (Streamable HTTP, stateless) ─────────────────────
      // The only outward MCP surface of the Butler Framework. Extensions
      // register a stdio provider in butler.json; they never listen for MCP.
      // trustedRequest above is the DNS-rebinding guard the MCP spec asks for.
      if (pathname === '/mcp') {
        await hosting.mcp.handle(request, response);
        return true;
      }
      if (pathname === '/mcp/status' && request.method === 'GET') {
        // ?owner=<kind>:<id> narrows to one extension (its settings view); ?warm=1 starts providers first.
        const owner = url.searchParams.get('owner') ?? undefined;
        send(response, 200, await hosting.mcp.status({ owner, warm: url.searchParams.get('warm') === '1' }));
        return true;
      }

      // ── plugin-local layout preference ───────────────────────────────
      // The layout belongs to the configured Butler state directory, so it
      // follows the same workdir as quick actions and never creates a second
      // authority under ~/.dsh/myspace-butler-panel.
      if (pathname === '/layout') {
        await layout(request, response);
        return true;
      }

      // ── health ───────────────────────────────────────────────────────
      if (pathname === '/health' && request.method === 'GET') {
        const [health, logs] = await Promise.all([
          healthSnapshot(supervisor, serviceManager, butler, runs),
          logSnapshot(supervisor, serviceManager, butler, runs),
        ]);
        { send(response, 200, { ...health, logs: logs.logs }); return true; }
      }
      if (pathname === '/logs' && request.method === 'GET') {
        { send(response, 200, await logSnapshot(supervisor, serviceManager, butler, runs)); return true; }
      }

      // ── catalog（扩展物发现结果；panel 读它得知有哪些 tool/service/faculty）
      if (pathname === '/catalog' && request.method === 'GET') {
        if (url.searchParams.get('rescan') === '1') {
          await hosting.rescan();
        }
        { send(response, 200, catalogView(hosting.catalog)); return true; }
      }
      // Tools register by directory: the folder already carries its butler.json.
      if (pathname === '/extensions/tool-dir' && request.method === 'POST') {
        try {
          const body = await readBody(request);
          const tool = await registerToolDir(config, String(body.dir ?? ''));
          await hosting.rescan();
          { send(response, 201, { tool, catalog: catalogView(hosting.catalog) }); return true; }
        } catch (error) {
          { send(response, 400, { error: { code: 'invalid_tool_dir', message: error instanceof Error ? error.message : String(error) } }); return true; }
        }
      }
      if (pathname === '/extensions' && request.method === 'POST') {
        try {
          const body = await readBody(request);
          const result = await createExtension(config, body);
          await hosting.rescan();
          { send(response, 201, { ...result, catalog: catalogView(hosting.catalog) }); return true; }
        } catch (error) {
          { send(response, 400, { error: { code: 'invalid_extension', message: error instanceof Error ? error.message : String(error) } }); return true; }
        }
      }

      const extensionConfig = /^\/extensions\/(tool|service)\/([^/]+)$/.exec(pathname);
      if (extensionConfig && (request.method === 'GET' || request.method === 'PUT')) {
        try {
          const kind = extensionConfig[1];
          const id = decodeURIComponent(extensionConfig[2]);
          if (request.method === 'GET') { send(response, 200, await readExtensionConfig(config, kind, id)); return true; }
          const result = await updateExtension(config, kind, id, await readBody(request));
          await hosting.rescan();
          { send(response, 200, { ...result, catalog: catalogView(hosting.catalog) }); return true; }
        } catch (error) {
          { send(response, 400, { error: { code: 'invalid_extension', message: error instanceof Error ? error.message : String(error) } }); return true; }
        }
      }

      // Card icon served from the manifest directory. The path never leaves the
      // Host: callers pass kind + id, the manifest names a file relative to its
      // own directory, and anything resolving outside that directory is refused.
      const iconRoute = /^\/icons\/(tool|service)\/([^/]+)$/.exec(pathname);
      if (iconRoute && request.method === 'GET') {
        const id = decodeURIComponent(iconRoute[2]);
        const found = (iconRoute[1] === 'tool' ? hosting.catalog.tools : hosting.catalog.services).find((item) => item.manifest.id === id);
        const declared = found?.manifest.icon;
        const mime = declared ? ICON_MIME[extname(declared).slice(1).toLowerCase()] : undefined;
        if (!found || !declared || !mime || iconView(declared)?.type !== 'file') { send(response, 404, { error: { code: 'no_icon', message: '未配置图标文件' } }); return true; }
        const file = isAbsolute(declared) ? declared : resolve(found.dir, declared);
        if (!isAbsolute(declared) && relative(found.dir, file).startsWith('..')) { send(response, 400, { error: { code: 'invalid_icon', message: '图标路径越界' } }); return true; }
        try {
          const bytes = await readTextFile(file);
          if (bytes.length > 2_000_000) throw new Error('too large');
          response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...(mime === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } : {}) });
          response.end(bytes);
        } catch { send(response, 404, { error: { code: 'icon_unreadable', message: '图标文件无法读取' } }); }
        return true;
      }

      // ── internal tools (existing) ────────────────────────────────────
      if (pathname === '/automations' && request.method === 'GET') {
        { send(response, 200, await readAutomationStatus(options.automationHost?.())); return true; }
      }
      if (pathname === '/automations' && request.method === 'POST') {
        const host = options.automationHost?.();
        if (!host) { send(response, 503, { error: { code: 'schedule_unavailable', message: 'DSH 自动化任务未启用（需要 schedule bundle）' } }); return true; }
        try {
          { send(response, 200, await registerAutomations(host, { cwd: config.instanceRoot })); return true; }
        } catch (error) {
          { send(response, 500, { error: { code: 'automation_failed', message: error instanceof Error ? error.message : String(error) } }); return true; }
        }
      }
      if (pathname === '/overview' && request.method === 'GET') {
        { send(response, 200, await overview(supervisor)); return true; }
      }
      if (pathname === '/butler' && request.method === 'GET') {
        const section = url.searchParams.get('section');
        if (section) {
          const allowed: ButlerDetailSection[] = ['journal', 'spool', 'endpoints', 'endpoint', 'doctor', 'config', 'digests', 'memory'];
          if (!allowed.includes(section as ButlerDetailSection)) { send(response, 400, { error: { code: 'invalid_section', message: 'Butler 详情分区不存在' } }); return true; }
          { send(response, 200, await butler.readDetail(section as ButlerDetailSection, url.searchParams.get('id') ?? undefined)); return true; }
        }
        { send(response, 200, await butler.read(url.searchParams.get('refresh') === '1')); return true; }
      }

      // ── public fixed capabilities (tools / hosted services) ──
      if (pathname === '/operations' && request.method === 'GET') {
        { send(response, 200, await readOperations(supervisor, serviceManager)); return true; }
      }
      if (pathname === '/operations/tools' && request.method === 'GET') {
        const snapshot = await readOperations(supervisor, serviceManager);
        { send(response, 200, { tools: snapshot.tools, checkedAt: snapshot.checkedAt }); return true; }
      }
      if (pathname === '/operations/services' && request.method === 'GET') {
        const snapshot = await readOperations(supervisor, serviceManager);
        { send(response, 200, { services: snapshot.services, checkedAt: snapshot.checkedAt }); return true; }
      }
      // ── configurable direct links (fixed allowlist only) ───────────────
      if (pathname === '/quick-actions' && request.method === 'GET') {
        const config = await quickActions.read();
        { send(response, 200, publicQuickActions(config)); return true; }
      }
      if (pathname === '/quick-actions' && request.method === 'PUT') {
        try {
          const config = await quickActions.update(await readBody(request));
          { send(response, 200, publicQuickActions(config)); return true; }
        } catch (error) {
          { send(response, 400, { error: { code: 'invalid_quick_actions', message: error instanceof Error ? error.message : '直达入口配置无效' } }); return true; }
        }
      }

      if (pathname === '/quick-actions' && request.method === 'POST') {
        try {
          const body = await readBody(request);
          const entry = body.entry;
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('快捷卡片必须是对象');
          const current = await quickActions.read();
          const id = (entry as { id?: unknown }).id;
          if (typeof id !== 'string') throw new Error('快捷卡片缺少 id');
          const config = await quickActions.update({ items: [...current.items, entry], enabled: [...current.enabled, id], order: [...current.order, id] });
          { send(response, 201, publicQuickActions(config)); return true; }
        } catch (error) {
          { send(response, 400, { error: { code: 'invalid_quick_action', message: error instanceof Error ? error.message : '快捷卡片无效' } }); return true; }
        }
      }
      const quickActionManage = /^\/quick-actions\/([^/]+)$/.exec(pathname);
      if (quickActionManage && (request.method === 'PATCH' || request.method === 'DELETE')) {
        try {
          const id = decodeURIComponent(quickActionManage[1]);
          const current = await quickActions.read();
          if (!current.items.some((item) => item.id === id)) { send(response, 404, { error: { code: 'not_found', message: '快捷卡片不存在' } }); return true; }
          const body = request.method === 'DELETE' ? {} : await readBody(request);
          const items = request.method === 'DELETE' ? current.items.filter((item) => item.id !== id) : current.items.map((item) => item.id === id ? ({ ...item, ...(body.entry as object) }) : item);
          const config = await quickActions.update({ items, enabled: current.enabled.filter((item) => item !== id), order: current.order.filter((item) => item !== id) });
          { send(response, 200, publicQuickActions(config)); return true; }
        } catch (error) {
          { send(response, 400, { error: { code: 'invalid_quick_action', message: error instanceof Error ? error.message : '快捷卡片无效' } }); return true; }
        }
      }

      // ── workflow run observation ─────────────────────────────────────
      // Tools/services drive multi-step work through the SDK runner, which
      // posts events to /runs/event; the console's 工作流 section renders them.
      if (pathname === '/runs' && request.method === 'GET') {
        { send(response, 200, { runs: runs.snapshot() }); return true; }
      }
      if (pathname === '/runs/stream' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write(':ok\n\n');
        runs.subscribe(response);
        return true;
      }
      // External probes (endpoint hooks, scripts) report one observation here.
      if (pathname === '/observe' && request.method === 'POST') {
        if (!options.collector) { send(response, 503, { error: { code: 'unavailable', message: 'Collector 未启用' } }); return true; }
        let input: ObservationInput;
        try { input = parseObservation(await readBody(request)); }
        catch (error) { send(response, 400, { error: { code: 'invalid_observation', message: error instanceof Error ? error.message : '观察无效' } }); return true; }
        const result = await options.collector.observe(input);
        if (result.queued) send(response, 202, { queued: true });
        else send(response, 502, { error: { code: 'intake_failed', message: result.error ?? 'intake 失败' } });
        return true;
      }
      // ── delegations: a workflow step hands one judgement to a fresh Butler Session ──
      // Local callers only (trustedRequest above). The call blocks until the Session submits,
      // times out or fails; the body carries the terminal record either way.
      if (pathname === '/delegations' && request.method === 'GET') {
        send(response, 200, { delegations: delegations.list() }); return true;
      }
      if (pathname === '/delegations' && request.method === 'POST') {
        let body: Record<string, unknown>;
        try { body = await readBody(request); } catch { send(response, 400, { error: { code: 'invalid_request', message: '请求体不是 JSON 对象' } }); return true; }
        const key = typeof body.delegation === 'string' ? body.delegation : '';
        if (!collectDelegations(hosting.catalog).has(key)) { send(response, 404, { error: { code: 'unknown_delegation', message: `未声明的委托：${key || '(空)'}` } }); return true; }
        if (!options.automationHost?.()?.sessionController?.prompt) { send(response, 503, { error: { code: 'sessions_unavailable', message: '当前 DSH 不支持插件驱动会话（sessionController.prompt 不可用）' } }); return true; }
        const abort = new AbortController();
        response.on('close', () => { if (!response.writableEnded) abort.abort(); });
        const record = await delegations.run(key, body.input, { signal: abort.signal });
        send(response, 200, record); return true;
      }
      const delegationRoute = /^\/delegations\/([^/]+)$/.exec(pathname);
      if (delegationRoute && request.method === 'GET') {
        const record = delegations.get(decodeURIComponent(delegationRoute[1]));
        if (record) send(response, 200, record); else send(response, 404, { error: { code: 'not_found', message: '委托不存在或已过期' } });
        return true;
      }

      // ── step confirmation (risk=confirm delegations) ─────────────────────────────
      // The owner decides in the observation area; same owner-only gate as card review.
      // The waiting step (an SDK process) polls GET; it can read, never decide.
      const confirmRoute = /^\/runs\/([^/]+)\/steps\/(\d+)\/confirm$/.exec(pathname);
      if (confirmRoute && request.method === 'POST') {
        try { assertReviewRequest(request, options.hostUrl ? new URL(options.hostUrl).origin : undefined); }
        catch { send(response, 403, { error: { code: 'forbidden', message: '确认只能由主人在观测区操作' } }); return true; }
        const body = await readBody(request).catch(() => ({} as Record<string, unknown>));
        const decision = body.decision === 'approve' || body.decision === 'reject' ? body.decision : undefined;
        if (!decision || typeof body.token !== 'string') { send(response, 400, { error: { code: 'invalid_request', message: '需要 decision 与 token' } }); return true; }
        const result = runs.decide(decodeURIComponent(confirmRoute[1]), Number(confirmRoute[2]), body.token, decision);
        if (typeof result === 'string') send(response, result === 'not_found' ? 404 : 409, { error: { code: result, message: result } });
        else send(response, 200, { decision: result.decision });
        return true;
      }
      if (confirmRoute && request.method === 'GET') {
        const decision = runs.decision(decodeURIComponent(confirmRoute[1]), Number(confirmRoute[2]), url.searchParams.get('token') ?? '');
        if (decision === 'not_found') send(response, 404, { error: { code: 'not_found', message: '没有这条待确认' } });
        else send(response, 200, { decision: decision ?? null });
        return true;
      }

      // Runner (CLI/MCP local process, no Origin) pushes step events here.
      if (pathname === '/runs/event' && request.method === 'POST') {
        runs.ingest(await readBody(request));
        { send(response, 202, { ok: true }); return true; }
      }

      // ── configured local direct links ────────────────────────────────
      // The caller sends an id, never a target: what that id opens is decided
      // by the stored config, which validated the target when it was written.
      const quickAction = /^\/quick-actions\/([^/]+)$/.exec(pathname);
      if (quickAction && request.method === 'POST') {
        const id = decodeURIComponent(quickAction[1]);
        const entry = findQuickAction(await quickActions.read(), id);
        if (!entry) {
          { send(response, 404, { error: { code: 'not_found', message: '快捷操作不存在' } }); return true; }
        }
        const result = await runQuickAction(entry, async (file, args) => {
          const opened = await runHostedCommand(spawner, {
            argv: [file, ...args],
            cwd: config.instanceRoot,
            graceMs: 5_000,
          }, 15_000);
          if (opened.error || opened.timedOut || opened.exitCode !== 0) throw new Error(opened.stderr || '打开快捷入口失败');
        });
        { send(response, 200, result); return true; }
      }

      const toolQuickAction = /^\/tools\/([^/]+)\/actions\/(\d+)$/.exec(pathname);
      if (toolQuickAction && request.method === 'POST') {
        const id = decodeURIComponent(toolQuickAction[1]);
        const index = Number(toolQuickAction[2]);
        const tool = supervisor.manifests().find((item) => item.id === id);
        const action = tool?.actions?.[index];
        if (!action || action.method !== 'POST') { send(response, 404, { error: { code: 'not_found', message: '工具快捷动作不存在' } }); return true; }
        const target = new URL(action.url);
        if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
          { send(response, 400, { error: { code: 'unsafe_target', message: '快捷动作仅允许本机 HTTP 目标' } }); return true; }
        }
        const upstream = await fetch(target, { method: 'POST' });
        const body = await upstream.text();
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(body);
        return true;
      }

      const toolAction = /^\/tools\/([^/]+)\/(start|stop|restart)$/.exec(pathname);
      if (toolAction && request.method === 'POST') {
        const status = supervisor[toolAction[2] as 'start' | 'stop' | 'restart'](decodeURIComponent(toolAction[1]));
        { send(response, 200, status); return true; }
      }

      // ── faculty（核心能力）的执行面：简报页控制面的后端 ─────────────────
      // faculties 没有 hosted 块、没有常驻进程，所以这里没有启停，只有两件事：
      // reports[]（清单声明为只读汇报）按 GET 触发，commands[] 带 effect，
      // POST 且 write/external 必须带 confirmed。两者跑的都是清单里的 exec，
      // argv 解析与环境注入和托管层完全一致（resolveArgv / butlerEnv）。
      const facultyReport = /^\/faculties\/([^/]+)\/reports\/([^/]+)$/.exec(pathname);
      if (facultyReport && request.method === 'GET') {
        const found = hosting.catalog.faculties.find((item) => item.manifest.id === decodeURIComponent(facultyReport[1]));
        if (!found) { send(response, 404, { error: { code: 'not_found', message: '核心能力不存在' } }); return true; }
        const report = found.manifest.reports?.find((item) => item.id === decodeURIComponent(facultyReport[2]));
        if (!report) { send(response, 404, { error: { code: 'not_found', message: '该核心能力没有这个报告' } }); return true; }
        const result = await runFacultyExec(found, report.exec, config, spawner);
        { send(response, 200, { ...result, report: report.id, shape: report.shape ?? 'status' }); return true; }
      }

      const facultyCommand = /^\/faculties\/([^/]+)\/commands\/([^/]+)$/.exec(pathname);
      if (facultyCommand && request.method === 'POST') {
        const found = hosting.catalog.faculties.find((item) => item.manifest.id === decodeURIComponent(facultyCommand[1]));
        if (!found) { send(response, 404, { error: { code: 'not_found', message: '核心能力不存在' } }); return true; }
        const command = found.manifest.commands?.find((item) => item.id === decodeURIComponent(facultyCommand[2]));
        if (!command) { send(response, 404, { error: { code: 'not_found', message: '该核心能力没有这个命令' } }); return true; }
        const body = (await readBody(request).catch(() => ({}))) as { confirmed?: unknown; args?: unknown };
        if (command.effect && command.effect !== 'read' && body?.confirmed !== true) {
          { send(response, 409, { error: { code: 'confirmation_required', message: `effect=${command.effect} 的命令需确认后执行` } }); return true; }
        }
        let invocation: { argv: string[]; stdin?: string };
        try { invocation = facultyInvocation(command, body?.args); }
        catch (error) { send(response, 400, { error: { code: 'invalid_args', message: error instanceof Error ? error.message : '参数无效' } }); return true; }
        const result = await runFacultyExec(found, [...command.exec, ...invocation.argv], config, spawner, invocation.stdin);
        { send(response, 200, { ...result, command: command.id, effect: command.effect ?? 'read' }); return true; }
      }

      // ── external services ────────────────────────────────────────────
      if (pathname === '/services' && request.method === 'GET') {
        { send(response, 200, await serviceManager.listStatus()); return true; }
      }
      const svcLog = /^\/(tools|services)\/([^/]+)\/log$/.exec(pathname);
      if (svcLog && request.method === 'GET') {
        const id = decodeURIComponent(svcLog[2]);
        const manager = svcLog[1] === 'tools' ? supervisor : serviceManager;
        if (!manager.ids().includes(id)) { send(response, 404, { error: { code: 'not_found' } }); return true; }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        response.write(':ok\n\n');
        manager.subscribeLog(id, response);
        return true;
      }

      const svcOpen = /^\/services\/([^/]+)\/open$/.exec(pathname);
      if (svcOpen && request.method === 'POST') {
        const id = decodeURIComponent(svcOpen[1]);
        const service = (await serviceManager.listStatus()).find((item) => item.id === id);
        if (!service) { send(response, 404, { error: { code: 'not_found', message: '服务不存在' } }); return true; }
        if (!service.openPath) { send(response, 409, { error: { code: 'no_open_path', message: '服务未配置本地目录' } }); return true; }
        const opened = await openLocalPath(service.openPath, spawner);
        if (!opened) { send(response, 502, { error: { code: 'open_failed', message: '无法打开本地目录' } }); return true; }
        { send(response, 200, { ok: true, path: service.openPath }); return true; }
      }

      const svcAction = /^\/services\/([^/]+)\/(start|stop|restart)$/.exec(pathname);
      if (svcAction && request.method === 'POST') {
        const id = decodeURIComponent(svcAction[1]);
        serviceManager[svcAction[2] as 'start' | 'stop' | 'restart'](id);
        { send(response, 200, await serviceManager.statusOf(id)); return true; }
      }

      return false;
    } catch (error) {
      send(response, 500, { error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } });
      return true;
    }
  };

  return { handle, runs, butler, delegations };
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function trustedRequest(request: IncomingMessage): boolean {
  // DSH forwards a Node IncomingMessage, but keeping the boundary defensive is
  // important: a malformed adapter object must become 403, never an uncaught
  // TypeError that the App reports as a generic 502/fetch-failed response.
  const headers = request?.headers ?? {};
  const remote = request?.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '')) return false;
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = headers.origin;
  if (!origin) return true; // Local SDK/CLI callers have no Origin.
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      && parsed.host === headers.host;
  } catch { return false; }
}

async function healthSnapshot(
  supervisor: Supervisor,
  serviceManager: ServiceManager,
  butler: ButlerStatusReader,
  runs: RunStore,
) {
  const observedAt = new Date().toISOString();
  const [butlerStatus, tools, services, runList] = await Promise.all([
    butler.read(),
    Promise.all(supervisor.ids().map(async (id) => {
      const status = supervisor.statusOf(id);
      const health = await supervisor.healthOf(id);
      return { id: `tool:${status.id}`, name: status.name, state: toolHealthState(health, status.running), observedAt, source: 'Supervisor', freshness: 'fresh', details: { running: status.running, health } };
    })),
    serviceManager.listStatus(),
    Promise.resolve(runs.snapshot()),
  ]);
  const health = [
    {
      id: 'butler', name: 'Butler Framework', state: butlerHealthState(butlerStatus.status), observedAt: butlerStatus.checkedAt,
      source: 'Butler doctor', freshness: 'fresh', details: { status: butlerStatus.status, passed: butlerStatus.doctor.passed, warnings: butlerStatus.doctor.warnings, failures: butlerStatus.doctor.failures },
    },
    ...tools,
    ...services.map((service) => ({
      id: `service:${service.id}`, name: service.name, state: serviceHealthState(service.state), observedAt, source: 'ServiceManager', freshness: 'fresh',
      details: { state: service.state, port: service.port },
    })),
    {
      id: 'runs', name: '工作流观测', state: runList.some((run) => run.status === 'error') ? 'degraded' : 'healthy',
      observedAt, source: 'RunStore', freshness: 'fresh', details: { active: runList.filter((run) => run.status === 'running').length, total: runList.length },
    },
  ];
  const healthy = health.filter((item) => item.state === 'healthy').length;
  return { checkedAt: observedAt, health, summary: { healthy, total: health.length, attention: health.length - healthy }, runs: runList.map(publicRunSummary) };
}

async function logSnapshot(supervisor: Supervisor, serviceManager: ServiceManager, butler: ButlerStatusReader, runs: RunStore) {
  const checkedAt = new Date().toISOString();
  const [butlerStatus, services] = await Promise.all([butler.read(), serviceManager.listStatus()]);
  const logs: Array<{ at: string; source: string; level: 'info' | 'warn' | 'error'; message: string }> = [];
  const doctorLines = butlerStatus.doctor.output.split('\n').filter(Boolean).slice(-20);
  for (const line of doctorLines) {
    const level = line.startsWith('[FAIL]') ? 'error' : line.startsWith('[WARN]') ? 'warn' : 'info';
    logs.push({ at: butlerStatus.checkedAt, source: 'Butler doctor', level, message: scrubLog(line) });
  }
  for (const run of runs.snapshot()) {
    const level = run.status === 'error' ? 'error' : run.status === 'running' ? 'info' : 'info';
    const detail = run.error || run.steps.find((step) => step.error)?.error || run.steps.find((step) => step.log)?.log;
    logs.push({ at: new Date(run.endedAt ?? run.lastEventAt ?? run.startedAt).toISOString(), source: `Run ${run.runId}`, level, message: scrubLog(`${run.title} · ${run.status}${detail ? ` · ${detail}` : ''}`) });
  }
  for (const service of services.filter((item) => item.state === 'crashed' || item.state === 'port-busy')) {
    logs.push({ at: new Date(service.lastExit?.at ?? Date.now()).toISOString(), source: `Service ${service.id}`, level: 'error', message: scrubLog(`${service.name} · ${service.state}`) });
  }
  return { checkedAt, logs: logs.slice(-100) };
}

function publicRunSummary(run: ReturnType<RunStore['snapshot']>[number]) {
  return {
    runId: run.runId,
    workflow: run.workflow,
    title: run.title,
    source: run.source,
    actor: run.actor,
    capabilityId: run.capabilityId,
    capabilityVersion: run.capabilityVersion,
    proposalId: run.proposalId,
    confirmed: run.confirmed,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    error: run.error ? scrubLog(run.error) : undefined,
    currentStep: run.steps[run.currentIndex]?.name,
  };
}

function toolHealthState(health: string, running: boolean): 'healthy' | 'degraded' | 'error' | 'unknown' {
  if (health === 'ok') return 'healthy';
  if (health === 'unhealthy') return 'degraded';
  if (health === 'down') return running ? 'error' : 'unknown';
  return 'unknown';
}

function butlerHealthState(state: string): 'healthy' | 'degraded' | 'error' {
  return state === 'healthy' ? 'healthy' : state === 'error' ? 'error' : 'degraded';
}

function serviceHealthState(state: string): 'healthy' | 'degraded' | 'error' | 'unknown' {
  return state === 'running' ? 'healthy' : state === 'crashed' ? 'error' : state === 'port-busy' ? 'degraded' : 'unknown';
}

function scrubLog(value: string): string {
  return String(value)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{8,}){1,2}\b/g, '[redacted]')
    .replace(/([?&](?:api[-_]?key|token|secret|password|authorization|credential)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(api[-_]?key|token|secret|password|authorization|cookie|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .slice(0, 500);
}

async function overview(supervisor: Supervisor) {
  const tools = await Promise.all(
    supervisor.ids().map(async (id) => ({ ...supervisor.statusOf(id), health: await supervisor.healthOf(id) })),
  );
  return { host: { version: VERSION, pid: process.pid, startedAt: 0 }, tools };
}

/** Map a request's `args` object onto argv using only the command's declared args. */
export function facultyArgs(command: import('./catalog.ts').ButlerCommandDecl, raw: unknown): string[] {
  return facultyInvocation(command, raw).argv;
}

/**
 * Validate a caller's `args` against the manifest and split them into what goes
 * on the command line and what goes to stdin (the one `stdin: true` arg, if
 * declared). Everything is checked before anything is spawned.
 */
export function facultyInvocation(command: import('./catalog.ts').ButlerCommandDecl, raw: unknown): { argv: string[]; stdin?: string } {
  const declared = command.args ?? [];
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('args 必须是对象');
  const values = raw as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!declared.some((arg) => arg.name === key)) throw new Error(`命令 ${command.id} 不接受参数 ${key}`);
  }
  const argv: string[] = [];
  let stdin: string | undefined;
  for (const arg of declared) {
    const value = values[arg.name];
    if (value === undefined) {
      if (arg.required) throw new Error(`缺少参数 ${arg.name}`);
      continue;
    }
    if (arg.stdin) {
      if (typeof value !== 'string' || !new RegExp(`^(?:${arg.pattern})$`, 'u').test(value)) throw new Error(`参数 ${arg.name} 格式无效`);
      stdin = value;
      continue;
    }
    if (typeof value !== 'string' || value.startsWith('-') || !new RegExp(`^(?:${arg.pattern})$`, 'u').test(value)) {
      throw new Error(`参数 ${arg.name} 格式无效`);
    }
    argv.push(...(arg.positional ? [value] : [`--${arg.name}`, value]));
  }
  return { argv, ...(stdin !== undefined ? { stdin } : {}) };
}

/**
 * Run one exec declared by a faculty manifest.
 *
 * Faculties have no `hosted` block, so there is no cwd of their own to keep a
 * process in — the manifest directory is the cwd, exactly as `resolveArgv`
 * assumes. The environment is the same one the managed layer injects, so a
 * faculty script cannot tell whether DSH or an automation task called it. A
 * non-zero exit is a *result*, not a transport error: the caller gets
 * the code and both streams and decides what to show.
 */
function runFacultyExec(
  found: CatalogScan['faculties'][number],
  exec: string[],
  config: ButlerConfig,
  spawner: import('./hosting.ts').Spawner,
  stdin?: string,
): Promise<{
  id: string;
  report?: string;
  command?: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  const argv = resolveArgv(found.dir, exec, config);
  return runHostedCommand(spawner, {
    argv,
    cwd: found.dir,
    env: butlerEnv(config),
    ...(stdin !== undefined ? { stdin: { data: stdin } } : {}),
    graceMs: 5_000,
  }, 120_000).then((result) => ({
    id: found.manifest.id,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  }));
}

/** 对外的扩展物目录：只暴露身份与声明，绝不暴露 command / cwd / env。 */
function catalogView(scan: CatalogScan) {
  const strip = ({ dir, manifest: m }: CatalogScan['tools'][number]) => ({
    id: m.id,
    name: m.name,
    kind: m.kind,
    description: m.description,
    icon: iconView(m.icon),
    version: m.version ?? 1,
    frequency: m.frequency,
    hosted: Boolean(m.hosted),
    panelUrl: m.panelUrl,
    panelSize: m.panelSize,
    actions: m.actions?.map((a, index) => ({ index, label: a.label, title: a.title, mode: a.mode ?? 'panel', url: a.url })),
    reports: m.reports?.map((r) => ({ id: r.id, name: r.name, shape: r.shape ?? 'status', schedule: r.schedule })),
    commands: m.commands?.map((c) => ({ id: c.id, description: c.description, effect: c.effect ?? 'read', needsArgs: (c.args ?? []).some((a) => a.required) })),
    dir,
  });
  return {
    tools: scan.tools.map(strip),
    services: scan.services.map(strip),
    faculties: scan.faculties.map(strip),
    rejected: scan.rejected,
    scannedAt: scan.scannedAt,
  };
}

const OBSERVATION_TYPES = new Set(['note', 'decision', 'fact', 'milestone', 'error', 'session']);

/** Validate `{source,type?,tags?,text,ref?}` against the same limits intake enforces. */
function parseObservation(body: Record<string, unknown>): ObservationInput {
  const { source, type = 'note', tags = [], text, ref } = body;
  if (typeof source !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) throw new Error('source 必须是小写字母、数字或连字符');
  if (typeof type !== 'string' || !OBSERVATION_TYPES.has(type)) throw new Error(`type 必须是 ${[...OBSERVATION_TYPES].join('|')}`);
  if (typeof text !== 'string' || !text.trim() || text.length > 2_000) throw new Error('text 必须是 1–2000 字符');
  if (!Array.isArray(tags) || tags.length > 32 || !tags.every((tag) => typeof tag === 'string' && tag.length > 0 && tag.length <= 500 && !/[,\u0000-\u001f]/.test(tag))) throw new Error('tags 必须是不含逗号与控制字符的字符串数组');
  if (ref !== undefined && (typeof ref !== 'string' || ref.length > 500)) throw new Error('ref 必须是 ≤500 字符的字符串');
  return { source, type, tags: tags as string[], text, ...(ref === undefined ? {} : { ref }) };
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += next.byteLength;
      if (size > 256 * 1024) {
        settled = true;
        // Stop retaining attacker-controlled input as soon as the limit is hit.
        request.destroy();
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(next);
    });
    request.on('end', () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks);
        const parsed = JSON.parse(raw.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
        settled = true;
        resolve(parsed as Record<string, unknown>);
      }
      catch (error) {
        settled = true;
        reject(error instanceof Error ? error : new Error('请求体不是有效 JSON'));
      }
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

const EXTENSION_ID = /^[a-z0-9][a-z0-9-]*$/;

function extensionRoot(config: ButlerConfig, kind: string): string {
  const root = config.scanRoots.find((candidate) => basename(candidate) === `${kind}s`);
  if (!root) throw new Error(`未配置 ${kind} 扫描目录`);
  return resolve(root);
}

function extensionPath(config: ButlerConfig, kind: string, id: string): string {
  if (!EXTENSION_ID.test(id)) throw new Error('id 只能包含小写字母、数字和连字符');
  const root = extensionRoot(config, kind);
  const dir = resolve(root, id);
  if (relative(root, dir).startsWith('..')) throw new Error('扩展物路径越界');
  return dir;
}

function publicExtension(manifest: Record<string, unknown>) {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    icon: typeof manifest.icon === 'string' ? manifest.icon : undefined,
    version: manifest.version ?? 1,
    frequency: manifest.frequency,
    hosted: Boolean(manifest.hosted),
    panelUrl: manifest.panelUrl,
    panelSize: manifest.panelSize,
    actions: Array.isArray(manifest.actions) ? manifest.actions : [],
  };
}

function extensionManifest(body: Record<string, unknown>, kind: string, id: string, requireHosted = true) {
  if (body.kind !== kind || body.id !== id) throw new Error('清单 kind/id 与路径不一致');
  if (body.schemaVersion !== 1 || typeof body.name !== 'string' || !body.name.trim()) throw new Error('需要 schemaVersion=1 与非空 name');
  const hosted = body.hosted;
  // Only a tool may be pure actions/panel with no process; creation still requires one.
  if (hosted === undefined && !requireHosted && kind === 'tool') return { ...body, schemaVersion: 1, kind, id };
  if (!hosted || typeof hosted !== 'object' || Array.isArray(hosted)) throw new Error('扩展物必须有 hosted 配置');
  const h = hosted as Record<string, unknown>;
  if (typeof h.command !== 'string' && !Array.isArray(h.command)) throw new Error('hosted.command 必须是字符串或参数数组');
  if (Array.isArray(h.command) && h.command.some((part) => typeof part !== 'string' || !part.trim())) throw new Error('hosted.command 参数无效');
  if (typeof h.cwd !== 'undefined' && typeof h.cwd !== 'string') throw new Error('hosted.cwd 必须是字符串');
  if (typeof h.port !== 'undefined' && (!Number.isInteger(h.port) || Number(h.port) < 1 || Number(h.port) > 65535)) throw new Error('hosted.port 无效');
  if (kind === 'service' && typeof body.panelUrl !== 'undefined') throw new Error('service 不支持 panelUrl');
  return { schemaVersion: 1, kind, id, name: body.name, ...(typeof body.description === 'string' && body.description.trim() ? { description: body.description.trim() } : {}), ...(typeof body.icon === 'string' && body.icon.trim() ? { icon: body.icon.trim() } : {}), ...(typeof body.version === 'number' ? { version: body.version } : {}), hosted, ...(body.panelUrl ? { panelUrl: body.panelUrl } : {}), ...(body.panelSize ? { panelSize: body.panelSize } : {}), ...(Array.isArray(body.actions) ? { actions: body.actions } : {}) };
}

async function readExtensionConfig(config: ButlerConfig, kind: string, id: string) {
  const file = join(extensionPath(config, kind, id), 'butler.json');
  const manifest = JSON.parse(await readTextFile(file, 'utf8')) as Record<string, unknown>;
  const hosted = (manifest.hosted ?? {}) as Record<string, unknown>;
  return { ...publicExtension(manifest), hosted: { command: hosted.command, cwd: hosted.cwd, port: hosted.port, url: hosted.url, openPath: hosted.openPath, autoStart: hosted.autoStart === true } };
}

async function writeExtension(config: ButlerConfig, kind: string, id: string, manifest: Record<string, unknown>, replace = false) {
  const dir = extensionPath(config, kind, id);
  const file = join(dir, 'butler.json');
  if (!replace) { try { await readTextFile(file); throw new Error('id 已存在'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
  return { extension: publicExtension(manifest) };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICON_UPLOAD_MAX = 150_000; // base64 of this stays under readBody's 256KB cap
/** 上传生成的图标文件名；带内容哈希，所以换图即换名，浏览器不会读到旧缓存。 */
const GENERATED_ICON = /^icon-[0-9a-f]{8}\.png$/;

/**
 * 控制台文件选择器上传的图标：浏览器已缩成 PNG 并以 data URL 送来。
 * 这里不信任客户端，只接受 PNG（校验魔数）并限制大小，其余一律拒绝。
 * @returns 解码后的字节与目标文件名；未上传时 undefined。
 */
function decodeIconUpload(raw: unknown): { bytes: Buffer; name: string } | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new Error('iconData 必须是字符串');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(raw);
  if (!match) throw new Error('图标上传只接受 PNG data URL');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > ICON_UPLOAD_MAX) throw new Error('图标文件过大（上限 150KB）');
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new Error('不是有效的 PNG 图片');
  return { bytes, name: `icon-${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.png` };
}

async function createExtension(config: ButlerConfig, body: Record<string, unknown>) {
  const kind = body.kind === 'tool' || body.kind === 'service' ? body.kind : '';
  const id = typeof body.id === 'string' ? body.id : '';
  if (!kind || !id) throw new Error('kind 只能是 tool/service，且必须提供 id');
  const upload = decodeIconUpload(body.iconData);
  const manifest = extensionManifest(body, kind, id);
  const result = await writeExtension(config, kind, id, upload ? { ...manifest, icon: upload.name } : manifest);
  if (upload) await writeFile(join(extensionPath(config, kind, id), upload.name), upload.bytes, { mode: 0o600 });
  return result;
}

/**
 * The console form edits a subset of the manifest (name, command, cwd, port,
 * url, openPath, plus the top-level `autoStart` switch which lands in
 * hosted.autoStart). Everything else already in the file — group,
 * restart, env, health, frequency, panel, actions — must survive a save, so the
 * edit is merged over the stored manifest instead of replacing it.
 */
export function mergeManifest(current: Record<string, unknown>, body: Record<string, unknown>): Record<string, unknown> {
  const FORM_HOSTED = ['command', 'cwd', 'port', 'url', 'openPath'];
  // A tool's form only edits identity (name, description, icon). Its process,
  // panel and actions are declared in its own butler.json, so a body without a
  // hosted block leaves that block exactly as stored — including its absence.
  const formHasHosted = body.hosted !== undefined;
  const currentHosted = (current.hosted && typeof current.hosted === 'object' ? current.hosted : {}) as Record<string, unknown>;
  const bodyHosted = (body.hosted && typeof body.hosted === 'object' ? body.hosted : {}) as Record<string, unknown>;
  const hosted: Record<string, unknown> = { ...currentHosted };
  for (const key of formHasHosted ? FORM_HOSTED : []) {
    if (key in bodyHosted && bodyHosted[key] !== '' && bodyHosted[key] !== null) hosted[key] = bodyHosted[key];
    else delete hosted[key];
  }
  // command is required; an empty form value keeps the stored one
  if (formHasHosted && hosted.command === undefined) hosted.command = currentHosted.command;
  const next: Record<string, unknown> = { ...current, ...(typeof body.name === 'string' ? { name: body.name } : {}) };
  if (formHasHosted) next.hosted = hosted;
  // description is a form field too: an empty value removes it
  if ('description' in body) {
    const text = typeof body.description === 'string' ? body.description.trim() : '';
    if (text) next.description = text; else delete next.description;
  }
  // icon likewise: an empty value removes it and the card falls back to letters
  if ('icon' in body) {
    const text = typeof body.icon === 'string' ? body.icon.trim() : '';
    if (text) next.icon = text; else delete next.icon;
  }
  // 「跟随 DSH 自启动」：单独的布尔开关，tool 的身份表单与 service 的完整表单都能改。
  // 只在已有 hosted 块时生效 —— 纯 actions/panel 的工具没有进程，谈不上自启动。
  if (typeof body.autoStart === 'boolean' && next.hosted && typeof next.hosted === 'object') {
    next.hosted = { ...(next.hosted as Record<string, unknown>), autoStart: body.autoStart };
  }
  return next;
}

async function updateExtension(config: ButlerConfig, kind: string, id: string, body: Record<string, unknown>) {
  const file = join(extensionPath(config, kind, id), 'butler.json');
  const current = JSON.parse(await readTextFile(file, 'utf8')) as Record<string, unknown>;
  const upload = decodeIconUpload(body.iconData);
  const merged = mergeManifest(current, body);
  if (upload) merged.icon = upload.name;
  extensionManifest({ ...merged, kind, id }, kind, id, false); // validate only
  const dir = extensionPath(config, kind, id);
  // The image lands before the manifest names it, so a rescan never sees a dangling icon.
  if (upload) await writeFile(join(dir, upload.name), upload.bytes, { mode: 0o600 });
  const result = await writeExtension(config, kind, id, { ...merged, kind, id }, true);
  // Only files this feature generated are ever removed; a hand-placed icon is the owner's.
  const previous = current.icon;
  if (typeof previous === 'string' && GENERATED_ICON.test(previous) && previous !== merged.icon) await unlink(join(dir, previous)).catch(() => {});
  return result;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * The public view of the direct-link config.
 *
 * Labels come from the entries themselves now. They used to be a hardcoded
 * three-way ternary here, which meant adding an entry anywhere else silently
 * labelled it "Wiki". The open target is deliberately not exposed: callers get
 * an id to POST back, never a path or URL they could redirect.
 */
function publicQuickActions(config: QuickActionConfig) {
  const labels = new Map(config.items.map((item) => [item.id, item.label]));
  return {
    enabled: config.enabled,
    order: config.order,
    updatedAt: config.updatedAt,
    actions: config.order
      .filter((id) => labels.has(id))
      .map((id, order) => {
        const entry = config.items.find((item) => item.id === id)!;
        const target = entry.target;
        const kind = target.kind === 'path' ? 'directory' : target.kind === 'file' ? 'file' : target.kind;
        const summary = target.kind === 'url' ? target.url : target.kind === 'app' ? (target.path ? `${target.app} · ${target.path}` : target.app) : target.path;
        return { id, order, label: entry.label, description: entry.description, category: entry.category, favorite: entry.favorite === true, kind, summary, enabled: config.enabled.includes(id) };
      }),
  };
}

async function openLocalPath(target: string, spawner: import('./hosting.ts').Spawner): Promise<boolean> {
  const result = await runHostedCommand(spawner, {
    argv: ['/usr/bin/open', target],
    cwd: process.env.HOME ?? '/',
    graceMs: 5_000,
  }, 15_000);
  return !result.error && !result.timedOut && result.exitCode === 0;
}
