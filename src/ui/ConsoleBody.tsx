/**
 * The operations console: one body rendered in two places.
 *
 * It registers into the keyed `sidebar.right.pane.tab` seat *and* into `main`
 * under its own panel id, so it can be read in a narrow docked column or given
 * the whole centre column. `wide` is the only difference between the two — the
 * data, the fetching, the order and the layout rules are shared, because a
 * console that disagrees with itself depending on where it is drawn is worse
 * than one that is merely cramped.
 *
 * What it shows is the Host's *registered capability catalogue*: the
 * tools and hosted services that have been declared, with their lifecycle
 * controls, followed by the 工作流 observation area: live SDK runner runs
 * (steps flowing pending → running → done) streamed from the Host RunStore. It used to show endpoint pings and doctor output; those
 * describe Butler's own health and have moved to the briefing page, which is
 * where "how are things" belongs. This surface answers "what can I run".
 *
 * Three things this page is built around, each of which was a measured failure
 * of the first version:
 *
 *  1. **A card has to be visible and recognisable.** The first version's card
 *     fill landed one RGB level off the canvas, and eight tool cards whose only
 *     difference was 14px of text are a wall you have to read. Cards now carry
 *     a state-coloured edge, an identity mark derived from the id, and a footer
 *     band, so "find the Feishu one" is answered by position and colour.
 *  2. **Order is the owner's.** Each section reorders inside itself, by drag or
 *     by arrow keys, and the order is a stored preference rather than a view
 *     state — see `console-layout.ts` for what it does when the catalogue
 *     changes underneath it.
 *  3. **Finding is a first-class action.** One filter box over name, id and
 *     description. Reordering is disabled while it is in use, because the
 *     visible sequence is then a projection and "move one to the left" would
 *     mean nothing.
 *
 * Quick actions are a third thing again: opening a folder is not operating a
 * service. They share this entry's page (Workbench.tsx) behind a tab switch but
 * not its data or its component.
 *
 * The registration's inject face supplies `useOperations`, `useRuns`,
 * `dismissRun`, `refresh`, `move` and `resetOrder`. Docking, splitting, floating and
 * per-session layout all belong to ui-sidebar-right — this file only draws.
 */

import { Fragment, cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PanelModal } from './PanelModal.tsx'
import { base } from './base.ts'
import { createExtension, followLog, openServicePath, readExtensionConfig, readExtensionMcp, registerToolDir, runLifecycle, runToolAction, updateExtensionConfig } from './operations-source.ts'
import { emptyLayout, hasCustomOrder, sectionDisplay, visibleItems, mergeStoredChoices } from './console-layout.ts'
import { GearIcon, GripIcon, SearchIcon, ConsoleIcon } from './icons.tsx'
import { useDragOrder } from './use-drag-order.ts'
import { edgeState, startedSince } from './runs-source.ts'
import { onAttention } from './run-attention.ts'
import { ToolManifestGuide } from './ToolManifestGuide.tsx'

/**
 * Report a catalogue state as one of the four tones the stylesheet styles.
 *
 * Tones rather than colours: the sheet picks the token per theme, so a state
 * that reads on white reads on `#151517` too, and a new state only has to
 * choose a tone rather than a hex.
 */
const TONE_OF = {
  ok: 'ok',
  running: 'ok',
  degraded: 'warn',
  'port-busy': 'warn',
  stopped: 'idle',
  unknown: 'idle',
  error: 'bad',
  down: 'bad',
  unhealthy: 'bad',
}

/**
 * Resolve a state string to a tone.
 * @param state - reported state.
 * @returns one of `ok`, `warn`, `bad`, `idle`.
 */
function toneOf(state) {
  return TONE_OF[state] ?? 'idle'
}

/** How many identity hues the stylesheet defines. Must match `MARKS`. */
const HUES = 8

/**
 * Pick a card's identity hue from its id.
 *
 * From the *id*, not the position: a card that keeps its colour while the
 * catalogue grows, the order changes and the filter hides its neighbours is
 * the whole point of having one. FNV-1a because it is four lines and spreads
 * ids that share a prefix (`feishu-…` next to `feishu-…`) instead of parking
 * them in the same bucket.
 * @param id - the capability id.
 * @returns an index into the stylesheet's palette.
 */
export function hueOf(id) {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % HUES
}

/**
 * Turn a capability name into a two-character mark.
 *
 * Two Latin words give their initials; one gives its first two letters; a name
 * with no Latin at all gives its first two characters. The mark is a reminder,
 * not an abbreviation — the name is right beside it.
 * @param name - the display name.
 * @returns at most two characters.
 */
function markOf(name) {
  const words = String(name).trim().split(/[\s·\-_/]+/).filter(Boolean)
  const latin = words.filter(word => /^[A-Za-z]/.test(word))
  if (latin.length >= 2) return `${latin[0][0]}${latin[1][0]}`.toUpperCase()
  if (latin.length === 1) return latin[0].slice(0, 2).toUpperCase()
  const text = String(name).trim()
  return text.slice(0, 2)
}

/**
 * Track one in-flight action per row.
 *
 * A console that runs something and says nothing is indistinguishable from one
 * that is broken, so every trigger reports pending, done, or the Dashboard's
 * own refusal text — 409s here are informative ("needs confirmation", "no
 * executor wired") and must not be flattened into a generic failure.
 * @param refresh - re-read the catalogue after a state change.
 * @returns the busy key, the last note, and a runner.
 */
function useRunner(refresh) {
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)

  const run = useCallback(async (key, task) => {
    setBusy(key)
    setNote(null)
    const result = await task()
    setBusy(null)
    setNote({ key, ok: result.ok, reason: result.reason })
    // Lifecycle changes take a moment to settle upstream; re-read so the row
    // stops claiming the state it had before the click.
    if (result.ok) void refresh()
  }, [refresh])

  return { busy, note, run }
}

/**
 * Render the operations console.
 * @param props - assembled slot props; `wide` selects the full-page layout.
 * @returns the console element.
 */
