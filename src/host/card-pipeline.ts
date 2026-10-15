import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { butlerEnv, type ButlerConfig } from './config.ts';
import { runHostedCommand, type Spawner } from './hosting.ts';

/** Actions understood by the journal card pipeline faculty. */
export const PIPELINE_ACTIONS = [
  'sessions.ingest', 'sessions.list', 'sessions.read',
  'candidates.list', 'candidates.get', 'candidates.edit', 'candidates.approve', 'candidates.reject',
  'cards.search', 'cards.read', 'distill.claim', 'distill.complete', 'candidates.submit',
  'migration.plan', 'review.prepare',
] as const;
export type PipelineAction = typeof PIPELINE_ACTIONS[number];

/** Actions deliberately exposed to the unauthenticated (but local/trusted) HTTP face. */
const HTTP_ACTIONS = new Set<PipelineAction>([
  'sessions.ingest', 'sessions.list', 'sessions.read',
  'candidates.list', 'candidates.get', 'candidates.edit', 'candidates.approve', 'candidates.reject',
  'cards.search', 'cards.read', 'review.prepare',
]);
const REVIEW_ACTIONS = new Set<PipelineAction>(['review.prepare', 'candidates.edit', 'candidates.approve', 'candidates.reject']);
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const MAX_ARGS_BYTES = 240 * 1024;
const REVIEW_TTL_MS = 2 * 60 * 1000;
const MAX_REVIEW_TOKENS = 256;

export interface PipelineErrorShape {
  code: string;
  message: string;
  [key: string]: unknown;
}

export class PipelineError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status = statusForPipelineCode(code), details?: Record<string, unknown>) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type PipelineEnvelope =
  | { ok: true; data: unknown }
  | { ok: false; error: PipelineErrorShape };

/**
 * Run the one fixed faculty command.  No shell is involved: the interpreter,
 * script and JSON request are separate argv/stdin values. This function is
 * intentionally exported for the agent-side tools and CLI adapters.
 */
export async function runPipeline(
  config: ButlerConfig,
  spawner: Spawner,
  action: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (!isPipelineAction(action)) throw new PipelineError('invalid_action', '不支持的 pipeline action', 400);
  if (REVIEW_ACTIONS.has(action)) throw new PipelineError('forbidden', '审核 action 只能由受信 Host UI 流程调用', 403);
  return executePipeline(config, spawner, action, args);
}

async function executePipeline(
  config: ButlerConfig,
  spawner: Spawner,
  action: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const safeArgs = validateArgs(args);
  if (!config.python) throw new PipelineError('pipeline_config', '未配置 pipeline Python 解释器', 502);
  const command = join(config.instanceRoot, 'faculties', 'journal', 'bin', 'pipeline');
  const input = JSON.stringify({ action, args: safeArgs });
  const result = await runHostedCommand(spawner, {
    argv: [config.python, command],
    cwd: config.instanceRoot,
    env: butlerEnv(config),
    stdin: { data: input },
    graceMs: 5_000,
  }, 120_000);
  if (result.timedOut) throw new PipelineError('pipeline_timeout', 'pipeline 执行超时', 502);
  if (result.error) throw new PipelineError('pipeline_spawn_failed', 'pipeline 无法启动', 502);
  if (result.stdout.length >= OUTPUT_LIMIT || result.stderr.length >= OUTPUT_LIMIT) {
    throw new PipelineError('pipeline_output_truncated', 'pipeline 输出过大，未接受截断结果', 502);
  }
  const envelope = parseEnvelope(result.stdout);
  if (result.exitCode !== 0) {
    if (envelope?.ok === false) throw pipelineBusinessError(envelope.error);
    throw new PipelineError('pipeline_failed', 'pipeline 执行失败', 502);
  }
  if (!envelope) throw new PipelineError('pipeline_invalid_response', 'pipeline 返回无效结果', 502);
  if (!envelope.ok) throw pipelineBusinessError(envelope.error);
  return envelope.data;
}

export interface PipelineHttpResult {
  status: number;
  envelope: PipelineEnvelope;
}

export interface PipelineEndpoint {
  handle(request: IncomingMessage, body: Record<string, unknown>): Promise<PipelineHttpResult>;
  /** Remove expired credentials; useful for long-lived hosts and deterministic tests. */
  cleanup(): void;
}

