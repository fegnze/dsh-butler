import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { butlerEnv, type ButlerConfig } from '../host/config.ts';
import { runHostedCommand, type Spawner } from '../host/hosting.ts';
import { delegationSpecFor, submitDelegationResult, SUBMIT_TOOL } from '../host/delegations.ts';

export const TOOL_NAMES = [
  'butler_journal_read', 'butler_distill_advance', 'butler_candidate', 'butler_card',
  'butler_search', 'butler_read', 'butler_report_session', 'butler_distill_claim',
  'butler_source_read', 'butler_candidate_submit', 'butler_distill_complete',
] as const;

type ToolName = (typeof TOOL_NAMES)[number];
type Args = Record<string, unknown>;
type Schema =
  | { type: 'string'; description: string; maxLength: number; enum?: string[]; pattern?: string }
  | { type: 'integer'; description: string; minimum: number; maximum?: number }
  | { type: 'array'; items: Schema; maxItems: number }
  | ObjectSchema;
interface ObjectSchema {
  type: 'object';
  additionalProperties: false;
  properties: Record<string, Schema>;
  required?: string[];
}
interface ToolSpec {
  name: ToolName;
  description: string;
  parameters: ObjectSchema;
}
interface LegacySpec extends ToolSpec {
  argv(args: Args): { script: string; argv: string[] };
}
type PipelineAction = 'cards.search' | 'cards.read' | 'sessions.ingest' | 'sessions.read'
  | 'distill.claim' | 'distill.complete' | 'candidates.submit';
interface PipelineSpec extends ToolSpec { action: PipelineAction }
interface ToolsHost { tools: { register(definition: unknown): () => void } }
export interface ButlerToolDeps {
  config: ButlerConfig | (() => Promise<ButlerConfig>);
  spawner: Spawner;
}
interface ConsumerDeps extends ButlerToolDeps { allowedScopes?: string[] }

const text = (description: string, maxLength: number, pattern?: string): Schema =>
  ({ type: 'string', description, maxLength, ...(pattern ? { pattern } : {}) });
const integer = (description: string, minimum: number, maximum?: number): Schema =>
  ({ type: 'integer', description, minimum, ...(maximum !== undefined ? { maximum } : {}) });
const choice = (description: string, values: string[]): Schema =>
  ({ type: 'string', description, maxLength: 100, enum: values });
const array = (items: Schema, maxItems: number): Schema => ({ type: 'array', items, maxItems });
const object = (properties: Record<string, Schema>, required?: string[]): ObjectSchema =>
  ({ type: 'object', additionalProperties: false, properties, ...(required ? { required } : {}) });

const legacySpecs: LegacySpec[] = [
  {
    name: 'butler_journal_read', description: 'Read observation records after the distill cursor (not commits or session turns).',
    parameters: object({ limit: integer('Max records.', 1, 200), max_chars: integer('Max chars per record.', 50, 4000) }),
    argv: (a) => ({ script: 'distill', argv: ['--json', ...(a.limit !== undefined ? [`--limit=${a.limit}`] : []), ...(a.max_chars !== undefined ? [`--max-chars=${a.max_chars}`] : [])] }),
  },
  {
    name: 'butler_distill_advance', description: 'Move the legacy distill cursor after the batch is handled.',
    parameters: object({ to: integer('Cursor.', 0) }, ['to']),
    argv: (a) => ({ script: 'distill', argv: [`--advance=${a.to}`] }),
  },
  {
    name: 'butler_candidate', description: 'Suggest an observation candidate; only the owner can promote it.',
    parameters: object({
      key: text('Journal key.', 80, '^journal:[0-9TZ:.+-]{1,40}:[a-z0-9][a-z0-9-]*(#[0-9]{1,4})?$'),
      to: choice('Target.', ['knowledge', 'rule', 'profile']), reason: text('Reason.', 300),
    }, ['key', 'to', 'reason']),
    argv: (a) => ({ script: 'memory', argv: ['candidate-mark', String(a.key), `--to=${a.to}`, `--reason=${a.reason}`] }),
  },
  {
    name: 'butler_card', description: 'Read legacy card index or a full card; never writes cards.',
    parameters: object({ id: text('Card id.', 80, '^(profile|(rule|knowledge)/[a-z0-9][a-z0-9-]{0,63})$') }),
    argv: (a) => ({ script: 'card', argv: a.id !== undefined ? [String(a.id)] : ['--list', '--json'] }),
  },
];

