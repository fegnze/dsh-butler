import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ButlerConfig } from './config.ts';
import { butlerEnv } from './config.ts';
import { runHostedCommand, type Spawner } from './hosting.ts';

/** Structural subset of DSH `SessionEvent` (@deepseek-ai/dsh-session). */
export interface SessionEvent { type?: unknown; seq?: unknown; id?: unknown; time?: unknown; data?: unknown }
/** Structural subset of DSH `Session`: `header` plus `snapshotEvents()`. */
export interface SessionInfo {
  header?: { id?: unknown; cwd?: unknown; agentPreset?: unknown; origin?: unknown; parentSession?: unknown; title?: unknown };
  snapshotEvents?: () => readonly unknown[];
}

export interface CollectorConfig {
  enabled: boolean;
  workspaces: string[];
  excludePresets: string[];
  includeSubagents: boolean;
  debounceMs: number;
}

export interface ObservationInput {
  source: string; type: string; tags?: string[]; text: string; ref?: string; workspace?: string;
  sessionId?: string; turn?: number; filesTouched?: string[]; toolsUsed?: string[]; gitCommits?: string[]; failed?: boolean;
}
export interface ObserveResult { queued: boolean; output: string; error?: string }

export interface TranscriptMessage { id: string; role: 'user' | 'assistant' | 'tool'; content: string; sequence: number; }
export interface TranscriptInput {
  source: 'dsh'; externalSessionId: string; workspace: string; title?: string; captureMode: 'transcript';
  segmentId: string; revision: number; messages: TranscriptMessage[];
  integrity: 'complete' | 'partial';
}
export interface Collector {
  readonly config: CollectorConfig;
  /** Resolves after pending-file recovery and the initial replay attempt. */
  readonly ready: Promise<void>;
  observe(input: ObservationInput): Promise<ObserveResult>;
  onSessionEvent(session: SessionInfo, event: SessionEvent): void;
  flush(): Promise<void>;
  dispose(): void;
}
export interface CollectorOptions extends Partial<CollectorConfig> {
  onError?: (message: string) => void;
  /** Explicit test/embedded-host escape hatch; durability is on by default. */
  durability?: boolean;
}

const SOURCE = 'dsh';
const TYPE = 'session';
const MAX_TEXT = 200;
const MAX_LIST = 100;
const MAX_MESSAGE = 64_000;
const MAX_TOOL_RESULT = 8_000;
const MAX_OUTBOX_COUNT = 1_000;
const MAX_OUTBOX_BYTES = 64 * 1024 * 1024;
const SAFE_SOURCE = /^[a-z0-9][a-z0-9-]*$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/g;
const PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path'];
const SECRET_RE = /(bearer\s+|api[_-]?key\s*[=:]\s*|token\s*[=:]\s*|password\s*[=:]\s*)[^\s,;]+/gi;
const OUTBOX_VERSION = 1;

type PendingPayload = { version: 1; keyHash: string; revisionHash: string; transcript: TranscriptInput };

