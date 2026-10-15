/**
 * Butler's DSH automation tasks (`ctx.schedule`), registered by the
 * plugin instead of being hand-copied from the README.
 *
 * DSH binds every task to one Session and delivers the prompt as a follow-up
 * there, so the tasks share one dedicated `butler`-preset Session at the
 * instance root; the preset then gives them butler_* tools only. Registration
 * is idempotent by title: identical tasks are kept, drifted ones are replaced,
 * tasks without the tag are never touched.
 */
import type { SessionPort } from './delegations.ts';

export const AUTOMATION_TAG = '· Butler';

export interface ButlerAutomation {
  key: 'distill';
  title: string;
  prompt: string;
  cron: { expression: string; time_zone: string };
}

const ZONE = 'Asia/Shanghai';
const RULES = '只用 butler_* 工具，不手改任何文件；写完即结束，不追问主人。';

/**
 * Tasks this plugin used to register and no longer does. The daily, weekly and audit shifts
 * were retired: the briefing page shows the same facts live, so a written digest only
 * duplicated it. Registration removes them by title so an installed copy stops running;
 * the digests already written stay where they are.
 */
export const RETIRED_TITLES: readonly string[] = ['日报', '周报', '周检'].map((name) => `${name} ${AUTOMATION_TAG}`);

export const BUTLER_AUTOMATIONS: readonly ButlerAutomation[] = [
  {
    key: 'distill',
    title: `蒸馏 ${AUTOMATION_TAG}`,
    cron: { expression: '0 * * * *', time_zone: ZONE },
    prompt: `Butler 蒸馏自动化任务。严格按以下闭环处理一个持久批次：
1. 首先调用 butler_distill_claim 领取批次。只使用返回的 runId、runToken、inputHash 和 sources；不得伪造或自行推进输入游标。没有可领取批次时直接结束。
2. 针对 sources 中的正式卡候选主题，调用 butler_search 检索正式卡，并按需用 butler_read 读取相关卡全文，检查重复、已有覆盖、修订目标和冲突。只检查正式卡，不试图读候选或私密会话。
3. 仅当证据充分、可追溯且有长期复用价值时，调用 butler_candidate_submit 提交完整草稿。草稿必须包含 kind（knowledge/profile/rule）、operation（create/revise/archive）、title、summary、body、rationale（推荐理由）、evidence；每条 evidence 必须包含 sourceId、messageIds、quote。scope 只表示可见范围（默认 local，可省略）；卡片适用于哪个项目、领域或场景写在 appliesTo。修订或归档必须给出目标正式卡及 baseRevision。每次提交都必须携带本批次的 runId、runToken、inputHash。只提交能独立阅读、范围清楚且相对正式卡有实质增量的内容；讨论、推测、一次性操作、无证据结论、重复内容或冲突未厘清时不提交。
   时效：不提交运行状态、版本号、数量、进度、能力或权限清单、端口、路径清单等会随实现变化的内容——这些以仓库、配置和系统自省为准；也不复述 AGENTS.md、README 等权威文件的规则，需要时在正文指向权威文件。knowledge 或 rule 卡依赖某个文件或其中一句原文时，用 checks 附上确定性检查项（type=path 只要求文件存在；type=quote 要求该文件仍含这段原文；path 为相对工作区根的路径）；检查失败时卡片自动暂停，依据恢复后自动恢复。profile 卡不加 checks。
   冲突：证据表明某张有效正式卡已经不成立时，提交 operation=revise（或 archive）指向该卡，并在 conflict 写明哪一点被推翻；目标卡会暂停直到主人批准或拒绝该候选。不要仅凭推测标记冲突。
4. 最后调用 butler_distill_complete，携带同一 runId、runToken、inputHash 和实际成功提交返回的 candidateIds。零候选时仍须完成批次，并写明简短 reason 说明为何没有候选。不得把未成功提交的草稿列为候选，也不得宣称未处理或输入不完整的内容已覆盖；失败或不完整时不得报告成功覆盖。
不得调用旧工具 journal_read、candidate-mark、advance；不得批准、拒绝或直接修改正式卡。${RULES}`,
  },
];