export function ConsoleBody({ t, useOperations, useRuns, dismissRun, decideStep = null, openSession = null, refresh, move, resetOrder, setDisplay, wide = false, lead = null }) {
  const status = useOperations(snapshot => snapshot.status)
  const tools = useOperations(snapshot => snapshot.tools)
  const services = useOperations(snapshot => snapshot.services)
  const layout = useOperations(snapshot => snapshot.layout)
  const layoutError = useOperations(snapshot => snapshot.layoutError)
  const layoutSaving = useOperations(snapshot => snapshot.layoutSaving)
  const { busy, note, run } = useRunner(refresh)
  const [panel, setPanel] = useState(null)
  const [editor, setEditor] = useState(null)
  const [query, setQuery] = useState('')
  const closePanel = useCallback(() => setPanel(null), [])
  // A tool panel is usually where a flow gets triggered. When a run starts
  // while it is open, close it and bring the 工作流 area into view, so the
  // owner watches the flow instead of a form that has done its job.
  const runs = useRuns(snapshot => snapshot.runs)
  const runsRef = useRef(null)
  const seenRuns = useRef(null)
  useEffect(() => {
    if (!panel) { seenRuns.current = null; return }
    if (seenRuns.current === null) { seenRuns.current = new Set(runs.map(run => run.runId)); return }
    if (startedSince(seenRuns.current, runs).length === 0) return
    setPanel(null)
    runsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [panel, runs])
  // Runs started elsewhere (an Agent session, a CLI, an automation) are routed
  // here by RunAttention: scroll 工作流 into view and flash the run once.
  const [flash, setFlash] = useState(null)
  useEffect(() => onAttention((detail) => {
    if (!runsRef.current) return
    runsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setFlash(detail.runId)
  }), [])
  useEffect(() => {
    if (!flash) return undefined
    const timer = setTimeout(() => setFlash(null), 1800)
    return () => clearTimeout(timer)
  }, [flash])
  const [logView, setLogView] = useState(null)
  const openEditor = useCallback((kind, item = null) => setEditor({ kind, item }), [])
  const closeEditor = useCallback(() => setEditor(null), [])
  const editExtension = useCallback(async (kind, item) => {
    try {
      const config = await readExtensionConfig(kind, item.id)
      openEditor(kind, { ...item, ...config, iconPreview: item.icon })
    } catch (error) { setPanel({ title: item.name, url: item.openUrl }) }
  }, [openEditor])
  const saveEditor = useCallback(async (manifest) => {
    const result = manifest.dir !== undefined
      ? await registerToolDir(manifest.dir)
      : editor?.item
      ? await updateExtensionConfig(editor.kind, editor.item.id, manifest)
      : await createExtension(manifest)
    // An older Host (the App was not restarted after a plugin update) accepts
    // the request, drops the icon fields it does not know and answers 200. Say
    // so instead of closing the form on a save that did not happen.
    const wantsIcon = Boolean(manifest.iconData) || Boolean(manifest.icon)
    if (result.ok && wantsIcon && typeof result.extension?.icon !== 'string') {
      return { ok: false, reason: t('console.hostStale') }
    }
    if (result.ok) { closeEditor(); await refresh() }
    return result
  }, [editor, closeEditor, refresh, t])

  /**
   * Act on one of a tool's declared actions according to its mode.
   *
   * The three modes are not variations on a button — they are three different
   * things to do, and collapsing them is how an action that was meant to open
   * a page ends up POSTing to it.
   * @param tool - the tool the action belongs to.
   * @param action - the action as read from the catalogue.
   */
  const triggerAction = (tool, action) => {
    if (action.mode === 'external') {
      // Deliberately a new tab, not the panel: `external` is the tool saying
      // this destination is a site, not a settings pane. `noopener` because
      // the opened page must not get a handle back to this one.
      if (action.url) window.open(action.url, '_blank', 'noopener,noreferrer')
      return
    }
    if (action.mode === 'panel') {
      if (action.url) setPanel({ title: `${tool.name} · ${action.label}`, url: action.url, size: tool.panelSize })
      return
    }
    void run(`tool:${tool.id}`, () => runToolAction(tool.id, action.index))
  }

  const filtering = query.trim().length > 0
  const ordered = layout ?? emptyLayout()
  const serviceDisplay = sectionDisplay(ordered, 'services')
  const toolDisplay = sectionDisplay(ordered, 'tools')
  const shownServices = visibleItems(services, serviceDisplay, query)
  const shownTools = visibleItems(tools, toolDisplay, query)
  const shown = shownServices.length + shownTools.length
  // Reordering a partial grid would make insertion boundaries ambiguous.
  const sortable = !filtering && !layoutSaving && typeof move === 'function'
  const custom = hasCustomOrder(ordered)
  const empty = tools.length === 0 && services.length === 0

  /**
   * Per-row status line: the pending marker, or the last outcome for this row.
   * @param key - the row's runner key.
   * @param fallback - what to show when this row has nothing to report.
   * @returns the line to render.
   */
  const lineFor = (key, fallback) => {
    if (busy === key) return t('console.busy')
    if (note?.key === key) return note.ok ? t('console.done') : note.reason
    return fallback
  }

  /** Whether a row's last action failed, so the line paints as an error. */
  const failed = key => note?.key === key && !note.ok

  /**
   * Build the grip descriptor for one card, when reordering is allowed.
   *
   * The grip carries both its labels and the pointer/keyboard handlers that
   * `useDragOrder` produces, so the card can wire it up without knowing about
   * the hook. Sorting off (a filter is active, or there is no order store)
   * returns null and the card omits the grip entirely.
   * @param item - the capability the grip belongs to.
   * @param grip - the descriptor handed in by `SortableSection`, or null.
   * @returns the descriptor to pass to `<Card>`, or null.
   */
  const gripFor = (item, grip) => (sortable && grip
    ? {
      id: item.id,
      label: grip['aria-label'],
      hint: grip.title,
      onPointerDown: grip.onPointerDown,
      onKeyDown: grip.onKeyDown,
    }
    : null)

  return (
    <div className="bp-console" data-wide={wide ? 'true' : 'false'}>
      <div className="bp-head">
        {wide ? (lead ?? <h1 className="bp-head__title">{t('console.title')}</h1>) : null}
        {wide ? <span className="bp-head__sub">{t('console.subtitle')}</span> : null}
        <span className="bp-head__spacer" />
        <label className="bp-search">
          <SearchIcon className="bp-search__icon" />
          <input
            type="search"
            value={query}
            aria-label={t('console.filter')}
            placeholder={t('console.filter')}
            onChange={event => setQuery(event.target.value)}
          />
          {filtering ? (
            <button
              type="button"
              className="bp-search__clear"
              aria-label={t('console.clearFilter')}
              onClick={() => setQuery('')}
            >
              ×
            </button>
          ) : null}
        </label>
        {custom && sortable ? (
          <button
            type="button"
            className="bp-btn bp-btn--ghost"
            title={t('console.resetOrderHint')}
            onClick={() => { if (typeof resetOrder === 'function') void resetOrder() }}
          >
            {t('console.resetOrder')}
          </button>
        ) : null}
        <button type="button" className="bp-btn" onClick={() => { void refresh() }}>
          {t('page.refresh')}
        </button>
      </div>

      {layoutError ? (
        <p className="bp-note" data-tone="bad">{t('console.orderError')}{layoutError}</p>
      ) : null}

      {status === 'offline'
        ? <p className="bp-empty">{t('console.offline')}</p>
        : empty
          ? <p className="bp-empty">{t('console.empty')}</p>
          : null}

      {filtering ? <p className="bp-search-scope" role="status">{t('console.searchScope')}</p> : null}
      {filtering && shown === 0 && status !== 'offline'
        ? <p className="bp-empty">{t('console.filterEmpty')}</p>
        : null}

      {/* First, not last: it is the live part of the page, and at the bottom
          it was cut off by the column's end. Idle, it is one heading line. */}
      <RunsSection t={t} useRuns={useRuns} dismissRun={dismissRun} decideStep={decideStep} openSession={openSession} wide={wide} sectionRef={runsRef} flash={flash} />

      {(shownServices.length > 0 || !filtering) ? (
        <SortableSection
          t={t}
          title={t('console.services')}
          section="services"
          onAdd={() => openEditor('service')}
          addLabel={t('console.addService')}
          items={shownServices}
          allItems={services}
          display={serviceDisplay}
          filtering={filtering}
          saving={layoutSaving}
          suspended={Boolean(panel || editor || logView)}
          setDisplay={setDisplay}
          move={sortable && shownServices.length === services.length ? move : null}
          render={(service, grip, drag) => (
            <Card
              key={service.id}
              id={service.id}
              name={service.name}
              tone={toneOf(service.state)}
              mark={markOf(service.name)}
              icon={service.icon}
              hue={hueOf(service.id)}
              line={lineFor(`service:${service.id}`, service.description || null)}
              bad={failed(`service:${service.id}`)}
              chips={[{ label: t(`state.${service.state}`) ?? service.state, tone: toneOf(service.state) }]}
              slot={service.port ? `:${service.port}` : null}
              // A hosted service's page is another process's UI, same as a
              // tool's admin page, so it opens the same way.
              onOpen={() => { void editExtension('service', service) }}
              onConfigure={() => { void editExtension('service', service) }}
              openHint={t('console.configure')}
              configureLabel={t('console.configure')}
              grip={gripFor(service, grip)}
              drag={drag}
            >
              {service.openUrl ? (
                <Control label={t('console.openPage')} onClick={() => { window.open(service.openUrl, '_blank', 'noopener,noreferrer') }} />
              ) : null}
              {service.hasOpenPath ? (
                <Control label={t('console.openDir')} disabled={busy !== null} onClick={() => { void run(`service:${service.id}`, () => openServicePath(service.id)) }} />
              ) : null}
              {service.actions.includes('log') ? (
                <Control label={t('console.log')} onClick={() => setLogView({ kind: 'services', id: service.id, name: service.name })} />
              ) : null}
              {lifecycleFor(service.state)
                .filter(action => service.actions.includes(action))
                .map(action => (
                  <Control
                    key={action}
                    label={t(`console.${action}`)}
                    primary={action === 'start'}
                    disabled={busy !== null}
                    onClick={() => { void run(`service:${service.id}`, () => runLifecycle('services', service.id, action)) }}
                  />
                ))}
            </Card>
          )}
        />
      ) : null}

      {(shownTools.length > 0 || !filtering) ? (
        <SortableSection
          t={t}
          title={t('console.tools')}
          section="tools"
          onAdd={() => openEditor('tool')}
          addLabel={t('console.addTool')}
          items={shownTools}
          allItems={tools}
          display={toolDisplay}
          filtering={filtering}
          saving={layoutSaving}
          suspended={Boolean(panel || editor || logView)}
          setDisplay={setDisplay}
          move={sortable && shownTools.length === tools.length ? move : null}
          render={(tool, grip, drag) => {
            const tone = tool.running ? toneOf(tool.health === 'none' || tool.health === 'unknown' ? 'running' : tool.health) : toneOf('stopped')
            return (
              <Card
                key={tool.id}
                id={tool.id}
                name={tool.name}
                tone={tone}
                mark={markOf(tool.name)}
                icon={tool.icon}
                hue={hueOf(tool.id)}
                line={lineFor(`tool:${tool.id}`, tool.description || tool.id)}
                bad={failed(`tool:${tool.id}`)}
                chips={[{ label: tool.running ? t('state.running') : t('state.stopped'), tone }]}
                // A tool that hosts a settings page opens it when its row is
                // clicked; one that does not stays inert rather than offering a
                // click that goes nowhere.
                onOpen={tool.panelUrl ? () => setPanel({ title: tool.name, url: tool.panelUrl, size: tool.panelSize }) : () => { void editExtension('tool', tool) }}
                openHint={tool.panelUrl ? t('console.openPanel') : null}
                onConfigure={() => { void editExtension('tool', tool) }}
                configureLabel={t('console.configure')}
                grip={gripFor(tool, grip)}
                drag={drag}
              >
                {tool.actions.map(action => (
                  <Control
                    key={action.index}
                    label={action.label}
                    disabled={busy !== null}
                    onClick={() => triggerAction(tool, action)}
                  />
                ))}
                <Control
                  label={tool.running ? t('console.restart') : t('console.start')}
                  primary
                  disabled={busy !== null}
                  onClick={() => {
                    void run(`tool:${tool.id}`, () => runLifecycle('tools', tool.id, tool.running ? 'restart' : 'start'))
                  }}
                />
                {tool.running ? (
                  <Control
                    label={t('console.stop')}
                    danger
                    disabled={busy !== null}
                    onClick={() => { void run(`tool:${tool.id}`, () => runLifecycle('tools', tool.id, 'stop')) }}
                  />
                ) : null}
              </Card>
            )
          }}
        />
      ) : null}

      <PanelModal panel={panel} onClose={closePanel} t={t} />
      {/* keyed: the form's fields are initialised from the item once, on mount */}
      {editor ? <ExtensionEditor key={`${editor.kind}:${editor.item?.id ?? 'new'}`} editor={editor} t={t} onClose={closeEditor} onSave={saveEditor} /> : null}
      {logView ? <LogViewer key={logView.id} view={logView} t={t} onClose={() => setLogView(null)} /> : null}
    </div>
  )
}

/**
 * One titled group of cards, reorderable inside itself.
 *
 * The grid is what the drag hook measures: it owns the card elements, the
 * pointer stream and the insertion line, and it is passed the visible ids so a
 * boundary always names a position in the order the owner is looking at.
 * @param props - copy, the section title, its cards, `move` (or null when
 *   reordering is unavailable), and a per-card renderer that is handed the
 *   card's grip and its drag state.
 * @returns the section element.
 */
/**
 * Form value → manifest command: a JSON array stays an argv array, anything
 * else is a shell-style string.
 * @param text - the field value.
 * @returns string or string[].
 */
function parseCommand(text) {
  const value = text.trim()
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed) && parsed.every(part => typeof part === 'string')) return parsed
    } catch { /* fall through: keep it as typed */ }
  }
  return value
}

