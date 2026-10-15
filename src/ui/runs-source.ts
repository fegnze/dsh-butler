/**
 * Workflow run observation for the console.
 *
 * Tools, services and faculties run multi-step work through the SDK runner,
 * which posts events to the Host's RunStore. The RunStore keeps the latest runs
 * in memory and streams them as `run` / `drop` SSE events on `/runs/stream`;
 * `/runs` is the same list as one snapshot. This source mirrors that list so
 * the console's 工作流 section can show each run's steps as they progress.
 *
 * Same `getSnapshot` / `subscribe` shape as the other sources. It connects only
 * while something is subscribed and reconnects after a dropped stream.
 */
import { base } from './base.ts'

const RECONNECT_MS = 3000

export interface StepConfirm { token: string; summary: string; items: string[]; sessionId?: string; decision?: 'approve' | 'reject' }
export interface RunStep { name: string; status: string; ms?: number; error?: string; log?: string; sessionId?: string; confirm?: StepConfirm }
export interface Run {
  runId: string; workflow: string; title: string; source: string; status: string;
  dryRun?: boolean; target?: string; error?: string;
  startedAt: number; endedAt?: number; currentIndex: number; steps: RunStep[];
}
type Runs = Map<string, Run>

/**
 * Upsert one `run` event. Malformed events return the same map untouched.
 * @param runs - current runs by id.
 * @param event - decoded `run` payload.
 * @returns a new map, or `runs` itself when the event is ignored.
 */
export function applyRun(runs: Runs, event: unknown): Runs {
  const run = event as Run | null
  if (!run || typeof run !== 'object' || typeof run.runId !== 'string' || !run.runId || !Array.isArray(run.steps)) return runs
  const next = new Map(runs)
  next.set(run.runId, run)
  return next
}

/**
 * Apply one `drop` event (the RunStore cleared finished runs).
 * @param runs - current runs by id.
 * @param event - decoded `{ ids }` payload.
 * @returns a new map, or `runs` itself when the event is ignored.
 */
export function applyDrop(runs: Runs, event: unknown): Runs {
  const ids = (event as { ids?: unknown } | null)?.ids
  if (!Array.isArray(ids)) return runs
  const next = new Map(runs)
  for (const id of ids) next.delete(String(id))
  return next
}

/**
 * Runs to show: running first (newest start), then finished (newest end).
 * @param runs - current runs by id.
 * @param dismissed - run ids the owner closed in this view.
 * @returns ordered runs.
 */
export function visibleRuns(runs: Runs, dismissed: Set<string>): Run[] {
  const list = [...runs.values()].filter(run => !dismissed.has(run.runId))
  const active = list.filter(run => run.status === 'running').sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  const done = list.filter(run => run.status !== 'running').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
  return [...active, ...done]
}

/**
 * Runs that started after a baseline: the "a flow was just triggered" signal.
 * Finished runs never count, because the stream replays history on connect.
 * @param seen - run ids known when the baseline was taken; null = no baseline yet.
 * @param runs - current runs.
 * @returns ids of newly started, still running runs.
 */
export function startedSince(seen: Set<string> | null, runs: Pick<Run, 'runId' | 'status'>[]): string[] {
  if (!seen) return []
  return runs.filter(run => run.status === 'running' && !seen.has(run.runId)).map(run => run.runId)
}

/**
 * State of the connector that leads *into* node `index` (0 = from the start
 * node; `steps.length` = into the end node).
 * @param run - status and steps of one run.
 * @param index - target node position.
 * @returns `flowing` (animated), `done`, `error` or `idle`.
 */
export function edgeState(run: { status: string; steps: { status: string }[] }, index: number): 'flowing' | 'done' | 'error' | 'idle' {
  const target = index < run.steps.length ? run.steps[index].status : null
  if (target === 'running') return 'flowing'
  if (target === 'success') return 'done'
  if (target === 'error') return 'error'
  if (target === null) {
    if (run.status === 'success') return 'done'
    if (run.status === 'error' || run.status === 'interrupted') return 'error'
  }
  return 'idle'
}

/**
 * The owner's decision on an awaiting step. Same owner-only headers as card review: the Host
 * accepts this only from the same-origin UI (or an authenticated DSH desktop forward).
 * @returns null on success, or the Host's error message.
 */
export async function decideStep(runId: string, index: number, token: string, decision: 'approve' | 'reject'): Promise<string | null> {
  const response = await fetch(`${base()}/runs/${encodeURIComponent(runId)}/steps/${index}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Butler-Review': '1',
      ...(typeof location !== 'undefined' && location.protocol === 'dsh-app:' && location.hostname === 'app' ? { 'X-Butler-Desktop': 'dsh-app://app' } : {}),
    },
    body: JSON.stringify({ token, decision }),
  })
  if (response.ok) return null
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
  return body?.error?.message ?? `HTTP ${response.status}`
}

/** Create the lazily connected run source. */
export function createRunsSource() {
  let runs: Runs = new Map()
  let snapshot = { status: 'loading', runs: [] as Run[] }
  let dismissed = new Set<string>()
  let stream: EventSource | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<() => void>()
  const emit = (status = snapshot.status) => {
    snapshot = { status, runs: visibleRuns(runs, dismissed) }
    for (const listener of listeners) listener()
  }
  const connect = () => {
    retry = null
    if (!listeners.size || stream) return
    // EventSource replays the current runs on connect (RunStore.subscribe), so
    // a reconnect needs no separate snapshot fetch.
    const source = new EventSource(`${base()}/runs/stream`)
    stream = source
    source.onopen = () => emit('ready')
    source.addEventListener('run', (event) => {
      try { runs = applyRun(runs, JSON.parse((event as MessageEvent).data)); emit('ready') } catch { /* skip one bad frame */ }
    })
    source.addEventListener('drop', (event) => {
      try { runs = applyDrop(runs, JSON.parse((event as MessageEvent).data)); emit('ready') } catch { /* skip one bad frame */ }
    })
    source.onerror = () => {
      source.close()
      if (stream === source) stream = null
      emit('offline')
      if (listeners.size && !retry) retry = setTimeout(connect, RECONNECT_MS)
    }
  }
  const disconnect = () => {
    if (retry) { clearTimeout(retry); retry = null }
    stream?.close()
    stream = null
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      connect()
      return () => { listeners.delete(listener); if (!listeners.size) disconnect() }
    },
    /** Hide one finished run in this view; the RunStore keeps it. */
    dismiss: (runId: string) => { dismissed = new Set(dismissed).add(runId); emit() },
  }
}
