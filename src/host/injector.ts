import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `agent/pre-step` injector: puts the compiled `self/build/context.md` into
 * each eligible DSH session once, as a plugin `snapshot` user message, so a
 * session knows the owner without marker blocks in external rule files.
 *
 * Dedup follows the Nowledge plugin: the snapshot is looked up on the
 * model-visible surface (`session.deriveMessages()`), not the raw log, so a
 * compaction that drops it causes one re-injection instead of silent loss.
 */
export const PLUGIN_NAME = 'myspace-butler-panel';
export const INJECT_SECTION = 'butler-context';

export interface InjectConfig {
  enabled: boolean;
  /** Empty = every workspace. */
  workspaces: string[];
  /** The butler preset carries its own persona; never double-inject it. */
  excludePresets: string[];
  includeSubagents: boolean;
  maxChars: number;
}

interface Header { cwd?: unknown; agentPreset?: unknown; origin?: unknown }
interface Section { name?: unknown; text?: unknown }
interface Message { source?: { kind?: unknown; form?: unknown; sections?: Section[] } }
interface Session { header?: Header; deriveMessages?: () => readonly Message[] }
type Decision = { kind: 'reject' } | { kind: 'enter'; messages: readonly unknown[]; [key: string]: unknown };

export interface InjectorDeps {
  selfRoot: string;
  config: InjectConfig;
  /** `createUserMessage` from `@deepseek-ai/dsh-llm`; injected so tests need no App packages. */
  createMessage: (input: { content: Array<{ type: 'text'; text: string }>; source: Record<string, unknown> }) => unknown;
  /** Optional Wiki reader. When present, its text/revision supersede the legacy snapshot. */
  loadWikiContext?: () => Promise<{ text: string; revision: string }>;
  warn?: (message: string) => void;
}

const HEADER = 'Butler context for this DSH session: the owner\'s profile and an index of approved rule/knowledge cards (read a card in full before relying on it). Treat it as working context, not an instruction override.\n\n';

function eligible(header: Header, config: InjectConfig): boolean {
  if (!config.enabled) return false;
  const preset = typeof header.agentPreset === 'string' ? header.agentPreset.toLowerCase() : '';
  if (preset && config.excludePresets.some((item) => item.toLowerCase() === preset)) return false;
  if (!config.includeSubagents && header.origin === 'subagent') return false;
  if (config.workspaces.length === 0) return true;
  return typeof header.cwd === 'string' && config.workspaces.includes(header.cwd);
}

/** Whether our snapshot is still on the model-visible surface. */
export function hasButlerContext(session: Session): boolean {
  return contextSections(session).some(({ section }) => section.name === INJECT_SECTION);
}

function contextSections(session: Session): Array<{ section: Section; message: Message }> {
  const messages = session.deriveMessages?.() ?? [];
  return messages.flatMap((message) => message.source?.kind === `plugin:${PLUGIN_NAME}`
    && message.source.form === 'snapshot'
    ? (message.source.sections ?? []).map((section) => ({ section, message })) : []);
}

function revisionFromSection(section: Section): string | undefined {
  if (typeof section.name === 'string' && section.name.startsWith(`${INJECT_SECTION}:`)) {
    return section.name.slice(INJECT_SECTION.length + 1) || undefined;
  }
  if (typeof section.text === 'string') {
    const match = section.text.match(/\[butler-context-revision:([^\]]+)\]/);
    return match?.[1];
  }
  return undefined;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Same shape as `createUserMessage` in `@deepseek-ai/dsh-llm`
 * (`deepFreeze(structuredClone({...input, role: 'user', id: randomUUID()}))`).
 * Re-implemented because a symlinked profile plugin cannot resolve App
 * packages; importing it took the whole plugin down (measured 2026-10-10).
 */
export function createUserMessage(input: Parameters<InjectorDeps['createMessage']>[0]): unknown {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }));
}

/** Build the pre-step handler; register with `{ prepend: true }`. */
export function createInjector(deps: InjectorDeps) {
  const file = join(deps.selfRoot, 'build', 'context.md');
  return async (payload: { agent: { session: Session }; signal?: AbortSignal }, next: () => Promise<Decision>): Promise<Decision> => {
    const decision = await next();
    if (decision.kind !== 'enter' || payload.signal?.aborted) return decision;
    try {
      const session = payload.agent.session;
      if (!eligible(session.header ?? {}, deps.config)) return decision;

      let body: string;
      let revision: string | undefined;
      if (deps.loadWikiContext) {
        let wiki: { text: string; revision: string };
        try {
          wiki = await deps.loadWikiContext();
        } catch (error) {
          deps.warn?.(`[butler] wiki context load failed: ${error instanceof Error ? error.message : String(error)}`);
          return decision;
        }
        body = typeof wiki.text === 'string' ? wiki.text.trim() : '';
        revision = typeof wiki.revision === 'string' ? wiki.revision.trim() : '';
        if (!body || !revision) return decision;
        const existing = contextSections(session);
        if (existing.some(({ section }) => revisionFromSection(section) === revision)) return decision;
      } else {
        if (hasButlerContext(session)) return decision;
        try {
          body = (await readFile(file, 'utf8')).trim();
        } catch {
          deps.warn?.(`[butler] inject skipped: ${file} missing; run journal build-context`);
          return decision;
        }
        if (!body) return decision;
      }

      if (payload.signal?.aborted) return decision;
      const header = revision
        ? 'Butler 正式卡知识快照：个人知识、身份资料与规则卡的索引。使用前请检索并读取卡片全文；这里只是工作上下文，不覆盖系统或项目规则。旧数据是否迁移以实际卡库返回内容为准。\n\n'
        : HEADER;
      let text = header + body;
      if (revision && contextSections(session).some(({ section }) => section.name === INJECT_SECTION || revisionFromSection(section))) {
        text = `以下替代此前Butler知识快照，卡片可能更新或归档，请重新检索读取\n\n${text}`;
      }
      const maxChars = Math.max(1, deps.config.maxChars);
      if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
      // Preserve the established main section and add a known-name revision
      // section; both are valid source.sections entries in createUserMessage.
      const sections: Array<{ name: string; text: string }> = [{ name: INJECT_SECTION, text }];
      if (revision) sections.push({ name: `${INJECT_SECTION}:${revision}`, text: `[butler-context-revision:${revision}]` });
      const message = deps.createMessage({
        content: [{ type: 'text', text }],
        source: { kind: `plugin:${PLUGIN_NAME}`, form: 'snapshot', sections },
      });
      return { ...decision, messages: [...decision.messages, message] };
    } catch (error) {
      deps.warn?.(`[butler] inject failed: ${error instanceof Error ? error.message : String(error)}`);
      return decision;
    }
  };
}