const ICON_EDGE = 128

/**
 * Read a picked image file and shrink it to a square PNG data URL.
 *
 * The card shows the icon at ~30px, so 128px is plenty, and shrinking here
 * keeps the upload tiny and format-agnostic: whatever the browser can decode
 * (png, jpg, webp, svg, gif's first frame) leaves as the one format the Host
 * accepts. Cropped to cover, not stretched, so a wide logo is not squashed.
 * @param file - the picked File.
 * @returns a `data:image/png;base64,...` string.
 */
async function pngFromFile(file) {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = ICON_EDGE
    canvas.height = ICON_EDGE
    const context = canvas.getContext('2d')
    const width = image.naturalWidth || ICON_EDGE
    const height = image.naturalHeight || ICON_EDGE
    const side = Math.min(width, height)
    context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, ICON_EDGE, ICON_EDGE)
    return canvas.toDataURL('image/png')
  } finally { URL.revokeObjectURL(url) }
}

/**
 * What the picker should preview for the current form state.
 * @param initial - the string the manifest declared when the form opened.
 * @param current - the text field's value now.
 * @param upload - a freshly picked image as a data URL, or null.
 * @param stored - the card's own normalized icon, for an unchanged value.
 * @returns an icon in the card's shape, or null for "letters".
 */