/** `schedule.catalog()` row; a cron record stores `expression`/`timeZone` flat (dsh-schedule createCronScheduleRecord). */
interface CatalogEntry { sessionId: string; id: string; status?: string; record: { id: string; title?: string; prompt?: string; kind?: string; expression?: string; timeZone?: string; scheduledAt?: string; lastDelivery?: { deliveredAt?: string } } }

export interface AutomationHost {
  schedule: {
    catalog(): Promise<CatalogEntry[]>;
    create(sessionId: string, request: { title: string; prompt: string; cron: ButlerAutomation['cron'] }): Promise<unknown>;
    delete(request: { sessionId: string; id: string }): Promise<unknown>;
  };
  sessionController: {
    create(request: { cwd?: string; workspaceId?: string; agentPreset: string }): Promise<{ sessionId: string }>;
    /** Queue a user turn (DSH dedups by requestId). Used by delegations; absent on older Apps. */
    prompt?: SessionPort['prompt'];
    cancel?: SessionPort['cancel'];
  };
  /**
   * DSH `ctx.workspaceRegistry`. A session created from a bare `cwd` belongs to no workspace and shows
   * up ungrouped; one created with a `workspaceId` is attached to that workspace. `create(path)` is
   * idempotent for the same directory (it returns the existing workspace). Optional: without it the
   * session is still created, just left ungrouped.
   */
  workspaceRegistry?: { create(path: string, title?: string): Promise<{ id: string; attachSession?(sessionId: string): Promise<void> }> };
}

export interface AutomationResult { sessionId: string; created: number; kept: number; removed: number }

/**
 * `schedule.catalog()` rows as the running DSH App returns them. Verified on a live App: a row is the flat
 * task record (`id`, `kind`, `title`, `prompt`, `expression`, `timeZone`, ...) with the owning session beside it;
 * older assumptions had the record nested under `record`. Accept both so a version change is not fatal, and when
 * a row has neither a record nor an id, report its field names instead of failing on a property read.
 */
function normalizeCatalog(rows: unknown): CatalogEntry[] {
  if (!Array.isArray(rows)) throw new Error(`schedule.catalog() 没有返回数组：${typeof rows}`);
  return rows.map((row: any) => {
    const record = row && typeof row === 'object' ? (row.record && typeof row.record === 'object' ? row.record : row) : undefined;
    const id = record?.id ?? row?.id;
    const sessionId = row?.sessionId ?? record?.sessionId;
    if (!record || typeof id !== 'string' || typeof sessionId !== 'string') {
      const keys = row && typeof row === 'object' ? Object.keys(row).join(',') : typeof row;
      throw new Error(`schedule.catalog() 的一行缺少 id 或 sessionId，字段：${keys}`);
    }
    return { sessionId, id, status: row.status ?? record.status, record };
  });
}

function same(entry: CatalogEntry, task: ButlerAutomation): boolean {
  const { record } = entry;
  return entry.status !== 'inactive' && record.kind === 'cron' && record.prompt === task.prompt
    && record.expression === task.cron.expression && record.timeZone === task.cron.time_zone;
}

/**
 * A fresh session for the tasks, placed in the Butler workspace when DSH can give us one.
 * Failing to find or create the workspace must not stop the tasks from being registered.
 */
async function createTaskSession(host: AutomationHost, cwd: string): Promise<string> {
  return (await host.sessionController.create({ ...(await butlerSessionTarget(host, cwd)), agentPreset: 'butler' })).sessionId;
}

/** Where a new Butler Session goes: the Butler workspace when DSH has one, else the bare cwd. */
export async function butlerSessionTarget(host: Pick<AutomationHost, 'workspaceRegistry'>, cwd: string): Promise<{ workspaceId: string } | { cwd: string }> {
  let workspaceId: string | undefined;
  try { workspaceId = (await host.workspaceRegistry?.create(cwd, 'Butler'))?.id; } catch { workspaceId = undefined; }
  return workspaceId ? { workspaceId } : { cwd };
}

