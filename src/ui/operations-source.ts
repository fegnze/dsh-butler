/**
 * Operations data source: the registered capability catalogue, in the order
 * its owner put it in.
 *
 * Same shape as `butler-source.ts` — a `getSnapshot` / `subscribe` pair the
 * slot registration hands to the renderer — but a different subject. Butler
 * reports *how things are*; this reports *what can be run*, which is the
 * distinction the two surfaces are split along.
 *
 * Kept separate from the Butler source on purpose: the briefing polls a doctor
 * run, the console polls a catalogue, and a single merged source would make
 * every doctor tick re-render the console (and vice versa) for no reason.
 *
 * Ordering lives here, not in the renderer, for the same reason the catalogue
 * does: both console instances (the page and the docked tab) read this one
 * observable, and an order held per component would let the two disagree about
 * where a card is. The rule itself — what a stored order means, what happens
 * when the catalogue changes under it — is `console-layout.ts`.
 *
 * Paths are same-origin and served by this plugin's Host half. See the note in
 * butler-source.ts for why calling the Dashboard's port directly cannot work.
 */

/** Same-origin prefix mounted by this plugin's Host half. */
import { base } from './base.ts'
import {
  emptyLayout,
  moveWithin,
  orderedItems,
  readLayout,
  withSectionOrder,
  withSectionDisplay,
} from './console-layout.ts'

/**
 * Poll cadence while at least one subscriber is attached.
 *
 * Faster than the Butler briefing's 15 s: this surface shows service state,
 * and a stop/start you triggered elsewhere should not look stuck for a quarter
 * of a minute.
 */
const POLL_MS = 8000

/** The snapshot shape every consumer reads. */
const EMPTY = {
  status: 'loading',
  error: null,
  checkedAt: null,
  tools: [],
  services: [],
  layout: emptyLayout(),
  layoutError: null,
  layoutSaving: false,
}

/**
 * Classify one raw action from `/myspace-butler/overview` into the mode the console acts on.
 *
 * Mirrors `operations.ts`'s `toOperationTool` exactly, so a row behaves the
 * same here as it does in the Dashboard. The order matters: a POST action is a
 * POST even if it also carries `target`, because running it is the point and
 * opening its URL would be a GET against a mutating endpoint.
 * @param action - raw action entry.
 * @returns `post`, `external` or `panel`.
 */
function modeOf(action) {
  if (action?.method === 'POST') return 'post'
  if (action?.target === 'external') return 'external'
  return 'panel'
}

/**
 * Keep manifest-provided panel dimensions within a safe, usable range.
 * @param size - untrusted catalogue data.
 * @returns normalized dimensions or null.
 */
function normalizePanelSize(size) {
  if (!size || typeof size !== 'object') return null
  const width = Number.isInteger(size.width) ? size.width : null
  const height = Number.isInteger(size.height) ? size.height : null
  if (width === null && height === null) return null
  return {
    ...(width !== null ? { width: Math.min(2400, Math.max(320, width)) } : {}),
    ...(height !== null ? { height: Math.min(1600, Math.max(240, height)) } : {}),
  }
}

/**
 * Turn the upstream payloads into the console's snapshot.
 *
 * Tools come from `/myspace-butler/overview` and everything else from `/myspace-butler/operations`,
 * because only the former carries `panelUrl` and per-action URLs — see the
 * note on the `overview` route in `dsh/index.js` for why the public catalogue
 * cannot answer this surface.
 *
 * Defensive on every field: this catalogue is assembled from a tool registry
 * and a service manager the owner edits by hand, so a half-written entry must
 * degrade to a dull row rather than throw inside a render.
 * @param raw - decoded `/myspace-butler/operations` body.
 * @param overview - decoded `/myspace-butler/overview` body.
 * @param layout - the stored card order, already validated.
 * @returns normalized snapshot.
 */
function normalizeIcon(value, kind, id) {
  if (value?.type === 'text' && typeof value.value === 'string' && value.value) return { type: 'text', value: value.value }
  if (value?.type === 'url' && typeof value.value === 'string' && value.value) return { type: 'image', src: value.value }
  // A manifest-local file is served by the Host by kind + id; the path stays there.
  if (value?.type === 'file') return { type: 'image', src: `${base()}/icons/${kind}/${encodeURIComponent(id)}?v=${encodeURIComponent(value.v ?? '')}` }
  return null
}

