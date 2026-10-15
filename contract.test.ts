/**
 * Contract tests for the three DSH seams this plugin depends on.
 *
 * These do NOT test our rendering. They assert that the upstream extension
 * points still exist with the shape we register against. Run this first after
 * every `dsh` upgrade: if it stays green, an upstream refactor did not reach
 * us; if it goes red, the diff it points at is the only thing to read.
 *
 *   bun test contract.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
// Imported, not read: the order rules are the part of this feature a text
// assertion cannot vouch for. Boundaries, merges and malformed files are
// executed here against the real module.
import {
  emptyLayout,
  hasCustomOrder,
  moveWithin,
  orderedItems,
  readLayout,
  withSectionOrder,
  LAYOUT_SECTIONS,
  LAYOUT_VERSION,
  MAX_ID_LENGTH,
  MAX_IDS_PER_SECTION,
} from './src/ui/console-layout.ts'
import {
  createLayoutHandler,
  LAYOUT_SECTIONS as HOST_LAYOUT_SECTIONS,
  LAYOUT_VERSION as HOST_LAYOUT_VERSION,
  MAX_BODY_BYTES as HOST_MAX_BODY_BYTES,
  MAX_ID_LENGTH as HOST_MAX_ID_LENGTH,
  MAX_IDS_PER_SECTION as HOST_MAX_IDS_PER_SECTION,
} from './src/host/layout.ts'

const SRC = join(import.meta.dir, 'src/client')
/** Generic UI (React only, no DSH) lives in the framework; index.tsx is the DSH glue. */
const UI = join(import.meta.dir, 'src', 'ui')

/** The same node build.py checks with, so both gates agree on the parser. */
const NODE = process.env.BUTLER_NODE ?? Bun.which('node') ?? 'node'

/**
 * The installed DSH packages this plugin registers against.
 *
 * Asserting only against our own source proves we are self-consistent, not that
 * upstream still offers the seams. These tests read the real installed artefacts
 * so an upgrade that moves a seam turns them red.
 */
// Overridable so the mutation harness can point the same assertions at a
// deliberately damaged copy and confirm they go red.
const DSH = process.env.DSH_SCOPE_OVERRIDE
  ?? join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai')

/** Whether a DSH install is present to check against. */
const installed = existsSync(DSH)

/**
 * The MySpace Dashboard's request router — the other end of the proxy.
 *
 * Checked in source rather than over HTTP on purpose: these assertions must
 * hold whether or not the Dashboard happens to be running.
 */
const DASHBOARD_SERVER = join(import.meta.dir, 'src/host/routes.ts')

/** Where `panelUrl` is declared: the tool registry the supervisor is fed from. */
const DASHBOARD_REGISTRY = join(import.meta.dir, 'src/host/registry.ts')

/** The public catalogue, kept in view so its stripping stays a deliberate choice. */
const DASHBOARD_OPERATIONS = join(import.meta.dir, 'src/host/operations.ts')

/** The Host half, read whole: unlike the client files, its comments are few. */
const host = readFileSync(join(import.meta.dir, 'dsh/index.js'), 'utf8')

/**
 * Read an installed upstream file.
 * @param rel - path relative to the @deepseek-ai scope.
 * @returns the file contents.
 */
function upstream(rel: string): string {
  return readFileSync(join(DSH, rel), 'utf8')
}

/**
 * Read a source file with comments stripped.
 *
 * Prose in comments is the classic false-green/false-red source: a `not.toContain`
 * matches a word we merely wrote about, and an occurrence count includes lines
 * that never execute. Assertions must see code only.
 * @param file - file name under src/client.
 * @returns the file's code with block and line comments removed.
 */
function code(file: string): string {
  const path = file === 'index.tsx' ? join(SRC, file) : join(UI, file)
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const index = code('index.tsx')

/**
 * Every `ctx.slots.register({...}, Component)` call in index.tsx.
 *
 * Written as a parser rather than `indexOf` because there are now three
 * registrations per slot name. A `slice(indexOf(...))` assertion silently
 * tests whichever one happens to come first, so it stays green while a later
 * entry is broken — which is exactly the failure this file exists to catch.
 * @returns one record per registration.
 */
function registrations(): { slot: string, body: string, component: string }[] {
  const found: { slot: string, body: string, component: string }[] = []
  const re = /ctx\.slots\.register\(\{([\s\S]*?)\},\s*(\w+)\)/g
  for (const match of index.matchAll(re)) {
    const body = match[1]
    const slot = /name:\s*'([^']+)'/.exec(body)?.[1] ?? ''
    found.push({ slot, body, component: match[2] })
  }
  return found
}

const slots = registrations()

/**
 * The single registration for a slot rendered by a given component.
 * @param slot - the slot name.
 * @param component - the component the registration renders.
 * @returns the registration body.
 */
function one(slot: string, component: string): string {
  const hits = slots.filter(r => r.slot === slot && r.component === component)
  expect(hits).toHaveLength(1)
  return hits[0].body
}

