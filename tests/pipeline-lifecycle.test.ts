import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { fromRaw } from '../src/host/config.ts';
import { createPipelineEndpoint, runPipeline } from '../src/host/card-pipeline.ts';
import { createNodeSpawner } from './node-spawner.ts';

const python = '/Users/ghost/MySpace/.venv/bin/python';
const trustedRequest = {
  headers: {
    host: 'localhost:19387', origin: 'http://localhost:19387',
    'sec-fetch-site': 'same-origin', 'x-butler-review': '1',
  },
} as unknown as IncomingMessage;

/** Each fixture owns its root; realpath handles macOS /var -> /private/var. */
test('pipeline lifecycle: profile create/revise/archive, decisions, HTTP review binding', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'butler-pipeline-lifecycle-')));
  try {
    cpSync(join(import.meta.dir, '../skeleton'), root, { recursive: true });
    const config = fromRaw(root, { python });
    mkdirSync(join(config.selfRoot, 'etc'), { recursive: true });
    writeFileSync(join(config.selfRoot, 'etc/knowledge-store.json'), JSON.stringify({ version: 1, active: 'wiki' }));
    const spawner = createNodeSpawner();
    const call = (action: string, args: Record<string, unknown> = {}) => runPipeline(config, spawner, action, args) as Promise<any>;
    const endpoint = createPipelineEndpoint(config, spawner, { hostUrl: 'http://localhost:19387' });

    async function ingest(label: string, message: string) {
      return call('sessions.ingest', {
        source: 'fixture', externalSessionId: `lifecycle-${label}`, segmentId: 'turn-1', revision: 1,
        captureMode: 'transcript', title: `Lifecycle ${label}`,
        messages: [{ id: `message-${label}`, role: 'user', sequence: 1, content: message }],
      });
    }
    async function claim() {
      const run = await call('distill.claim', { limit: 1, maxChars: 20_000 });
      expect(run.runId, 'a fresh ingested fixture must be claimable').toBeTruthy();
      expect(run.runToken).toBeTruthy();
      expect(run.inputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(run.sources).toHaveLength(1);
      return run;
    }
    async function submit(run: any, source: any, candidate: Record<string, unknown>) {
      const result = await call('candidates.submit', {
        runId: run.runId, runToken: run.runToken, inputHash: run.inputHash,
        kind: 'profile', scope: 'local', rationale: 'Lifecycle contract fixture',
        evidence: [{ sourceId: source.id, messageIds: [source.messageId], quote: source.quote }],
        ...candidate,
      });
      await call('distill.complete', {
        runId: run.runId, runToken: run.runToken, inputHash: run.inputHash, candidateIds: [result.id],
      });
      return result;
    }
    async function approve(candidate: any, key: string) {
      const binding = { id: candidate.id, revision: candidate.revision, contentHash: candidate.contentHash };
      const prepared = await endpoint.handle(trustedRequest, { action: 'review.prepare', args: binding });
      expect(prepared.status, JSON.stringify(prepared.envelope)).toBe(200);
      const reviewToken = (prepared.envelope as any).data.reviewToken;
      return {
        binding, reviewToken,
        request: { action: 'candidates.approve', args: { ...binding, reviewToken, idempotencyKey: key } },
      };
    }
    async function reject(candidate: any, key: string) {
      const binding = { id: candidate.id, revision: candidate.revision, contentHash: candidate.contentHash };
      const prepared = await endpoint.handle(trustedRequest, { action: 'review.prepare', args: binding });
      expect(prepared.status, JSON.stringify(prepared.envelope)).toBe(200);
      return endpoint.handle(trustedRequest, {
        action: 'candidates.reject', args: { ...binding, reviewToken: (prepared.envelope as any).data.reviewToken, idempotencyKey: key },
      });
    }

    const firstText = 'Profile card lifecycle alpha: preserve a stable operating preference.';
    const firstSource = await ingest('profile-alpha', firstText);
    const firstRun = await claim();
    const created = await submit(firstRun, { id: firstSource.id, messageId: 'message-profile-alpha', quote: firstText }, {
      operation: 'create', title: 'Alpha profile', summary: 'Stable preference alpha', body: 'Prefer stable, explicit operating guidance for alpha.',
    });
    expect(created.status).toBe('pending');
    expect((await call('cards.search', { query: 'operating guidance for alpha' })).items).toHaveLength(0);

    // HTTP candidates.get must preserve the complete content hash, not scrub it as a credential.
    const httpGet = await endpoint.handle(trustedRequest, { action: 'candidates.get', args: { id: created.id } });
    expect(httpGet.status, JSON.stringify(httpGet.envelope)).toBe(200);
    expect((httpGet.envelope as any).data.contentHash).toBe(created.contentHash);

    const bound = await approve(created, 'approve-alpha');
    const approved = await endpoint.handle(trustedRequest, bound.request);
    expect(approved.status, JSON.stringify(approved.envelope)).toBe(200);
    const card = (approved.envelope as any).data.card;
    expect(card.kind).toBe('profile');
    expect(card.status).toBe('active');
    expect((await endpoint.handle(trustedRequest, bound.request)).envelope).toEqual(approved.envelope);
    expect((await endpoint.handle(trustedRequest, {
      action: 'candidates.approve', args: { ...bound.binding, reviewToken: bound.reviewToken, idempotencyKey: 'different-key' },
    })).status).toBe(409);

    const betaText = 'Profile card lifecycle beta: a separate profile enters review.';
    const betaSource = await ingest('profile-beta', betaText);
    const betaCandidate = await submit(await claim(), { id: betaSource.id, messageId: 'message-profile-beta', quote: betaText }, {
      operation: 'create', title: 'Beta profile', summary: 'Independent profile beta', body: `Keep the beta profile separate and searchable. unique-beta-marker [[${card.id}]]`,
    });
    const betaDecision = await endpoint.handle(trustedRequest, (await approve(betaCandidate, 'approve-beta')).request);
    expect(betaDecision.status).toBe(200);
    expect((await call('cards.read', { id: betaCandidate.id })).links).toContain(card.id);
    expect((await call('cards.read', { id: card.id })).backlinks).toContain(betaCandidate.id);
    expect((await call('cards.search', { query: 'unique-beta-marker' })).items.map((item: any) => item.id)).toContain(betaCandidate.id);

    const reviseText = 'Profile card lifecycle revise alpha without changing the card identity.';
    const reviseSource = await ingest('profile-revise', reviseText);
    const reviseCandidate = await submit(await claim(), { id: reviseSource.id, messageId: 'message-profile-revise', quote: reviseText }, {
      operation: 'revise', targetId: card.id, baseRevision: card.revision,
      title: 'Alpha profile revised', summary: 'Updated stable preference', body: 'Revised alpha guidance unique-revised-alpha-marker.',
    });
    const editResult = await endpoint.handle(trustedRequest, { action: 'candidates.edit', args: {
      id: reviseCandidate.id, expectedRevision: reviseCandidate.revision, body: `${reviseCandidate.body} human edit`,
    } });
    expect(editResult.status, JSON.stringify(editResult.envelope)).toBe(200);
    const edited = (editResult.envelope as any).data;
    const staleEdit = await endpoint.handle(trustedRequest, { action: 'candidates.edit', args: {
      id: reviseCandidate.id, expectedRevision: reviseCandidate.revision, body: 'stale write',
    } });
    expect(staleEdit.status).toBe(409);
    expect((staleEdit.envelope as any).error.code).toBe('revision_conflict');
    const revisedDecision = await endpoint.handle(trustedRequest, (await approve(edited, 'revise-alpha')).request);
    expect(revisedDecision.status, JSON.stringify(revisedDecision.envelope)).toBe(200);
    const revisedCard = (revisedDecision.envelope as any).data.card;
    expect(revisedCard.id).toBe(card.id);
    expect(revisedCard.revision).toBe(card.revision + 1);

    const archiveText = 'Profile card lifecycle archive alpha after superseding it.';
    const archiveSource = await ingest('profile-archive', archiveText);
    const archiveCandidate = await submit(await claim(), { id: archiveSource.id, messageId: 'message-profile-archive', quote: archiveText }, {
      operation: 'archive', targetId: card.id, baseRevision: revisedCard.revision,
      title: 'Archive alpha', summary: 'Archive superseded alpha', body: 'Archived alpha profile unique-archive-alpha-marker.',
    });
    const archivedDecision = await endpoint.handle(trustedRequest, (await approve(archiveCandidate, 'archive-alpha')).request);
    expect(archivedDecision.status, JSON.stringify(archivedDecision.envelope)).toBe(200);
    expect((archivedDecision.envelope as any).data.card.status).toBe('archived');
    expect((await call('cards.search', { query: 'unique-archive-alpha-marker' })).items).toHaveLength(0);

    const rejectText = 'Profile card lifecycle reject this proposal without approval.';
    const rejectSource = await ingest('profile-reject', rejectText);
    const rejectedCandidate = await submit(await claim(), { id: rejectSource.id, messageId: 'message-profile-reject', quote: rejectText }, {
      operation: 'create', title: 'Rejected profile', summary: 'Must remain rejected', body: 'Rejected profile unique-rejected-marker.',
    });
    const rejected = await reject(rejectedCandidate, 'reject-profile');
    expect(rejected.status, JSON.stringify(rejected.envelope)).toBe(200);
    expect((rejected.envelope as any).data.card).toBeNull();
    const rejectBinding = { id: rejectedCandidate.id, revision: rejectedCandidate.revision, contentHash: rejectedCandidate.contentHash };
    const freshReview = await endpoint.handle(trustedRequest, { action: 'review.prepare', args: rejectBinding });
    const unauthorizedApproval = await endpoint.handle(trustedRequest, {
      action: 'candidates.approve', args: { ...rejectBinding, reviewToken: (freshReview.envelope as any).data.reviewToken, idempotencyKey: 'approve-after-reject' },
    });
    expect(unauthorizedApproval.status).toBe(409);
    expect((unauthorizedApproval.envelope as any).error.code).toBe('already_decided');
    expect((await call('cards.search', { query: 'unique-rejected-marker' })).items).toHaveLength(0);

    const unauthorized = await endpoint.handle({ headers: {} } as IncomingMessage, {
      action: 'review.prepare', args: { id: created.id, revision: created.revision, contentHash: created.contentHash },
    });
    expect(unauthorized.status).toBe(403);
    expect((unauthorized.envelope as any).error.code).toBe('forbidden');
  } finally {
    // This exact root was created exclusively for this test fixture.
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