interface ReviewToken {
  token: string;
  id: string;
  revision: number;
  contentHash: string;
  origin: string;
  expiresAt: number;
  action?: 'candidates.approve' | 'candidates.reject';
  fingerprint?: string;
  idempotencyKey?: string;
  result?: Promise<unknown>;
}

/** Create the HTTP endpoint and its in-memory, short-lived review credentials. */
export function createPipelineEndpoint(config: ButlerConfig, spawner: Spawner, options: { hostUrl?: string } = {}): PipelineEndpoint {
  const tokens = new Map<string, ReviewToken>();
  const expectedOrigin = options.hostUrl ? originOf(options.hostUrl) : undefined;

  const cleanup = () => {
    const now = Date.now();
    for (const [key, value] of tokens) if (value.expiresAt <= now) tokens.delete(key);
    while (tokens.size > MAX_REVIEW_TOKENS) {
      const oldest = tokens.keys().next().value;
      if (oldest === undefined) break;
      tokens.delete(oldest);
    }
  };

  const handle = async (request: IncomingMessage, body: Record<string, unknown>): Promise<PipelineHttpResult> => {
    cleanup();
    try {
      const action = body.action;
      if (typeof action !== 'string' || !isPipelineAction(action)) throw new PipelineError('invalid_action', '不支持的 pipeline action', 400);
      if (!HTTP_ACTIONS.has(action)) throw new PipelineError('forbidden', '该 pipeline action 不开放 HTTP 调用', 403);
      const args = body.args;
      if (!isRecord(args)) throw new PipelineError('invalid_args', 'args 必须是 JSON 对象', 400);
      if (REVIEW_ACTIONS.has(action)) assertReviewRequest(request, expectedOrigin);
      validateArgs(args);
      if (action === 'candidates.approve' || action === 'candidates.reject') {
        const data = await runMutation(request, action, args);
        return success(data);
      }
      if (action === 'candidates.edit') {
        const { reviewToken: _ignored, actor: _actor, ...editArgs } = args;
        const data = await executePipeline(config, spawner, action, editArgs);
        return success(data);
      }
      if (action === 'review.prepare') {
        const data = await prepareReview(request, args);
        // The short-lived review token is intentionally returned only by this
        // preparation response; it is never forwarded to the faculty command.
        return { status: 200, envelope: { ok: true, data } };
      }
      const data = await runPipeline(config, spawner, action, args);
      return success(stripCredentialFields(data));
    } catch (error) {
      return failure(error);
    }
  };

  const prepareReview = async (request: IncomingMessage, args: Record<string, unknown>) => {
    const binding = reviewBinding(args);
    const origin = requestOrigin(request, expectedOrigin);
    const data = await executePipeline(config, spawner, 'candidates.get', { id: binding.id });
    const candidate = candidateData(data);
    if (!candidate || candidate.id !== binding.id) throw new PipelineError('not_found', '候选不存在', 404);
    if (candidate.revision !== binding.revision || candidate.contentHash !== binding.contentHash) {
      throw new PipelineError('revision_conflict', '候选版本或内容已变化', 409, {
        currentRevision: candidate.revision,
        currentContentHash: candidate.contentHash,
      });
    }
    cleanup();
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + REVIEW_TTL_MS;
    tokens.set(token, { token, ...binding, origin, expiresAt });
    cleanup();
    return { reviewToken: token, expiresAt };
  };

  const runMutation = async (request: IncomingMessage, action: 'candidates.approve' | 'candidates.reject', args: Record<string, unknown>) => {
    const binding = reviewBinding(args);
    const token = requiredString(args.reviewToken, 'reviewToken');
    const idempotencyKey = requiredString(args.idempotencyKey, 'idempotencyKey');
    if (idempotencyKey.length > 200) throw new PipelineError('invalid_idempotency_key', 'idempotencyKey 无效', 400);
    const review = tokens.get(token);
    if (!review || review.expiresAt <= Date.now()) {
      if (review) tokens.delete(token);
      throw new PipelineError('forbidden', '审核凭据无效或已过期', 403);
    }
    const origin = requestOrigin(request, expectedOrigin);
    if (review.origin !== origin || review.id !== binding.id || review.revision !== binding.revision || review.contentHash !== binding.contentHash) {
      throw new PipelineError('forbidden', '审核凭据绑定不匹配', 403);
    }
    const forwarded: Record<string, unknown> = { ...binding, actor: 'human-ui', idempotencyKey };
    if (args.baseRevision !== undefined) {
      if (!Number.isInteger(args.baseRevision) || Number(args.baseRevision) < 0) throw new PipelineError('invalid_base_revision', 'baseRevision 无效', 400);
      forwarded.baseRevision = args.baseRevision;
    }
    if (action === 'candidates.reject' && args.reason !== undefined) {
      if (typeof args.reason !== 'string' || args.reason.length > 4_000) throw new PipelineError('invalid_reason', 'reason 无效', 400);
      forwarded.reason = args.reason;
    }
    // Fingerprint the entire caller payload (canonical key order), not just the
    // forwarded subset, so adding ignored fields is not a distinct-request bypass.
    const fingerprint = fingerprintOf({ action, args });
    if (review.action) {
      if (review.action !== action || review.idempotencyKey !== idempotencyKey || review.fingerprint !== fingerprint) {
        throw new PipelineError('idempotency_conflict', '审核凭据已用于不同请求', 409);
      }
      if (review.result) return review.result;
    }
    review.action = action;
    review.idempotencyKey = idempotencyKey;
    review.fingerprint = fingerprint;
    // Share the same in-flight promise for concurrent identical retries. Keep
    // failures too: a transport-ambiguous mutation must not be executed twice.
    review.result = executePipeline(config, spawner, action, forwarded).then(stripCredentialFields);
    return review.result;
  };

  return { cleanup, handle };
}