function normalize(raw, overview, layout) {
  // `/myspace-butler/operations` still supplies capabilityId/version, which `/myspace-butler/overview`
  // does not carry and which a version-checked run needs. Index it by id and
  // fold it into the richer rows rather than dropping either source.
  const catalogue = new Map(
    (Array.isArray(raw?.tools) ? raw.tools : []).map(item => [String(item?.id ?? ''), item]),
  )

  const tools = orderedItems((Array.isArray(overview?.tools) ? overview.tools : []).map((item) => {
    const id = String(item?.id ?? '')
    const listed = catalogue.get(id)
    return {
      id,
      name: item?.name ?? id,
      description: item?.description ?? '',
      icon: normalizeIcon(item?.icon, 'tool', id),
      capabilityId: listed?.capabilityId ?? `tool:${id}`,
      version: listed?.version ?? 1,
      running: item?.running === true,
      health: item?.health ?? 'unknown',
      frequency: item?.frequency ?? null,
      // The tool's own settings page. Present only for tools that host one —
      // rows without it are not clickable, exactly as upstream.
      panelUrl: typeof item?.panelUrl === 'string' ? item.panelUrl : null,
      panelSize: normalizePanelSize(item?.panelSize),
      actions: (Array.isArray(item?.actions) ? item.actions : []).map((action, index) => ({
        index,
        label: action?.label ?? '',
        mode: modeOf(action),
        // Only `external` actions are opened by the browser directly. A `post`
        // is proxied by index and never by URL, so the Dashboard stays the one
        // deciding what that index resolves to.
        url: typeof action?.url === 'string' ? action.url : null,
      })),
    }
  }), layout.order.tools)

  const services = orderedItems((Array.isArray(raw?.services) ? raw.services : []).map(item => ({
    id: String(item?.id ?? ''),
    name: item?.name ?? item?.id ?? '',
    description: item?.description ?? '',
    icon: normalizeIcon(item?.icon, 'service', String(item?.id ?? '')),
    capabilityId: item?.capabilityId ?? '',
    version: item?.version ?? 0,
    state: item?.state ?? 'unknown',
    port: item?.port ?? null,
    openUrl: item?.openUrl ?? null,
    actions: Array.isArray(item?.actions) ? item.actions : [],
  })), layout.order.services)


  return {
    status: 'ok',
    error: null,
    checkedAt: raw?.checkedAt ?? null,
    tools,
    services,
  }
}

/**
 * Read the error message out of a Dashboard failure body.
 *
 * The Dashboard answers `{ error: { code, message } }`; the Host proxy answers
 * `{ error: '<string>' }` when the Dashboard itself is unreachable. Both shapes
 * reach here, and the message is the part worth showing — a bare status code
 * tells the reader nothing about whether to retry or to go fix a config.
 * @param response - the settled fetch response.
 * @returns a human-readable reason.
 */
async function reasonOf(response) {
  try {
    const body = await response.json()
    const error = body?.error
    if (typeof error === 'string') return error
    if (error?.message) return String(error.message)
  } catch { /* not JSON; fall through to the status line */ }
  return `HTTP ${response.status}`
}

/**
 * Read the stored card order.
 *
 * Never throws: a failure here means "no order yet", which is a console in
 * registration order, not a broken console. Reporting it as an offline
 * catalogue would be the one failure mode this whole surface can afford least.
 * @returns `{ ok: true, layout }`, or `{ ok: false, reason }`.
 */
