/**
 * MySpace Butler panel, browser half.
 *
 * One rail entry, 「工作台」, with three tabs behind one switch:
 *
 *   1. Console        (`/myspace-butler/operations`, also a right-sidebar tab)
 *   2. Quick actions  (`/myspace-butler/quick-actions`)
 *   3. Butler         (`/myspace-butler/butler`, the card page)
 *
 * The three still share nothing but a dictionary: each tab keeps its own data
 * source and is mounted only while selected, so a hidden tab does not poll.
 *
 * Zero DSH source changes. The coupling surface is exactly what the
 * architecture allows: slot registration, the shared panel id, and type-only
 * imports. No runtime value of another feature package is imported.
 */

import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

// Everything visual and every Butler data source lives in src/ui
// (React only, no DSH). This file is the DSH-specific part: slot registration,
// panel ids, the proxy prefix, and the asset path the Host half serves.
import { ConsoleBody, ConsoleTitle } from '../ui/ConsoleBody.tsx'
import { WorkbenchPage } from '../ui/Workbench.tsx'
import { WorkbenchPanelIcon } from '../ui/icons.tsx'
import { createButlerSource } from '../ui/butler-source.ts'
import { createOperationsSource } from '../ui/operations-source.ts'
import { createRunsSource, decideStep } from '../ui/runs-source.ts'
import { RunAttention } from '../ui/RunAttention.tsx'
import { installConsoleStyles } from '../ui/panel-styles.ts'
import { installNoSelectRule } from '../ui/no-select.ts'
import { configureBase } from '../ui/base.ts'
import { en, zh } from '../ui/locales.ts'

/** Copy namespace owned by this plugin. */
const NS = 'butlerPanel'

/** Same-origin prefix owned by the in-process Butler Host (`dsh/index.js`). */
const BASE = '/myspace-butler'

/** Butler's face, shipped with the package and served by the Host half. */
const BUTLER_ICON = `${BASE}/assets/cat-butler-icon.png`

/** The workbench's id (console + launchpad + Butler), shared by its rail entry and its page. */
export const CONSOLE_PANEL_ID = 'butler-console-page'

/** This implementation's identity in the right-sidebar tab system. */
export const CONSOLE_ID = 'myspace-butler-panel/console'

/** The tab kind this package owns. */
export const CONSOLE_KIND = 'butler-console'

/** Browser services this plugin needs. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Register the workbench's rail entry and page, and the console's docked tab.
 * @param ctx - the browser plugin context.
 */
function openSessionVia(ctx) {
  let workspace
  try { workspace = ctx.get?.('uiWorkspace') } catch { workspace = undefined }
  return typeof workspace?.openSession === 'function' ? (id) => workspace.openSession(id) : null
}

/**
 * Read an optional App service without making it a hard dependency (cordis
 * treats every `inject` entry as required).
 * @param ctx - the browser plugin context.
 * @param name - service name.
 * @returns the service, or undefined.
 */
function optional(ctx, name) {
  try { return ctx.get?.(name) } catch { return undefined }
}