function previewOf(initial, current, upload, stored) {
  if (upload) return { type: 'image', src: upload }
  const text = current.trim()
  if (!text) return null
  if (text === initial) return stored ?? null
  if (/^https?:\/\//i.test(text) || /^data:image\//i.test(text)) return { type: 'image', src: text }
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(text)) return null
  return { type: 'text', value: text.slice(0, 8) }
}

/**
 * The icon field: a file picker with a live preview, plus a short text box for
 * the two things a file cannot be (an emoji, a remote image address).
 * @param props - value/onChange for the text, the pending upload, the preview and copy.
 * @returns the field element.
 */
function IconPicker({ t, value, onValue, upload, onUpload, preview, mark, hue }) {
  const input = useRef(null)
  const [problem, setProblem] = useState(null)
  const pick = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setProblem(null)
    try {
      onUpload(await pngFromFile(file))
      onValue('')
    } catch { setProblem(t('console.iconUnreadable')) }
  }
  const clear = () => { onUpload(null); onValue('') }
  return (
    <div className="bp-iconpick">
      <span className="bp-iconpick__label">{t('console.icon')}</span>
      <div className="bp-iconpick__row">
        <CardMark mark={mark} icon={preview} hue={hue} />
        <button type="button" className="bp-btn" onClick={() => input.current?.click()}>{t('console.iconChoose')}</button>
        {preview ? <button type="button" className="bp-btn bp-btn--ghost" onClick={clear}>{t('console.iconClear')}</button> : null}
        <input ref={input} type="file" accept="image/*" hidden onChange={pick} />
      </div>
      <input
        className="bp-iconpick__text"
        value={value}
        placeholder={t('console.iconHint')}
        onChange={(event) => { onUpload(null); onValue(event.target.value) }}
      />
      {problem ? <span className="bp-note" data-tone="bad">{problem}</span> : null}
    </div>
  )
}

function ExtensionEditor({ editor, t, onClose, onSave }) {
  const [name, setName] = useState(editor?.item?.name ?? '')
  const [description, setDescription] = useState(editor?.item?.description ?? '')
  const initialIcon = typeof editor?.item?.icon === 'string' ? editor.item.icon : ''
  const [icon, setIcon] = useState(initialIcon)
  const [iconUpload, setIconUpload] = useState(null)
  const [id, setId] = useState(editor?.item?.id ?? '')
  const storedCommand = editor?.item?.hosted?.command ?? editor?.item?.command
  // An argv array is edited as a JSON array so quoting survives the round trip.
  const [command, setCommand] = useState(Array.isArray(storedCommand) ? JSON.stringify(storedCommand) : storedCommand ?? '')
  const [cwd, setCwd] = useState(editor?.item?.cwd ?? editor?.item?.hosted?.cwd ?? '')
  const [port, setPort] = useState(editor?.item?.port ?? editor?.item?.hosted?.port ?? '')
  const [url, setUrl] = useState(editor?.item?.hosted?.url ?? editor?.item?.openUrl ?? '')
  const [openPath, setOpenPath] = useState(editor?.item?.hosted?.openPath ?? '')
  // 跟随 DSH 自启动：读回的配置里 hosted.autoStart 已归一成布尔；新建默认关闭（不常驻）。
  const [autoStart, setAutoStart] = useState(editor?.item?.hosted?.autoStart === true)
  const [dir, setDir] = useState('')
  const [guide, setGuide] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  if (!editor) return null
  const kind = editor.kind
  // Adding a tool is registering a directory: the folder already declares
  // itself in butler.json, so the console asks for nothing else. Services
  // (and editing an existing entry) keep the manifest form.
  const byDir = kind === 'tool' && !editor.item
  // Configuring an existing tool edits its identity only; see ToolIdentityFields.
  const identityOnly = kind === 'tool' && Boolean(editor.item)
  // 有进程才谈得上自启动：新建服务必有进程；已有扩展看读回的 hosted.command。
  const hasProcess = !byDir && (!editor.item ? kind === 'service' : Boolean(editor.item.hosted?.command))
  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    const manifest = byDir
      ? { dir: dir.trim() }
      : identityOnly
      ? { name: name.trim(), description: description.trim(), icon: icon.trim(), ...(iconUpload ? { iconData: iconUpload } : {}), ...(hasProcess ? { autoStart } : {}) }
      : { schemaVersion: 1, kind, id: id.trim(), name: name.trim(), description: description.trim(), icon: icon.trim(), ...(iconUpload ? { iconData: iconUpload } : {}), autoStart, hosted: { command: parseCommand(command), ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(port ? { port: Number(port) } : {}), ...(url.trim() ? { url: url.trim() } : {}), ...(openPath.trim() ? { openPath: openPath.trim() } : {}), autoStart } }
    const result = await onSave(manifest)
    setBusy(false)
    if (!result.ok) setError(result.reason)
  }
  const title = editor.item ? t('console.configure') : kind === 'service' ? t('console.addService') : t('console.addTool')
  return (
    <div className="bp-editor-backdrop" role="presentation" onClick={onClose}>
      <form className="bp-editor" data-guide={guide ? 'true' : undefined} onSubmit={submit} onClick={event => event.stopPropagation()}>
        <div className="bp-editor__head">
          <h2>{title}</h2>
          <button type="button" className="bp-btn bp-btn--ghost" aria-label={t('console.cancel')} onClick={onClose}>×</button>
        </div>
        {byDir ? (
          <>
            <p className="bp-editor__note">
              {t('console.toolDirHint')}
              {' '}
              <button type="button" className="bp-link" aria-expanded={guide} onClick={() => setGuide(open => !open)}>
                {guide ? t('console.guideHide') : t('console.guideShow')}
              </button>
            </p>
            <label>{t('console.toolDir')}<input required autoFocus placeholder="~/path/to/my-tool" value={dir} onChange={event => setDir(event.target.value)} /></label>
            {guide ? <ToolManifestGuide /> : null}
          </>
        ) : (
          <>
            <label>ID<input value={id} disabled={Boolean(editor.item)} onChange={event => setId(event.target.value)} /></label>
            <label>{t('console.name')}<input required value={name} onChange={event => setName(event.target.value)} /></label>
            <label>{t('console.description')}<input value={description} placeholder={t('console.descriptionHint')} onChange={event => setDescription(event.target.value)} /></label>
            <IconPicker
              t={t}
              value={icon}
              onValue={setIcon}
              upload={iconUpload}
              onUpload={setIconUpload}
              preview={previewOf(initialIcon, icon, iconUpload, editor?.item?.iconPreview)}
              mark={markOf(name || id)}
              hue={hueOf(id || 'new')}
            />
            {hasProcess ? (
              <label className="bp-editor__check">
                <input type="checkbox" checked={autoStart} onChange={event => setAutoStart(event.target.checked)} />
                {t('console.autoStart')}
                <small>{t('console.autoStartHint')}</small>
              </label>
            ) : null}
            {identityOnly ? (
              <p className="bp-editor__note">{t('console.toolIdentityNote')}</p>
            ) : (
              <>
                <label>{t('console.command')}<input required value={command} onChange={event => setCommand(event.target.value)} /></label>
                <label>{t('console.cwd')}<input value={cwd} onChange={event => setCwd(event.target.value)} /></label>
                <label>{t('console.port')}<input type="number" value={port} onChange={event => setPort(event.target.value)} /></label>
                <label>{t('console.url')}<input type="url" value={url} onChange={event => setUrl(event.target.value)} /></label>
                <label>{t('console.openPathField')}<input value={openPath} placeholder="~/path" onChange={event => setOpenPath(event.target.value)} /></label>
              </>
            )}
          </>
        )}

        {error ? <p className="bp-note" data-tone="bad">{error}</p> : null}
        <div className="bp-editor__acts">
          <button type="button" className="bp-btn" onClick={onClose}>{t('console.cancel')}</button>
          <button type="submit" className="bp-btn bp-btn--primary" disabled={busy}>{byDir ? t('console.register') : t('console.save')}</button>
        </div>
      </form>
    </div>
  )
}

