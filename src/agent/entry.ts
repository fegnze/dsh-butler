import { join } from 'node:path';
import { createSubprocessSpawner, type Spawner, type SubprocessRuntimeLike } from '../host/hosting.ts';
import { loadButlerConfig, publishedWorkdir, type ButlerConfig } from '../host/config.ts';
import { registerButlerTools, registerDelegationSubmitTool, TOOL_NAMES } from './tools.ts';
import { delegationToolsFor, SUBMIT_TOOL } from '../host/delegations.ts';

/**
 * Agent-scoped half of the Butler plugin, mounted as a row inside the `butler`
 * agent preset. Tools registered here are visible only to agents of that
 * preset. It reads the same work directory as the Host, never initializes it,
 * and spawns only through the DSH subprocess seam.
 *
 * The workdir is resolved per call, not at apply time: preset rows can be
 * applied before the Host plugin finishes mounting, and freezing a fallback
 * then silently pointed real sessions at the generic `~/.dsh/butler` skeleton
 * (measured 2026-10-10). There is deliberately no default-workdir fallback.
 */
/**
 * Tools a Butler agent may execute. Enforced with an agent-scoped
 * `tools.guard`, not `tools.restrict`: the preset's own glob/grep/ask_user rows
 * register into an *ancestor* layer, so `restrict({allow: []})` hid them and
 * the butler_* tools too (measured 2026-10-10: only team/schedule tools
 * remained). A guard leaves the catalog untouched and refuses everything else
 * at execution time, which is the boundary that matters.
 */
export const BUTLER_ALLOWED_TOOLS: ReadonlySet<string> = new Set([...TOOL_NAMES, 'glob', 'grep', 'ask_user_question']);

/**
 * A Session serving a delegation is narrowed to that delegation's declared tools plus the
 * submit tool (no distill/candidate tools, no ask_user: nobody is there to answer). Any other
 * Butler Session keeps the preset's normal set; the submit tool is refused there.
 */
export function butlerGuard(exec: { name: string; agent?: { id?: string } }): string | undefined {
  const delegated = delegationToolsFor(exec.agent?.id);
  if (delegated) return delegated.has(exec.name) ? undefined : `This delegation allows only ${[...delegated].join(', ')}; \`${exec.name}\` is not permitted`;
  if (exec.name === SUBMIT_TOOL) return `\`${SUBMIT_TOOL}\` is only available inside a delegation session`;
  return BUTLER_ALLOWED_TOOLS.has(exec.name) ? undefined : `Butler preset does not allow \`${exec.name}\`; use butler_* tools, glob, grep or ask_user_question`;
}

export async function applyAgent(ctx: {
  tools: { register(definition: unknown): () => void; guard?(guard: (exec: { name: string }) => string | undefined): () => void };
  subprocess: SubprocessRuntimeLike;
  effect<T>(factory: () => T | Promise<T>, label?: string): T | Promise<T>;
}, pluginConfig: { workdir?: string } = {}, overrides: { spawner?: Spawner } = {}): Promise<void> {
  const spawner = overrides.spawner ?? createSubprocessSpawner(ctx.subprocess);
  let cached: { workdir: string; config: ButlerConfig } | undefined;
  const config = async (): Promise<ButlerConfig> => {
    const workdir = pluginConfig.workdir || publishedWorkdir() || process.env.BUTLER_WORKDIR;
    if (!workdir) throw new Error('Butler workdir unknown: the Butler Host plugin has not mounted (no published workdir)');
    if (cached?.workdir !== workdir) cached = { workdir, config: await loadButlerConfig(join(workdir, 'butler.json')) };
    return cached.config;
  };
  ctx.effect(() => {
    const disposers = [...registerButlerTools(ctx, { config, spawner }), registerDelegationSubmitTool(ctx)];
    if (ctx.tools.guard) disposers.push(ctx.tools.guard(butlerGuard));
    return async () => {
      for (const dispose of disposers.reverse()) dispose();
      await spawner.shutdown?.();
    };
  }, 'butler: agent tools');
}
