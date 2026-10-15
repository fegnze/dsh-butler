import { runHostedCommand, type Spawner } from './hosting.ts';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

export interface ButlerEndpointStatus {
  id: string;
  kind: string;
  installed: boolean;
  version?: number;
  status: 'ok' | 'legacy' | 'missing' | 'fail' | 'unknown';
}

export type ButlerDetailSection = 'journal' | 'spool' | 'endpoints' | 'endpoint' | 'doctor' | 'config' | 'digests' | 'memory';

export interface ButlerStatus {
  root: string;
  /** Aggregate for older consumers; prefer the three split signals below. */
  status: 'healthy' | 'warning' | 'error';
  /** doctor only: any failure, non-zero exit or unparsable run is `error`; warnings are `warning`. */
  health: 'healthy' | 'warning' | 'error';
  /** Observations waiting for `run` to merge. */
  queue: { spool: number };
  /** Proposals awaiting a decision, from `proposals.jsonl` (the only source). */
  pending: { count: number; bad: number; items: ButlerPendingProposal[] };
  checkedAt: string;
  doctor: {
    exitCode: number;
    passed: number;
    warnings: number;
    failures: number;
    output: string;
  };
  journal: {
    records: number;
    /** What the journal took in over the last 24 hours, by kind: the briefing's live "what happened". */
    recent: { observation: number; git: number; session: number };
    latest?: { ts?: string; source?: string; type?: string; text?: string };
  };
  spool: {
    records: number;
    sources: number;
  };
  /** Distill's open suggestions: observation records marked "worth promoting" and not yet decided. */
  /** Where distill stands: how much is still to read, and when it last moved on. */
  distill: {
    /** Journal rows distill has already read past (the cursor). */
    read: number;
    /** Journal rows in total. */
    total: number;
    /** Observation rows after the cursor: what the next distill will actually look at. */
    waiting: number;
    /** Git and session-turn rows after the cursor: they are looked up, never distilled. */
    reference: number;
    /** When the cursor last moved (the cursor file's own time); absent before the first distill. */
    lastRunAt?: string;
  };
  candidates: {
    count: number;
    /** Suggestions the owner turned into a card, and ones the owner declined. */
    promoted: number;
    dismissed: number;
    /** Newest first, at most a handful: enough for the briefing to name them. */
    items: Array<{ key: string; to: 'knowledge' | 'rule' | 'profile'; reason: string; ts?: string; text?: string }>;
  };
  latestDigest?: {
    name: string;
    relativePath: string;
    updatedAt: string;
    preview: string;
  };
  endpoints: ButlerEndpointStatus[];
}

export interface ButlerJournalRecord {
  ts?: string;
  source?: string;
  type?: string;
  tags?: string[];
  text?: string;
  /** Provenance, e.g. `dsh://<sessionId>#<turn>`, `git://<repo>@<sha>`, `proposal://<id>`. */
  ref?: string;
  /** On a `decision` written by a promotion: the record it was promoted from (`journal:<ts>:<source>`). */
  origin?: string;
  workspace?: string;
  sessionId?: string;
  turn?: number;
  toolsUsed?: string[];
  filesTouched?: string[];
  gitCommits?: Array<{ sha?: string; subject?: string }>;
  failed?: boolean;
}

const strings = (value: unknown, max = 50): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, max).map((item) => item.slice(0, 300)) : undefined;

export interface ButlerSpoolSource {
  source: string;
  records: number;
  entries: ButlerJournalRecord[];
}

export interface ButlerDigestEntry {
  name: string;
  relativePath: string;
  updatedAt: string;
  preview: string;
}

export type ButlerDetail =
  | { section: 'journal'; total: number; records: ButlerJournalRecord[] }
  | { section: 'spool'; total: number; sources: ButlerSpoolSource[] }
  | { section: 'endpoints'; endpoints: ButlerEndpointStatus[] }
  | { section: 'endpoint'; endpoint: ButlerEndpointStatus & { path?: string; driver?: string; endpointVersion?: number; installedAt?: string } }
  | { section: 'doctor'; checkedAt: string; doctor: ButlerStatus['doctor'] }
  | { section: 'config'; root: string; persona: { profilePath: string; profile: string; rulesPath: string; rules: Array<{ slug: string; title: string; summary: string }> }; registryPath: string; automations: string[]; commands: { name: string; purpose: string }[]; maintenance: string[] }
  | { section: 'digests'; entries: ButlerDigestEntry[] }
  | { section: 'memory'; cards: ButlerCard[]; profile: string; records: ButlerRecordGroups; trash: number };