describe('one rail entry: 工作台', () => {
  test('a single panel id, and it is not the reserved conversation key', () => {
    const ids = index.match(/export const \w*PANEL_ID = '([^']+)'/g) ?? []
    expect(ids).toHaveLength(1)
    expect(ids[0]).not.toContain("'conversation'")
    // The old briefing entry is merged into the workbench: no second rail row.
    expect(index).not.toMatch(/export const PANEL_ID\b/)
  })

  test('the one rail row and the one page share that id', () => {
    const rail = slots.filter(r => r.slot === 'sidebar.panellist')
    const main = slots.filter(r => r.slot === 'main')
    expect(rail).toHaveLength(1)
    expect(main).toHaveLength(1)
    const idOf = (body: string) => /\b(?:id|key):\s*(\w+)/.exec(body)?.[1]
    expect(idOf(rail[0].body)).toBe('CONSOLE_PANEL_ID')
    expect(idOf(main[0].body)).toBe('CONSOLE_PANEL_ID')
    expect(slots.filter(r => r.component === 'ButlerPage')).toHaveLength(0)
  })

  test('Butler is the workbench\'s third tab, mounted only while selected', () => {
    const bench = code('Workbench.tsx')
    expect(bench).toContain("const TABS = ['console', 'actions', 'butler']")
    expect(bench).toContain('<ButlerPage {...props} />')
    expect(bench).toContain("tab === 'butler' ? <ButlerTab")
    const locales = code('locales.ts')
    expect(locales).toContain("'workbench.panel': '工作台'")
  })

  test('rail rows carry the id/order/label triple, at distinct orders', () => {
    const rail = slots.filter(r => r.slot === 'sidebar.panellist')
    const orders: number[] = []
    for (const row of rail) {
      expect(row.body).toMatch(/\bid:\s*\w+/)
      expect(row.body).toContain('label:')
      const order = /order:\s*(-?\d+)/.exec(row.body)
      expect(order).not.toBeNull()
      orders.push(Number(order![1]))
    }
    // Equal orders make the rail order depend on registration sequence.
    expect(new Set(orders).size).toBe(orders.length)
  })

  test('quick actions shares the workbench entry but not the console\'s data', () => {
    // There is no separate registration for it any more: it is the workbench's
    // second tab. It still fetches its own list and reads nothing from either
    // source, so the shared page must not hand it the operations face.
    expect(slots.filter(r => r.component === 'QuickActionsPage')).toHaveLength(0)
    const bench = code('Workbench.tsx')
    expect(bench).toContain('<QuickActionsPage t={t} lead={lead} />')
    expect(bench).toContain("tab === 'console' ?")
    const page = code('QuickActionsPage.tsx')
    expect(page).not.toContain('useButler')
    expect(page).not.toContain('useOperations')
  })

  test('the briefing does not reach into the console or quick actions', () => {
    // The briefing is a report about Butler itself. Quick actions and the
    // console each own their own rail entry, so this page still does not fetch
    // on anyone else's behalf. One deliberate exception: the capability panel
    // runs *faculty* commands, because faculties are the core capabilities the
    // user asked this page to control — that is butler-source's surface, not
    // the console's.
    const page = code('ButlerPage.tsx')
    expect(page).not.toContain('runQuickAction')
    expect(page).not.toContain('fetchQuickActions')
    expect(page).not.toContain('runLifecycle')
    expect(page).not.toContain('runWorkflow')
    expect(page).toContain('runFacultyCommand')
  })

  test('the capability panel reports faculties, and never the extended set', () => {
    // The standing convention: faculties are the core capabilities and belong
    // to the briefing; tools / services / workflows are extended and belong to
    // the console. A count of either set on the wrong page is the drift this
    // guards against.
    const page = code('ButlerPage.tsx')
    const source = code('butler-source.ts')
    expect(source).toContain('faculties')
    expect(source).toContain('rejected')
    for (const marker of ['.tools', '.services', '.workflows']) {
      expect(page).not.toContain(marker)
    }
  })

  test('the briefing and the console read different sources', () => {
    // They were one object, which made every doctor tick re-render the
    // console — and, worse, implied the two surfaces showed the same thing.
    // The workbench page carries both faces, but each tab subscribes only to
    // its own hook; the docked console still gets the operations face alone.
    expect(one('main', 'WorkbenchPage')).toContain('inject: workbenchFace')
    expect(one('sidebar.right.pane.tab', 'ConsoleBody')).toContain('inject: operationsFace')
    expect(index).toContain('hooks: { butler }')
    expect(index).toContain('hooks: { operations, runs }')
    expect(index).toContain('hooks: { ...ops.hooks, ...own.hooks }')
    // A single shared face would make the split above cosmetic.
    expect(index).not.toMatch(/inject:\s*face\b/)
  })

  test('the visual surfaces degrade instead of squeezing text into columns', () => {
    const consoleBody = code('ConsoleBody.tsx')
    const styles = code('panel-styles.ts')
    const quickActions = code('QuickActionsPage.tsx')
    const butlerPage = code('ButlerPage.tsx')

    // Capability cards put controls below the content — identity band, then
    // footer band. A horizontal control rail inside a narrow card is what
    // produced one-character service names.
    //
    // These read the stylesheet rather than the component because that is
    // where layout lives now: inline styles cannot express hover, focus,
    // sticky or drag, and a page of them cannot follow the theme. The intents
    // are unchanged; only their address is.
    expect(styles).toMatch(/\.bp-tile \{[^}]*flex-direction: column;/)
    // Workflow runs are traces, not cards: the step flow wraps instead of
    // squeezing a long pipeline into one row.
    expect(consoleBody).toContain('function RunTrace')
    expect(styles).toMatch(/\.bp-flow \{[^}]*flex-wrap: wrap;/)
    // connectors animate only while the next node runs, and honour reduced motion
    expect(styles).toMatch(/\.bp-flow__edge\[data-state="flowing"\] \{[^}]*animation:/)
    expect(styles).toMatch(/prefers-reduced-motion[^{]*\{[^}]*bp-flow__edge/)
    expect(styles).toMatch(/\.bp-trace__title \{[^}]*overflow-wrap: anywhere;/)
    // The column count follows the width the slot actually has, and a docked
    // pane gets one column however wide the window is.
    expect(styles).toContain('grid-template-columns: repeat(auto-fit, minmax(312px, 1fr))')
    expect(styles).toMatch(/\.bp-console\[data-wide="false"\] \.bp-grid \{ grid-template-columns: 1fr;/)
    // State and buttons share one line: the footer never wraps, the meta box
    // (state + port) is one clipped line that gives way first, so a port that
    // does not fit disappears instead of pushing the buttons down. Buttons
    // still wrap among themselves rather than overflow the card, and a long
    // capability name breaks rather than widening its column.
    expect(styles).toMatch(/\.bp-tile__foot \{[^}]*flex-wrap: nowrap;/)
    expect(styles).toMatch(/\.bp-tile__meta \{[^}]*flex: 1 1 0;[^}]*min-width: min-content;[^}]*flex-wrap: wrap;[^}]*height: 25px;[^}]*overflow: hidden;/)
    expect(styles).toMatch(/\.bp-tile__meta > \.bp-chip \{ flex: none; \}/)
    expect(styles).toMatch(/\.bp-tile__acts \{[^}]*flex-wrap: wrap;/)
    expect(styles).toMatch(/\.bp-tile__name \{[^}]*overflow-wrap: anywhere;/)
    expect(consoleBody).toContain('size: tool.panelSize')
    expect(code('PanelModal.tsx')).toContain('dimensions.width')
    expect(code('PanelModal.tsx')).toContain('calc(100vw - 48px)')

    // All three pages choose columns from available width rather than locking
    // themselves to a desktop count.
    // …and the launchpad no longer draws its own: it uses the console's grid and cards.
    expect(quickActions).toContain('className="bp-grid"')
    expect(quickActions).toContain('className="bp-tile"')
    expect(quickActions).not.toMatch(/style=\{\{/)
    expect(quickActions).toContain("添加快捷卡片")
    expect(quickActions).toContain("搜索快捷卡片")
    expect(quickActions).toContain("saveQuickAction")
    // One title bar per half, the same component class the console uses, with the
    // workbench switch handed in where the title would be.
    expect(quickActions).toContain('<div className="bp-head">')
    expect(quickActions).toContain('lead ?? <h1')
    // The briefing takes its geometry from the shared sheet, and its content
    // sits 16px inside the glass head exactly as the console's does.
    const briefingStyles = code('panel-styles.ts')
    expect(briefingStyles).toContain('.bq-brief > .bq-metrics')
    expect(briefingStyles).toContain('grid-template-columns: 352px minmax(0, 1fr)')
    expect(briefingStyles).toContain('repeat(auto-fit, minmax(312px, 1fr))')
    expect(butlerPage).toContain('className="bq-brief"')
  })

  test('the carriers are never hosted workloads', () => {
    // DSH used to be a row in Butler/services/, which closed the control
    // plane into a loop: the guardian spawned the GUI, the GUI rendered the
    // console, and the console offered a stop button for the process serving
    // it — with no surface left to start it from afterwards.
    //
    // Two halves of one rule, so both are asserted here. The browser must ask
    // *itself* about its runtime rather than the guardian, and the Host must
    // answer locally rather than forwarding.
    // The console no longer draws the carrier at all: the DSH App hosting
    // this page is a description, not something to show status or controls for.
    expect(code('ConsoleBody.tsx')).not.toContain('runtime')

    const host = readFileSync(join(import.meta.dir, 'dsh', 'index.js'), 'utf8')
    // DSH mounts Butler in-process; the plugin does not proxy or own a second runtime.
    expect(host).toContain('path: ASSET_PATH')
    expect(host).toContain('await mountButler(ctx, config)')
    // A symlinked profile plugin cannot resolve App packages: importing
    // @deepseek-ai/dsh-llm here took the whole plugin down (measured 2026-10-10).
    expect(host).not.toContain('@deepseek-ai/dsh-llm')
    expect(host).not.toContain('launchctl')
    // No stop route exists, in either half. Adding one re-opens the loop.
    expect(host).not.toContain('/myspace-butler/runtime/stop')
    // And the guardian must not be asked to operate on the carrier it renders.
    expect(host).not.toMatch(/OPERATIONS[\s\S]*?\bdsh\b/)
  })

  test('the console reports capabilities, and the briefing reports health', () => {
    // The user pointed at the Dashboard's operations page and said "this is
    // the console I want". Endpoint pings and doctor output answer "how are
    // things", which is the briefing's subject, so they moved there.
    const console_ = code('ConsoleBody.tsx')
    expect(console_).not.toContain('useButler')
    expect(console_).not.toContain('doctor')
    expect(console_).toContain('useOperations')
    const page = code('ButlerPage.tsx')
    // The two used to be folds at the bottom of the page; they are viewers
    // behind the metric digits and the verdict chip now, which is where the
    // owner went looking for them.
    expect(page).toContain("t('view.doctor')")
    expect(page).toContain("t('view.endpoints')")
  })
})

describe('seam 1 — sidebar entry', () => {
  test('registers into the sidebar.panellist list slot', () => {
    expect(index).toContain("ctx.slots.inject('sidebar.panellist'")
    expect(index).toContain("name: 'sidebar.panellist'")
  })

  test('entry carries the id/order/label triple the rail requires', () => {
    const entry = one('sidebar.panellist', 'WorkbenchPanelIcon')
    expect(entry).toContain('id: CONSOLE_PANEL_ID')
    expect(entry).toMatch(/order:\s*-?\d+/)
    expect(entry).toContain('label:')
  })
})

describe('seam 2 — main page', () => {
  test('registers into the root-scoped main keyed slot', () => {
    expect(index).toContain("ctx.slots.inject('main'")
    expect(index).toContain("name: 'main'")
  })

  test('page and entry share one id, which is how selectPanel routes', () => {
    expect(one('main', 'WorkbenchPage')).toContain('key: CONSOLE_PANEL_ID')
    expect(one('sidebar.panellist', 'WorkbenchPanelIcon')).toContain('id: CONSOLE_PANEL_ID')
  })

  test('main key is not the reserved conversation key', () => {
    expect(index).toContain("CONSOLE_PANEL_ID = 'butler-console-page'")
    expect(index).not.toContain("PANEL_ID = 'conversation'")
  })
})

describe('seam 3 — right sidebar console', () => {
  test('registers a tab type through ctx.sidebarRightTabs', () => {
    expect(index).toContain('ctx.sidebarRightTabs.register(')
  })

  test('claims the extension priority tier', () => {
    // Count, do not merely contain. Substring containment stays green after the
    // value is downgraded if the literal survives anywhere else in the file, so
    // assert that every priority key in the code reads 'extension'.
    const priorities = index.match(/priority:\s*'(\w+)'/g) ?? []
    expect(priorities).toHaveLength(1)
    expect(priorities[0]).toBe("priority: 'extension'")
  })

  test('body and title share the definition id, as the seat addressing requires', () => {
    expect(one('sidebar.right.pane.tab', 'ConsoleBody')).toContain('key: CONSOLE_ID')
    expect(one('sidebar.right.pane.tab.title', 'ConsoleTitle')).toContain('key: CONSOLE_ID')
  })

  test('the console draws the same component in the tab and on its page', () => {
    // Two surfaces, one body: a console that disagrees with itself depending
    // on where it is docked is worse than one that is merely cramped.
    expect(one('main', 'WorkbenchPage')).toContain('key: CONSOLE_PANEL_ID')
    const console_ = code('ConsoleBody.tsx')
    expect(console_).toMatch(/export function ConsolePage/)
    expect(console_).toContain('<ConsoleBody {...props} wide />')
    // the page is drawn by the workbench, with the console's own title handed to the switch
    expect(code('Workbench.tsx')).toContain('<ConsolePage {...props} lead={lead} />')
    expect(console_).toContain('lead ?? <h1')
  })
})