function success(data: unknown): PipelineHttpResult {
  return { status: 200, envelope: { ok: true, data: stripCredentialFields(data) } };
}

function failure(error: unknown): PipelineHttpResult {
  if (error instanceof PipelineError) {
    const details = error.details ? stripCredentialFields(error.details) : undefined;
    return { status: error.status, envelope: { ok: false, error: { code: error.code, message: error.message, ...(details ?? {}) } } };
  }
  return { status: 500, envelope: { ok: false, error: { code: 'internal', message: 'pipeline 请求失败' } } };
}

function parseEnvelope(text: string): PipelineEnvelope | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || typeof value.ok !== 'boolean') return undefined;
    if (value.ok === true) return { ok: true, data: value.data };
    if (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') return undefined;
    return { ok: false, error: value.error as PipelineErrorShape };
  } catch {
    return undefined;
  }
}

function pipelineBusinessError(error: PipelineErrorShape): PipelineError {
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : 'pipeline_failed';
  // Never reflect arbitrary command messages, stderr or nested error payloads:
  // even a well-formed business error may contain credentials from bad input.
  const details: Record<string, unknown> = {};
  for (const key of ['currentRevision', 'expectedRevision', 'baseRevision']) {
    if (Number.isSafeInteger(error[key])) details[key] = error[key];
  }
  return new PipelineError(code, `pipeline 业务错误：${code}`, statusForPipelineCode(code), details);
}

function statusForPipelineCode(code: string): number {
  if (code === 'store_not_active') return 409;
  if (code === 'not_found') return 404;
  if (code === 'forbidden') return 403;
  if (['card_unavailable', 'revision_conflict', 'base_revision_conflict', 'already_decided', 'idempotency_conflict', 'input_changed', 'candidate_mismatch', 'lease_expired'].includes(code)) return 409;
  if (code.startsWith('invalid_')) return 400;
  return 502;
}

function isPipelineAction(value: string): value is PipelineAction {
  return (PIPELINE_ACTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(args)) throw new PipelineError('invalid_args', 'args 必须是 JSON 对象', 400);
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(args), 'utf8'); } catch { throw new PipelineError('invalid_args', 'args 不是可序列化 JSON', 400); }
  if (size > MAX_ARGS_BYTES) throw new PipelineError('invalid_args', 'args 过大', 400);
  return args;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw new PipelineError(`invalid_${name}`, `${name} 无效`, 400);
  return value;
}

