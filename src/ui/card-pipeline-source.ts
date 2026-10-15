/** Same-origin client for the Butler card pipeline API. */

export type CandidateKind = 'knowledge' | 'profile' | 'rule'
export type CandidateOperation = 'create' | 'revise' | 'merge' | 'archive'
export type CandidateStatus = 'pending' | 'approved' | 'rejected' | 'superseded'
export type EvidenceReference = {
  sourceId: string
  messageIds: string[]
  quote?: string
  [key: string]: unknown
}

export interface Candidate {
  id: string
  revision: number
  contentHash: string
  kind: CandidateKind
  operation?: CandidateOperation
  status?: CandidateStatus
  targetId?: string
  baseRevision?: number | null
  title: string
  summary: string
  body: string
  evidence: EvidenceReference[]
  rationale?: string
  scope?: string
  tags?: string[]
  relatedCards?: string[]
  conflicts?: unknown[]
  [key: string]: unknown
}

export type ValidityCheck = { type: 'path' | 'quote'; path: string; text?: string }
export interface CardValidity {
  state: 'valid' | 'suspended'
  reasons: Array<{ code: 'check_failed' | 'conflict'; detail?: string; candidateId?: string }>
  checks: ValidityCheck[]
  results: Array<{ ok: boolean; detail: string }>
  changedAt?: number | null
}

export interface Card {
  id: string
  revision: number
  kind: CandidateKind
  title: string
  summary: string
  body?: string
  /** Visibility (local/team…); where the card applies lives in appliesTo. */
  scope?: string
  appliesTo?: string
  tags?: string[]
  status?: 'active' | 'archived'
  /** Lifecycle active and validity not suspended. */
  usable?: boolean
  validity?: CardValidity | null
  approvedAt?: string
  evidence?: EvidenceReference[]
  links?: string[]
  [key: string]: unknown
}

/** One-line owner-facing usability label for a formal card. */
export function cardUsability(card: Pick<Card, 'status' | 'validity'>): { usable: boolean; text: string } {
  if (card.status && card.status !== 'active') return { usable: false, text: '已归档' }
  if (card.validity?.state === 'suspended') {
    const codes = new Set(card.validity.reasons.map(reason => reason.code))
    return { usable: false, text: `已暂停（${[codes.has('check_failed') ? '依据失效' : '', codes.has('conflict') ? '有冲突待审' : ''].filter(Boolean).join('、') || '原因未注明'}）` }
  }
  return { usable: true, text: card.validity?.checks?.length ? '有效 · 依据已核验' : '有效' }
}

export interface SessionMessage {
  id: string
  role: string
  content: string
  sequence: number
  [key: string]: unknown
}

export interface Session {
  id: string
  source?: string
  externalSessionId?: string
  workspace?: string
  agentId?: string
  title?: string
  messages: SessionMessage[]
  [key: string]: unknown
}

export interface PipelineError extends Error {
  code: string
  status: number
  details?: unknown
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code?: string; message?: string; [key: string]: unknown } }

const PIPELINE_URL = '/myspace-butler/api/pipeline'

/** Send a pipeline command exclusively to the fixed same-origin API route. */
export async function pipelineRequest<T = unknown>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!action || typeof action !== 'string') throw new TypeError('action must be a non-empty string')
  const response = await fetch(PIPELINE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Butler-Review': '1',
      ...(typeof location !== 'undefined' && location.protocol === 'dsh-app:' && location.hostname === 'app' ? { 'X-Butler-Desktop': 'dsh-app://app' } : {}),
    },
    body: JSON.stringify({ action, args }),
  })
  let envelope: Envelope<T>
  try {
    envelope = await response.json() as Envelope<T>
  } catch {
    throw Object.assign(new Error(`Invalid pipeline response (${response.status})`), {
      code: 'invalid_response', status: response.status,
    })
  }
  if (!response.ok || !envelope || typeof envelope !== 'object' || envelope.ok !== true) {
    const failure = envelope && typeof envelope === 'object' && envelope.ok === false ? envelope.error : undefined
    throw Object.assign(new Error(failure?.message || `Pipeline request failed (${response.status})`), {
      code: failure?.code || (response.status === 409 ? 'conflict' : 'request_failed'),
      status: response.status,
      details: failure ? Object.fromEntries(Object.entries(failure).filter(([key]) => key !== 'code' && key !== 'message')) : undefined,
    })
  }
  return envelope.data
}

/** Execute a deliberate UI review action; mutations are never retried. */
export async function reviewCandidate(
  candidate: Pick<Candidate, 'id' | 'revision' | 'contentHash' | 'baseRevision'>,
  action: 'approve' | 'reject',
  reason?: string,
): Promise<unknown> {
  const binding = { id: candidate.id, revision: candidate.revision, contentHash: candidate.contentHash }
  const prepared = await pipelineRequest<{ reviewToken: string }>('review.prepare', binding)
  if (!prepared || typeof prepared.reviewToken !== 'string' || !prepared.reviewToken) {
    throw Object.assign(new Error('Review preparation returned no review token'), {
      code: 'invalid_review_token', status: 502,
    })
  }
  const args: Record<string, unknown> = {
    ...binding,
    ...(candidate.baseRevision == null ? {} : { baseRevision: candidate.baseRevision }),
    reviewToken: prepared.reviewToken,
    idempotencyKey: crypto.randomUUID(),
    ...(reason === undefined ? {} : { reason }),
  }
  return pipelineRequest(`candidates.${action}`, args)
}
