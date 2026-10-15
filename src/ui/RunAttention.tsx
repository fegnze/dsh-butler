/**
 * Frame-wide attention router for workflow runs, mounted in `shell.overlay`.
 *
 * It renders nothing most of the time. When a run starts (or a step starts
 * waiting for the owner) it decides, from where the owner is, how to surface
 * it — see run-attention.ts for the routing table. It never raises the window:
 * while the window is not focused the item is held, and delivered when the
 * owner comes back (by clicking the Host's system notification or otherwise).
 *
 * The only visible part is the nudge: a small note in the bottom-right corner
 * with a 「查看」 action, used when the owner is on some other page. A start
 * nudge fades on its own; an awaiting one stays until handled.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { announce, attentionItems, routeFor, takeFresh } from './run-attention.ts'

const START_NUDGE_MS = 8000

/**
 * @param props - copy, the panel hook, the runs hook, and the two navigation callbacks.
 * @returns the nudge, or null.
 */
export function RunAttention({ t, usePanelInfo, useRuns, consolePanelId, showWorkbench, openConsoleTab }) {
  const activePanelId = usePanelInfo(info => info.activePanelId)
  const runs = useRuns(snapshot => snapshot.runs)
  const [nudge, setNudge] = useState(null)
  const since = useRef(Date.now())
  const seen = useRef(new Set())
  const pending = useRef(null)
  const panelRef = useRef(activePanelId)
  panelRef.current = activePanelId

  const deliver = useCallback(() => {
    const item = pending.current
    if (!item) return
    if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) return
    pending.current = null
    let route = routeFor(panelRef.current ?? null, consolePanelId)
    if (route === 'rightbar' && !openConsoleTab()) route = 'nudge'
    if (route === 'nudge') { setNudge(item); return }
    setNudge(null)
    announce(item)
  }, [consolePanelId, openConsoleTab])

  useEffect(() => {
    const item = takeFresh(seen.current, attentionItems(runs, since.current))
    if (item) { pending.current = item; deliver() }
    // A handled awaiting step takes its nudge with it.
    setNudge(current => current && current.reason === 'await'
      && !runs.some(run => run.runId === current.runId && run.steps.some(step => step.status === 'awaiting'))
      ? null : current)
  }, [runs, deliver])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onBack = () => deliver()
    window.addEventListener('focus', onBack)
    document.addEventListener('visibilitychange', onBack)
    return () => { window.removeEventListener('focus', onBack); document.removeEventListener('visibilitychange', onBack) }
  }, [deliver])

  // The owner walked onto the workbench by themselves: the nudge has done its job.
  useEffect(() => { if (activePanelId === consolePanelId) setNudge(null) }, [activePanelId, consolePanelId])

  useEffect(() => {
    if (!nudge || nudge.reason !== 'start') return undefined
    const timer = setTimeout(() => setNudge(current => (current === nudge ? null : current)), START_NUDGE_MS)
    return () => clearTimeout(timer)
  }, [nudge])

  if (!nudge) return null
  const go = () => { const item = nudge; setNudge(null); if (showWorkbench()) announce(item) }
  return (
    <div className="bp-nudge" role="status" data-reason={nudge.reason}>
      <span className="bp-dot" data-tone={nudge.reason === 'await' ? 'warn' : 'ok'} aria-hidden="true" />
      <span className="bp-nudge__text">
        <span className="bp-nudge__label">{nudge.reason === 'await' ? t('runs.nudgeAwait') : t('runs.nudgeStart')}</span>
        <span className="bp-nudge__title" title={nudge.title}>{nudge.title}{nudge.step ? ` · ${nudge.step}` : ''}</span>
      </span>
      <button type="button" className="bp-btn bp-btn--primary" onClick={go}>{t('runs.nudgeView')}</button>
      <button type="button" className="bp-search__clear" aria-label={t('runs.dismiss')} title={t('runs.dismiss')} onClick={() => setNudge(null)}>×</button>
    </div>
  )
}
