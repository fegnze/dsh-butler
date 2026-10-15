/**
 * Where a workflow run should be brought to the owner's attention.
 *
 * Runs are started from many places — a tool panel, an Agent session, a CLI,
 * an automation — and most of them are not the console. Forcing the window to
 * the front or yanking the main panel away interrupts whatever the owner is
 * doing, so attention is routed by where they already are:
 *
 *  - on the workbench   → switch it to the console and scroll to 工作流;
 *  - in a conversation  → open the console as a right-sidebar tab beside it;
 *  - anywhere else      → a small nudge with a 「查看」 action, no navigation.
 *
 * While the window is not focused nothing moves: the Host already posts a
 * system notification, and the routing waits for the window to come back.
 *
 * This file is the pure part (keys, freshness, routing) plus the event the
 * console listens to; the overlay component in RunAttention.tsx wires it up.
 */

/** Minimal run shape this module reads. */
export interface AttentionRun {
  runId: string; title: string; status: string; startedAt?: number;
  steps: { name: string; status: string; confirm?: { token: string } }[];
}

export type AttentionReason = 'start' | 'await'
export interface Attention { key: string; reason: AttentionReason; runId: string; title: string; step?: string }
export type Route = 'workbench' | 'rightbar' | 'nudge'

/** Window event the console (and the workbench switch) listen to. */
export const ATTENTION_EVENT = 'butler:runs-attention'

/**
 * Every attention-worthy fact in the current runs, oldest-first per run.
 * A run start counts only when it began after `since` (the stream replays
 * history on connect, which must not re-trigger). A step awaiting the owner
 * always counts — it is waiting for exactly this person.
 * @param runs - visible runs.
 * @param since - epoch ms; starts before this are history.
 * @returns attention items keyed so each fires once.
 */
export function attentionItems(runs: AttentionRun[], since: number): Attention[] {
  const out: Attention[] = []
  for (const run of runs) {
    if (run.status === 'running' && (run.startedAt ?? 0) >= since) {
      out.push({ key: `start:${run.runId}`, reason: 'start', runId: run.runId, title: run.title })
    }
    run.steps.forEach((step, index) => {
      if (step.status === 'awaiting' && step.confirm?.token) {
        out.push({ key: `await:${run.runId}:${index}:${step.confirm.token}`, reason: 'await', runId: run.runId, title: run.title, step: step.name })
      }
    })
  }
  return out
}

/**
 * The newest unseen attention item, marking everything current as seen.
 * An awaiting step outranks a start: it needs a decision, a start only a look.
 * @param seen - keys already handled; mutated.
 * @param items - from `attentionItems`.
 * @returns the item to act on, or null.
 */
export function takeFresh(seen: Set<string>, items: Attention[]): Attention | null {
  const fresh = items.filter(item => !seen.has(item.key))
  for (const item of items) seen.add(item.key)
  if (!fresh.length) return null
  return fresh.find(item => item.reason === 'await') ?? fresh[fresh.length - 1]
}

/**
 * Decide how to surface attention from where the owner is.
 * @param activePanelId - the main panel; null means a conversation is shown.
 * @param consolePanelId - the workbench's panel id.
 * @returns the route.
 */
export function routeFor(activePanelId: string | null, consolePanelId: string): Route {
  if (activePanelId === consolePanelId) return 'workbench'
  if (activePanelId === null) return 'rightbar'
  return 'nudge'
}

/**
 * Ask any mounted console to bring 工作流 into view.
 * @param detail - the attention item.
 */
export function announce(detail: Attention): void {
  if (typeof window === 'undefined') return
  // Two frames: a tab or page that was just opened mounts its console first.
  const fire = () => window.dispatchEvent(new CustomEvent(ATTENTION_EVENT, { detail }))
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(fire))
  else setTimeout(fire, 32)
}

/**
 * Subscribe to attention announcements.
 * @param listener - receives the attention item.
 * @returns unsubscribe.
 */
export function onAttention(listener: (detail: Attention) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handler = (event: Event) => listener((event as CustomEvent<Attention>).detail)
  window.addEventListener(ATTENTION_EVENT, handler)
  return () => window.removeEventListener(ATTENTION_EVENT, handler)
}
