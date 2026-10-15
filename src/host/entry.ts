import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHosting, createSubprocessSpawner, type HostEvent, type SubprocessRuntimeLike } from './hosting.ts';
import { defaultWorkdir, ensureWorkdir, loadButlerConfig, publishWorkdir, publishedWorkdir } from './config.ts';
import { createButlerRouter } from './routes.ts';
import { markAuthenticatedDesktopRequest } from './card-pipeline.ts';
import { createCollector, type SessionEvent, type SessionInfo } from './collector.ts';
import type { AutomationHost } from './automations.ts';
import { createInjector, createUserMessage, type InjectorDeps } from './injector.ts';
import { createWikiContextLoader } from './wiki-context.ts';

export interface ButlerPluginConfig {
  workdir?: string;
  /** Test/package override; production uses the bundled generic skeleton. */
  skeletonDir?: string;
  /** Test override; defaults to the local `createUserMessage` (same shape as dsh-llm's). */
  createMessage?: InjectorDeps['createMessage'];
}

/** Mount Butler's in-process host into DSH's own web server and lifecycle. */
export async function mountButler(ctx: {
  webServer: { port: number; register(route: { kind: 'prefix'; path: string; handler: (req: any, res: any) => Promise<void> }): () => void };
  subprocess: SubprocessRuntimeLike;
  effect<T>(factory: () => T | Promise<T>, label?: string): T | Promise<T>;
  /** Cordis event bus; returns a disposer. Absent in hosts without session events. */
  on?: (event: string, handler: (...args: any[]) => unknown, options?: { prepend?: boolean }) => (() => void) | void;
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  /** Cordis non-injecting service read (`ctx.get(name)`); undefined when not provided. */
  get?: (name: string) => unknown;
}, pluginConfig: ButlerPluginConfig = {}): Promise<void> {
  const workdir = pluginConfig.workdir || process.env.BUTLER_WORKDIR || defaultWorkdir();
  const skeletonDir = pluginConfig.skeletonDir || await locateSkeleton();
  let initialized: { path: string; created: boolean };
  try {
    initialized = await ensureWorkdir(workdir, skeletonDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger?.error?.(`[butler] cannot initialize workdir: ${message}`);
    throw error;
  }
  if (initialized.created) ctx.logger?.warn?.(`[butler] initialized generic workdir at ${initialized.path}`);
  let config;
  try {
    config = await loadButlerConfig(initialized.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger?.error?.(`[butler] invalid workdir config: ${message}`);
    throw error;
  }
  const baseUrl = `http://127.0.0.1:${ctx.webServer.port}/myspace-butler`;
  const spawner = createSubprocessSpawner(ctx.subprocess);
  const collector = createCollector(config, spawner, {
    ...config.collector,
    onError: (message) => ctx.logger?.warn?.(`[butler] ${message}`),
  });
  // L0: facts the host witnessed itself go through the same intake path.
  const observeHost = (event: HostEvent) => {
    void collector.observe({ source: 'butler', type: event.type, tags: [event.subject], text: event.text, ref: `butler://${event.subject}` })
      .then((result) => { if (!result.queued) ctx.logger?.warn?.(`[butler] L0 intake failed: ${result.error ?? ''}`); });
  };
  const hosting = await createHosting(config, spawner, baseUrl, observeHost);
  const createMessage = config.inject.enabled ? pluginConfig.createMessage ?? createUserMessage : undefined;
  // Store cutover is explicit: old personal data is never silently replaced by an empty Wiki.
  let wikiActive = false;
  try {
    const marker = JSON.parse(await readFile(join(config.selfRoot, 'etc', 'knowledge-store.json'), 'utf8'));
    if (marker?.version !== 1 || !['legacy', 'wiki'].includes(marker?.active)) throw new Error('invalid knowledge-store marker');
    wikiActive = marker.active === 'wiki';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const injector = createMessage
    ? createInjector({ selfRoot: config.selfRoot, config: config.inject, createMessage,
      ...(wikiActive ? { loadWikiContext: createWikiContextLoader(config, spawner) } : {}),
      warn: (message) => ctx.logger?.warn?.(message) })
    : undefined;
  // schedule/sessionController/workspaceRegistry are optional App services. Cordis treats every
  // `inject` entry as required, so they are read per request with the
  // non-injecting `ctx.get(name)`; Butler still mounts without the bundle.
  const automationHost = (): AutomationHost | undefined => {
    try {
      const schedule = ctx.get?.('schedule') as AutomationHost['schedule'] | undefined;
      const sessionController = ctx.get?.('sessionController') as AutomationHost['sessionController'] | undefined;
      const workspaceRegistry = ctx.get?.('workspaceRegistry') as AutomationHost['workspaceRegistry'] | undefined;
      return schedule && sessionController ? { schedule, sessionController, ...(workspaceRegistry ? { workspaceRegistry } : {}) } : undefined;
    } catch {
      return undefined;
    }
  };
  const router = createButlerRouter(hosting, { hostUrl: baseUrl, collector, automationHost });
  // Keep route registration, auto-start, and managed-range teardown in one
  // effect so HMR/plugin unload cannot leave a route or child behind.
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/myspace-butler',
      handler: async (req, res) => {
        if (!req.headers.origin && req.headers['x-butler-desktop'] === 'dsh-app://app') {
          // Plugin routes are outside /api: explicitly invoke DSH's admission gate.
          const connection = ctx.get?.('connection') as { admit?: (request: any) => { rejection?: number; peer?: unknown } } | undefined;
          const admission = connection?.admit?.(req);
          if (!admission || admission.rejection !== undefined || !admission.peer) {
            res.writeHead(admission?.rejection ?? 403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'DSH 桌面认证失败，请重新打开应用' } }));
            return;
          }
          markAuthenticatedDesktopRequest(req);
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname.slice('/myspace-butler'.length) || '/';
        if (await router.handle(req, res, pathname, url)) return;
        if (!res.writableEnded) {
          res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: 'not_found' }));
        }
      },
    });
    // session/event is a synchronous notify; the collector debounces and runs
    // intake off the event path, so a slow or failing intake never blocks DSH.
    const unsubscribe = ctx.on?.('session/event', (session: SessionInfo, event: SessionEvent) => collector.onSessionEvent(session, event));
    const unsubscribeInject = injector ? ctx.on?.('agent/pre-step', injector as never, { prepend: true }) : undefined;
    hosting.autoStart();
    publishWorkdir(config.instanceRoot);
    return async () => {
      if (publishedWorkdir() === config.instanceRoot) publishWorkdir(undefined);
      if (typeof unsubscribe === 'function') unsubscribe();
      if (typeof unsubscribeInject === 'function') unsubscribeInject();
      collector.dispose();
      dispose();
      await collector.flush();
      await hosting.shutdown();
    };
  }, 'butler: in-process host');
}

async function locateSkeleton(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL('../skeleton', import.meta.url)),
    fileURLToPath(new URL('../../skeleton', import.meta.url)),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the package-root layout after the source layout.
    }
  }
  throw new Error(`找不到插件 skeleton：${candidates.join(', ')}`);
}