async function fetchOrder() {
  try {
    const response = await fetch(`${base()}/layout`, { headers: { accept: 'application/json' } })
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
    return { ok: true, layout: readLayout(await response.json()) }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * Create the shared operations observable.
 * @returns the source face consumed by the slot registration.
 */
export function createOperationsSource() {
  let snapshot = EMPTY
  let timer = null
  const listeners = new Set()

  /**
   * Writes that have been queued but have not settled.
   *
   * A poll that lands mid-write must not fold the file's *previous* order back
   * in: the card would jump back to where it was and then jump forward again
   * on the following tick, which reads as "the drag did not take".
   */
  let writing = 0
  let layoutRevision = 0

  /** Serialises writes, so two arrow presses do not race the same file. */
  let chain = Promise.resolve()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const pull = async () => {
    const revision = layoutRevision
    let layout = snapshot.layout
    let layoutError = null
    try {
      // Both or neither: a console showing services from one tick and tools
      // from another would attribute a stale state to a live row. One await,
      // one snapshot — the order rides along, so a card cannot be drawn in one
      // order and removed in another.
      const [listing, overview, stored] = await Promise.all([
        fetch(`${base()}/operations`, { headers: { accept: 'application/json' } }),
        fetch(`${base()}/overview`, { headers: { accept: 'application/json' } }),
        fetchOrder(),
      ])
      if (!listing.ok) throw new Error(`HTTP ${listing.status}`)
      if (!overview.ok) throw new Error(`HTTP ${overview.status}`)
      const [raw, details] = await Promise.all([listing.json(), overview.json()])
      layout = snapshot.layout
      if (writing === 0 && revision === layoutRevision) {
        if (stored.ok) layout = stored.layout
        else layoutError = stored.reason
      }
      snapshot = { ...normalize(raw, details, layout), layout, layoutError, layoutSaving: writing > 0 }
    } catch (error) {
      snapshot = { ...EMPTY, status: 'offline', error: String(error?.message ?? error), layout: snapshot.layout, layoutError, layoutSaving: writing > 0 }
    }
    emit()
  }

  /**
   * Store one layout, reverting the optimistic snapshot when it is refused.
   * @param next - the layout to persist.
   * @param revertTo - the layout to restore when the write fails.
   * @returns settlement of this write, after any write already queued.
   */
  const push = (next, revertTo) => {
    writing += 1
    layoutRevision += 1
    snapshot = { ...snapshot, layoutSaving: true }
    emit()
    chain = chain.then(async () => {
      try {
        const response = await fetch(`${base()}/layout`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
        })
        if (!response.ok) throw new Error(await reasonOf(response))
        const saved = readLayout(await response.json())
        if (JSON.stringify(saved.display) !== JSON.stringify(next.display)) throw new Error('The Host did not persist the display settings. Reload the Butler plugin and retry.')
        return { ok: true }
      } catch (error) {
        // Put the order back. Leaving the page showing an order the store does
        // not have means the next poll silently reverts it, and the owner sees
        // their change "not take" with nothing to explain it.
        snapshot = { ...snapshot, layout: revertTo, layoutError: String(error?.message ?? error) }
        emit()
        return { ok: false, reason: String(error?.message ?? error) }
      } finally {
        writing -= 1
        layoutRevision += 1
        snapshot = { ...snapshot, layoutSaving: writing > 0 }
        emit()
      }
    })
    return chain
  }

  /**
   * Move one card to an insertion boundary inside its own section.
   * @param section - one of the catalogue sections.
   * @param id - the card being moved.
   * @param boundary - where it was dropped, as a boundary in 0..n.
   * @returns settlement of the write.
   */
  const move = (section, id, boundary) => {
    if (writing > 0) return Promise.resolve()
    const before = snapshot
    const current = before[section]
    if (!Array.isArray(current)) return Promise.resolve()
    const ids = current.map(item => item.id)
    const nextIds = moveWithin(ids, id, boundary)
    // `moveWithin` returns the same array for a move that changes nothing —
    // released on the card it started on, or one slot to its right.
    if (nextIds === ids) return Promise.resolve()
    const next = withSectionOrder(before.layout, section, nextIds)
    // Optimistic: the card lands where it was dropped on this frame and the
    // write follows. A round trip per drag would make the grid feel broken on
    // every slow poll, and the section being reordered is tiny.
    snapshot = {
      ...before,
      layout: next,
      [section]: orderedItems(current, nextIds),
      layoutError: null,
    }
    emit()
    return push(next, before.layout)
  }

  /**
   * Drop every stored order and re-read the catalogue in registration order.
   *
   * The catalogue order is not in the snapshot any more — it was replaced by
   * the stored order — so a reset has to go back to the source for it rather
   * than reverse-deriving it here.
   * @returns settlement after the store is cleared and the catalogue re-read.
   */
  const reset = async () => {
    if (writing > 0) return
    const before = snapshot.layout
    const next = { ...before, order: {} }
    snapshot = { ...snapshot, layout: next, layoutError: null }
    emit()
    await push(next, before)
    await pull()
  }

  const setDisplay = (section, patch) => {
    if (writing > 0) return Promise.resolve({ ok: false, reason: 'A layout change is still being saved.' })
    const before = snapshot.layout
    const next = withSectionDisplay(before, section, patch)
    snapshot = { ...snapshot, layout: next, layoutError: null }
    emit()
    return push(next, before)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      if (timer === null) {
        void pull()
        timer = setInterval(() => { void pull() }, POLL_MS)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }
    },
    refresh: () => pull(),
    move,
    reset,
    setDisplay,
  }
}

/**
 * Run one lifecycle action against a tool or a service.
 * @param kind - `tools` or `services`.
 * @param id - capability identity.
 * @param action - `start`, `stop` or `restart`.
 * @returns `{ ok }` on success, `{ ok: false, reason }` otherwise.
 */