/**
 * What this extension contributes to Butler's unified MCP service, read-only.
 * Shown only when the extension declares an `mcp` block (or its declaration was
 * rejected); otherwise renders nothing. The endpoint is Butler's, never the tool's.
 * @param props - extension kind/id and translator.
 * @returns the section, or null.
 */
function McpSection({ kind, id, t }) {
  const [view, setView] = useState({ phase: 'loading' })
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let live = true
    readExtensionMcp(kind, id).then(
      (data) => { if (live) setView({ phase: 'ready', ...data }) },
      // An older Host has no /mcp/status: say nothing rather than a false "none".
      () => { if (live) setView({ phase: 'absent' }) },
    )
    return () => { live = false }
  }, [kind, id])
  if (view.phase === 'absent') return null
  if (view.phase === 'ready' && !view.provider && !view.conflict) return null
  const copy = async () => {
    try { await navigator.clipboard.writeText(view.endpoint); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard denied */ }
  }
  const provider = view.provider
  const tools = provider?.toolDetails ?? (provider?.tools ?? []).map(name => ({ name, description: '' }))
  return (
    <section className="bp-mcp" aria-label={t('console.mcpTitle')}>
      <div className="bp-mcp__head">
        <h3>{t('console.mcpTitle')}</h3>
        {provider ? <span className="bp-chip">{`${provider.namespace}__*`}</span> : null}
        {provider ? <span className="bp-chip" data-tone={provider.state === 'ready' ? 'ok' : undefined}>{t(`console.mcpState.${provider.state}`)}</span> : null}
      </div>
      {view.phase === 'loading' ? <p className="bp-editor__note">{t('console.mcpLoading')}</p> : null}
      {view.conflict ? <p className="bp-editor__note" data-tone="bad">{view.conflict.reason}</p> : null}
      {provider?.error ? <p className="bp-editor__note" data-tone="bad">{provider.error}</p> : null}
      {view.phase === 'ready' && view.endpoint ? (
        <div className="bp-mcp__endpoint">
          <code>{view.endpoint}</code>
          <button type="button" className="bp-btn" onClick={() => { void copy() }}>{copied ? t('console.mcpCopied') : t('console.mcpCopy')}</button>
        </div>
      ) : null}
      {tools.length ? (
        <ul className="bp-mcp__tools">
          {tools.map(tool => <li key={tool.name}><code>{tool.name}</code>{tool.description ? <small>{tool.description}</small> : null}</li>)}
        </ul>
      ) : null}
      {provider?.rejectedTools?.length ? <p className="bp-editor__note" data-tone="bad">{`${t('console.mcpRejected')}${provider.rejectedTools.join('、')}`}</p> : null}

    </section>
  )
}

/**
 * Lifecycle buttons that make sense in a state: a running service can be
 * restarted or stopped, a stopped one started, a crashed/port-busy one
 * restarted or started again.
 * @param state - service state.
 * @returns the lifecycle verbs to offer.
 */
function lifecycleFor(state) {
  if (state === 'running') return ['restart', 'stop']
  if (state === 'stopped') return ['start']
  return ['restart', 'stop']
}

/**
 * Live process log for one tool/service, in the plugin's opaque dialog.
 * @param props - which log, copy, close callback.
 * @returns the dialog.
 */
function LogViewer({ view, t, onClose }) {
  const [lines, setLines] = useState([])
  const bodyRef = useRef(null)
  const dialogRef = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement
    const close = dialogRef.current?.querySelector('button')
    close?.focus()
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current() }
      if (event.key === 'Tab') { event.preventDefault(); close?.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => followLog(view.kind, view.id, line => {
    setLines(previous => (previous.length >= 400 ? [...previous.slice(-399), line] : [...previous, line]))
  }), [view.kind, view.id])
  useEffect(() => {
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [lines])
  return (
    <div className="bp-editor-backdrop" role="presentation" onClick={onClose}>
      <div className="bp-editor bp-logview" ref={dialogRef} role="dialog" aria-modal="true" aria-label={`${view.name} · ${t('console.log')}`} onClick={event => event.stopPropagation()}>
        <div className="bp-editor__head">
          <h2>{`${view.name} · ${t('console.log')}`}</h2>
          <button type="button" className="bp-btn bp-btn--ghost" aria-label={t('console.cancel')} onClick={onClose}>×</button>
        </div>
        <pre ref={bodyRef} className="bp-logview__body">
          {lines.length === 0
            ? t('console.logEmpty')
            : lines.map((line, index) => `${new Date(line.t).toLocaleTimeString()}  ${line.text}`).join('\n')}
        </pre>
      </div>
    </div>
  )
}

