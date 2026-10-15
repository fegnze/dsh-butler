import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { fromRaw } from '../src/host/config.ts';
import { createPipelineEndpoint, runPipeline } from '../src/host/card-pipeline.ts';
import { createNodeSpawner } from './node-spawner.ts';

/** Real faculty subprocess + actual review boundary, never the owner's instance. */
test('transcript → bound draft → explicit UI approval → searchable Markdown', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'butler-pipeline-e2e-')));
  try {
    cpSync(join(import.meta.dir, '../skeleton'), root, { recursive: true });
    const config = fromRaw(root, { python: '/Users/ghost/MySpace/.venv/bin/python' });
    mkdirSync(join(config.selfRoot, 'etc'), { recursive: true });
    writeFileSync(join(config.selfRoot, 'etc/knowledge-store.json'), JSON.stringify({ version: 1, active: 'wiki' }));
    const spawner = createNodeSpawner();
    const call = (action: string, args: Record<string, unknown> = {}) => runPipeline(config, spawner, action, args) as Promise<any>;
    const receipt = await call('sessions.ingest', {
      source: 'fixture', externalSessionId: 'session-one', segmentId: 'turn-one', revision: 1,
      captureMode: 'transcript', title: '明确的长期决定',
      messages: [{ id: 'u1', role: 'user', sequence: 1, content: '交付时必须报告实际验证结果，不把构建成功当作上线成功。' }],
    });
    const run = await call('distill.claim', { limit: 1 });
    expect(run.runId).toBeTruthy();
    const candidate = await call('candidates.submit', {
      runId: run.runId, runToken: run.runToken, inputHash: run.inputHash,
      kind: 'rule', operation: 'create', title: '交付时区分构建和上线验证', summary: '只报告实际完成的验证。',
      body: '交付时报告实际验证结果，构建通过不能冒充上线完成。', rationale: '明确且可复用的交付约定', scope: 'local',
      evidence: [{ sourceId: receipt.id, messageIds: ['u1'], quote: '不把构建成功当作上线成功' }],
    });
    expect(candidate.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await call('cards.search', { query: '上线' })).items).toHaveLength(0);
    await call('distill.complete', { runId: run.runId, runToken: run.runToken, inputHash: run.inputHash, candidateIds: [candidate.id] });
    const session = await call('sessions.read', { id: receipt.id });
    expect(session.distillStatus).toBe('covered');
    expect(session.candidateCount).toBe(1);
    const endpoint = createPipelineEndpoint(config, spawner, { hostUrl: 'http://localhost:19387' });
    const browser = { headers: { host: 'localhost:19387', origin: 'http://localhost:19387', 'sec-fetch-site': 'same-origin', 'x-butler-review': '1' } } as unknown as IncomingMessage;
    const visible = await endpoint.handle(browser, { action: 'candidates.get', args: { id: candidate.id } });
    expect((visible.envelope as any).data.contentHash).toBe(candidate.contentHash);
    const edited = await endpoint.handle(browser, { action: 'candidates.edit', args: { id: candidate.id, expectedRevision: candidate.revision, title: candidate.title, summary: candidate.summary, body: candidate.body } });
    expect(edited.status, JSON.stringify(edited.envelope)).toBe(200);
    const reviewed = (edited.envelope as any).data;
    expect(reviewed.revision).toBe(candidate.revision + 1);
    const binding = { id: reviewed.id, revision: reviewed.revision, contentHash: reviewed.contentHash };
    const forbidden = await endpoint.handle({ headers: {} } as IncomingMessage, { action: 'review.prepare', args: binding });
    expect(forbidden.status).toBe(403);
    const preparation = await endpoint.handle(browser, { action: 'review.prepare', args: binding });
    expect(preparation.status).toBe(200);
    const token = (preparation.envelope as any).data.reviewToken;
    expect(token).toBeTruthy();
    const request = { action: 'candidates.approve', args: { ...binding, reviewToken: token, idempotencyKey: 'e2e-approval-1' } };
    const approved = await endpoint.handle(browser, request);
    expect(approved.status, JSON.stringify(approved.envelope)).toBe(200);
    const card = (approved.envelope as any).data.card;
    expect(card.kind).toBe('rule');
    expect((await endpoint.handle(browser, request)).envelope).toEqual(approved.envelope);
    const found = await call('cards.search', { query: '上线' });
    expect(found.items.map((row: any) => row.id)).toContain(card.id);
    expect((await call('cards.read', { id: card.id })).body).toBe(candidate.body);
    const dir = join(config.selfRoot, 'wiki', 'rule');
    expect(existsSync(dir)).toBe(true);
    const md = readdirSync(dir).filter(name => name.endsWith('.md'));
    expect(md).toHaveLength(1);
    expect(readFileSync(join(dir, md[0]), 'utf8')).toContain(candidate.body);
  } finally {
    // This exact directory was created above solely for this fixture.
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