export async function createExtension(manifest) {
  try {
    const response = await fetch(`${base()}/extensions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest) })
    if (!response.ok) return { ok: false, reason: await reasonOf(response) }
    return { ok: true, extension: (await response.json().catch(() => null))?.extension ?? null }
  } catch (error) { return { ok: false, reason: String(error?.message ?? error) } }
}

/**
 * Register a tool by its directory (which must contain a kind=tool butler.json).
 * @param dir - absolute or ~/ path.
 * @returns `{ ok, tool }` or `{ ok: false, reason }`.
 */
export async function registerToolDir(dir) {
  try {
    const response = await fetch(`${base()}/extensions/tool-dir`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir }) })
    if (!response.ok) return { ok: false, reason: await reasonOf(response) }
    return { ok: true, tool: (await response.json()).tool }
  } catch (error) { return { ok: false, reason: String(error?.message ?? error) } }
}

/**
 * Reveal a service's declared local directory in Finder (Host-side).
 * @param id - service id.
 * @returns `{ ok }` or `{ ok: false, reason }`.
 */
export async function openServicePath(id) {
  try {
    const response = await fetch(`${base()}/services/${encodeURIComponent(id)}/open`, { method: 'POST' })
    if (!response.ok) return { ok: false, reason: await reasonOf(response) }
    return { ok: true }
  } catch (error) { return { ok: false, reason: String(error?.message ?? error) } }
}

/**
 * Follow a tool/service process log (SSE: replays the bounded tail, then live).
 * @param kind - 'tools' | 'services'.
 * @param id - extension id.
 * @param onLine - receives `{ t, text }`.
 * @returns a close function.
 */
export function followLog(kind, id, onLine) {
  const source = new EventSource(`${base()}/${kind}/${encodeURIComponent(id)}/log`)
  source.onmessage = (event) => { try { onLine(JSON.parse(event.data)) } catch { /* keep-alive */ } }
  return () => source.close()
}

/**
 * MCP tools one extension contributes to Butler's unified MCP service.
 * Starts the provider if needed (Host waits a bounded time) so the list is real.
 * @param kind - 'tool' | 'service'.
 * @param id - extension id.
 * @returns `{ endpoint, provider, conflict }`; provider/conflict null when it declares none.
 */
export async function readExtensionMcp(kind, id) {
  const owner = `${kind}:${id}`
  const response = await fetch(`${base()}/mcp/status?owner=${encodeURIComponent(owner)}&warm=1`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(await reasonOf(response))
  const body = await response.json()
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
  const provider = Array.isArray(body?.providers) ? body.providers.find(p => p?.owner === owner) ?? null : null
  const conflict = Array.isArray(body?.conflicts) ? body.conflicts.find(c => c?.owner === owner) ?? null : null
  return { endpoint, provider, conflict }
}

export async function readExtensionConfig(kind, id) {
  const response = await fetch(`${base()}/extensions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(await reasonOf(response))
  return response.json()
}

export async function updateExtensionConfig(kind, id, manifest) {
  try {
    const response = await fetch(`${base()}/extensions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest) })
    if (!response.ok) return { ok: false, reason: await reasonOf(response) }
    return { ok: true, extension: (await response.json().catch(() => null))?.extension ?? null }
  } catch (error) { return { ok: false, reason: String(error?.message ?? error) } }
}

export async function runLifecycle(kind, id, action) {
  try {
    const response = await fetch(
      `${base()}/operations/${kind}/${encodeURIComponent(id)}/${action}`,
      { method: 'POST' },
    )
    if (!response.ok) return { ok: false, reason: await reasonOf(response) }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * Trigger one of a tool's own quick actions, addressed by index.
 *
 * The index, not the URL. The page reads `action.url` only to decide whether a
 * row is `external` (openable) — a `post` is forwarded by position and the
 * Dashboard resolves it against its own manifest, where it also refuses any
 * target that is not loopback HTTP. Sending the URL instead would move that
 * decision into the browser, which is the one place it must not live.
 * @param id - tool identity.
 * @param index - position of the action in the tool's manifest.
 * @returns `{ ok }` on success, `{ ok: false, reason }` otherwise.
 */
export async function runToolAction(id, index) {
  try {
    const response = await fetch(
      `${base()}/operations/tools/${encodeURIComponent(id)}/actions/${index}`,
      { method: 'POST' },
    )
    if (!response.ok) return { ok: false, reason: await reasonOf(response) }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}