/**
 * The journal split by what a record is, not by where it was stored.
 *
 * `observation` is what an agent or the owner chose to report: the only group
 * a card can be promoted from. `git` (a commit already is the authoritative
 * record of itself) and `session` (a turn-end marker the collector derives) are
 * kept for looking things up and never offered for promotion.
 */
export type ButlerRecordKind = 'observation' | 'git' | 'session';
export type ButlerRecordGroups = Record<ButlerRecordKind, { total: number; records: ButlerMemoryRecord[] }>;

/** A journal record plus the card it was promoted into, when there is one. */
export interface ButlerMemoryRecord extends ButlerJournalRecord {
  /**
   * Stable handle a card's `origin` points back to: `journal:<ts>:<source>`,
   * with `#<n>` appended from the second record that shares a second and a
   * source. The journal is append-only, so the count never shifts.
   */
  key: string;
  promotedTo?: string;
  /** Distill's suggestion for this record, until the owner promotes or dismisses it. */
  candidate?: { to: 'knowledge' | 'rule' | 'profile'; reason: string };
}

/**
 * Which group a record belongs to.
 * @param record - one journal line.
 * @returns the group; anything not recognisably a commit or a turn marker is an observation.
 */
export function classifyRecord(record: ButlerJournalRecord): ButlerRecordKind {
  if (record.source === 'git' || record.tags?.includes('git-commit')) return 'git';
  if (record.type === 'session') return 'session';
  return 'observation';
}

/** One rule/knowledge card, body included: the memory view reads and edits it. */
export interface ButlerCard {
  id: string;
  kind: 'rule' | 'knowledge';
  slug: string;
  title: string;
  summary: string;
  body: string;
  approvedAt?: string;
  proposal?: string;
  /** The record this card was promoted from (`journal:<ts>:<source>`); absent for hand-written cards. */
  origin?: string;
}

interface DoctorResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface EndpointManifest {
  kind?: string;
  path?: string;
  driver?: string;
  endpoint_version?: number;
  installed?: { version?: number; ts?: string };
}

/** One undecided proposal with what approval would write, so the owner can decide on the briefing page. */
export interface ButlerPendingProposal {
  id: string; kind: string; title: string;
  body?: string; find?: string; slug?: string; evidence?: string[]; createdAt?: string;
}

const MAX_PROPOSAL_BODY = 20_000;

const CACHE_MS = 30_000;
const MAX_OUTPUT = 4_000;
const MAX_PREVIEW = 360;

export class ButlerStatusReader {
  readonly root: string;
  readonly doctorPath: string;
  private cached?: { expiresAt: number; value: ButlerStatus };

  /**
   * @param root Butler 本体目录（BUTLER_SELF_ROOT；工作目录配置的 selfRoot）。
   * @param doctorPath journal faculty 的 doctor 命令；缺省按 `<instance>/faculties/journal/bin/doctor`。
   */
  constructor(
    root = process.env.BUTLER_SELF_ROOT ?? join(process.env.BUTLER_INSTANCE_ROOT ?? join(homedir(), '.dsh', 'butler'), 'self'),
    doctorPath = join(process.env.BUTLER_INSTANCE_ROOT ?? join(homedir(), '.dsh', 'butler'), 'faculties', 'journal', 'bin', 'doctor'),
    private readonly spawner: Spawner,
    /** Environment for the doctor process, including the configured interpreter. */
    private readonly env: Record<string, string> = {},
  ) {
    this.root = root;
    this.doctorPath = doctorPath;
  }