const consumerSpecs: PipelineSpec[] = [
  {
    name: 'butler_search', description: 'Search usable approved cards (title, summary, tags, body) within the consumer visibility allowlist. Archived or suspended cards are never returned.', action: 'cards.search',
    parameters: object({ query: text('Query.', 500), kind: choice('Kind.', ['knowledge', 'profile', 'rule']), scope: text('Visibility scope.', 100) }, ['query']),
  },
  {
    name: 'butler_read', description: 'Read a usable approved card within the consumer visibility allowlist. Fails with card_unavailable when the card is archived or suspended; do not rely on it then.', action: 'cards.read',
    parameters: object({ id: text('Card id.', 200) }, ['id']),
  },
  {
    name: 'butler_report_session', description: 'Ingest bounded source messages for later distillation.', action: 'sessions.ingest',
    parameters: object({
      source: text('Source.', 100), externalSessionId: text('External id.', 200),
      segmentId: text('Stable segment or turn id; reuse for retries.', 300), revision: integer('Segment revision, starting at 1.', 1),
      integrity: choice('Capture completeness.', ['complete', 'partial']), title: text('Session title.', 500),
      messages: array(object({
        id: text('Message id.', 200), role: choice('Role.', ['user', 'assistant', 'system', 'tool']),
        content: text('Content.', 50000), sequence: integer('Sequence.', 0, 100000),
      }, ['id', 'role', 'content', 'sequence']), 1000),
      workspace: text('Workspace.', 500), captureMode: text('Capture mode.', 50),
    }, ['source', 'externalSessionId', 'messages', 'segmentId', 'revision']),
  },
];
const distillSpecs: PipelineSpec[] = [
  {
    name: 'butler_distill_claim', description: 'Claim a bounded batch of distill inputs.', action: 'distill.claim',
    parameters: object({ limit: integer('Limit.', 1, 20), maxChars: integer('Input character budget.', 1000, 200000) }),
  },
  {
    name: 'butler_source_read', description: 'Read a source session by id.', action: 'sessions.read',
    parameters: object({ id: text('Source id.', 200) }, ['id']),
  },
  {
    name: 'butler_candidate_submit', description: 'Submit a candidate with source evidence; does not approve it.', action: 'candidates.submit',
    parameters: object({
      runId: text('Run id.', 200), runToken: text('Run token.', 500), inputHash: text('Input hash.', 200),
      kind: choice('Kind.', ['knowledge', 'profile', 'rule']), operation: choice('Operation.', ['create', 'revise', 'archive']),
      title: text('Title.', 500), summary: text('Summary.', 5000), body: text('Body.', 100000),
      rationale: text('Rationale.', 5000),
      scope: text('Visibility only (default local). Put where the card applies in appliesTo.', 100, '^[a-z][a-z0-9-]{0,31}$'),
      appliesTo: text('Where this card applies (project, area, situation).', 500),
      evidence: array(object({ sourceId: text('Source id.', 200), messageIds: array(text('Message id.', 200), 100), quote: text('Quote.', 5000) }, ['sourceId', 'messageIds']), 100),
      targetId: text('Target id.', 200), baseRevision: integer('Revision.', 0, 100000), tags: array(text('Tag.', 100), 50),
      checks: array(object({
        type: choice('path: file/dir must exist; quote: file must still contain text.', ['path', 'quote']),
        path: text('Path relative to the validity root, e.g. AGENTS.md.', 300), text: text('Exact authority text for a quote check.', 500),
      }, ['type', 'path']), 10),
      conflict: text('Revise/archive only: what in the target card the evidence now contradicts. Suspends the target until the owner decides.', 1000),
    }, ['runId', 'runToken', 'inputHash', 'kind', 'operation', 'title', 'summary', 'body', 'rationale', 'evidence']),
  },
  {
    name: 'butler_distill_complete', description: 'Complete a leased distill batch with its candidate ids.', action: 'distill.complete',
    parameters: object({
      runId: text('Run id.', 200), runToken: text('Run token.', 500), inputHash: text('Input hash.', 200),
      candidateIds: array(text('Candidate id.', 200), 100), reason: text('Reason.', 5000),
    }, ['runId', 'runToken', 'inputHash', 'candidateIds']),
  },
];