/**
 * A task session registered before workspaces were used is ungrouped; attach it to the Butler workspace.
 * `attachSession` is idempotent for an already-accounted id and requires the session's cwd to equal the
 * workspace path (true for sessions we created). Best effort: grouping is cosmetic, never worth failing for.
 */
async function adoptIntoWorkspace(host: AutomationHost, cwd: string, sessionId: string): Promise<void> {
  try { await (await host.workspaceRegistry?.create(cwd, 'Butler'))?.attachSession?.(sessionId); } catch { /* ungrouped is acceptable */ }
}

export interface AutomationStatus {
  /** False when this DSH App has no schedule service (or it could not be read): nothing to show. */
  available: boolean;
  /** The distill task exists, is active and matches what this plugin would register today. */
  registered: boolean;
  /** When DSH will run it next / last delivered it, ISO strings from the schedule record. */
  nextRunAt?: string;
  lastRunAt?: string;
  expression?: string;
  timeZone?: string;
}

/**
 * Where the distill task stands in DSH's own schedule, read-only. A page asking "when does distill run" must
 * answer from the schedule, not from a number this plugin remembers. Never throws: an unreadable schedule is
 * reported as unavailable so the briefing can say so instead of failing.
 */
export async function readAutomationStatus(host: AutomationHost | undefined): Promise<AutomationStatus> {
  if (!host) return { available: false, registered: false };
  try {
    const task = BUTLER_AUTOMATIONS[0]!;
    const entries = normalizeCatalog(await host.schedule.catalog()).filter((entry) => entry.record.title === task.title && entry.status !== 'inactive');
    const entry = entries.find((item) => same(item, task)) ?? entries[0];
    if (!entry) return { available: true, registered: false };
    const { record } = entry;
    return {
      available: true,
      registered: same(entry, task),
      ...(record.scheduledAt ? { nextRunAt: record.scheduledAt } : {}),
      ...(record.lastDelivery?.deliveredAt ? { lastRunAt: record.lastDelivery.deliveredAt } : {}),
      ...(record.expression ? { expression: record.expression } : {}),
      ...(record.timeZone ? { timeZone: record.timeZone } : {}),
    };
  } catch {
    return { available: false, registered: false };
  }
}

/** Create or refresh every Butler automation task; returns the Session they live in. */
export async function registerAutomations(host: AutomationHost, options: { cwd: string }): Promise<AutomationResult> {
  const titles = new Set(BUTLER_AUTOMATIONS.map((task) => task.title));
  const catalog = normalizeCatalog(await host.schedule.catalog());
  const ours = catalog.filter((entry) => titles.has(entry.record.title ?? ''));
  let removed = 0;
  for (const entry of catalog.filter((item) => RETIRED_TITLES.includes(item.record.title ?? ''))) {
    await host.schedule.delete({ sessionId: entry.sessionId, id: entry.id });
    removed += 1;
  }
  const keep = new Set<string>();
  for (const task of BUTLER_AUTOMATIONS) {
    const matches = ours.filter((entry) => entry.record.title === task.title);
    const good = matches.find((entry) => same(entry, task));
    if (good) keep.add(task.title);
    for (const entry of matches) {
      if (entry === good) continue;
      await host.schedule.delete({ sessionId: entry.sessionId, id: entry.id });
      removed += 1;
    }
  }
  const reused = ours.find((entry) => entry.status !== 'inactive')?.sessionId;
  if (reused) await adoptIntoWorkspace(host, options.cwd, reused);
  const sessionId = reused ?? await createTaskSession(host, options.cwd);
  let created = 0;
  for (const task of BUTLER_AUTOMATIONS) {
    if (keep.has(task.title)) continue;
    await host.schedule.create(sessionId, { title: task.title, prompt: task.prompt, cron: task.cron });
    created += 1;
  }
  return { sessionId, created, kept: keep.size, removed };
}