function reviewBinding(args: Record<string, unknown>): { id: string; revision: number; contentHash: string } {
  const id = requiredString(args.id, 'id');
  if (!Number.isInteger(args.revision) || Number(args.revision) < 1) throw new PipelineError('invalid_revision', 'revision 无效', 400);
  const contentHash = requiredString(args.contentHash, 'contentHash');
  return { id, revision: Number(args.revision), contentHash };
}

/**
 * Owner-only gate: same-origin UI with `X-Butler-Review: 1` and an explicit Origin (or an
 * authenticated DSH desktop forward). SDK processes and agent tools cannot produce it, which is
 * why workflow step confirmation reuses it too.
 */
export function assertReviewRequest(request: IncomingMessage, expectedOrigin?: string): void {
  const headers = request?.headers ?? {};
  // Some desktop WebViews omit Fetch Metadata. Explicit Origin remains mandatory
  // and is matched against the configured Host below; never accept a cross-site value.
  const site = header(headers, 'sec-fetch-site');
  if (header(headers, 'x-butler-review') !== '1' || (site !== undefined && site !== 'same-origin')) {
    throw new PipelineError('forbidden', '审核动作必须来自受信同源 UI', 403);
  }
  requestOrigin(request, expectedOrigin);
}

const authenticatedDesktopRequests = new WeakSet<IncomingMessage>();
/** Called only after DSH clientConnection.admit verifies the signed cookie. */
export function markAuthenticatedDesktopRequest(request: IncomingMessage): void {
  authenticatedDesktopRequests.add(request);
}

function requestOrigin(request: IncomingMessage, expectedOrigin?: string): string {
  const origin = header(request?.headers ?? {}, 'origin');
  if (!origin) {
    // DSH desktop forwardWebRequest strips Origin/Fetch Metadata, injects its
    // signed auth cookie, and the Host authentication gate runs before routes.
    // The custom header is CSRF intent, NOT standalone authentication.
    const headers = request?.headers ?? {};
    const host = header(headers, 'host');
    const cookie = header(headers, 'cookie') ?? '';
    if (authenticatedDesktopRequests.has(request) && expectedOrigin && host === new URL(expectedOrigin).host
      && header(headers, 'x-butler-desktop') === 'dsh-app://app'
      && header(headers, 'x-butler-review') === '1'
      && header(headers, 'sec-fetch-site') === undefined
      && /(?:^|;\s*)dsh-auth-[^=;\s]+=[^;\s]+/.test(cookie)) return expectedOrigin;
    throw new PipelineError('forbidden', '审核动作必须显式携带 Origin，或经过已认证的 DSH 桌面转发', 403);
  }
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new PipelineError('forbidden', 'Origin 无效', 403); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new PipelineError('forbidden', 'Origin 无效', 403);
  }
  const normalized = parsed.origin;
  if (expectedOrigin && normalized !== expectedOrigin) throw new PipelineError('forbidden', 'Origin 与 Butler 不匹配', 403);
  const host = header(request?.headers ?? {}, 'host');
  if (host && normalized !== `http://${host}` && normalized !== `https://${host}`) throw new PipelineError('forbidden', 'Origin 与请求主机不匹配', 403);
  return normalized;
}

function originOf(value: string): string | undefined {
  try { return new URL(value).origin; } catch { return undefined; }
}

function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function candidateData(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  const candidate = isRecord(data.candidate) ? data.candidate : data;
  return candidate;
}

function fingerprintOf(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item)
    ? item.map(canonical)
    : isRecord(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]))
      : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function safeMessage(value: unknown): string {
  return typeof value === 'string' && value.length <= 500 ? scrubSecrets(value) : 'pipeline 业务错误';
}

function scrubSecrets(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/([?&](?:api[-_]?key|token|secret|password|authorization|credential)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(api[-_]?key|token|secret|password|authorization|cookie|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function stripCredentialFields(value: unknown): any {
  if (Array.isArray(value)) return value.map(stripCredentialFields);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:reviewToken|leaseToken|runToken)$/i.test(key)) continue;
    // Content and hashes are domain data, not credentials. Redact secrets at
    // ingestion; never mutate the exact revision/hash-bound review payload.
    out[key] = stripCredentialFields(child);
  }
  return out;
}