/** DSH session collector. L0 observe remains journal intake; session turns use durable transcript ingest. */
export function createCollector(config: ButlerConfig, spawner: Spawner, raw: CollectorOptions = {}): Collector {
  const options: CollectorConfig = {
    enabled: raw.enabled !== false,
    workspaces: stringList(raw.workspaces),
    excludePresets: raw.excludePresets === undefined ? ['butler'] : stringList(raw.excludePresets),
    includeSubagents: raw.includeSubagents === true,
    debounceMs: Number.isFinite(raw.debounceMs) && Number(raw.debounceMs) >= 0 ? Number(raw.debounceMs) : 2_000,
  };
  const durable = raw.durability !== false;
  const report = (text: string) => { try { (raw.onError ?? console.warn)(text); } catch { /* logging must never reject the host chain */ } };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, PendingPayload>();
  const pendingBySession = new Map<string, Set<string>>();
  const persisting = new Map<string, Promise<void>>();
  const persisted = new Map<string, string>();
  const inflight = new Map<string, Promise<void>>();
  const draining = new Map<string, Promise<void>>();
  let drainAllTask: Promise<void> | undefined;
  let disposed = false;
  let initializing = true;
  let flushActive = false;
  let outboxCount = 0;
  let outboxBytes = 0;
  const intakePath = join(config.instanceRoot, 'faculties', 'journal', 'bin', 'intake');
  const pipelinePath = join(config.instanceRoot, 'faculties', 'journal', 'bin', 'pipeline');
  const pendingRoot = resolve(config.stateDir, 'collector-pending');

  const ready = (async () => {
    if (!durable || !options.enabled) {
      initializing = false;
      return;
    }
    try {
      await ensurePendingRoot();
      await recoverOutbox();
    } catch (error) {
      // Recovery failures are deliberately non-fatal: files remain untouched for a later startup.
      report(`collector: outbox 恢复失败 ${safeError(error)}`);
    }
    initializing = false;
    // A turn can arrive synchronously while recovery is in progress. Persist it before replaying.
    await waitForPersistence();
    await drainAll();
  })().catch((error) => {
    initializing = false;
    report(`collector: 初始化失败 ${safeError(error)}`);
  });

  const collector: Collector = {
    config: options,
    ready,
    async observe(input) {
      if (!SAFE_SOURCE.test(input.source)) return { queued: false, output: '', error: 'source 无效' };
      const tags = (input.tags ?? []).filter((tag) => typeof tag === 'string' && tag.length > 0 && tag.length <= 500 && !/[,\u0000-\u001f]/.test(tag)).slice(0, 32);
      const argv = [config.python ?? 'python', intakePath, '--source', input.source, '--type', input.type || 'note'];
      if (tags.length) argv.push('--tag', tags.join(','));
      if (input.ref) argv.push('--ref', input.ref.slice(0, 500));
      if (input.workspace) argv.push('--workspace', input.workspace.slice(0, 500));
      if (input.sessionId) argv.push('--session-id', input.sessionId.slice(0, 240));
      if (Number.isInteger(input.turn)) argv.push('--turn', String(input.turn));
      if (input.filesTouched?.length) argv.push('--files', input.filesTouched.slice(0, MAX_LIST).join('\u001f'));
      if (input.toolsUsed?.length) argv.push('--tools', input.toolsUsed.slice(0, MAX_LIST).join('\u001f'));
      if (input.gitCommits?.length) argv.push('--commits', input.gitCommits.slice(0, MAX_LIST).join('\u001f'));
      if (input.failed) argv.push('--failed');
      const result = await runHostedCommand(spawner, { argv, cwd: config.instanceRoot, env: butlerEnv(config), stdin: { data: input.text.slice(0, 2_000) }, graceMs: 5_000 }, 15_000);
      const queued = result.exitCode === 0 && !result.error && !result.timedOut;
      const error = queued ? undefined : (result.error?.message || result.stderr.trim() || (result.timedOut ? 'intake 超时' : `intake 退出码 ${result.exitCode}`));
      return { queued, output: result.stdout, error };
    },
    onSessionEvent(session, event) {
      if (disposed || !options.enabled || event?.type !== 'turn/end') return;
      const header = session?.header ?? {};
      const sessionId = stringValue(header.id);
      if (!sessionId) return report('collector: session.header.id 缺失，跳过');
      if (!allowed(header, options)) return;
      let transcript: TranscriptInput;
      try { transcript = deriveTranscript(session, event); }
      catch (error) { report(`collector: 会话快照失败 ${sessionId} ${safeError(error)}`); return; }
      const key = identityHash(transcript);
      const previous = pending.get(key);
      if (previous && previous.revisionHash === transcriptHash(previous.transcript)) return;
      if (previous) transcript = { ...transcript, revision: previous.transcript.revision + 1 };
      const payload = makePayload(transcript);
      pending.set(key, payload);
      persisted.delete(key);
      addSessionKey(transcript.externalSessionId, key);
      void persistCurrent(key, true);
    },
    async flush() {
      // Flush waits recovery, persistence, and sends, but does not spin forever on a failed send.
      if (flushActive) return;
      flushActive = true;
      try {
      await ready;
      await waitForPersistence();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await drainAll();
      await waitForPersistence();
      if (persisting.size) await Promise.allSettled([...persisting.values()]);
      if (draining.size || inflight.size) await Promise.allSettled([...draining.values(), ...inflight.values()]);
      } finally {
        flushActive = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      // Do not cancel pending or claimed work. The owning entry teardown awaits flush().
      void drainAll();
      if (inflight.size) report(`collector: shutdown 尚有 ${inflight.size} 个会话片段待 pipeline 回执；请 await flush() 后再终止 subprocess`);
    },
  };
  return collector;

  function addSessionKey(sessionId: string, key: string): void {
    const keys = pendingBySession.get(sessionId) ?? new Set<string>();
    keys.add(key);
    pendingBySession.set(sessionId, keys);
  }
  function removeSessionKey(sessionId: string, key: string): void {
    const keys = pendingBySession.get(sessionId);
    if (!keys) return;
    keys.delete(key);
    if (!keys.size) pendingBySession.delete(sessionId);
  }
  function scheduleSession(sessionId: string): void {
    if (disposed || initializing) return;
    const old = timers.get(sessionId);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      void drainSession(sessionId);
    }, options.debounceMs);
    timer.unref?.();
    timers.set(sessionId, timer);
  }
  function persistCurrent(key: string, onlyIfNew = false): Promise<void> {
    const active = persisting.get(key);
    if (active) return active;
    const payload = pending.get(key);
    if (!payload) return Promise.resolve();
    if (persisted.get(key) === payload.revisionHash) {
      if (!initializing) scheduleSession(payload.transcript.externalSessionId);
      return Promise.resolve();
    }
    const task = (async () => {
      if (!durable) {
        if (!initializing) scheduleSession(payload.transcript.externalSessionId);
        return;
      }
      let success = false;
      try {
        await persistPayload(payload);
        success = true;
        persisted.set(key, payload.revisionHash);
        if (!initializing) scheduleSession(payload.transcript.externalSessionId);
      } catch (error) {
        report(`collector: outbox 持久化失败 ${payload.keyHash} ${safeError(error)}`);
      } finally {
        persisting.delete(key);
        const latest = pending.get(key);
        // A newer revision that arrived during the write gets its own atomic write; an unchanged
        // failed revision remains in memory for the next explicit event/flush/startup retry.
        if (latest && latest.revisionHash !== payload.revisionHash) void persistCurrent(key);
      }
    })();
    persisting.set(key, task);
    void task.catch(() => undefined);
    return task;
  }
  async function waitForPersistence(): Promise<void> {
    // One snapshot is intentional: failures remain queued and are retried by a later flush/event.
    for (const key of [...pending.keys()]) void persistCurrent(key);
    if (persisting.size) await Promise.allSettled([...persisting.values()]);
  }
  async function drainAll(): Promise<void> {
    if (drainAllTask) return drainAllTask;
    drainAllTask = (async () => {
      // A manual flush claims debounce work synchronously; cancelling timers here also
      // closes the race where persistence finishes while flush is already draining.
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      const sessions = [...pendingBySession.keys()];
      for (const sessionId of sessions) void drainSession(sessionId);
      if (draining.size) await Promise.allSettled([...draining.values()]);
      if (inflight.size) await Promise.allSettled([...inflight.values()]);
    })().finally(() => { drainAllTask = undefined; });
    return drainAllTask;
  }
  function drainSession(sessionId: string): Promise<void> {
    const active = draining.get(sessionId);
    if (active) return active;
    const task = (async () => {
      const keys = [...(pendingBySession.get(sessionId) ?? [])];
      for (const key of keys) {
        const payload = pending.get(key);
        if (payload) await attempt(payload);
      }
    })().finally(() => draining.delete(sessionId));
    draining.set(sessionId, task);
    void task.catch((error) => report(`collector: drain 异常 ${safeError(error)}`));
    return task;
  }
  function attempt(payload: PendingPayload): Promise<void> {
    const active = inflight.get(payload.keyHash);
    if (active) return active;
    const task = (async () => {
      const result = await runHostedCommand(spawner, {
        argv: [config.python ?? 'python', pipelinePath], cwd: config.instanceRoot, env: butlerEnv(config),
        stdin: { data: JSON.stringify({ action: 'sessions.ingest', args: payload.transcript }) }, graceMs: 5_000,
      }, 15_000);
      // Exit zero alone is not a durable write receipt; keep unacknowledged input.
      const receipt = isPipelineSuccess(result.stdout);
      if (result.error || result.timedOut || result.exitCode !== 0) {
        report(`collector: pipeline 采集失败 ${payload.transcript.segmentId} ${result.timedOut ? 'timeout' : `exit ${result.exitCode}`}`);
        return;
      }
      if (!receipt) {
        report(`collector: pipeline 未确认写入 ${payload.transcript.segmentId}`);
        return;
      }
      // Keep the faculty response private: only a boolean receipt is used below.
      try {
        if (!durable || await removeOutboxIfMatch(payload)) {
          const current = pending.get(payload.keyHash);
          if (current?.revisionHash === payload.revisionHash) {
            pending.delete(payload.keyHash);
            removeSessionKey(payload.transcript.externalSessionId, payload.keyHash);
          }
        }
      } catch (error) {
        report(`collector: outbox 删除失败 ${payload.keyHash} ${safeError(error)}`);
      }
    })().catch((error) => { report(`collector: pipeline 异常 ${payload.keyHash} ${safeError(error)}`); });
    inflight.set(payload.keyHash, task);
    void task.finally(() => inflight.delete(payload.keyHash));
    return task;
  }

  async function ensurePendingRoot(): Promise<void> {
    const state = resolve(config.stateDir);
    await ensureDirectory(state);
    await ensureDirectory(pendingRoot);
    if (resolve(pendingRoot).split('/').length < resolve(state).split('/').length) throw new Error('collector outbox 路径非法');
  }
  async function recoverOutbox(): Promise<void> {
    const entries = await readdir(pendingRoot, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      const path = join(pendingRoot, name);
      if (!name.endsWith('.json')) {
        // Atomic-write leftovers are not an outbox record. Never follow or delete them.
        continue;
      }
      if (!HASH_RE.test(name.slice(0, -5))) {
        report(`collector: outbox 忽略非法文件名 ${safeName(name)}`);
        continue;
      }
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        report(`collector: outbox 拒绝非普通文件 ${safeName(name)}`);
        continue;
      }
      let payload: PendingPayload;
      try {
        payload = parsePayload(await readFile(path, 'utf8'));
      } catch (error) {
        report(`collector: outbox schema 无效 ${safeName(name)} ${safeError(error)}`);
        continue;
      }
      if (payload.keyHash !== name.slice(0, -5) || payload.keyHash !== identityHash(payload.transcript)) {
        report(`collector: outbox hash 不匹配 ${safeName(name)}`);
        continue;
      }
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (outboxCount >= MAX_OUTBOX_COUNT || outboxBytes + bytes > MAX_OUTBOX_BYTES) {
        report(`collector: outbox 超限，保留 ${payload.keyHash}`);
        continue;
      }
      const key = payload.keyHash;
      const current = pending.get(key);
      if (!current || current.transcript.revision < payload.transcript.revision) {
        pending.set(key, payload);
        persisted.set(key, payload.revisionHash);
        addSessionKey(payload.transcript.externalSessionId, key);
        outboxCount += 1;
        outboxBytes += stat.size;
      }
    }
  }
  async function persistPayload(payload: PendingPayload): Promise<void> {
    await ensurePendingRoot();
    const path = outboxPath(payload.keyHash);
    let previousBytes = 0;
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('目标不是普通文件');
      const previous = parsePayload(await readFile(path, 'utf8'));
      if (previous.keyHash !== payload.keyHash) throw new Error('目标文件 hash 不匹配');
      previousBytes = stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const encoded = JSON.stringify(payload);
    const bytes = Buffer.byteLength(encoded);
    if (!previousBytes && outboxCount >= MAX_OUTBOX_COUNT) throw new Error('outbox 文件数超限');
    if (outboxBytes - previousBytes + bytes > MAX_OUTBOX_BYTES) throw new Error('outbox 大小超限');
    const temp = join(pendingRoot, `.${payload.keyHash}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    if (!isFixedOutboxPath(temp)) throw new Error('临时路径非法');
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await rename(temp, path);
    } catch (error) {
      try { await unlink(temp); } catch { /* preserve the original rename error */ }
      throw error;
    }
    if (!previousBytes) outboxCount += 1;
    outboxBytes += bytes - previousBytes;
  }
  async function removeOutboxIfMatch(payload: PendingPayload): Promise<boolean> {
    if (!durable) return true;
    await ensurePendingRoot();
    const path = outboxPath(payload.keyHash);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('删除目标不是普通文件');
      const current = parsePayload(await readFile(path, 'utf8'));
      if (current.keyHash !== payload.keyHash || current.revisionHash !== payload.revisionHash) { report(`collector: outbox revision mismatch ${payload.keyHash}`); return false; }
      await unlink(path);
      outboxCount = Math.max(0, outboxCount - 1);
      outboxBytes = Math.max(0, outboxBytes - stat.size);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }
  function outboxPath(keyHash: string): string {
    if (!HASH_RE.test(keyHash)) throw new Error('outbox hash 非法');
    const path = join(pendingRoot, `${keyHash}.json`);
    if (!isFixedOutboxPath(path)) throw new Error('outbox 路径非法');
    return path;
  }
  function isFixedOutboxPath(path: string): boolean { return resolve(path).startsWith(`${resolve(pendingRoot)}/`) && resolve(path) !== resolve(pendingRoot); }
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('collector stateDir 必须是非 symlink 目录');
}
function identityKey(transcript: TranscriptInput): string { return `${transcript.externalSessionId}\u0000${transcript.segmentId}`; }
function identityHash(transcript: TranscriptInput): string { return createHash('sha256').update(identityKey(transcript)).digest('hex'); }
function transcriptHash(transcript: TranscriptInput): string { return createHash('sha256').update(JSON.stringify(transcript)).digest('hex'); }
function makePayload(transcript: TranscriptInput): PendingPayload { return { version: OUTBOX_VERSION, keyHash: identityHash(transcript), revisionHash: transcriptHash(transcript), transcript }; }
function parsePayload(raw: string): PendingPayload {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('不是对象');
  const item = value as Record<string, unknown>;
  if (item.version !== OUTBOX_VERSION || typeof item.keyHash !== 'string' || !HASH_RE.test(item.keyHash) || typeof item.revisionHash !== 'string' || !HASH_RE.test(item.revisionHash)) throw new Error('顶层 schema 无效');
  const transcript = validateTranscript(item.transcript);
  const result = { version: 1 as const, keyHash: item.keyHash, revisionHash: item.revisionHash, transcript };
  if (identityHash(transcript) !== result.keyHash || transcriptHash(transcript) !== result.revisionHash) throw new Error('内容 hash 无效');
  return result;
}
function validateTranscript(value: unknown): TranscriptInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('transcript schema 无效');
  const item = value as Record<string, unknown>;
  if (item.source !== 'dsh' || item.captureMode !== 'transcript' || typeof item.externalSessionId !== 'string' || !item.externalSessionId || typeof item.workspace !== 'string' || typeof item.segmentId !== 'string' || typeof item.revision !== 'number' || !Number.isInteger(item.revision) || item.revision < 1 || !['complete', 'partial'].includes(String(item.integrity)) || !Array.isArray(item.messages) || item.messages.length > MAX_LIST * 100) throw new Error('transcript 顶层字段无效');
  if (item.title !== undefined && typeof item.title !== 'string') throw new Error('transcript title 无效');
  const messages: TranscriptMessage[] = [];
  for (const raw of item.messages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('message schema 无效');
    const message = raw as Record<string, unknown>;
    if (typeof message.id !== 'string' || !message.id || !['user', 'assistant', 'tool'].includes(String(message.role)) || typeof message.content !== 'string' || typeof message.sequence !== 'number' || !Number.isInteger(message.sequence)) throw new Error('message 字段无效');
    if (message.content.length > MAX_MESSAGE) throw new Error('message 过大');
    messages.push({ id: message.id, role: message.role as TranscriptMessage['role'], content: message.content, sequence: message.sequence });
  }
  return { source: 'dsh', externalSessionId: item.externalSessionId, workspace: item.workspace, ...(item.title === undefined ? {} : { title: item.title as string }), captureMode: 'transcript', segmentId: item.segmentId, revision: item.revision, messages, integrity: item.integrity as TranscriptInput['integrity'] };
}
function isPipelineSuccess(output: string): boolean { try { const value = JSON.parse(output.trim()); return value?.ok === true && value?.data !== undefined; } catch { return false; } }
function allowed(header: NonNullable<SessionInfo['header']>, config: CollectorConfig): boolean {
  const preset = (stringValue(header.agentPreset) ?? '').toLowerCase();
  if (preset && config.excludePresets.some((item) => item.toLowerCase() === preset)) return false;
  if (!config.includeSubagents && header.origin === 'subagent') return false;
  if (config.workspaces.length === 0) return true;
  const cwd = stringValue(header.cwd);
  return cwd !== undefined && config.workspaces.includes(cwd);
}

interface RawEvent { type: string; seq: number; id?: string; time?: string | number; data: Record<string, unknown> }

/** Legacy bounded observation retained for L0/external observe compatibility only. */
export function deriveObservation(session: SessionInfo, end: SessionEvent): ObservationInput {
  const header = session.header ?? {};
  const sessionId = stringValue(header.id) ?? 'unknown';
  const workspace = stringValue(header.cwd);
  const endData = record(end.data);
  const turn = integer(endData.turn);
  const scoped = scopedEvents(session, end, turn);
  const prompt = scoped.find((item) => item.type === 'user/message' && record(item.data.source).kind === 'user');
  const files: string[] = [], tools: string[] = [], commits: string[] = [];
  let failed = record(endData.reason).kind === 'error';
  for (const item of scoped) {
    if (item.type === 'tool/call') { if (typeof item.data.name === 'string') tools.push(item.data.name); files.push(...argumentPaths(item.data.arguments)); }
    else if (item.type === 'tool/result') { const msg = record(item.data.message); const blocks = Array.isArray(msg.content) ? msg.content : []; if (item.data.error || blocks.some((block) => record(block).isError === true)) failed = true; for (const match of textOf(blocks).matchAll(COMMIT_RE)) commits.push(match[1]); }
  }
  return { source: SOURCE, type: TYPE, tags: workspace ? [`workspace:${workspace}`] : [], text: ((prompt ? textOf(prompt.data.content) : '').trim() || 'DSH 回合结束').slice(0, MAX_TEXT), ref: `dsh://${sessionId}${turn === undefined ? '' : `#${turn}`}`, workspace, sessionId, turn, filesTouched: unique(files), toolsUsed: unique(tools), gitCommits: unique(commits), failed };
}

/** Build a complete transcript segment from the actual snapshot event range. */
export function deriveTranscript(session: SessionInfo, end: SessionEvent): TranscriptInput {
  const header = session.header ?? {};
  const externalSessionId = stringValue(header.id);
  if (!externalSessionId) throw new Error('session.header.id 缺失');
  const workspace = stringValue(header.cwd) ?? '';
  const turn = turnOf(end);
  if (turn === undefined) throw new Error('turn/end.data.turn 缺失');
  const events = scopedEvents(session, end, turn);
  const messages: TranscriptMessage[] = [];
  for (const item of events) {
    const data = item.data;
    if (item.type === 'user/message') {
      const source = record(data.source);
      if (source.kind !== 'user') continue;
      const content = boundedSafeText(data.content, MAX_MESSAGE);
      if (content) messages.push({ id: eventMessageId(item, externalSessionId), role: 'user', content, sequence: item.seq });
    } else if (item.type === 'assistant/message' || item.type === 'assistant/final' || item.type === 'agent/message') {
      const message = record(data.message);
      const source = record(message.source);
      if (source.kind === 'plugin' || source.kind === 'system' || data.hidden === true || data.reasoning === true) continue;
      const content = boundedSafeText(data.content ?? message.content, MAX_MESSAGE);
      if (content) messages.push({ id: eventMessageId(item, externalSessionId), role: 'assistant', content, sequence: item.seq });
    } else if (item.type === 'tool/result') {
      const content = boundedSafeText(record(data.message).content ?? data.content, MAX_TOOL_RESULT);
      if (content) messages.push({ id: eventMessageId(item, externalSessionId), role: 'tool', content, sequence: item.seq });
    }
  }
  const uniqueMessages = [...new Map(messages.map((m) => [m.id, m])).values()].sort((a, b) => a.sequence - b.sequence);
  return {
    source: 'dsh', externalSessionId, workspace, ...(stringValue(header.title) ? { title: stringValue(header.title) } : {}),
    captureMode: 'transcript', segmentId: `dsh://${externalSessionId}#${turn}`, revision: 1, messages: uniqueMessages,
    integrity: events.length > 0 && !uniqueMessages.some(m => m.content.endsWith('[TRUNCATED]')) ? 'complete' : 'partial',
  };
}

function scopedEvents(session: SessionInfo, end: SessionEvent, turn: number | undefined): RawEvent[] {
  if (typeof session.snapshotEvents !== 'function') throw new Error('session.snapshotEvents 不可用');
  const events = session.snapshotEvents().map(normalize).filter((item): item is RawEvent => item !== undefined);
  const endSeq = integer(end.seq);
  let start = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (endSeq !== undefined && item.seq > endSeq) continue;
    if (item.type === 'turn/start' && (turn === undefined || integer(item.data.turn) === turn)) { start = index; break; }
  }
  return start < 0 ? [] : events.slice(start).filter((item) => endSeq === undefined || item.seq <= endSeq);
}
function normalize(value: unknown): RawEvent | undefined { const item = record(value); const seq = integer(item.seq); if (typeof item.type !== 'string' || seq === undefined) return undefined; return { type: item.type, seq, id: stringValue(item.id), time: typeof item.time === 'string' || typeof item.time === 'number' ? item.time : undefined, data: record(item.data) }; }
function eventMessageId(item: RawEvent, sessionId: string): string { return stringValue(item.data.id) ?? stringValue(record(item.data.message).id) ?? item.id ?? `dsh:${sessionId}:event:${item.seq}`; }
function turnOf(event: SessionEvent): number | undefined { return integer(record(event.data).turn); }
function argumentPaths(raw: unknown): string[] { if (typeof raw !== 'string') return []; try { const args = record(JSON.parse(raw)); return PATH_KEYS.map((key) => args[key]).filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1_000); } catch { return []; } }
function boundedSafeText(value: unknown, limit: number): string { const text = textOf(value).replace(SECRET_RE, '$1[REDACTED]').trim(); return text.length > limit ? `${text.slice(0, limit - 12)}\n[TRUNCATED]` : text; }
function textOf(value: unknown): string { if (typeof value === 'string') return value; if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n'); const item = record(value); if (item.type === 'text' && typeof item.text === 'string') return item.text; if (item.type === 'tool-result') return textOf(item.content); return ''; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isInteger(value) ? value : undefined; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.length > 0) : []; }
function unique(values: string[]): string[] { return [...new Set(values)].slice(0, MAX_LIST); }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 160) : 'unknown error'; }
function safeName(name: string): string { return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80); }