describe('coupling discipline', () => {
  test('every cross-package import of a feature package is type-only', () => {
    const lines = index.split('\n').filter(l => l.includes("from '@deepseek-ai/"))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.startsWith('import type')).toBe(true)
    }
  })

  test('no component receives ctx', () => {
    for (const file of [
      'ButlerPage.tsx', 'ConsoleBody.tsx', 'QuickActionsPage.tsx', 'Workbench.tsx', 'icons.tsx',
      // The redesign's modules, so the framework layer stays DSH-free: a
      // stylesheet or a drag hook that reached for `ctx` would be a component
      // in a file that does not look like one.
      'panel-styles.ts', 'console-layout.ts', 'use-drag-order.ts',
    ]) {
      const source = code(file)
      expect(source).not.toContain('ClientContext')
      expect(source).not.toMatch(/\bctx\./)
    }
  })

  test('the briefing renders with the console\'s own classes, not a second skin', () => {
    // The user rejected a briefing that carried its own vocabulary and its own
    // white gradients: next to the console it read as a different app, and the
    // theme's glass never reached it. Now the page shares the console's token
    // block and its component classes; only layout it owns is named `.bq-`.
    const page = code('ButlerPage.tsx')
    const styles = code('panel-styles.ts')
    for (const shared of ['className="bp-head"', 'className="bp-tile', 'className="bp-btn', 'className="bp-chip', 'className="bp-dot"', 'className="bp-note"']) {
      expect(page).toContain(shared)
    }
    // The tokens are declared once and cover both shells.
    expect(styles).toContain('.bp-console,\n.bq-brief {')
    // And no second stylesheet exists to drift.
    expect(() => code('briefing-styles.ts')).toThrow()
  })

  test('every registration is wrapped in ctx.effect for HMR and teardown', () => {
    // Counting effects against registrations is not enough — a registration can
    // escape its effect while the totals still match. Assert the wrapping at
    // each call site instead.
    const sites = [...index.matchAll(/ctx\.(slots\.inject|sidebarRightTabs\.register)\(/g)]
    // One entry: rail row + page + tab body + tab title + the type, plus the
    // frame-wide run-attention overlay.
    expect(sites.length).toBe(6)
    for (const site of sites) {
      const before = index.slice(Math.max(0, site.index - 24), site.index)
      expect(before).toContain('ctx.effect(() => ')
    }
  })

  test('run attention routes by where the owner is and never raises the window', () => {
    const attention = code('RunAttention.tsx') + code('run-attention.ts')
    // No window raising, no forced focus: the Host's system notification is the
    // only out-of-app signal; in-app routing waits for the window to be focused.
    expect(attention).not.toMatch(/window\.focus\(|\.activate\(|open -a/)
    expect(attention).toContain('document.hasFocus()')
    // Optional services, read lazily, never added to `inject`.
    expect(index).toContain("optional(ctx, 'layout')")
    expect(index).toContain("optional(ctx, 'sidebarRight')")
    expect(index).not.toMatch(/inject = \[[^\]]*'(layout|sidebarRight)'/)
    // 工作流 is the first section of the console, ahead of services and tools.
    const body = code('ConsoleBody.tsx')
    expect(body.indexOf('<RunsSection')).toBeGreaterThan(0)
    expect(body.indexOf('<RunsSection')).toBeLessThan(body.indexOf('title={t(\'console.services\')}'))
  })

  test('the browser half calls same-origin paths only', () => {
    // A real boot taught this one: the Dashboard answers 200 over loopback but
    // sends no Access-Control-Allow-Origin, so a direct cross-port fetch is
    // discarded by the browser and the panel silently renders `offline`. curl
    // cannot see it. Data goes through the Host proxy instead.
    for (const file of ['butler-source.ts', 'operations-source.ts']) {
      const source = code(file)
      expect(source).not.toMatch(/https?:\/\//)
      expect(source).toContain("import { base } from './base.ts'")
    }
  })

  test('the proxy forwards an allowlist, not whatever the page asks for', () => {
    // The browser half supplies a kind, an id and a verb. Composing a
    // Dashboard path out of those without a table would let the page reach
    // every /api route the Dashboard exposes.
    // Prototype keys are not entries, at *both* levels: the kind is looked up
    // in OPERATIONS and the verb in that kind's own actions object, and a bare
    // `in` or member access at either level would resolve `constructor` to a
    // truthy rule and forward a path built from it.
    expect(host).toContain("inject = ['webServer', 'subprocess']")
    expect(host).toContain("path: ASSET_PATH")
    expect(host).not.toContain('forward(')
  })

  test('an action that takes an argument is not interchangeable with one that does not', () => {
    // `tools/<id>/actions/<index>` is the only four-segment shape. Accepting a
    // stray fourth segment on a lifecycle verb, or dropping the index from an
    // indexed action, both compose a Dashboard path that is not the one the
    // page meant — and a 404 from that is indistinguishable from a dead tool.
    expect(host).toContain('mountButler')
    expect(host).toContain('workdir')
    // The index must be literal digits. `Number()` would accept '1e3' and
    // '0x2', which are not the index any row rendered.
  })

  test('the console renders tools from the overview, not from the public catalogue', () => {
    // `/api/operations` strips `panelUrl` and every action URL. A source that
    // reads only it produces rows that look complete and are not: the tool is
    // listed, it can be started, and its settings page is unreachable. Assert
    // both routes are read and that tools come from the richer one.
    const source = code('operations-source.ts')
    expect(source).toContain('`${base()}/operations`')
    expect(source).toContain('`${base()}/overview`')
    expect(source).toContain('overview?.tools')
    expect(source).toContain('item?.panelUrl')
    expect(source).toContain('normalizePanelSize(item?.panelSize)')
  })

  test('the two reads land in one snapshot', () => {
    // Sequential awaits would let services come from one tick and tools from
    // the next, so a row could show a state its sibling had already left.
    const source = code('operations-source.ts')
    expect(source).toContain('Promise.all(')
    // The stored order rides in the same `Promise.all` and is folded in by the
    // same `normalize` call, so a card cannot be drawn in one order and
    // re-ordered by the next tick.
    expect(source).toContain('await Promise.all([listing.json(), overview.json()])')
    expect(source).toContain('normalize(raw, details, layout)')
  })

  test('a tool quick action is sent by index, never by URL', () => {
    // The Dashboard resolves the index against its own manifest and refuses
    // any target that is not loopback HTTP. Posting `action.url` from the page
    // would move that decision into the browser.
    const source = code('operations-source.ts')
    expect(source).toMatch(/\/actions\/\$\{index\}/)
    expect(source).not.toMatch(/body: JSON\.stringify\(\{[^}]*url/)
  })

  test('the three action modes stay three different behaviours', () => {
    // `external` opens a tab, `panel` opens the embedded frame, `post` runs.
    // Collapsing any pair turns an action meant to open a page into one that
    // POSTs to it, or the reverse.
    const body = code('ConsoleBody.tsx')
    expect(body).toContain("action.mode === 'external'")
    expect(body).toContain("action.mode === 'panel'")
    expect(body).toContain('runToolAction(tool.id, action.index)')
    // An opened tab must not keep a handle back to this page.
    expect(body).toContain("'noopener,noreferrer'")
  })

  test('the embedded panel is the only iframe, and it is for pages we do not own', () => {
    // The migration rule: what belonged to the Dashboard gets rewritten, what
    // the Dashboard merely referenced stays referenced. A second iframe
    // appearing here means something that should have been rewritten was
    // embedded instead.
    const panel = code('PanelModal.tsx')
    expect(panel).toContain('<iframe')
    expect((code('ConsoleBody.tsx').match(/<iframe/g) ?? []).length).toBe(0)
    // Theme must be passed through or a dark host opens a white rectangle.
    expect(panel).toContain("'theme='")
  })

  test('the panel chrome reads DSH theme tokens, not invented ones', () => {
    // `--ds-bg` never existed upstream: the old overlay choice also put the
    // title bar on a raised blue surface while the tool page used its base
    // surface, making the two halves look like separate windows.
    // The tokens we now read are the ones the DSH base stylesheet redefines
    // under body[data-ds-dark-theme], and the attribute the ThemePresenter
    // actually stamps. A rename upstream turns the upstream-half test below
    // red; this half pins our side to reading them.
    const panel = code('PanelModal.tsx')
    expect(panel).not.toContain('--ds-bg')
    expect(panel).toContain('function panelPalette(theme)')
    expect(panel).toContain("surface: '#111318'")
    expect(panel).toContain("surface: '#ffffff'")
    expect(panel).toContain('background: palette.surface')
    expect(panel).toContain('borderBottom: `1px solid ${palette.line}`')
    expect(panel).not.toContain("background: '#fff'")
    expect(panel).not.toContain('var(--dsw-alias-bg-overlay,')
    expect(panel).toContain('data-ds-dark-theme')
    // The frame only learns the theme from its URL, so a flip while open must
    // reload it — the observer and the theme-keyed remount are what make the
    // bar and the page agree.
    expect(panel).toContain('MutationObserver')
    expect(panel).toContain("'data-ds-dark-theme', 'style', 'class'")
    expect(panel).toContain('document.documentElement')
    expect(panel).toContain("panel.url + ':' + theme")
  })

  test('workflows are observed, never launched from a hard-coded catalogue', () => {
    // The console used to list a built-in "workspace health scan" workflow
    // with a Run button. Workflows are traces of SDK runner work started by
    // tools, CLIs or automations; the console only watches them.
    const source = code('operations-source.ts')
    expect(source).not.toContain('/operations/workflows')
    expect(source).not.toContain('workflows')
    const runs = code('runs-source.ts')
    expect(runs).toContain('`${base()}/runs/stream`')
    expect(runs).toContain("addEventListener('run'")
    expect(runs).toContain("addEventListener('drop'")
    expect(host).not.toContain('capabilityId:')
  })

  test('the console surfaces the Dashboard refusal instead of a status code', () => {
    // 409s here carry the whole point: needs confirmation, no executor wired,
    // capability drifted. Flattening them to "failed" throws away the answer.
    //
    // Count, do not merely contain. There are two callers, and degrading one
    // of them back to `HTTP ${status}` left a bare toContain perfectly green
    // because the other still mentioned reasonOf.
    const source = code('operations-source.ts')
    const failures = source.match(/if \(!response\.ok\) return \{ ok: false, reason: ([^}]+) \}/g) ?? []
    expect(failures.length).toBeGreaterThanOrEqual(2)
    for (const line of failures) expect(line).toContain('await reasonOf(response)')
    expect(source).toContain('error?.message')
    expect(code('ConsoleBody.tsx')).toContain('note.reason')
  })

  test('the Host half owns the Dashboard address and proxies it', () => {
    expect(host).toContain('mountButler')
    expect(host).toContain('ctx.webServer.register')
    expect(host).toContain("inject = ['webServer', 'subprocess']")
  })

  test('the rail selection fix is scoped, disposable, and specificity-free', () => {
    const rule = code('no-select.ts')
    // Upstream's own class name is a build artefact (`hHd-Xa_panelRow`) and
    // will change without notice; the rail's semantics will not.
    expect(rule).toContain('nav[aria-label] button')
    expect(rule).not.toMatch(/panelRow|_panelActive/)
    // `:where()` keeps specificity at zero, so anything upstream sets wins.
    expect(rule).toContain(':where(')
    // It must come back off: registered through ctx.effect, and the installer
    // has to hand back a disposer for that to mean anything. The listener is
    // generation-safe so an old HMR disposer cannot remove a newer rule.
    expect(rule).toContain('return () => {')
    expect(rule).toContain('live?.dataset.owner === token')
    expect(rule).toContain("document.addEventListener('selectstart', stopSelection, true)")
    expect(rule).toContain("event.preventDefault()")
    expect(rule).toContain('removeAllRanges()')
    expect(index).toContain('ctx.effect(() => installNoSelectRule()')
  })

  test('no registered path ends in a slash', () => {
    // A trailing slash on a prefix route is silent death: it registers fine
    // and then matches nothing, because the Host appends the separator itself.
    // Every myspace-butler path literal in the file, however it is written:
    // an object key, a `path:` value, or a hoisted constant.
    const paths = [...host.matchAll(/'(\/myspace-butler[^']*)'/g)].map(m => m[1])
    expect(paths.length).toBeGreaterThanOrEqual(1)
    for (const path of paths) expect(path.endsWith('/')).toBe(false)
  })
})

describe('bundle protocol', () => {
  const BUNDLE = join(import.meta.dir, 'dsh/client.js')
  const bundle = readFileSync(BUNDLE, 'utf8')

  test('the client bundle announces itself to the module loader', () => {
    // DSH concatenates every client into one combo response. A plain ESM
    // bundle does not just fail on its own — it takes the whole roster down
    // with "loaded without registering ... via __ModuleLoader__.load", which
    // reads as an unrelated package failing.
    expect(bundle).toContain('window.__ModuleLoader__.load({')
    expect(bundle).toContain("id: 'dsh-butler'")
    expect(bundle).toContain('factory: (require) =>')
  })

  test('no ESM syntax survives inside the CJS factory', () => {
    expect(bundle).not.toMatch(/^\s*import\s/m)
    expect(bundle).not.toMatch(/\bexport\s*[{*]/)
    expect(bundle).not.toMatch(/\bexport\s+default\b/)
  })

  test('peers are reached through the loader require, in production form', () => {
    expect(bundle).toContain('require("react/jsx-runtime")')
    // The dev runtime is not in the loader's roster; requiring it fails only
    // once a browser actually boots the plugin.
    expect(bundle).not.toContain('jsx-dev-runtime')
  })

  test('the factory returns the cordis plugin exports', () => {
    expect(bundle).toContain('exports.apply =')
    expect(bundle).toContain('exports.inject =')
    expect(bundle).toContain('return module.exports')
  })

  test('the shipped bundle parses as JavaScript', () => {
    // Every other test in this block is a pattern match over text, and a
    // pattern match cannot distinguish a rewritten binding from a
    // half-rewritten one. `const {jsx as $}` — the ESM `as` left standing
    // because the rewrite matched identifiers with `\w`, which excludes `$` —
    // passed all of them and reached a browser as "Failed to load plugins",
    // blaming @deepseek-ai/dsh-client-hmr. Parsing does not care how the
    // text got there.
    // Explicitly node: under `bun test`, process.execPath is bun, which has
    // no --check and would exit 0 on anything.
    const checked = spawnSync(NODE, ['--check', BUNDLE], { encoding: 'utf8' })
    expect(checked.stderr).toBe('')
    expect(checked.status).toBe(0)
  })

  test('the build refuses to ship a bundle that does not parse', () => {
    // The assertion above only holds for the artefact currently on disk. This
    // one keeps the gate in the build, so the next bundle cannot skip it.
    const build = readFileSync(join(import.meta.dir, 'build.py'), 'utf8')
    expect(build).toContain("'--check'")
    expect(build).toContain('parses(OUT)')
  })

  test('the import rewrite accepts minified identifiers', () => {
    // Minifiers name things `$` and `_`, neither of which is in `\w`.
    const build = readFileSync(join(import.meta.dir, 'build.py'), 'utf8')
    expect(build).toContain("IDENT = r'[A-Za-z_$][A-Za-z0-9_$]*'")
    expect(build).not.toMatch(/\(\\w\+\)\\s\+as\\s\+\(\\w\+\)/)
    // ...and the artefact shows the rewrite actually landed.
    expect(bundle).not.toMatch(/\bconst\s*\{[^}]*\bas\b/)
  })
})

/**
 * The half that actually guards against upstream drift.
 *
 * Everything above proves our source says what we meant. These read the
 * installed packages: if an upgrade renames a slot, drops a priority tier, or
 * changes which fields a definition carries, they go red and name the file.
 */
describe.skipIf(!installed)('upstream seams, as installed', () => {
  test('subprocess retains fully specified spawn and managed-range teardown', () => {
    const service = upstream('dsh-subprocess/lib/types/index.d.ts')
    const types = upstream('dsh-subprocess/lib/types/types.d.ts')
    expect(service).toContain('subprocess: SubprocessRuntime;')
    expect(service).toContain('abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle;')
    for (const field of ['argv: readonly string[];', 'cwd: string;', 'stdio: SubprocessStdio;', 'graceMs: number;']) {
      expect(types).toContain(field)
    }
    expect(types).toContain('readonly done: Promise<SubprocessOutcome>;')
    expect(types).toContain('terminate(): void;')
    expect(types).toContain('waitForExit(signal?: AbortSignal): Promise<boolean>;')
    const entry = readFileSync(join(import.meta.dir, 'src/host/entry.ts'), 'utf8')
    expect(entry).toContain('createSubprocessSpawner(ctx.subprocess)')
    expect(entry).toContain('await hosting.shutdown()')
    const hosting = readFileSync(join(import.meta.dir, 'src/host/hosting.ts'), 'utf8')
    expect(hosting).not.toMatch(/from ['"]node:child_process['"]/)
    expect(hosting).not.toContain('createNodeSpawner')
  })
  test('ui-sidebar still consumes a sidebar.panellist list', () => {
    const sidebar = upstream('dsh-client-ui-sidebar/lib/client.js')
    expect(sidebar).toContain('entriesOfSlot("sidebar.panellist")')
    expect(sidebar).toContain('ctx.slots.subscribe("sidebar.panellist"')
  })

  test('ui-sidebar still reads id/order/label off each entry', () => {
    const sidebar = upstream('dsh-client-ui-sidebar/lib/client.js')
    const sync = sidebar.slice(sidebar.indexOf('entriesOfSlot("sidebar.panellist")'))
    const body = sync.slice(0, sync.indexOf('.sort('))
    expect(body).toContain('options.id')
    expect(body).toContain('options.order')
    expect(body).toContain('options.label')
  })

  test('ui-layout still keys the main slot by the active panel id', () => {
    const layout = upstream('dsh-client-ui-layout/lib/client.js')
    // The one line that makes an entry id and a page key the same thing.
    expect(layout).toContain('renderSlot("main", {}, { entryKey:')
    expect(layout).toContain('info.activePanelId')
  })

  test('selectPanel still validates against registered main keys', () => {
    const layout = upstream('dsh-client-ui-layout/lib/client.js')
    expect(layout).toContain('ctx.slots.entries("main").some((entry) => entry.options.key === id)')
    expect(layout).toContain('is not registered')
  })

  test('conversation is still the reserved main key we must not take', () => {
    const conversation = upstream('dsh-client-ui-conversation/lib/client.js')
    expect(conversation).toContain('key: "conversation"')
  })

  test('sidebarRightTabs is still provided under that service name', () => {
    const right = upstream('dsh-client-ui-sidebar-right/lib/client.js')
    expect(right).toContain('ctx.reflect.provide("sidebarRightTabs"')
  })

  test("extension is still a priority band, and the registry's default", () => {
    const types = upstream('dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts')
    expect(types).toContain("export type SidebarRightTabPriority = 'extension' | 'builtin' | 'fallback'")
    const right = upstream('dsh-client-ui-sidebar-right/lib/client.js')
    expect(right).toContain('definition.priority ?? DEFAULT_BAND')
  })

  test('we register no field the tab definition does not declare', () => {
    const types = upstream('dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts')
    const decl = types.slice(types.indexOf('interface SidebarRightTabDefinition'))
    const known = new Set(
      [...decl.slice(0, decl.indexOf('\n}')).matchAll(/readonly (\w+)\??:/g)].map(m => m[1]),
    )
    // Fields our registration passes to sidebarRightTabs.register.
    for (const field of ['id', 'kind', 'priority', 'title', 'guide']) {
      expect(known.has(field)).toBe(true)
    }
    // A field the registry never reads is silently dropped — catch it here
    // rather than wondering why the tab does not behave as written.
    expect(known.has('keepMounted')).toBe(false)
    expect(index).not.toContain('keepMounted')
  })

  test('guide entries carry order/title/description and no id of their own', () => {
    const types = upstream('dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts')
    const decl = types.slice(types.indexOf('interface SidebarRightGuideEntry'))
    const fields = new Set(
      [...decl.slice(0, decl.indexOf('\n}')).matchAll(/readonly (\w+)\??:/g)].map(m => m[1]),
    )
    expect([...fields].sort()).toEqual(['description', 'icon', 'order', 'title'])
    const guide = index.slice(index.indexOf('guide: [{'))
    expect(guide.slice(0, guide.indexOf('}]'))).not.toMatch(/\bid:/)
  })

  test('the keyed tab seats still exist under the names we register', () => {
    const contract = upstream('dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts')
    for (const seat of ["'sidebar.right.pane.tab'", "'sidebar.right.pane.tab.title'"]) {
      expect(contract).toContain(`${seat}: {`)
    }
    expect(contract).toContain("kind: 'keyed'")
  })

  test('our registration shape matches the shipped ui-sidebar-files example', () => {
    const files = upstream('dsh-client-ui-sidebar-files/lib/client.js')
    // The official out-of-the-box precedent for seam 3: effect-wrapped,
    // slots.inject outside, key bound to the definition id.
    expect(files).toContain('ctx.effect(() => ctx.sidebarRightTabs.register(')
    expect(files).toContain('ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab"')
    expect(files).toContain('"slots"')
    expect(files).toContain('"sidebarRightTabs"')
  })

  test('the theme tokens and palette attribute our panel chrome reads still exist', () => {
    // The overlay reads --dsw-alias-* variables and the data-ds-dark-theme
    // attribute. Both are upstream surface area: the base stylesheet defines
    // the tokens per palette, the ui-layout ThemePresenter stamps the
    // attribute. If a refactor renames either, our bar silently goes white in
    // dark mode again — exactly the bug these tokens fixed.
    //
    // Assert per-palette *definitions* (token + colon inside the alias block),
    // not mere mentions: a token renamed in one palette still appears in the
    // other, and a whole-file toContain stays falsely green.
    const theme = upstream('dsh-client-ui-theme/lib/client.js')
    const TOKENS = [
      '--dsw-alias-bg-base:',
      '--dsw-alias-bg-overlay:',
      '--dsw-alias-label-primary:',
      '--dsw-alias-label-secondary:',
    ]
    const darkOpen = 'body[data-ds-dark-theme]{--dsw-alias-bg-base'
    const darkBlock = theme.slice(theme.indexOf(darkOpen), theme.indexOf('}', theme.indexOf(darkOpen)))
    const lightOpen = 'body{--dsw-alias-bg-base'
    const lightBlock = theme.slice(theme.indexOf(lightOpen), theme.indexOf('}', theme.indexOf(lightOpen)))
    for (const token of TOKENS) {
      expect(darkBlock).toContain(token)
      expect(lightBlock).toContain(token)
    }
    const layout = upstream('dsh-client-ui-layout/lib/client.js')
    expect(layout).toContain('DARK_ATTRIBUTE = "data-ds-dark-theme"')
    expect(layout).toContain('body.setAttribute(DARK_ATTRIBUTE')
  })

  test('the loader still uses the lazy-CJS bundle protocol we emit', () => {
    // Our envelope is hand-written, so the shape must be checked against a
    // shipped bundle rather than assumed.
    const shipped = upstream('dsh-client-ui-sidebar-files/lib/client.js')
    expect(shipped).toContain('window.__ModuleLoader__.load({')
    expect(shipped).toContain('factory: (require) =>')
    expect(shipped).toContain('return module.exports;')
    expect(shipped).toContain('require("react/jsx-runtime")')
  })

  test('no shipped package occupies the sidebar.panellist rail', () => {
    // The rail is empty by design — the seam is genuinely ours. If an upgrade
    // ships a panel, our order: 5 suddenly competes and this says so.
    const sidebar = upstream('dsh-client-ui-sidebar/lib/client.js')
    expect(sidebar).not.toContain('name: "sidebar.panellist"')
  })

  test('panel rows are still text-selectable upstream, so our rule is still needed', () => {
    // The whole reason no-select.ts exists. If upstream adds the property to
    // their own panelRow, this goes red and the right response is to delete
    // our rule rather than keep two owners of the same declaration.
    const sidebar = upstream('dsh-client-ui-sidebar/lib/client.js')
    const row = sidebar.slice(sidebar.indexOf('panelRow{'))
    expect(row.slice(0, row.indexOf('}'))).not.toContain('user-select')
  })

  test('the rail is still a labelled nav containing the panel buttons', () => {
    // Our selector targets the rail's structure, not its class names. That is
    // only safe while the structure is what we think it is.
    const sidebar = upstream('dsh-client-ui-sidebar/lib/client.js')
    expect(sidebar).toContain('"nav"')
    expect(sidebar).toMatch(/"aria-label":\s*t\(/)
  })

  test('a prefix route still matches the path itself and path/<rest>, nothing else', () => {
    // The rule that made a trailing slash fatal: the Host compares against `p`
    // and `p/`, so a registered prefix ending in "/" can only ever match a
    // doubled slash. It does not throw — the route simply never fires and the
    // request falls through to the SPA's 404.
    const server = upstream('dsh-host-webserver/lib/index.js')
    const match = server.slice(server.indexOf('match(pathname)'))
    expect(match.slice(0, match.indexOf('return best'))).toContain(
      'pathname !== prefix && !pathname.startsWith(`${prefix}/`)',
    )
  })

  test('exact routes are consulted before prefix routes', () => {
    // Why our listing route and run route may share a path.
    const server = upstream('dsh-host-webserver/lib/index.js')
    const match = server.slice(server.indexOf('match(pathname)'))
    const head = match.slice(0, match.indexOf('for (const'))
    expect(head).toContain('this.exact.get(pathname)')
  })

  test('exact and prefix are separate tables, so sharing a path is legal', () => {
    const server = upstream('dsh-host-webserver/lib/index.js')
    const register = server.slice(server.indexOf('register(route) {'))
    const body = register.slice(0, register.indexOf('return () =>'))
    // Collision is per-table. Were it global, our shared path would throw at
    // boot instead of composing.
    expect(body).toContain('route.kind === "exact" ? this.exact : this.prefixes')
    expect(body).toContain('table.has(route.path)')
  })

  test('a route carries kind/path/handler and no name of its own', () => {
    // We were passing `name:` — accepted silently, read by nobody.
    const types = upstream('dsh-host-webserver/lib/types/index.d.ts')
    const decl = types.slice(types.indexOf('interface WebRoute {'))
    const fields = new Set(
      [...decl.slice(0, decl.indexOf('\n}')).matchAll(/^\s{4}(\w+)\??:/gm)].map(m => m[1]),
    )
    expect([...fields].sort()).toEqual(['handler', 'kind', 'path'])
    // Scoped to the registration literals: a `name` elsewhere in the file is
    // ordinary data (the runtime report carries one), and a blanket ban on the
    // word made an unrelated payload field fail this seam check.
    for (const [, literal] of host.matchAll(/ctx\.webServer\.register\(\{([\s\S]*?)\n\s*\}\)/g)) {
      expect(literal).not.toMatch(/^\s*name:/m)
    }
  })
})

// Router behavior is executed in tests/routes.test.ts (no retired skips).

/**
 * The card order, executed rather than read.
 *
 * Ordering is the one part of this console whose bugs are invisible in a
 * screenshot: a card lands one slot off, the catalogue gains a capability and
 * it never appears, a malformed file takes the page down. All three are
 * decided by four pure functions, so they are tested as functions.
 */
describe('card order — the rules, executed', () => {
  /** A catalogue section, in the order the guardian reported it. */
  const section = (...names: string[]) => names.map(name => ({ id: name, name }))

  test('a stored order is a hint: unknown ids are dropped, new items are kept', () => {
    const items = section('a', 'b', 'c', 'd')
    // `gone` was stored, `d` was added after the file was written.
    expect(orderedItems(items, ['c', 'gone', 'a']).map(i => i.id)).toEqual(['c', 'a', 'b', 'd'])
    // Nothing stored: the catalogue's own order stands, untouched.
    expect(orderedItems(items, []).map(i => i.id)).toEqual(['a', 'b', 'c', 'd'])
    // The input is not mutated — the snapshot's array is handed straight in.
    const original = section('a', 'b')
    orderedItems(original, ['b', 'a'])
    expect(original.map(i => i.id)).toEqual(['a', 'b'])
  })

  test('an unlisted capability keeps its place relative to the others', () => {
    // Stable partition, not a sort: the tail keeps catalogue order, which is
    // registration order and therefore the only fallback the owner has.
    const items = section('a', 'b', 'c', 'd', 'e')
    expect(orderedItems(items, ['e']).map(i => i.id)).toEqual(['e', 'a', 'b', 'c', 'd'])
  })

  test('a boundary is not an index, and the difference is the whole drag', () => {
    const order = ['a', 'b', 'c', 'd']
    // Dragged `a` past `c`: the pointer sat on the boundary before `d`.
    expect(moveWithin(order, 'a', 3)).toEqual(['b', 'c', 'a', 'd'])
    // Dragged `d` back to the boundary before `b`.
    expect(moveWithin(order, 'd', 1)).toEqual(['a', 'd', 'b', 'c'])
    // A boundary past the end lands at the end, not out of range.
    expect(moveWithin(order, 'a', 99)).toEqual(['b', 'c', 'd', 'a'])
    // A boundary before the start lands at the start.
    expect(moveWithin(order, 'd', -5)).toEqual(['d', 'a', 'b', 'c'])
  })

  test('a drag that changes nothing does not write', () => {
    const order = ['a', 'b', 'c']
    // Released on its own card, or one slot to its right, which is the same
    // position. Returning the same array — identity, not equality — is what
    // lets the source skip a pointless round trip.
    expect(moveWithin(order, 'b', 1)).toBe(order)
    expect(moveWithin(order, 'b', 2)).toBe(order)
    expect(moveWithin(order, 'b', 0)).not.toBe(order)
    // An id that is not in the section is not a move.
    expect(moveWithin(order, 'zzz', 0)).toBe(order)
  })

  test('the drag boundary and the array index are converted in one place', () => {
    // Two conversions of the same convention is how a card comes to land one
    // slot off. The renderer reports boundaries; only this module indexes.
    const order = ['a', 'b', 'c', 'd', 'e']
    for (const id of order) {
      for (let boundary = 0; boundary <= order.length; boundary += 1) {
        const next = moveWithin(order, id, boundary)
        expect([...next].sort()).toEqual([...order].sort())
        // Wherever it landed, the card is at the boundary it was dropped on —
        // except at the end, where the boundary is past the last slot.
        const landed = next.indexOf(id)
        expect(landed).toBe(Math.min(boundary > order.indexOf(id) ? boundary - 1 : boundary, order.length - 1))
      }
    }
  })

  test('a layout with no preference in it is not a layout with an empty list', () => {
    // Both render identically; only one is a document that says "the owner has
    // no opinion", and that is what makes the reset action a real reset.
    const one = withSectionOrder(emptyLayout(), 'tools', ['a', 'b'])
    expect(hasCustomOrder(one)).toBe(true)
    const reset = withSectionOrder(one, 'tools', [])
    expect(hasCustomOrder(reset)).toBe(false)
    expect(reset.order).toEqual({})
    // The input is untouched, so an optimistic update can keep the previous
    // layout to revert to.
    expect(one.order.tools).toEqual(['a', 'b'])
  })

  test('a malformed document reads as no order, never as a broken console', () => {
    for (const junk of [null, undefined, 7, 'tools', [], {}, { version: 2, order: {} },
      { version: LAYOUT_VERSION }, { version: LAYOUT_VERSION, order: [] },
      { version: LAYOUT_VERSION, order: { nope: ['a'] } },
      { version: LAYOUT_VERSION, order: { tools: 'a' } },
      { version: LAYOUT_VERSION, order: { tools: [1, 2] } },
      { version: LAYOUT_VERSION, order: { tools: [''] } }]) {
      expect(readLayout(junk)).toEqual(emptyLayout())
    }
  })

  test('a valid document is narrowed rather than trusted', () => {
    // Duplicates make the order depend on which copy the reader keeps, so the
    // later one goes; an id past the cap is dropped; a legal section survives.
    const read = readLayout({
      version: LAYOUT_VERSION,
      order: {
        tools: ['a', 'a', 'b', 'x'.repeat(MAX_ID_LENGTH + 1)],
        services: ['s1'],
        // Unknown sections are not carried into the snapshot at all.
        ghost: ['g'],
      },
    })
    expect(read.order.tools).toEqual(['a', 'b'])
    expect(read.order.services).toEqual(['s1'])
    expect(read.order.ghost).toBeUndefined()
    // An over-long section is truncated, not rejected: the owner loses the
    // tail of a preference rather than the whole order.
    const long = readLayout({
      version: LAYOUT_VERSION,
      order: { tools: Array.from({ length: MAX_IDS_PER_SECTION + 5 }, (_, i) => `t${i}`) },
    })
    expect(long.order.tools).toHaveLength(MAX_IDS_PER_SECTION)
  })

  test('the stored order is versioned, so a shape change is detected', () => {
    // A document from another shape is discarded whole: that costs an
    // ordering, which is recoverable, and never costs a wrong rendering.
    expect(emptyLayout()).toEqual({ version: LAYOUT_VERSION, order: {} })
    expect(readLayout({ version: LAYOUT_VERSION + 1, order: {} })).toEqual(emptyLayout())
  })
})

/**
 * Two halves, one convention.
 *
 * The Host validates and stores what the browser sends. They cannot share a
 * module — the installed package ships only `dsh/` — so the only defence
 * against drift is asserting the two copies against each other rather than
 * each against itself.
 */
describe('card order — the two halves agree', () => {
  /**
   * Parse a `const NAME = [ ... ]` list of single-quoted strings out of the Host.
   * @param name - the constant's name.
   * @returns its members.
   */
  const hostList = (name: string) => {
    const found = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(host)
    expect(found).not.toBeNull()
    return found![1].split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean)
  }

  /**
   * Parse a `const NAME = <digits>` number out of the Host.
   * @param name - the constant's name.
   * @returns its value.
   */
  const hostNumber = (name: string) => {
    const found = new RegExp(`const ${name} = (\\d+)`).exec(host)
    expect(found).not.toBeNull()
    return Number(found![1])
  }

  test('both halves order the same sections', () => {
    expect([...HOST_LAYOUT_SECTIONS]).toEqual([...LAYOUT_SECTIONS])
    expect(HOST_LAYOUT_VERSION).toBe(LAYOUT_VERSION)
  })

  test('both halves cap a stored layout the same way', () => {
    expect(HOST_MAX_IDS_PER_SECTION).toBe(MAX_IDS_PER_SECTION)
    expect(HOST_MAX_ID_LENGTH).toBe(MAX_ID_LENGTH)
  })

  test('the largest legal layout still fits the body the Host accepts', () => {
    // A cap larger than the body limit is a write the Host rejects for a
    // reason the browser cannot explain. Each id costs its length plus the
    // quotes and comma around it.
    expect(HOST_MAX_BODY_BYTES).toBe(32 * 1024)
    const worst = LAYOUT_SECTIONS.length * MAX_IDS_PER_SECTION * (MAX_ID_LENGTH + 3) * 2 + 256
    expect(worst).toBeLessThan(HOST_MAX_BODY_BYTES)
  })

  test('the console renders exactly the sections the store will accept', () => {
    // The other end of the same rule: a card in a section the store does not
    // know is a drag that 400s, and the failure looks like a broken grip.
    const console_ = code('ConsoleBody.tsx')
    for (const section of LAYOUT_SECTIONS) expect(console_).toContain(`section="${section}"`)
  })

  test('the order is answered locally and never forwarded', () => {
    // It is this panel's preference; the Butler Host keeps it alongside the
    // configured state directory, and the proxy's allowlist is closed.
    expect(host).not.toContain("path: '/myspace-butler/layout'")
    expect(host).toContain('await mountButler(ctx, config)')
  })

  test('the route is mounted inside the Butler Host and handles GET and PUT only', () => {
    expect(readFileSync(join(import.meta.dir, 'src/host/routes.ts'), 'utf8')).toContain("if (pathname === '/layout')")
    const layout = readFileSync(join(import.meta.dir, 'src/host/layout.ts'), 'utf8')
    expect(layout).toContain('createLayoutHandler')
    expect(layout).toContain('methodNotAllowed(response, [\'GET\', \'PUT\'])')
  })

  test('a write is atomic, and a corrupt file is reported rather than swallowed', () => {
    // The console polls this file. Truncating it in place would let a poll read
    // half a layout; malformed data must be reported rather than read as empty.
    const layout = readFileSync(join(import.meta.dir, 'src/host/layout.ts'), 'utf8')
    expect(layout).toMatch(/writeFile\(temp[\s\S]{0,160}rename\(temp, layoutFile\)/)
    expect(layout).toContain('layout.json is not JSON')
    expect(layout).toContain("code === 'ENOENT'")
  })

  test('the preference follows the configured Butler state directory', () => {
    expect(readFileSync(join(import.meta.dir, 'src/host/routes.ts'), 'utf8')).toContain('createLayoutHandler(config.stateDir)')
    expect(host).not.toContain('BUTLER_PANEL_STATE_DIR')
    expect(host).not.toContain("myspace-butler-panel')")
  })
})

/**
 * The console's data path for ordering.
 */
describe('card order — how the console stores and applies it', () => {
  const source = code('operations-source.ts')

  test('the order is read same-origin, alongside the catalogue', () => {
    expect(source).toContain('`${base()}/layout`')
    expect(source).toMatch(/method: 'PUT'/)
    // The order rides in the same Promise.all as the two catalogue reads.
    expect(source).toMatch(/fetchOrder\(\),/)
  })

  test('a missing or unreadable order is not an offline console', () => {
    // The one failure this surface can afford least is showing nothing because
    // a preference could not be read.
    const order = source.slice(source.indexOf('async function fetchOrder'), source.indexOf('export function createOperationsSource'))
    expect(order).toContain('return { ok: false, reason:')
    expect(order).not.toContain('throw')
    // And the catch that would mark the whole snapshot offline is around the
    // catalogue only.
    expect(source).toContain('if (writing === 0 && revision === layoutRevision)')
  })

  test('a move lands on screen before the write is queued', () => {
    const move = source.slice(source.indexOf('const move = ('), source.indexOf('const reset ='))
    // Both halves of the claim, because `indexOf` on a missing anchor is -1 and
    // a deleted optimistic write would otherwise compare as "earlier".
    expect(move).toContain('snapshot = {')
    expect(move).toContain('return push(')
    expect(move.indexOf('snapshot = {')).toBeLessThan(move.indexOf('return push('))
    // ...and a boundary is passed straight through: the conversion to an array
    // index happens inside `moveWithin` and nowhere else.
    expect(source).toContain('moveWithin(ids, id, boundary)')
    expect(move).not.toContain('indexOf')
  })

  test('a refused write puts the order back and says why', () => {
    const push = source.slice(source.indexOf('const push = ('), source.indexOf('const move = ('))
    expect(push).toMatch(/catch \(error\)[\s\S]*?layout: revertTo, layoutError:/)
  })

  test('writes are serialised and a poll during one keeps the optimistic order', () => {
    // Two arrow presses in quick succession must not race the same file, and a
    // poll that lands mid-write must not fold the previous order back in — the
    // card would jump back and then forward, which reads as "it did not take".
    expect(source).toContain('chain = chain.then(')
    expect(source).toContain('let writing = 0')
    expect(source).toMatch(/finally \{\s*writing -= 1/)
  })
})

/**
 * The redesign, asserted where it can actually regress.
 */
describe('the console redesign', () => {
  const console_ = code('ConsoleBody.tsx')
  const styles = code('panel-styles.ts')
  const drag = code('use-drag-order.ts')

  test('the console renders its cards from the stylesheet, not from inline greys', () => {
    // Measured on the running page, the old card fill resolved to #f5f6fa on a
    // #f6f7fb canvas — one level apart, which is to say no card at all. The
    // literals are gone; if they come back, so does the problem.
    expect(console_).not.toContain('rgba(128,128,128')
    expect(console_).toContain('className="bp-console"')
    expect(styles).toContain('.bp-tile')
  })

  test('state colour comes from the theme, in both themes', () => {
    for (const token of [
      'var(--dsw-alias-state-success-primary)',
      'var(--dsw-alias-state-warn-primary)',
      'var(--dsw-alias-state-error-primary)',
      'var(--dsw-alias-label-caption)',
    ]) expect(styles).toContain(token)
    // Every surface value the sheet introduces has a dark counterpart, or the
    // console keeps its old look the moment the theme flips.
    for (const name of ['--bp-tile-a:', '--bp-tile-b:', '--bp-band:', '--bp-lift:']) {
      expect(styles).toContain(name)
    }
    expect(styles).toContain('body[data-ds-dark-theme] .bp-console,')
    expect(styles).toContain('body[data-ds-dark-theme] .bq-brief {')
    // The sheet is delivered as a template literal, so a backtick anywhere in
    // its body — including inside a /* comment */ — closes it early and turns
    // the rest into a tagged template. That still *parses*, which is why
    // build.py's node --check and the bundle-parse test both stayed green
    // while the installed plugin died on load with "console is not a function".
    //
    // Read the raw file, not `code()`: the helper strips comments, and comments
    // are exactly where a stray backtick hides — and they ship in the sheet.
    const raw = readFileSync(join(UI, 'panel-styles.ts'), 'utf8')
    const open = raw.indexOf('const CSS = `') + 'const CSS = `'.length
    const close = raw.indexOf('\n`', open)
    expect(close).toBeGreaterThan(open)
    expect(raw.slice(open, close)).not.toContain('`')
    // The rules are generated per hue, so they are asserted in the
    // generator's own terms. Checking only for the selector would pass a dark
    // rule that interpolates the *light* colour — two palettes, one used.
    const rules = styles.slice(styles.indexOf('function markRules()'), styles.indexOf('const CSS ='))
    expect(rules).toMatch(/\n\.bp-tile__mark\[data-hue="\$\{index\}"\] \{ background: \$\{fill\(light, [\d.]+\)\}; color: \$\{light\}; \}/)
    expect(rules).toMatch(/\nbody\[data-ds-dark-theme\] \.bp-tile__mark\[data-hue="\$\{index\}"\] \{ background: \$\{fill\(dark, [\d.]+\)\}; color: \$\{dark\}; \}/)
  })

  test('the sheet installs whole, not truncated at a stray backtick', async () => {
    // Compile-time checks cannot see this failure, so install the real sheet
    // into a stub document and read back what a browser would have received.
    // `.bq-jrec__text` lives at the end of the sheet: if the literal closed
    // early, that tail never reaches the style element.
    const { installConsoleStyles } = await import(new URL('./src/ui/panel-styles.ts', import.meta.url).href)
    const installed = []
    const stub = { dataset: {}, id: '', textContent: '', replaceWith() {}, remove() {} }
    const previous = globalThis.document
    globalThis.document = {
      getElementById: () => null,
      createElement: () => stub,
      head: { append: (node) => installed.push(node) },
    }
    try {
      installConsoleStyles()
    } finally {
      if (previous === undefined) delete globalThis.document
      else globalThis.document = previous
    }
    expect(installed).toHaveLength(1)
    const sheet = installed[0].textContent
    for (const marker of ['.bp-console', '.bq-brief', '.bq-jrec__text', '.bq-doc__foot', '.bq-metric:last-child']) {
      expect(sheet).toContain(marker)
    }
    // A truncated template is also a *short* one; the full sheet is ~26 kB.
    expect(sheet.length).toBeGreaterThan(20_000)
  })

  test('the identity palette matches the count the component assumes', () => {
    // A hue index the sheet has no rule for is a card with no mark, silently.
    const start = styles.indexOf('const MARKS = [')
    const marks = styles.slice(start, styles.indexOf('\n]', start))
    const declared = (marks.match(/'#[0-9A-Fa-f]{6}'/g) ?? []).length
    const hues = Number(/const HUES = (\d+)/.exec(console_)![1])
    // Two themes, one colour each, per hue.
    expect(declared).toBe(hues * 2)
    expect(console_).toContain('return hash % HUES')
    // The hue is derived from the id, not from the position: a card that keeps
    // its colour while the catalogue grows is the point of having one.
    expect(console_).toContain('hue={hueOf(tool.id)}')
  })

  test('a component in this package never installs CSS without a disposer', () => {
    expect(styles).toContain("style.dataset.owner = token")
    expect(styles).toContain('if (live?.dataset.owner === token) live.remove()')
    // The plugin installs it once per generation, in an effect, like the rail
    // rule beside it.
    expect(index).toContain('ctx.effect(() => installConsoleStyles()')
  })

  test('reordering is per section, by a grip, and off while filtering', () => {
    // A card's body opens its settings page. Making the same surface start a
    // drag means every click is a race the click loses.
    expect(console_).toContain('className="bp-grip"')
    expect(console_).toContain('aria-label={grip.label}')
    expect(drag).toContain('setPointerCapture')
    // The visible sequence is a projection while a filter is on, so a boundary
    // in it does not name a position in the stored order.
    expect(console_).toContain('const sortable = !filtering')
    expect(console_).toContain('move={sortable && shownServices.length === services.length ? move : null}')
    expect(console_).toContain('move={sortable && shownTools.length === tools.length ? move : null}')
  })

  test('the keyboard path exists, and a cancelled gesture changes nothing', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(drag).toContain(key)
    }
    // Escape, a lost pointer, an unmount: only pointerup commits, and every
    // path clears the document-level drag marker it set.
    expect(drag).toContain("event.key === 'Escape'")
    expect(drag).toContain("event.type === 'pointerup'")
    expect(drag).toContain("document.body.removeAttribute('data-bp-drag')")
    expect(drag).toMatch(/useEffect\(\(\) => end, \[end\]\)/)
  })

  test('the drag is measured in boundaries, in one place', () => {
    expect(drag).toContain('boundaryAt')
    expect(drag).toMatch(/return cards\.length/)
    // The line is drawn from grid-relative geometry, so it survives scrolling
    // and zooming without a second coordinate space.
    expect(drag).toContain('offsetLeft')
    expect(styles).toMatch(/\.bp-grid \{[^}]*position: relative;/)
  })

  test('the header offers a filter and a reset only when one is needed', () => {
    expect(console_).toContain("t('console.filter')")
    expect(console_).toContain("t('console.filterEmpty')")
    // A reset control on a catalogue nobody has reordered is a button that
    // does nothing, so it is gated on there being a stored order.
    expect(console_).toContain('const custom = hasCustomOrder(ordered)')
    expect(console_).toContain('{custom && sortable ? (')
    // ...and on a file the store refuses, so the note in the page has a way
    // out beside it.
    expect(console_).toContain('{layoutError ? (')
  })
})

/**
 * The layout route, executed.
 *
 * The assertions above read the Host half as text, and text cannot tell a
 * rename-based write from a truncating one, or a 400 from a 500. This block
 * loads the Host layout handler against a temporary Butler state directory and
 * calls it directly — so the store is exercised end to end without touching
 * the state of the console anyone is actually using.
 */
describe('the layout route, executed', () => {
  /** The temporary state directory and its Host-owned layout route. */
  let host_: { dir: string, route: (req: any, res: any) => Promise<void> }

  /** Load the route against a temporary Butler state directory. */
  async function load(): Promise<typeof host_> {
    if (host_) return host_
    const dir = mkdtempSync(join(tmpdir(), 'butler-layout-'))
    host_ = { dir, route: createLayoutHandler(dir) as (req: any, res: any) => Promise<void> }
    return host_
  }

  /** A response double that records the status and body it was handed. */
  function response() {
    const seen = { status: 0, body: '', headers: {} as Record<string, string> }
    return {
      seen,
      writeHead(status: number, headers: Record<string, string>) {
        seen.status = status
        seen.headers = headers
      },
      end(text?: string) { seen.body = text ?? '' },
    }
  }

  /**
   * A request double. `readBody` consumes the request as an async iterable of
   * buffers, so that is what this yields.
   * @param method - HTTP method.
   * @param raw - the already-serialised body, when there is one.
   * @returns the request double.
   */
  function request(method: string, raw?: string) {
    const chunks = raw === undefined ? [] : [Buffer.from(raw, 'utf8')]
    return {
      method,
      url: '/myspace-butler/layout',
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    }
  }

  /**
   * Call the route and return what it answered.
   * @param method - HTTP method.
   * @param raw - the serialised body, when there is one.
   * @returns the recorded response.
   */
  async function call(method: string, raw?: string) {
    const { route } = await load()
    const res = response()
    await route(request(method, raw), res)
    return res
  }

  /** The path of the file the route stores, inside the temporary directory. */
  const layoutPath = () => join(host_.dir, 'layout.json')

  /** Serialise a value as the browser half would. */
  const json = (value: unknown) => JSON.stringify(value)

  test('a first run reads as no order', async () => {
    await load()
    rmSync(layoutPath(), { force: true })
    const res = await call('GET')
    expect(res.seen.status).toBe(200)
    expect(JSON.parse(res.seen.body)).toEqual({ version: LAYOUT_VERSION, order: {} })
  })

  test('a written order is stored whole and read back', async () => {
    const layout = { version: LAYOUT_VERSION, order: { tools: ['b', 'a'], services: ['s'] } }
    const written = await call('PUT', json(layout))
    expect(written.seen.status).toBe(200)
    // Byte for byte, because the file is what every other consumer of this
    // state directory would read.
    expect(JSON.parse(readFileSync(layoutPath(), 'utf8'))).toEqual(layout)
    const read = await call('GET')
    expect(JSON.parse(read.seen.body)).toEqual(layout)
    // A section the owner has no preference about is stored as absent, not as
    // an empty list: only one of those says "no opinion".
    expect(JSON.parse(read.seen.body).order.workflows).toBeUndefined()
  })

  test('a document the store does not understand is refused with a reason', async () => {
    const cases: [string, string][] = [
      ['an unknown section', json({ version: LAYOUT_VERSION, order: { ghost: ['a'] } })],
      ['a repeated id', json({ version: LAYOUT_VERSION, order: { tools: ['a', 'a'] } })],
      ['a wrong version', json({ version: LAYOUT_VERSION + 1, order: {} })],
      ['a section that is not a list', json({ version: LAYOUT_VERSION, order: { tools: 'a' } })],
      ['an id that is not a string', json({ version: LAYOUT_VERSION, order: { tools: [1] } })],
      ['too many ids', json({
        version: LAYOUT_VERSION,
        order: { tools: Array.from({ length: MAX_IDS_PER_SECTION + 1 }, (_, i) => `t${i}`) },
      })],
      ['an id past the length cap', json({ version: LAYOUT_VERSION, order: { tools: ['x'.repeat(MAX_ID_LENGTH + 1)] } })],
      ['the wrong shape entirely', json([1, 2, 3])],
    ]
    for (const [what, body] of cases) {
      const res = await call('PUT', body)
      // 400 and not 500: the caller is our own browser half, so a document
      // that does not conform is a bug it can be told about.
      expect({ what, status: res.seen.status }).toEqual({ what, status: 400 })
      expect(JSON.parse(res.seen.body).error).toBeTruthy()
    }
  })

  test('a body that is not JSON never reaches the validator', async () => {
    const res = await call('PUT', '{"version":1,')
    expect(res.seen.status).toBe(400)
    expect(JSON.parse(res.seen.body).error).toBeTruthy()
  })

  test('a body past the size cap is refused rather than buffered', async () => {
    const res = await call('PUT', `{"version":1,"order":{"tools":["${'x'.repeat(HOST_MAX_BODY_BYTES + 1)}"]}}`)
    expect(res.seen.status).toBe(400)
    expect(JSON.parse(res.seen.body).error).toContain('too large')
  })

  test('a refused write leaves the stored order alone', async () => {
    const good = { version: LAYOUT_VERSION, order: { tools: ['keep'] } }
    expect((await call('PUT', json(good))).seen.status).toBe(200)
    expect((await call('PUT', json({ version: LAYOUT_VERSION, order: { nope: ['a'] } }))).seen.status).toBe(400)
    expect(JSON.parse((await call('GET')).seen.body)).toEqual(good)
  })

  test('a malformed file is reported, not silently read as no order', async () => {
    // The failure mode this feature exists to remove is a preference that
    // quietly does not apply. Both corruptions say so.
    writeFileSync(layoutPath(), '{"version":1,', 'utf8')
    const truncated = await call('GET')
    expect(truncated.seen.status).toBe(500)
    expect(JSON.parse(truncated.seen.body).error).toContain('is not JSON')

    writeFileSync(layoutPath(), json({ version: LAYOUT_VERSION, order: { ghost: ['a'] } }), 'utf8')
    const wrongShape = await call('GET')
    expect(wrongShape.seen.status).toBe(500)
    expect(JSON.parse(wrongShape.seen.body).error).toContain('is not a layout')

    // ...and the way out of it works: a valid write replaces the file.
    expect((await call('PUT', json({ version: LAYOUT_VERSION, order: {} }))).seen.status).toBe(200)
    expect((await call('GET')).seen.status).toBe(200)
  })

  test('only GET and PUT are answered', async () => {
    for (const method of ['POST', 'DELETE', 'PATCH']) {
      const res = await call(method)
      expect({ method, status: res.seen.status }).toEqual({ method, status: 405 })
      expect(res.seen.headers.allow).toBe('GET, PUT')
    }
  })

  test('the state directory is created on the first write, not at load', async () => {
    // Nothing above may have written the directory into existence before a
    // write asked for it: a plugin that creates state at load leaves debris on
    // a machine where it is installed but never used.
    rmSync(host_.dir, { recursive: true, force: true })
    expect(existsSync(host_.dir)).toBe(false)
    expect((await call('GET')).seen.status).toBe(200)
    expect(existsSync(host_.dir)).toBe(false)
    expect((await call('PUT', json({ version: LAYOUT_VERSION, order: { tools: ['a'] } }))).seen.status).toBe(200)
    expect(existsSync(layoutPath())).toBe(true)
  })
})

describe('butler.json guide matches the schema', () => {
  test('every field the guide documents exists, and 必填 matches required', async () => {
    const { TOOL_FIELDS, HOSTED_FIELDS, ACTION_FIELDS } = await import('./src/ui/tool-manifest-fields.ts')
    const schema = JSON.parse(readFileSync(join(import.meta.dir, 'spec', 'butler.schema.json'), 'utf8'))
    const check = (rows: readonly (readonly string[])[], node: { properties: Record<string, unknown>; required?: string[] }) => {
      for (const [field, need] of rows) {
        expect(Object.keys(node.properties)).toContain(field)
        expect(need === '必填').toBe((node.required ?? []).includes(field))
      }
    }
    // kind is required by the schema too; schemaVersion/kind/id/name are the four
    check(TOOL_FIELDS.filter(([f]) => !['reports', 'commands'].includes(f)), schema)
    check(HOSTED_FIELDS, schema.$defs.hosted)
    check(ACTION_FIELDS, schema.$defs.action)
  })
})