  async read(force = false): Promise<ButlerStatus> {
    if (!force && this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;

    const doctor = await this.runDoctor();
    const [journal, spool, pending, suggested, distill, digest, endpoints] = await Promise.all([
      this.readJournal(),
      this.readSpool(),
      this.readPending(),
      this.readSuggestions(),
      this.readDistill(),
      this.readLatestDigest(),
      this.readEndpoints(doctor.output),
    ]);
    const health: ButlerStatus['health'] = doctor.failures > 0 ? 'error' : doctor.warnings > 0 ? 'warning' : 'healthy';
    const status: ButlerStatus = {
      root: this.root,
      status: health === 'error' ? 'error' : health === 'warning' || pending.count > 0 ? 'warning' : 'healthy',
      health,
      queue: { spool: spool.records },
      pending,
      checkedAt: new Date().toISOString(),
      doctor,
      journal,
      spool,
      candidates: suggested,
      distill,
      latestDigest: digest,
      endpoints,
    };
    this.cached = { expiresAt: Date.now() + CACHE_MS, value: status };
    return status;
  }

  async readDetail(section: ButlerDetailSection, endpointId?: string): Promise<ButlerDetail> {
    if (section === 'journal') {
      const records = await readJsonLines(join(this.root, 'journal', 'JOURNAL.jsonl'));
      return { section, total: records.length, records: records.slice(-100).reverse() };
    }
    if (section === 'spool') {
      const dir = join(this.root, 'spool');
      let names: string[] = [];
      try { names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort(); } catch { /* empty */ }
      const sources = await Promise.all(names.map(async (name) => {
        const records = await readJsonLines(join(dir, name));
        return { source: name.replace(/\.jsonl$/, ''), records: records.length, entries: records.slice(-100).reverse() };
      }));
      return { section, total: sources.reduce((sum, item) => sum + item.records, 0), sources };
    }
    if (section === 'memory') {
      const records = await readJsonLines(join(this.root, 'journal', 'JOURNAL.jsonl'));
      const order = await readCardOrder(join(this.root, 'etc', 'card-order.json'));
      const cards = [
        ...await readCards(join(this.root, 'rules'), 'rule', order.rule),
        ...await readCards(join(this.root, 'knowledge'), 'knowledge', order.knowledge),
      ];
      let trash = 0;
      try { trash = (await readdir(join(this.root, 'trash'))).filter((name) => name.endsWith('.md')).length; } catch { /* no trash yet */ }
      return {
        section,
        cards,
        profile: (await readText(join(this.root, 'persona', 'profile.md'), 40_000)).trim(),
        records: groupRecords(records, cards, await readCandidates(join(this.root, 'candidates.jsonl'))),
        trash,
      };
    }
    if (section === 'doctor') {
      const status = await this.read(true);
      return { section, checkedAt: status.checkedAt, doctor: status.doctor };
    }
    if (section === 'endpoints') {
      const status = await this.read();
      return { section, endpoints: status.endpoints };
    }
    if (section === 'endpoint') {
      if (!endpointId) throw new Error('endpoint id 不能为空');
      const registry = await this.readRegistry();
      const target = registry.targets?.[endpointId];
      if (!target) throw new Error(`未知 Butler 端点: ${endpointId}`);
      const status = (await this.read()).endpoints.find((item) => item.id === endpointId);
      if (!status) throw new Error(`端点状态不可用: ${endpointId}`);
      return {
        section,
        endpoint: {
          ...status,
          path: target.path,
          driver: target.driver,
          endpointVersion: target.endpoint_version,
          installedAt: target.installed?.ts,
        },
      };
    }
    if (section === 'digests') {
      const dir = join(this.root, 'digests');
      let names: string[] = [];
      try { names = (await readdir(dir)).filter((name) => /^(daily|weekly|audit)-.+\.md$/.test(name)); } catch { /* empty */ }
      const entries = await Promise.all(names.map(async (name) => {
        const path = join(dir, name);
        const stats = await stat(path);
        return { name, relativePath: relative(this.root, path), updatedAt: stats.mtime.toISOString(), preview: compactPreview(await readText(path, 20_000)) };
      }));
      entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { section, entries: entries.slice(0, 30) };
    }
    const profilePath = join(this.root, 'persona', 'profile.md');
    return {
      section: 'config',
      root: this.root,
      persona: {
        profilePath: relative(this.root, profilePath),
        profile: (await readText(profilePath, 20_000)).trim(),
        rulesPath: 'rules',
        rules: await readRuleIndex(join(this.root, 'rules')),
      },
      registryPath: relative(this.root, join(this.root, 'etc', 'endpoints.json')),
      automations: [
        '蒸馏：由 DSH 自动化任务触发（只给观察记录打「建议升级」标记）',
      ],
      commands: [
        { name: 'intake', purpose: '各端上报观察到 spool' },
        { name: 'card', purpose: '只读主人画像、卡片索引或单张卡' },
        { name: 'run', purpose: '合并 spool 到 journal 总账' },
        { name: 'install', purpose: '幂等安装或升级个人全局端点' },
        { name: 'doctor', purpose: '巡检骨架、端点和积压' },
      ],
      maintenance: [
        'persona 与 knowledge 变更须经主人确认',
        '端点配置以 etc/endpoints.json 与 drivers/ 为权威',
        'Butler 简报仅展示配置，不直接写本体文件',
      ],
    };
  }

  private async readRegistry(): Promise<{ targets?: Record<string, EndpointManifest> }> {
    const raw = await readText(join(this.root, 'etc', 'endpoints.json'));
    if (!raw) return { targets: {} };
    try { return JSON.parse(raw) as { targets?: Record<string, EndpointManifest> }; }
    catch { return { targets: {} }; }
  }

  private async runDoctor(): Promise<ButlerStatus['doctor']> {
    let result: DoctorResult;
    try {
      result = await execDoctor(this.doctorPath, this.spawner, this.env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { exitCode: 1, stdout: '', stderr: message };
    }
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return {
      exitCode: result.exitCode,
      passed: countLines(result.stdout, /^\[PASS\]/m),
      warnings: countLines(result.stdout, /^\[WARN\]/m),
      // A syntax/runtime failure can produce no structured [FAIL] lines. Keep
      // the non-zero doctor exit visible in the status instead of calling a
      // broken doctor healthy.
      failures: countLines(result.stdout, /^\[FAIL\]/m) || (result.exitCode === 0 ? 0 : 1),
      output: output.slice(0, MAX_OUTPUT),
    };
  }

  private async readJournal(): Promise<ButlerStatus['journal']> {
    const path = join(this.root, 'journal', 'JOURNAL.jsonl');
    const lines = await nonEmptyLines(path);
    let latest: ButlerStatus['journal']['latest'];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as ButlerStatus['journal']['latest'];
        if (parsed && typeof parsed === 'object') {
          latest = { ...parsed, text: typeof parsed.text === 'string' ? parsed.text.slice(0, MAX_PREVIEW) : undefined };
          break;
        }
      } catch {
        // JOURNAL is append-only; a malformed line remains visible to doctor.
      }
    }
    return { records: lines.length, recent: this.countRecent(lines), latest };
  }