export function apply(ctx) {
  configureBase(BASE)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'butler-panel: dictionaries')
  const t = ctx.locale.bind(NS)

  // Upstream's panel rows are text-selectable, so a double-click paints a
  // selection over the label. Their bug, our rail too — see no-select.ts.
  ctx.effect(() => installNoSelectRule(), 'butler-panel: rail text selection')

  // The panel's sheet serves both surfaces: the console and the briefing share
  // the token block and the component classes, so they cannot drift into two
  // skins. Injected rather than inlined because hover, focus, sticky and drag
  // states cannot be expressed as inline styles — see panel-styles.ts.
  ctx.effect(() => installConsoleStyles(), 'butler-panel: console stylesheet')

  // Two sources, one per subject. The briefing reads Butler's own health; the
  // console reads the registered capability catalogue. They were briefly the
  // same object, which meant every doctor tick re-rendered the console and
  // every catalogue poll re-rendered the briefing — and, worse, made it look
  // as though the two surfaces were showing the same thing.
  //
  // Each source is lazy: it polls only while something is subscribed, so a
  // user who never opens the console never pays for its 8 s cadence.
  const butler = createButlerSource()
  const butlerFace = () => ({
    hooks: { butler },
    refresh: () => butler.refresh(),
    // 「重新巡检」与「刷新」是两件事：refresh 重读缓存，recheck 强制 doctor
    // 重跑（`?refresh=1`）。一个按了可能什么都不变的按钮不是按钮。
    recheck: () => butler.recheck(),
    icon: BUTLER_ICON,
    // Opens a `dsh://` record's session with the App's own navigation (the
    // same call the Automation tasks page uses). Optional service, read lazily:
    // without it the ref is shown as text instead of a button.
    openSession: openSessionVia(ctx),
  })

  const operations = createOperationsSource()
  // Two sources with different cadences: the catalogue is polled, workflow
  // runs are streamed (SSE) so a step turning green shows up as it happens.
  const runs = createRunsSource()
  const operationsFace = () => ({
    hooks: { operations, runs },
    dismissRun: (runId) => runs.dismiss(runId),
    decideStep,
    // A delegation step links its Butler Session; open it with the App's own navigation.
    openSession: openSessionVia(ctx),
    refresh: () => operations.refresh(),
    // Both console instances get the same two callbacks from the same source,
    // so the page and the docked tab cannot disagree about where a card is.
    move: (section, id, boundary) => operations.move(section, id, boundary),
    resetOrder: () => operations.reset(),
    setDisplay: (section, patch) => operations.setDisplay(section, patch),
  })

  // ── 1. 工作台 ─────────────────────────────────────────────────────────
  // One rail row, three tabs behind a switch: the operations console, the
  // quick launchpad and Butler's own page. The page gets both faces; each tab
  // subscribes only to its own hook, so the sources stay separate. The console
  // alone has a second home — a docked tab beside a conversation — drawn by
  // the same component.
  const workbenchFace = () => {
    const ops = operationsFace()
    const own = butlerFace()
    return { ...own, ...ops, hooks: { ...ops.hooks, ...own.hooks } }
  }
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: CONSOLE_PANEL_ID,
    locale: NS,
    inject: workbenchFace,
  }, WorkbenchPage)), 'butler-panel: workbench page')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: CONSOLE_PANEL_ID,
    // Panel rows sort ascending; place the workbench before builtin entries.
    order: -10,
    label: () => t('workbench.panel'),
    locale: NS,
  }, WorkbenchPanelIcon)), 'butler-panel: workbench entry')

  // A right-sidebar tab type. `priority: 'extension'` is the default and the
  // highest tier — an out-of-tree type outranks every builtin viewer.
  //
  // Field set verified against the installed 0.1.5-rc.2 `SidebarRightTabDefinition`:
  // the registry reads id / kind / priority / patterns / canOpen / title / guide
  // and nothing else. A page type (opened by kind, recognising no address)
  // declares no `patterns`. Guide entries carry order / title / description /
  // icon — no id of their own; the registry stamps the contributing `kind` on.
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: CONSOLE_ID,
    kind: CONSOLE_KIND,
    priority: 'extension',
    title: () => t('console.title'),
    guide: [{
      order: 5,
      title: () => t('console.guide.title'),
      description: () => t('console.guide.description'),
    }],
  }), 'butler-panel: console tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: CONSOLE_ID,
    locale: NS,
    inject: operationsFace,
  }, ConsoleBody)), 'butler-panel: console body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: CONSOLE_ID,
    locale: NS,
  }, ConsoleTitle)), 'butler-panel: console title')

  // ── 2. Run attention ──────────────────────────────────────────────────
  // Runs are mostly started from outside the console (Agent sessions, CLI,
  // automations). This frame-wide entry routes a new run — or a step waiting
  // for the owner — to where the owner already is, and never raises the
  // window: see run-attention.ts. Both navigation services are optional;
  // without them the route degrades to the nudge.
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'myspace-butler/run-attention',
    order: 100,
    locale: NS,
    inject: () => ({
      hooks: { runs },
      consolePanelId: CONSOLE_PANEL_ID,
      showWorkbench: () => {
        const layout = optional(ctx, 'layout')
        if (typeof layout?.selectPanel !== 'function') return false
        try { layout.selectPanel(CONSOLE_PANEL_ID); return true } catch { return false }
      },
      openConsoleTab: () => {
        const right = optional(ctx, 'sidebarRight')
        if (typeof right?.openTab !== 'function') return false
        // Throws when no session surface is mounted; the caller falls back.
        try { right.openTab(CONSOLE_KIND); return true } catch { return false }
      },
    }),
  }, RunAttention)), 'butler-panel: run attention')
}