function SortableSection({ t, title, section, items, allItems, display, filtering, saving, suspended, setDisplay, move, render, onAdd, addLabel }) {
  const ids = items.map(item => item.id)
  const enabled = typeof move === 'function'
  const onMove = useCallback((id, boundary) => { move(section, id, boundary) }, [move, section])
  const { gridProps, gripProps, dragId, dropLine } = useDragOrder({ ids, enabled, onMove })
  const [managing, setManaging] = useState(false)
  const closeManager = useCallback(() => setManaging(false), [])
  const bodyRef = useRef(null)
  const switchRef = useRef(null)
  const oldHeight = useRef(null)
  const animation = useRef(null)
  const storedCount = allItems.filter(item => display.stored.includes(item.id)).length
  const canManage = typeof setDisplay === 'function'
  const all = display.mode === 'all'
  const switchMode = () => {
    oldHeight.current = bodyRef.current?.getBoundingClientRect().height
    void setDisplay(section, { mode: all ? 'resident' : 'all' })
  }
  useLayoutEffect(() => {
    const body = bodyRef.current
    animation.current?.cancel()
    if (body && oldHeight.current !== null && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      body.style.overflow = 'hidden'
      animation.current = body.animate([{ height: `${oldHeight.current}px` }, { height: `${body.getBoundingClientRect().height}px` }], { duration: 180, easing: 'ease-out' })
      animation.current.onfinish = () => { body.style.overflow = '' }
    }
    oldHeight.current = null
    return () => { animation.current?.cancel(); if (body) body.style.overflow = '' }
  }, [display.mode])
  const toggleStored = (item) => {
    const stored = display.stored.includes(item.id)
      ? display.stored.filter(id => id !== item.id) : [...display.stored, item.id]
    if (!filtering && !all && !display.stored.includes(item.id)) switchRef.current?.focus()
    void setDisplay(section, { stored })
  }

  return (
    <section className="bp-sec" data-section={section}>
      <div className="bp-catalog-section-heading">
        <h3 className="bp-sec__title">
          <button type="button" className="bp-display-switch" ref={switchRef} disabled={!canManage || filtering} aria-disabled={saving || !canManage || filtering}
            aria-label={`${title} · ${t(filtering ? 'console.searchResults' : all ? 'console.showAll' : 'console.showResident')}`}
            aria-pressed={all} title={t(all ? 'console.showResident' : 'console.showAll')} onClick={() => { if (!saving) switchMode() }}>
            <span className="bp-display-chevron" data-all={all} aria-hidden="true">›</span>
            {title}
            <span className="bp-sec__count">{items.length}{items.length !== allItems.length ? ` / ${allItems.length}` : ''}</span>
            <span className="bp-display-mode">{t(filtering ? 'console.searchResults' : all ? 'console.showAll' : 'console.showResident')}</span>
          </button>
        </h3>
        <span className="bp-sec__rule" />
        {canManage ? <button type="button" className="bp-btn bp-btn--ghost bp-display-manage" aria-label={`${title} · ${t('console.displayManage')} · ${t('console.stored')} ${storedCount}`} onClick={() => setManaging(true)}>
          <ConsoleIcon size={14} />{t('console.displayManage')}<span>· {t('console.stored')} {storedCount}</span>
        </button> : null}
        {onAdd ? <button type="button" className="bp-btn bp-btn--act" onClick={onAdd}>{addLabel}</button> : null}
      </div>
      <div className="bp-section-content" ref={bodyRef}>
        <div className="bp-grid" {...gridProps}>
          {items.map(item => cloneElement(render(
            item,
            enabled ? gripProps(item.id, `${item.name} · ${t('console.drag')}`, t('console.dragHint')) : null,
            dragId === item.id,
          ), {
            storedLabel: display.stored.includes(item.id) ? t('console.stored') : null,
            displayAction: canManage ? {
              label: t(display.stored.includes(item.id) ? 'console.makeResident' : 'console.store'),
              menuLabel: `${item.name} · ${t('console.displayManage')}`,
              disabled: saving, run: () => toggleStored(item),
            } : null,
          }))}
          {dropLine ? <span className="bp-drop" style={dropLine} aria-hidden="true" /> : null}
        </div>
        {!filtering && items.length === 0 && allItems.length > 0 ? <div className="bp-resident-empty">
          <span>{t('console.noResident')}</span>
          <button type="button" className="bp-btn" disabled={saving} onClick={switchMode}>{t('console.showAll')}</button>
        </div> : null}
      </div>
      {managing ? <DisplayManager t={t} title={title} items={allItems} display={display} saving={saving} suspended={suspended}
        render={render} onClose={closeManager} onSave={stored => setDisplay(section, { stored })} /> : null}
    </section>
  )
}

function DisplayManager({ t, title, items, display, saving, suspended, render, onClose, onSave }) {
  // Store only explicit unchecked choices: items discovered while open default to resident.
  const [draft, setDraft] = useState(() => display.stored.slice())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const dialogRef = useRef(null)
  const pendingRef = useRef(false)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog) {
      dialog.inert = suspended
      if (!suspended) dialog.querySelector('button')?.focus()
    }
  }, [suspended])
  const label = `${title} · ${t('console.displayManage')}`
  const residentIds = items.filter(item => !draft.includes(item.id)).map(item => item.id)
  useEffect(() => {
    const previous = document.activeElement
    const dialog = dialogRef.current
    dialog.querySelector('button')?.focus()
    const onKey = event => {
      // Tool panels and log/config dialogs can open over the drawer.
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      if (suspendedRef.current || dialogs.at(-1) !== dialog) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        if (!pendingRef.current) onClose()
      }
      if (event.key !== 'Tab') return
      const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true); if (previous?.isConnected) previous.focus() }
  }, [onClose])
  const save = async () => {
    pendingRef.current = true; setPending(true); setError(null)
    try {
      const result = await onSave(mergeStoredChoices(display.stored, items, residentIds))
      if (result.ok) onClose()
      else setError(result.reason)
    } catch (err) { setError(String(err?.message ?? err)) }
    finally { pendingRef.current = false; setPending(false) }
  }
  return <div className="bp-editor-backdrop bp-display-backdrop" onClick={() => { if (!pending) onClose() }}>
    <div className="bp-editor bp-display-drawer" role="dialog" aria-modal={!suspended} aria-hidden={suspended || undefined} aria-label={label} ref={dialogRef} onClick={event => event.stopPropagation()}>
      <div className="bp-editor__head"><h2>{label}</h2><button type="button" className="bp-btn bp-btn--ghost" aria-label={t('panel.close')} disabled={pending} onClick={onClose}>×</button></div>
      <p className="bp-editor__note">{t('console.displayHelp')}</p>
      <div className="bp-display-summary"><span>{t('console.resident')} {residentIds.length}</span><span>{t('console.stored')} {items.length - residentIds.length}</span></div>
      <div className="bp-display-list">
        {items.map(item => {
          const card = render(item, null, false).props
          const resident = !draft.includes(item.id)
          return <div key={item.id} className="bp-display-row">
            <div className="bp-display-row__identity"><CardMark mark={card.mark} icon={card.icon} hue={card.hue} /><div className="bp-display-row__name"><strong>{item.name}</strong><span className="bp-display-row__state"><span className="bp-dot" data-tone={card.tone} />{card.chips?.[0]?.label}{card.slot ? ` · ${card.slot}` : ''}</span></div>
              <label className="bp-resident-choice"><input type="checkbox" checked={resident} disabled={pending} aria-label={`${item.name} · ${t('console.resident')}`} onChange={event => setDraft(current => event.target.checked ? current.filter(id => id !== item.id) : [...current, item.id])} />{t('console.resident')}</label>
            </div>
            {card.bad ? <p className="bp-editor__note" role="alert">{card.line}</p> : null}
            <div className="bp-display-row__actions">{card.children}</div>
          </div>
        })}
        {items.length === 0 ? <p className="bp-editor__note">{t('console.empty')}</p> : null}
      </div>
      {error ? <p className="bp-note" data-tone="bad" role="alert">{error}</p> : null}
      <div className="bp-display-footer"><span>{t('console.displaySaveHint')}</span><button type="button" className="bp-btn" disabled={pending} onClick={onClose}>{t('console.cancel')}</button><button type="button" className="bp-btn bp-btn--primary" disabled={pending || saving} onClick={() => { void save() }}>{t(pending ? 'console.busy' : 'console.save')}</button></div>
    </div>
  </div>
}