  /** Records stamped within the last 24 hours, by `classifyRecord`; a line with no readable time is not counted. */
  private countRecent(lines: string[], now = Date.now()): { observation: number; git: number; session: number } {
    const since = now - 24 * 3_600_000;
    const recent = { observation: 0, git: 0, session: 0 };
    // The journal is append-only and time-ordered, so walk back from the end and stop at the first old row.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as ButlerJournalRecord;
        const at = typeof parsed?.ts === 'string' ? Date.parse(parsed.ts) : Number.NaN;
        if (Number.isNaN(at)) continue;
        if (at < since) break;
        recent[classifyRecord(parsed)] += 1;
      } catch { /* a malformed line stays visible to doctor */ }
    }
    return recent;
  }

  /**
   * Open suggestions from distill, resolved against the journal so each carries its record's
   * time and first words. A suggestion whose record is gone, or has since been promoted, is not open.
   */
  private async readSuggestions(): Promise<ButlerStatus['candidates']> {
    const decided = await countDecisions(join(this.root, 'candidates.jsonl'));
    const marks = await readCandidates(join(this.root, 'candidates.jsonl'));
    if (marks.size === 0) return { count: 0, ...decided, items: [] };
    const records = await readJsonLines(join(this.root, 'journal', 'JOURNAL.jsonl'));
    const [rules, knowledge] = await Promise.all([readCards(join(this.root, 'rules'), 'rule', []), readCards(join(this.root, 'knowledge'), 'knowledge', [])]);
    const observation = groupRecords(records, [...rules, ...knowledge], marks).observation;
    // groupRecords already drops a promoted record's suggestion and only attaches it to observations
    const open = observation.records.filter((record) => record.candidate);
    return {
      count: open.length,
      ...decided,
      items: open.slice(0, 5).map((record) => ({ key: record.key, ...record.candidate!, ts: record.ts, text: record.text?.slice(0, 120) })),
    };
  }

  /**
   * Distill's own progress, read from the cursor and the journal. The cursor counts journal rows, so
   * "waiting" is the observation rows after it; Butler's own memory-write traces are skipped the way
   * `bin/distill` skips them, otherwise the page would promise material distill never hands over.
   */
  private async readDistill(): Promise<ButlerStatus['distill']> {
    const lines = await nonEmptyLines(join(this.root, 'journal', 'JOURNAL.jsonl'));
    let cursor = 0;
    let lastRunAt: string | undefined;
    const cursorFile = join(this.root, 'etc', 'cursor.json');
    try {
      const value = (JSON.parse(await readFile(cursorFile, 'utf8')) as { distill?: unknown }).distill;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) cursor = Math.min(value, lines.length);
      lastRunAt = (await stat(cursorFile)).mtime.toISOString();
    } catch { /* no cursor yet: distill has never run */ }
    let waiting = 0;
    let reference = 0;
    // Distill merges the holding area into the journal before it reads, so those rows are material too.
    const spoolDir = join(this.root, 'spool');
    let held: string[] = [];
    try {
      for (const name of (await readdir(spoolDir)).filter((file) => file.endsWith('.jsonl'))) held = held.concat(await nonEmptyLines(join(spoolDir, name)));
    } catch { /* no holding area yet */ }
    for (const line of [...lines.slice(cursor), ...held]) {
      try {
        const record = JSON.parse(line) as ButlerJournalRecord;
        if (!record || typeof record !== 'object') continue;
        if (classifyRecord(record) !== 'observation') reference += 1;
        else if (!(record.source === 'butler' && record.tags?.includes('memory'))) waiting += 1;
      } catch { /* a malformed line stays visible to doctor */ }
    }
    return { read: cursor, total: lines.length, waiting, reference, ...(lastRunAt ? { lastRunAt } : {}) };
  }

  private async readSpool(): Promise<ButlerStatus['spool']> {
    const dir = join(this.root, 'spool');
    let files: string[] = [];
    try { files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')); } catch { return { records: 0, sources: 0 }; }
    let records = 0;
    for (const file of files) records += (await nonEmptyLines(join(dir, file))).length;
    return { records, sources: files.length };
  }

  /** Fold `proposals.jsonl` create/status events the same way `bin/proposals` does. */
  private async readPending(): Promise<ButlerStatus['pending']> {
    const folded = new Map<string, Record<string, unknown>>();
    let bad = 0;
    for (const line of await nonEmptyLines(join(this.root, 'proposals.jsonl'))) {
      let record: Record<string, unknown>;
      try { record = JSON.parse(line); } catch { bad += 1; continue; }
      if (!record || typeof record.id !== 'string') continue;
      if (record.event === 'create') folded.set(record.id, { ...record });
      else if (record.event === 'status' && folded.has(record.id)) Object.assign(folded.get(record.id)!, record);
    }
    const items = [...folded.values()]
      .filter((item) => item.status === 'pending')
      .map((item): ButlerPendingProposal => {
        const evidence = Array.isArray(item.evidence) ? item.evidence.filter((ref): ref is string => typeof ref === 'string').slice(0, 20) : [];
        return {
          id: String(item.id), kind: String(item.kind ?? ''), title: String(item.title ?? '').slice(0, MAX_PREVIEW),
          ...(typeof item.body === 'string' ? { body: item.body.slice(0, MAX_PROPOSAL_BODY) } : {}),
          ...(typeof item.find === 'string' ? { find: item.find.slice(0, MAX_PROPOSAL_BODY) } : {}),
          ...(typeof item.slug === 'string' ? { slug: item.slug } : {}),
          ...(evidence.length ? { evidence } : {}),
          ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}),
        };
      });
    return { count: items.length, bad, items };
  }

  private async readLatestDigest(): Promise<ButlerStatus['latestDigest']> {
    const digest = await this.readNamedDigest('');
    if (!digest) return undefined;
    return {
      name: digest.name,
      relativePath: relative(this.root, digest.path),
      updatedAt: digest.updatedAt,
      preview: digest.preview,
    };
  }

  private async readNamedDigest(prefix: string): Promise<{
    name: string;
    path: string;
    updatedAt: string;
    preview: string;
    previewSource: string;
  } | undefined> {
    const dir = join(this.root, 'digests');
    let names: string[];
    try { names = await readdir(dir); } catch { return undefined; }
    const candidates = names.filter((name) => {
      if (!name.endsWith('.md')) return false;
      if (prefix) return name.startsWith(prefix);
      return /^(daily|weekly|audit)-.+\.md$/.test(name);
    });
    if (!candidates.length) return undefined;
    const entries = await Promise.all(candidates.map(async (name) => {
      const path = join(dir, name);
      try { return { name, path, stats: await stat(path) }; } catch { return undefined; }
    }));
    const latest = entries.filter(Boolean).sort((a, b) => b!.stats.mtimeMs - a!.stats.mtimeMs)[0];
    if (!latest) return undefined;
    const source = await readText(latest.path, 20_000);
    return {
      name: latest.name,
      path: latest.path,
      updatedAt: latest.stats.mtime.toISOString(),
      preview: compactPreview(source),
      previewSource: source,
    };
  }

  private async readEndpoints(doctorOutput: string): Promise<ButlerEndpointStatus[]> {
    try {
      const data = await this.readRegistry();
      // doctor reports every known endpoint (git included) even when the
      // registry has no row yet, so the list is the union of both sources.
      const levels = new Map<string, string>();
      for (const match of doctorOutput.matchAll(/^\[(PASS|WARN|FAIL|INFO)\] 端点 (\S+) /gm)) levels.set(match[2]!, match[1]!);
      const targets = data.targets ?? {};
      const ids = [...new Set([...Object.keys(targets), ...levels.keys()])];
      return ids.map((id) => {
        const target = targets[id] ?? {};
        const level = levels.get(id);
        const installed = Boolean(target.installed) && level !== 'INFO';
        const status: ButlerEndpointStatus['status'] = level === 'PASS' ? 'ok' : level === 'FAIL' ? 'fail' : level === 'WARN' ? 'legacy' : level === 'INFO' ? 'missing' : installed ? 'unknown' : 'missing';
        return { id, kind: target.kind ?? 'unknown', installed, version: target.installed?.version, status };
      });
    } catch {
      return [];
    }
  }
}
async function execDoctor(path: string, spawner: Spawner, env: Record<string, string>): Promise<DoctorResult> {
  const result = await runHostedCommand(spawner, {
    argv: env.BUTLER_PYTHON ? [env.BUTLER_PYTHON, path] : [path],
    cwd: dirname(path),
    env,
    graceMs: 5_000,
  }, 8_000);
  return {
    exitCode: result.error || result.timedOut ? 1 : result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: [result.stderr, result.error?.message, result.timedOut ? 'doctor timed out' : ''].filter(Boolean).join('\n'),
  };
}

