import { join } from 'node:path';
import { createSubprocessSpawner, type Spawner, type SubprocessRuntimeLike } from '../host/hosting.ts';
import { loadButlerConfig, publishedWorkdir, type ButlerConfig } from '../host/config.ts';
import { registerConsumerTools } from './tools.ts';

/** Configuration for the consumer-facing, read/report-only agent extension. */
export interface ConsumerPluginConfig {
  /** Optional fixed scope allow-list. It is plugin configuration, never model input. */
  allowedScopes?: readonly string[];
}

/**
 * Mount consumer tools without a restricted/guard layer. The host owns the
 * workdir publication; this bundle only reads it and never initializes an
 * instance or personal state of its own.
 */
export async function applyConsumer(
  ctx: {
    tools: { register(definition: unknown): () => void };
    subprocess: SubprocessRuntimeLike;
    effect<T>(factory: () => T | Promise<T>, label?: string): T | Promise<T>;
  },
  pluginConfig: ConsumerPluginConfig = {},
  overrides: { spawner?: Spawner } = {},
): Promise<void> {
  const spawner = overrides.spawner ?? createSubprocessSpawner(ctx.subprocess);
  let cached: { workdir: string; config: ButlerConfig } | undefined;
  const config = async (): Promise<ButlerConfig> => {
    const workdir = publishedWorkdir();
    if (!workdir) throw new Error('Butler workdir unknown: the Butler Host plugin has not mounted (no published workdir)');
    if (cached?.workdir !== workdir) cached = { workdir, config: await loadButlerConfig(join(workdir, 'butler.json')) };
    return cached.config;
  };
  ctx.effect(() => {
    const disposer = registerConsumerTools(ctx, { config, spawner, ...(pluginConfig.allowedScopes ? { allowedScopes: [...pluginConfig.allowedScopes] } : {}) });
    return async () => {
      for (const dispose of disposer.reverse()) dispose();
      await spawner.shutdown?.();
    };
  }, 'butler: consumer tools');
}
