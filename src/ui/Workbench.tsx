import { useCallback, useEffect, useState } from 'react'
import { ConsolePage } from './ConsoleBody.tsx'
import { QuickActionsPage } from './QuickActionsPage.tsx'
import { ButlerPage } from './ButlerPage.tsx'
import { announce, onAttention } from './run-attention.ts'

/** Where the last-used tab is remembered; purely a convenience, never required. */
const TAB_KEY = 'butler.workbench.tab'

const TABS = ['console', 'actions', 'butler']

/**
 * Read the remembered tab, tolerating storage that is missing or throws
 * (private mode, a sandboxed frame).
 * @returns one of TABS.
 */
function readTab() {
  try {
    const stored = globalThis.localStorage?.getItem(TAB_KEY)
    return TABS.includes(stored) ? stored : 'console'
  } catch { return 'console' }
}

/**
 * Butler's own page as the workbench's third tab. Its dedicated title sits
 * below the shared workbench bar, so switching tabs never moves the switch.
 * @param props - the workbench's slot props plus `lead`.
 * @returns the tab element.
 */
function ButlerTab(props) {
  const { lead } = props
  return (
    <div className="bp-console" data-wide="true" data-bench="butler">
      <div className="bp-head">
        {lead}
        <span className="bp-head__spacer" />
      </div>
      <ButlerPage {...props} />
    </div>
  )
}

/**
 * The one rail entry's page, 「工作台」: the operations console, the
 * quick launchpad and Butler's own card page behind a three-way switch.
 *
 * The switch is not a bar of its own: each half passes it into the start of
 * its own title bar (`lead`), in the place its title used to occupy, so the
 * shared tabs have the same geometry above each page's content. Each tab
 * keeps its own data source and is mounted only while selected, so a hidden
 * tab does not poll.
 * @param props - the workbench's assembled slot props (the launchpad ignores them).
 * @returns the page element.
 */
export function WorkbenchPage(props) {
  const { t } = props
  const [tab, setTab] = useState(readTab)
  const choose = useCallback((next) => {
    setTab(next)
    try { globalThis.localStorage?.setItem(TAB_KEY, next) } catch { /* remembering is optional */ }
  }, [])
  // A run routed here while another tab is up: show the console (without
  // remembering it as the owner's choice) and re-announce once it has mounted.
  useEffect(() => onAttention((detail) => {
    if (tab === 'console') return
    setTab('console')
    announce(detail)
  }), [tab])
  const onKeyDown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.key === 'ArrowRight' ? 1 : TABS.length - 1
    choose(TABS[(TABS.indexOf(tab) + step) % TABS.length])
  }
  const labels = { console: t('console.title'), actions: t('actions.title'), butler: t('panel') }
  const lead = (
    <div className="bp-switch" role="tablist" onKeyDown={onKeyDown}>
      {TABS.map(key => (
        <button
          key={key}
          type="button"
          role="tab"
          className="bp-switch__tab"
          aria-selected={tab === key}
          tabIndex={tab === key ? 0 : -1}
          onClick={() => choose(key)}
        >
          {labels[key]}
        </button>
      ))}
    </div>
  )
  return tab === 'butler' ? <ButlerTab {...props} lead={lead} />
    : tab === 'console' ? <ConsolePage {...props} lead={lead} /> : <QuickActionsPage t={t} lead={lead} />
}
