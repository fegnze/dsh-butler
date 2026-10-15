import { afterEach, expect, mock, test } from 'bun:test'
import { pipelineRequest, reviewCandidate } from '../src/ui/card-pipeline-source.ts'

const originalFetch = globalThis.fetch
const originalRandomUUID = globalThis.crypto.randomUUID
const installFetch = (implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
  const replacement = Object.assign(mock(implementation), { preconnect: () => {} })
  globalThis.fetch = replacement
}

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.crypto.randomUUID = originalRandomUUID
})

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

test('pipelineRequest posts same-origin JSON with review headers and unwraps success envelope', async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined
  installFetch(async (input, init) => {
    request = { input, init }
    return response(200, { ok: true, data: { candidates: [] } })
  })

  await expect(pipelineRequest('candidates.list', { status: 'pending' })).resolves.toEqual({ candidates: [] })
  expect(request?.input).toBe('/myspace-butler/api/pipeline')
  expect(request?.init?.method).toBe('POST')
  expect(request?.init?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Butler-Review': '1' })
  expect(JSON.parse(String(request?.init?.body))).toEqual({ action: 'candidates.list', args: { status: 'pending' } })
})

test('pipelineRequest turns API errors and 409 conflicts into coded errors', async () => {
  installFetch(async () => response(400, { ok: false, error: { code: 'bad_action', message: '未知动作', field: 'action' } }))
  await expect(pipelineRequest('invalid')).rejects.toMatchObject({ code: 'bad_action', status: 400, message: '未知动作', details: { field: 'action' } })

  installFetch(async () => response(409, { ok: false, error: { code: 'revision_conflict', message: '版本已变化', currentRevision: 4 } }))
  await expect(pipelineRequest('candidates.approve')).rejects.toMatchObject({ code: 'revision_conflict', status: 409, details: { currentRevision: 4 } })
})

test('reviewCandidate prepares a bound token before one approve mutation', async () => {
  const calls: Array<{ action: string; args: Record<string, unknown> }> = []
  globalThis.crypto.randomUUID = mock(() => `00000000-0000-4000-8000-000000000001` as const)
  installFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body))
    calls.push(call)
    return call.action === 'review.prepare'
      ? response(200, { ok: true, data: { reviewToken: 'token-1' } })
      : response(200, { ok: true, data: { approved: true } })
  })

  await expect(reviewCandidate({ id: 'c1', revision: 3, contentHash: 'hash', baseRevision: 2 }, 'approve')).resolves.toEqual({ approved: true })
  expect(calls).toEqual([
    { action: 'review.prepare', args: { id: 'c1', revision: 3, contentHash: 'hash' } },
    { action: 'candidates.approve', args: { id: 'c1', revision: 3, contentHash: 'hash', baseRevision: 2, reviewToken: 'token-1', idempotencyKey: '00000000-0000-4000-8000-000000000001' } },
  ])
})

test('legacy create candidates omit null baseRevision for approve and reject', async () => {
  const calls: any[] = []
  installFetch(async (_input, init) => {
    const call = JSON.parse(String(init?.body)); calls.push(call)
    return response(200, { ok: true, data: call.action === 'review.prepare' ? { reviewToken: 'token' } : { status: 'done' } })
  })
  for (const action of ['approve', 'reject'] as const) {
    await reviewCandidate({ id: 'legacy-create', revision: 1, contentHash: 'h', baseRevision: null }, action)
  }
  expect(calls).toHaveLength(4)
  for (const call of calls) expect(call.args).not.toHaveProperty('baseRevision')
})

test('reviewCandidate does not mutate when preparation fails and never retries mutation failure', async () => {
  const calls: string[] = []
  installFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { action } = JSON.parse(String(init?.body))
    calls.push(action)
    return response(action === 'review.prepare' ? 403 : 409, { ok: false, error: { code: 'denied', message: '拒绝' } })
  })
  const candidate = { id: 'c1', revision: 1, contentHash: 'h' }
  await expect(reviewCandidate(candidate, 'approve')).rejects.toMatchObject({ code: 'denied', status: 403 })
  expect(calls).toEqual(['review.prepare'])

  calls.length = 0
  installFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { action } = JSON.parse(String(init?.body))
    calls.push(action)
    return action === 'review.prepare'
      ? response(200, { ok: true, data: { reviewToken: 'token' } })
      : response(409, { ok: false, error: { code: 'conflict', message: '版本冲突' } })
  })
  await expect(reviewCandidate(candidate, 'reject', '不保留')).rejects.toMatchObject({ code: 'conflict', status: 409 })
  expect(calls).toEqual(['review.prepare', 'candidates.reject'])
})