async function nonEmptyLines(path: string): Promise<string[]> {
  const raw = await readText(path);
  return raw ? raw.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

async function readJsonLines(path: string): Promise<ButlerJournalRecord[]> {
  const records: ButlerJournalRecord[] = [];
  for (const line of await nonEmptyLines(path)) {
    try {
      const parsed = JSON.parse(line) as ButlerJournalRecord;
      if (parsed && typeof parsed === 'object') {
        records.push({
          ts: typeof parsed.ts === 'string' ? parsed.ts : undefined,
          source: typeof parsed.source === 'string' ? parsed.source : undefined,
          type: typeof parsed.type === 'string' ? parsed.type : undefined,
          tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
          text: typeof parsed.text === 'string' ? parsed.text.slice(0, 2_000) : undefined,
          ...(typeof parsed.ref === 'string' ? { ref: parsed.ref.slice(0, 500) } : {}),
          ...(typeof parsed.origin === 'string' ? { origin: parsed.origin.slice(0, 120) } : {}),
          ...(typeof parsed.workspace === 'string' ? { workspace: parsed.workspace.slice(0, 500) } : {}),
          ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId.slice(0, 200) } : {}),
          ...(Number.isSafeInteger(parsed.turn) ? { turn: parsed.turn } : {}),
          ...(strings(parsed.toolsUsed) ? { toolsUsed: strings(parsed.toolsUsed) } : {}),
          ...(strings(parsed.filesTouched) ? { filesTouched: strings(parsed.filesTouched) } : {}),
          ...(Array.isArray(parsed.gitCommits) ? { gitCommits: parsed.gitCommits.slice(0, 20).filter((c) => c && typeof c === 'object').map((c) => ({ ...(typeof c.sha === 'string' ? { sha: c.sha.slice(0, 64) } : {}), ...(typeof c.subject === 'string' ? { subject: c.subject.slice(0, 300) } : {}) })) } : {}),
          ...(parsed.failed === true ? { failed: true } : {}),
        });
      }
    } catch {
      // malformed JSONL remains Butler doctor's responsibility; detail view skips it.
    }
  }
  return records;
}