function isRecord(value: unknown): value is Args {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validateSchema(name: string, schema: Schema, value: unknown, path = name): void {
  const bad = (why: string): never => { throw new Error(`${name}: ${path} ${why}`); };
  switch (schema.type) {
    case 'object': {
      if (!isRecord(value)) return bad('must be an object');
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) bad(`unknown argument "${key}"`);
      }
      for (const key of schema.required ?? []) if (value[key] === undefined) bad(`missing "${key}"`);
      for (const [key, item] of Object.entries(value)) validateSchema(name, schema.properties[key]!, item, `${path}.${key}`);
      break;
    }
    case 'array':
      if (!Array.isArray(value) || value.length > schema.maxItems) return bad('invalid array');
      value.forEach((item, i) => validateSchema(name, schema.items, item, `${path}[${i}]`));
      break;
    case 'string':
      if (typeof value !== 'string' || !value.trim() || value.length > schema.maxLength) return bad('invalid string');
      if (schema.enum && !schema.enum.includes(value)) bad('invalid enum');
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) bad('has an invalid format');
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < schema.minimum || (schema.maximum !== undefined && value > schema.maximum)) bad('invalid integer');
      break;
  }
}

/** Validate the complete schema, including nested required fields, before spawning. */
export function validateArgs(spec: ToolSpec, raw: unknown): Args {
  validateSchema(spec.name, spec.parameters, raw);
  return raw as Args;
}
async function resolveConfig(deps: ButlerToolDeps): Promise<ButlerConfig> {
  return typeof deps.config === 'function' ? deps.config() : deps.config;
}
function journalBin(config: ButlerConfig): string {
  for (const scanRoot of config.scanRoots) {
    const bin = join(scanRoot, 'journal', 'bin');
    if (existsSync(join(bin, 'memory'))) return bin;
  }
  throw new Error('Butler journal faculty (journal/bin/memory) not found in scan roots');
}
function interpreter(config: ButlerConfig): string {
  if (!config.python?.trim()) throw new Error('Butler config.python is required to run journal faculty tools');
  return config.python;
}
async function pipeline(deps: ButlerToolDeps, action: PipelineAction, args: Args): Promise<unknown> {
  const config = await resolveConfig(deps);
  const python = interpreter(config);
  const result = await runHostedCommand(deps.spawner, {
    argv: [python, join(config.instanceRoot, 'faculties/journal/bin/pipeline')], cwd: config.instanceRoot,
    env: butlerEnv(config), stdin: { data: JSON.stringify({ action, args }) + '\n' }, graceMs: 5000,
  }, 110000);
  if (result.error) throw new Error(`${action}: ${result.error.message}`);
  if (result.timedOut) throw new Error(`${action}: timed out`);
  if (result.stdout.length >= 2 * 1024 * 1024 || result.stderr.length >= 2 * 1024 * 1024) throw new Error(`${action}: pipeline output truncated`);
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch {
    if (result.exitCode !== 0) throw new Error(`${action}: exit ${result.exitCode} ${result.stderr.trim().slice(0, 2000)}`);
    throw new Error(`${action}: invalid JSON output`);
  }
  // Faculty business failures are JSON on stdout, including when exitCode is nonzero.
  if (isRecord(parsed) && parsed.ok === false) {
    const error = parsed.error;
    if (isRecord(error)) throw new Error(`${action}: ${String(error.code ?? 'pipeline_failed')}: ${String(error.message ?? 'pipeline failed')}`);
    throw new Error(`${action}: ${String(error ?? 'pipeline failed')}`);
  }
  if (result.exitCode !== 0) throw new Error(`${action}: exit ${result.exitCode} ${result.stderr.trim().slice(0, 2000)}`);
  if (!isRecord(parsed) || parsed.ok !== true) throw new Error(`${action}: invalid pipeline envelope`);
  return parsed.data ?? null;
}
function definition(spec: ToolSpec, execute: (raw: unknown) => Promise<string>) {
  return {
    name: spec.name, description: spec.description, parameters: spec.parameters,
    output: { schema: { type: 'string' }, render: (_: unknown, value: string) => [{ type: 'text', text: value }] },
    timeoutMs: 120000, execute,
  };
}