function CardDisplayMenu({ action, onConfigure, configureLabel }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const outside = event => { if (!ref.current?.contains(event.target)) setOpen(false) }
    const escape = event => { if (event.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div className="bp-display-menu" ref={ref}>
    <button type="button" className="bp-grip" aria-label={action.menuLabel} aria-expanded={open} disabled={action.disabled} onClick={() => setOpen(!open)}>···</button>
    {open ? <div className="bp-display-menu__popover">
      {onConfigure ? <button type="button" className="bp-btn" onClick={() => { setOpen(false); onConfigure() }}>{configureLabel}</button> : null}
      <button type="button" className="bp-btn" disabled={action.disabled} onClick={() => { setOpen(false); ref.current?.querySelector('button')?.focus(); action.run() }}>{action.label}</button>
    </div> : null}
  </div>
}

const RUN_LABEL = { running: 'runs.running', success: 'runs.success', error: 'runs.error', interrupted: 'runs.interrupted' }
const RUN_TONE = { running: 'warn', success: 'ok', error: 'bad', interrupted: 'bad' }
const STEP_MARK = { success: '✓', error: '✕', skipped: '–', awaiting: '?' }

/**
 * 工作流 observation area: what tools/services/faculties are executing right
 * now through the SDK runner, step by step. It replaced a hard-coded workflow
 * catalogue: a workflow is not a thing to list and click, it is a trace of
 * work that something else started (a tool action, a CLI, an automation).
 * @param props - copy, the runs hook, dismiss callback, layout width.
 * @returns the section element.
 */
function RunsSection({ t, useRuns, dismissRun, decideStep, openSession, wide, sectionRef, flash = null }) {
  const status = useRuns(snapshot => snapshot.status)
  const runs = useRuns(snapshot => snapshot.runs)
  const idle = runs.length === 0
  return (
    <section ref={sectionRef} className="bp-sec bp-runs" data-wide={wide ? 'true' : 'false'} data-idle={idle ? 'true' : 'false'}>
      <div className="bp-catalog-section-heading">
        <h3 className="bp-sec__title">{t('console.workflows')}</h3>
        <span className="bp-sec__count">{runs.length}</span>
        <span className="bp-sec__rule" />
        <span className="bp-sec__hint" title={idle ? t('runs.empty') : undefined}>{status === 'offline' ? t('runs.offline') : idle ? t('runs.idle') : t('runs.hint')}</span>
      </div>
      {idle ? null : (
        <div className="bp-runs__list">
          {runs.map(run => <RunTrace key={run.runId} t={t} run={run} onDismiss={dismissRun} decideStep={decideStep} openSession={openSession} flash={flash === run.runId} />)}
        </div>
      )}
    </section>
  )
}

/**
 * One run: status, title, target and source, then its steps as a flow.
 * @param props - copy, the run record, dismiss callback.
 * @returns the trace element.
 */
function RunTrace({ t, run, onDismiss, decideStep = null, openSession = null, flash = false }) {
  const done = run.status !== 'running'
  const elapsed = run.endedAt && run.startedAt ? `${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s` : null
  return (
    <div className="bp-trace" data-status={run.status} data-flash={flash ? 'true' : undefined}>
      <div className="bp-trace__head">
        <span className="bp-chip" data-tone={RUN_TONE[run.status] ?? 'idle'}>
          <span className="bp-dot" data-tone={RUN_TONE[run.status] ?? 'idle'} aria-hidden="true" />
          {RUN_LABEL[run.status] ? t(RUN_LABEL[run.status]) : run.status}
        </span>
        <span className="bp-trace__title">{run.title}</span>
        {run.target ? <span className="bp-trace__target" title={run.target}>{run.target}</span> : null}
        <span className="bp-head__spacer" />
        <span className="bp-trace__meta">
          {run.source}{run.dryRun ? ' · dry-run' : ''}{elapsed ? ` · ${elapsed}` : ''}
          {run.startedAt ? ` · ${new Date(run.startedAt).toLocaleTimeString()}` : ''}
        </span>
        {done && typeof onDismiss === 'function' ? (
          <button type="button" className="bp-search__clear" aria-label={t('runs.dismiss')} title={t('runs.dismiss')} onClick={() => onDismiss(run.runId)}>×</button>
        ) : null}
      </div>
      <div className="bp-flow" role="list" aria-label={run.title}>
        <span className="bp-flow__term" data-state={run.status === 'running' || run.steps.some(step => step.status !== 'pending') ? 'on' : 'off'} aria-hidden="true">
          <span className="bp-flow__term-dot" />{t('runs.start')}
        </span>
        {run.steps.map((step, index) => (
          <Fragment key={`${index}:${step.name}`}>
            <span className="bp-flow__edge" data-state={edgeState(run, index)} aria-hidden="true"><i /></span>
            <div
              role="listitem"
              className="bp-flow__node"
              data-status={step.status}
              title={step.error || step.log || undefined}
            >
              <span className="bp-flow__mark" aria-hidden="true">{STEP_MARK[step.status] ?? (index + 1)}</span>
              <span className="bp-flow__body">
                <span className="bp-flow__name">{step.name}</span>
                <span className="bp-flow__sub">
                  {step.status === 'success' && step.ms != null ? `${(step.ms / 1000).toFixed(1)}s`
                    : step.status === 'awaiting' ? t('runs.awaiting')
                    : step.status === 'running' ? (step.log || t('runs.running'))
                      : step.status === 'error' ? (step.error || t('runs.error'))
                        : step.status === 'skipped' ? t('runs.skipped') : t('runs.pending')}
                </span>
              </span>
            </div>
          </Fragment>
        ))}
        {/* edge + terminal stay together so a wrap never strands the end node */}
        <span className="bp-flow__tail" aria-hidden="true">
          <span className="bp-flow__edge" data-state={edgeState(run, run.steps.length)}><i /></span>
          <span className="bp-flow__term" data-state={run.status === 'success' ? 'ok' : run.status === 'running' ? 'off' : 'bad'}>
            <span className="bp-flow__term-dot" />{t('runs.end')}
          </span>
        </span>
      </div>
      {run.steps.map((step, index) => step.status === 'awaiting' && step.confirm
        ? <StepConfirmBox key={`confirm:${index}`} t={t} runId={run.runId} index={index} step={step} decideStep={decideStep} openSession={openSession} />
        : null)}
      {run.steps.some(step => step.sessionId && step.status !== 'awaiting') && typeof openSession === 'function' ? (
        <div className="bp-trace__links">
          {run.steps.map((step, index) => step.sessionId && step.status !== 'awaiting'
            ? <button key={`s:${index}`} type="button" className="bp-link" onClick={() => openSession(step.sessionId)}>{t('runs.openSession')} · {step.name}</button>
            : null)}
        </div>
      ) : null}
      {run.error && done ? <div className="bp-trace__error">{run.error}</div> : null}
    </div>
  )
}

/**
 * A delegation result waiting for the owner. Shows what the Butler Session proposed, a link to
 * that Session for the full reasoning, and approve / reject. Deciding goes through the Host's
 * owner-only gate; the workflow step is polling for exactly this answer.
 * @param props - copy, run id, step index and record, the decide and open-session callbacks.
 * @returns the confirmation element.
 */
function StepConfirmBox({ t, runId, index, step, decideStep, openSession }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const confirm = step.confirm
  const decide = async (decision) => {
    if (typeof decideStep !== 'function') return
    setBusy(true); setError(null)
    const failed = await decideStep(runId, index, confirm.token, decision).catch(e => String(e?.message ?? e))
    setBusy(false)
    if (failed) setError(failed)
  }
  return (
    <div className="bp-trace__confirm" role="group" aria-label={t('runs.awaiting')}>
      <div className="bp-trace__confirm-head">
        <span className="bp-chip" data-tone="warn"><span className="bp-dot" data-tone="warn" aria-hidden="true" />{t('runs.awaiting')}</span>
        <span className="bp-trace__confirm-step">{step.name}</span>
        {confirm.sessionId && typeof openSession === 'function'
          ? <button type="button" className="bp-link" onClick={() => openSession(confirm.sessionId)}>{t('runs.viewSession')}</button>
          : null}
      </div>
      {confirm.summary ? <p className="bp-trace__confirm-summary">{confirm.summary}</p> : null}
      {confirm.items?.length ? <ul className="bp-trace__confirm-items">{confirm.items.map((item, i) => <li key={i}>{item}</li>)}</ul> : null}
      {error ? <p className="bp-note" data-tone="bad">{error}</p> : null}
      <div className="bp-trace__confirm-acts">
        <button type="button" className="bp-btn" disabled={busy || typeof decideStep !== 'function'} onClick={() => decide('reject')}>{t('runs.reject')}</button>
        <button type="button" className="bp-btn bp-btn--primary" disabled={busy || typeof decideStep !== 'function'} onClick={() => decide('approve')}>{t('runs.approve')}</button>
      </div>
    </div>
  )
}

/**
 * The card's identity tile: the configured icon when there is one, otherwise
 * the letters derived from the name.
 *
 * An image that fails to load (dead URL, deleted file) falls back to the
 * letters instead of leaving a broken-image glyph, so a bad `icon` costs the
 * owner nothing worse than not having set one.
 * @param props - the derived mark, the configured icon (or null) and the hue.
 * @returns the tile element.
 */
function CardMark({ mark, icon, hue }) {
  const [broken, setBroken] = useState(false)
  const src = icon?.type === 'image' && !broken ? icon.src : null
  useEffect(() => { setBroken(false) }, [icon?.src])
  if (src) {
    return (
      <span className="bp-tile__mark bp-tile__mark--image" aria-hidden="true">
        <img src={src} alt="" draggable={false} onError={() => setBroken(true)} />
      </span>
    )
  }
  if (icon?.type === 'text') {
    return <span className="bp-tile__mark bp-tile__mark--glyph" data-hue={hue} aria-hidden="true">{icon.value}</span>
  }
  return <span className="bp-tile__mark" data-hue={hue} aria-hidden="true">{mark}</span>
}

/**
 * One capability card.
 *
 * Four bands, always in this order, so the eye can scan a column of them down
 * a single edge: the state rail, the identity row (mark, name, description,
 * grip), and the footer (state chip, slot, controls). The description reserves
 * two lines whether or not it needs them, which is what keeps the footer bands
 * of a row aligned instead of stepping.
 * @param props - assembled card content.
 * @returns the card element.
 */
function Card({
  id, name, tone, mark, icon, hue, line, bad, chips, slot, onOpen, openHint, onConfigure, configureLabel, grip, drag, storedLabel = null, displayAction = null, children,
}) {
  const openFromKeyboard = onOpen
    ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
      }
    : undefined
  return (
    <article className="bp-tile" data-card-id={id} data-tone={tone} data-dragging={drag ? 'true' : undefined}>
      <span className="bp-tile__rail" aria-hidden="true" />
      <div className="bp-tile__head">
        <CardMark mark={mark} icon={icon} hue={hue} />
        <div
          className="bp-tile__open"
          data-clickable={onOpen ? 'true' : 'false'}
          role={onOpen ? 'button' : undefined}
          tabIndex={onOpen ? 0 : undefined}
          title={openHint ?? undefined}
          onClick={onOpen ?? undefined}
          onKeyDown={openFromKeyboard}
        >
          <h4 className="bp-tile__name">{name}</h4>
          {storedLabel ? <span className="bp-stored-label">{storedLabel}</span> : null}
          {line ? <p className="bp-tile__desc" data-bad={bad ? 'true' : undefined}>{line}</p> : null}
        </div>
        {onConfigure && !displayAction ? (
          <button type="button" className="bp-grip bp-cfg" aria-label={configureLabel} title={configureLabel} onClick={onConfigure}>
            <GearIcon />
          </button>
        ) : null}
        {displayAction ? <CardDisplayMenu action={displayAction} onConfigure={onConfigure} configureLabel={configureLabel} /> : null}
        {grip ? (
          <button
            type="button"
            className="bp-grip"
            aria-label={grip.label}
            title={grip.hint}
            onPointerDown={grip.onPointerDown}
            onKeyDown={grip.onKeyDown}
          >
            <GripIcon />
          </button>
        ) : null}
      </div>
      <div className="bp-tile__foot">
        {/* State + port share what the buttons leave. The port is a wrapping
            sibling in a one-line box, so when it does not fit it drops to the
            clipped second line instead of pushing the buttons down. */}
        <div className="bp-tile__meta">
        {(chips ?? []).map(chip => (
          <span
            key={chip.label}
            className={chip.soft ? 'bp-chip bp-chip--soft' : 'bp-chip'}
            data-tone={chip.tone}
          >
            <span className="bp-dot" data-tone={chip.tone} aria-hidden="true" />
            {chip.label}
          </span>
        ))}
        {slot ? <span className="bp-tile__slot">{slot}</span> : null}
        </div>
        <div className="bp-tile__acts">{children}</div>
      </div>
    </article>
  )
}

/**
 * One small action button.
 * @param props - label, disabled flag, click handler, and its visual weight.
 * @returns the button element.
 */
function Control({ label, disabled, onClick, primary, danger }) {
  const weight = primary ? ' bp-btn--primary' : danger ? ' bp-btn--danger' : ''
  return (
    <button
      type="button"
      className={`bp-btn bp-btn--act${weight}`}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

/**
 * Render the console as a full-width page.
 * @param props - assembled slot props.
 * @returns the page element.
 */
export function ConsolePage(props) {
  return <ConsoleBody {...props} wide />
}

/**
 * Render the chip title for the console tab.
 * @param props - assembled slot props.
 * @returns the chip label.
 */
export function ConsoleTitle({ t }) {
  return <span>{t('console.title')}</span>
}