/**
 * Every card of one kind with its body. Rules keep approval order (what the
 * context index uses); knowledge is newest first. A file without front matter
 * is still a card — its title falls back to the slug and its body is the file.
 */
async function readCards(dir: string, kind: 'rule' | 'knowledge', order: string[] = []): Promise<ButlerCard[]> {
  let names: string[] = [];
  try { names = (await readdir(dir)).filter((name) => /^[a-z0-9][a-z0-9-]{0,63}\.md$/.test(name)).sort(); } catch { return []; }
  const cards = await Promise.all(names.slice(0, 300).map(async (name) => {
    const text = await readText(join(dir, name), 60_000);
    const parsed = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(text);
    const meta = parsed?.[1] ?? '';
    const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(meta)?.[1]?.trim() ?? '';
    const slug = name.slice(0, -3);
    const body = (parsed ? parsed[2] : text).replace(/\s+$/, '');
    return {
      id: `${kind}/${slug}`, kind, slug,
      title: field('title') || slug,
      summary: field('summary'),
      body,
      ...(field('approvedAt') ? { approvedAt: field('approvedAt') } : {}),
      ...(field('proposal') ? { proposal: field('proposal') } : {}),
      ...(field('origin') ? { origin: field('origin') } : {}),
    } satisfies ButlerCard;
  }));
  cards.sort((a, b) => (a.approvedAt ?? '').localeCompare(b.approvedAt ?? '') || a.slug.localeCompare(b.slug));
  if (kind === 'knowledge') cards.reverse();
  // The owner's own order wins; cards never placed keep the order above, after the placed ones.
  const rank = new Map(order.map((slug, index) => [slug, index]));
  return cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => (rank.get(a.card.slug) ?? order.length) - (rank.get(b.card.slug) ?? order.length) || a.index - b.index)
    .map((item) => item.card);
}

