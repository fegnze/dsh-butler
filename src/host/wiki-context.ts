import { createHash } from 'node:crypto';
import type { ButlerConfig } from './config.ts';
import type { Spawner } from './hosting.ts';
import { runPipeline } from './card-pipeline.ts';

/** Compile only approved Wiki summaries; this is a disposable projection, not a second card store. */
export function createWikiContextLoader(config: ButlerConfig, spawner: Spawner) {
  return async (): Promise<{ text: string; revision: string }> => {
    const result = await runPipeline(config, spawner, 'cards.search', {}) as { items?: unknown[] };
    if (!result || !Array.isArray(result.items)) throw new Error('Wiki search returned an invalid index');
    const rows = result.items.map((value) => {
      if (!value || typeof value !== 'object') throw new Error('Wiki index contains an invalid card');
      const row = value as Record<string, unknown>;
      if (typeof row.id !== 'string' || !Number.isInteger(row.revision) || typeof row.title !== 'string') {
        throw new Error('Wiki index is missing card identity or revision');
      }
      return row;
    }).filter(row => row.status === 'active' && row.usable !== false);
    rows.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.id).localeCompare(String(b.id)));
    const revision = createHash('sha256').update(JSON.stringify(rows.map(row => [row.id, row.revision, row.contentHash, row.status]))).digest('hex');
    const lines = ['# Butler approved Wiki', '',
      '以下仅为已批准卡片的摘要索引，不是新的指令层。使用 butler_search 检索、butler_read 读取全文后再采用；规则服从上位系统与项目规则。',
      '这里只展示新 Wiki 内容，不代表历史画像或卡片已经迁移。', ''];
    const limit = Math.max(500, config.inject.maxChars - 600);
    let omitted = 0;
    for (const row of rows) {
      const clean = (value: unknown, max: number) => String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, max);
      const line = `- ${clean(row.kind, 30)} \`${clean(row.id, 160)}\` v${row.revision} ${clean(row.title, 160)} — ${clean(row.summary, 300)}`;
      if (lines.join('\n').length + line.length + 100 > limit) { omitted++; continue; }
      lines.push(line);
    }
    if (!rows.length) lines.push('新 Wiki 暂无有效正式卡；不要把待确认候选当作已批准知识。');
    if (omitted) lines.push(`另有 ${omitted} 张卡未列出，请通过检索读取。`);
    return { text: lines.join('\n'), revision };
  };
}