/** No allowlist means the single-user local scope, never unrestricted access. */
export function registerConsumerTools(ctx: ToolsHost, deps: ConsumerDeps): Array<() => void> {
  const scopes = new Set(deps.allowedScopes ?? ['local']);
  const projectCard = (value: unknown, full: boolean) => {
    if (!isRecord(value)) throw new Error('invalid card');
    const fields = ['id', 'kind', 'title', 'summary', 'scope', 'appliesTo', 'revision', ...(full ? ['body', 'links'] : [])];
    return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  };
  // Defence in depth: the faculty already withholds unusable cards from consumers.
  const usableCard = (value: Args): boolean => value.status === 'active' && value.usable !== false
    && !(isRecord(value.validity) && value.validity.state !== 'valid');
  const allowedCard = (value: unknown): boolean => isRecord(value) && typeof value.scope === 'string' && scopes.has(value.scope) && usableCard(value);
  return consumerSpecs.map((spec) => ctx.tools.register(definition(spec, async (raw) => {
    const args = validateArgs(spec, raw);
    if (spec.action === 'cards.search' && args.scope !== undefined && !scopes.has(String(args.scope))) {
      throw new Error(`${spec.name}: scope not allowed`);
    }
    const data = await pipeline(deps, spec.action, args);
    if (spec.action === 'cards.search') {
      if (!isRecord(data) || !Array.isArray(data.items)) throw new Error(`${spec.name}: invalid cards.search response`);
      return JSON.stringify({ items: data.items.filter((card) => allowedCard(card) && (args.scope === undefined || (isRecord(card) && card.scope === args.scope))).map(card => projectCard(card, false)) });
    }
    if (spec.action === 'cards.read') {
      if (isRecord(data) && !usableCard(data)) throw new Error(`${spec.name}: card_unavailable: card is archived or suspended`);
      if (!allowedCard(data)) throw new Error(`${spec.name}: returned card scope not allowed`);
      return JSON.stringify(projectCard(data, true));
    }
    return JSON.stringify(data);
  })));
}
export function registerButlerTools(ctx: ToolsHost, deps: ButlerToolDeps): Array<() => void> {
  const legacy = legacySpecs.map((spec) => ctx.tools.register(definition(spec, async (raw) => {
    const args = validateArgs(spec, raw);
    const command = spec.argv(args);
    const config = await resolveConfig(deps);
    const python = interpreter(config);
    const bin = journalBin(config);
    const result = await runHostedCommand(deps.spawner, {
      argv: [python, join(bin, command.script), ...command.argv], cwd: bin, env: butlerEnv(config), graceMs: 5000,
    }, 110000);
    if (result.error) throw new Error(`${spec.name}: ${result.error.message}`);
    if (result.timedOut) throw new Error(`${spec.name}: timed out`);
    if (result.exitCode !== 0) throw new Error(`${spec.name}: exit ${result.exitCode} ${result.stderr.trim().slice(0, 2000)}`);
    return result.stdout.trim();
  })));
  const distill = distillSpecs.map((spec) => ctx.tools.register(definition(spec, async (raw) =>
    JSON.stringify(await pipeline(deps, spec.action, validateArgs(spec, raw))))));
  return [...legacy, ...registerConsumerTools(ctx, deps), ...distill];
}

/**
 * The single way a delegation Session hands its answer back. The result is validated against
 * the schema the extension declared; an invalid one returns the reason so the model can fix it.
 * The tool's own parameter schema is open (`result` is any JSON) because each delegation
 * declares its own shape; the real check happens in submitDelegationResult.
 */
export function registerDelegationSubmitTool(ctx: ToolsHost): () => void {
  return ctx.tools.register({
    name: SUBMIT_TOOL,
    description: 'Submit the result of the current delegated task exactly once. `result` must match the JSON schema given in the task prompt. Only usable inside a delegation session.',
    parameters: { type: 'object', additionalProperties: false, required: ['result'], properties: { result: { description: 'Result object matching the task\'s result schema.' } } },
    output: { schema: { type: 'string' }, render: (_: unknown, value: string) => [{ type: 'text', text: value }] },
    timeoutMs: 10000,
    execute: async (raw: unknown, exec?: { agent?: { id?: string } }) => {
      const sessionId = exec?.agent?.id;
      if (!delegationSpecFor(sessionId)) throw new Error(`${SUBMIT_TOOL}: this session is not serving a delegation`);
      if (!isRecord(raw) || !('result' in raw)) throw new Error(`${SUBMIT_TOOL}: missing "result"`);
      submitDelegationResult(sessionId, raw.result);
      return '已提交，任务结束。';
    },
  });
}