/**
 * The order the owner dragged each card section into (`etc/card-order.json`).
 * Missing or damaged means "never reordered", never an error.
 * @param path - the order file.
 * @returns slugs per section.
 */
async function readCardOrder(path: string): Promise<Record<'rule' | 'knowledge', string[]>> {
  const empty = { rule: [] as string[], knowledge: [] as string[] };
  try {
    const data = JSON.parse(await readText(path, 200_000)) as Record<string, unknown>;
    return {
      rule: strings(data.rule, 400) ?? empty.rule,
      knowledge: strings(data.knowledge, 400) ?? empty.knowledge,
    };
  } catch { return empty; }
}

/** How many records of each group the page receives; the rest stay in the journal file. */
const RECORDS_PER_GROUP = 300;

/**
 * Split the journal into its groups, newest first, and mark each record the
 * cards were promoted from.
 * @param records - every journal line, oldest first.
 * @param cards - the cards, whose `origin` names the record they came from.
 * @returns the three groups with their true totals.
 */
/** How many suggestions ended in a card and how many the owner declined; the last event per record counts. */
async function countDecisions(path: string): Promise<{ promoted: number; dismissed: number }> {
  const last = new Map<string, unknown>();
  for (const line of await nonEmptyLines(path)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.origin === 'string' && (event.event === 'mark' || event.event === 'dismiss' || event.event === 'promote')) last.set(event.origin, event.event);
    } catch { /* damaged line */ }
  }
  let promoted = 0;
  let dismissed = 0;
  for (const event of last.values()) { if (event === 'promote') promoted += 1; else if (event === 'dismiss') dismissed += 1; }
  return { promoted, dismissed };
}

/**
 * Distill's open suggestions: record handle -> target kind and reason. The last event per
 * record wins (a `dismiss` or `promote` after a `mark` closes it), a damaged line is skipped.
 */
async function readCandidates(path: string): Promise<Map<string, { to: 'knowledge' | 'rule' | 'profile'; reason: string }>> {
  const last = new Map<string, Record<string, unknown>>();
  for (const line of await nonEmptyLines(path)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.origin === 'string' && (event.event === 'mark' || event.event === 'dismiss' || event.event === 'promote')) last.set(event.origin, event);
    } catch { /* damaged line */ }
  }
  const open = new Map<string, { to: 'knowledge' | 'rule' | 'profile'; reason: string }>();
  for (const [origin, event] of last) {
    if (event.event === 'mark' && (event.to === 'knowledge' || event.to === 'rule' || event.to === 'profile')) open.set(origin, { to: event.to, reason: String(event.reason ?? '').slice(0, 300) });
  }
  return open;
}

function groupRecords(records: ButlerJournalRecord[], cards: ButlerCard[], candidates: Map<string, { to: 'knowledge' | 'rule' | 'profile'; reason: string }> = new Map()): ButlerRecordGroups {
  // A card names its record in its own front matter. The identity card is one file with no
  // per-record place to say so, so a promotion into it is told by the decision the faculty journalled.
  const promoted = new Map<string, string>();
  for (const record of records) if (record.origin && record.tags?.includes('profile')) promoted.set(record.origin, 'profile');
  for (const card of cards) if (card.origin) promoted.set(card.origin, card.id);
  const groups: ButlerRecordGroups = {
    observation: { total: 0, records: [] },
    git: { total: 0, records: [] },
    session: { total: 0, records: [] },
  };
  // Number duplicates oldest-first, so a record keeps its handle as the journal grows.
  const seen = new Map<string, number>();
  const keys = records.map((record) => {
    const base = `journal:${record.ts ?? ''}:${record.source ?? ''}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  });
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const group = groups[classifyRecord(record)];
    group.total += 1;
    if (group.records.length >= RECORDS_PER_GROUP) continue;
    const key = keys[index];
    // A promoted record has already been decided; its suggestion is spent.
    const candidate = promoted.has(key) ? undefined : candidates.get(key);
    group.records.push({ ...record, key, ...(promoted.has(key) ? { promotedTo: promoted.get(key) } : {}), ...(candidate && group === groups.observation ? { candidate } : {}) });
  }
  return groups;
}

/** One line per rule card (front matter title/summary), for the config view. */
async function readRuleIndex(dir: string): Promise<Array<{ slug: string; title: string; summary: string }>> {
  let names: string[] = [];
  try { names = (await readdir(dir)).filter((name) => /^[a-z0-9][a-z0-9-]{0,63}\.md$/.test(name)).sort(); } catch { return []; }
  return Promise.all(names.slice(0, 200).map(async (name) => {
    const text = await readText(join(dir, name), 20_000);
    const meta = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(meta)?.[1]?.trim() ?? '';
    return { slug: name.slice(0, -3), title: field('title') || name.slice(0, -3), summary: field('summary') };
  }));
}

async function readText(path: string, max = 100_000): Promise<string> {
  try {
    await access(path);
    return (await readFile(path, 'utf8')).slice(0, max);
  } catch {
    return '';
  }
}

function countLines(text: string, pattern: RegExp): number {
  return text.split('\n').filter((line) => pattern.test(line)).length;
}

function compactPreview(source: string): string {
  return source.replace(/^---[\s\S]*?---\s*/m, '').replace(/[#>*`]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_PREVIEW);
}
