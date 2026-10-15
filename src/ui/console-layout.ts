/**
 * The console's card order: per-section, owner-set by dragging, merged over
 * whatever order the catalogue happens to report.
 *
 * Order is a *preference*, not domain data, so it never travels to the
 * Host: the Host owns what a capability is, this file owns where the
 * owner wants to see it. It is stored through the plugin's own Host half
 * (`layout.json` under the plugin's DSH state directory), which is why the
 * panel survives a cache clear, a different browser, and a change of the
 * address it is opened at — `127.0.0.1` and `localhost` are
 * different storage origins, so a browser-side store would silently forget.
 *
 * Two rules shape everything here:
 *
 *   1. A stored order is a *hint*, never a filter. An id the file names but
 *      the catalogue no longer has is ignored; a capability the catalogue has
 *      gained since the file was written appears, at the end. Otherwise a
 *      newly registered tool would be invisible until someone reordered.
 *   2. Ordering is per section and only per section. "Move this card" always
 *      means "move it among its own kind" — a service cannot be dragged into
 *      the tool grid, because the two grids answer different questions.
 */

/**
 * The sections whose cards can be reordered. A closed set.
 *
 * The Host half validates against its own copy of this list (it cannot import
 * this module: the installed package ships only `dsh/`), and the contract test
 * asserts the two lists are equal, so adding a section here without adding it
 * there fails a test rather than failing silently at the write.
 */
export const LAYOUT_SECTIONS = ['services', 'tools']

/**
 * Shape marker.
 *
 * Written into the file so a future change to the payload can be *detected*
 * instead of misread: a document whose version is not this one is discarded
 * whole, which costs an ordering and never costs a wrong rendering.
 */
export const LAYOUT_VERSION = 1

/**
 * Caps on stored ids.
 *
 * These are not cosmetic: the Host refuses a request body over 32 KiB, so the
 * largest layout that fits is `LAYOUT_SECTIONS.length * MAX_IDS_PER_SECTION *
 * MAX_ID_LENGTH * 2` characters for order and display, plus JSON punctuation. A contract test asserts
 * that product still fits, so raising one of these without raising the body
 * cap turns red instead of producing writes the Host rejects.
 */
export const MAX_IDS_PER_SECTION = 64

/** Longest capability id we will store. The longest today is ~30 characters. */
export const MAX_ID_LENGTH = 64

/**
 * An empty layout: a document that orders nothing.
 *
 * @returns a layout with no section overridden.
 */
export function emptyLayout() {
  return { version: LAYOUT_VERSION, order: {} }
}

/**
 * Validate one untrusted layout document.
 *
 * Used by the browser half on what it reads and by the Host half on what it
 * writes, and it is deliberately structural: it does not know which ids exist,
 * only that a document claiming to be a layout must not be able to carry
 * anything else. A document that fails is replaced by an empty layout rather
 * than raising, because a corrupted preference must not be able to take the
 * console down.
 * @param value - decoded JSON of unknown shape.
 * @returns a valid layout, or an empty one.
 */
export function readLayout(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyLayout()
  if (value.version !== LAYOUT_VERSION) return emptyLayout()
  const source = value.order
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return emptyLayout()
  const order = {}
  for (const section of LAYOUT_SECTIONS) {
    // `hasOwnProperty`, not a truthiness check: a document carrying
    // `{"tools": "..."}` or an inherited key must not be read as an order.
    if (!Object.prototype.hasOwnProperty.call(source, section)) continue
    const ids = source[section]
    if (!Array.isArray(ids)) continue
    const kept = []
    for (const id of ids.slice(0, MAX_IDS_PER_SECTION)) {
      if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) continue
      // A duplicate would make the sort below non-deterministic in a way that
      // depends on the file's order, which is the one thing it must not do.
      if (kept.includes(id)) continue
      kept.push(id)
    }
    if (kept.length > 0) order[section] = kept
  }
  const display = {}
  for (const section of LAYOUT_SECTIONS) {
    const entry = value.display?.[section]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const stored = Array.isArray(entry.stored)
      ? [...new Set(entry.stored.filter(id => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH))].slice(0, MAX_IDS_PER_SECTION)
      : []
    display[section] = { mode: entry.mode === 'all' ? 'all' : 'resident', stored }
  }
  return { version: LAYOUT_VERSION, order, ...(Object.keys(display).length ? { display } : {}) }
}

/**
 * Apply a stored order to a catalogue section.
 *
 * A stable partition, not a sort: ids the file knows about come first in the
 * file's sequence, everything else follows in catalogue order. Stable matters
 * because the catalogue order is itself meaningful (registration order), and
 * it must remain the fallback for every capability the owner has not touched.
 * @param items - the catalogue section, in the order the Host reported.
 * @param ids - the stored order for this section; may be empty or partial.
 * @returns a new array; never drops, never duplicates, never mutates.
 */
export function orderedItems(items, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return items
  const rank = new Map()
  for (const id of ids) if (!rank.has(id)) rank.set(id, rank.size)
  const known = []
  const rest = []
  for (const item of items) (rank.has(item.id) ? known : rest).push(item)
  // Both halves keep their own order: `known` by rank, `rest` as given.
  known.sort((a, b) => rank.get(a.id) - rank.get(b.id))
  return known.concat(rest)
}

/**
 * Move one id to an insertion boundary.
 *
 * `toIndex` is a *boundary*, 0..length inclusive, which is what the drag
 * interaction actually has: the pointer sits between two cards, not on one.
 * Turning a boundary into an array index is where off-by-one bugs live, so it
 * happens once, here, and is tested directly.
 * @param ids - the section's ids in their current visual order.
 * @param id - the id to move.
 * @param toIndex - the boundary it should end up on.
 * @returns a new array, or the original when the move is a no-op.
 */
export function moveWithin(ids, id, toIndex) {
  const from = ids.indexOf(id)
  if (from === -1) return ids
  const rest = ids.slice()
  rest.splice(from, 1)
  // Removing the card shifts every boundary after it down by one, so a
  // rightward move must subtract one before clamping. Clamping last, not
  // first, so a boundary past the end lands at the end.
  const requested = toIndex > from ? toIndex - 1 : toIndex
  const at = Math.max(0, Math.min(rest.length, requested))
  rest.splice(at, 0, id)
  const unchanged = rest.every((value, index) => value === ids[index])
  return unchanged ? ids : rest
}

/**
 * Replace one section's order inside a layout.
 *
 * An empty list *removes* the section rather than storing `[]`. Both render
 * identically, but only one of them is a document that says "the owner has no
 * preference here" — and that is what makes the reset action a real reset.
 * @param layout - the layout to derive from.
 * @param section - one of `LAYOUT_SECTIONS`.
 * @param ids - the section's ids in their new order.
 * @returns a new layout.
 */
export function withSectionOrder(layout, section, ids) {
  const order = { ...layout.order }
  if (ids.length === 0) delete order[section]
  else order[section] = ids
  return { ...layout, version: LAYOUT_VERSION, order }
}

/** Display membership is explicit; new catalogue entries remain resident. */
export function sectionDisplay(layout, section) {
  return layout.display?.[section] ?? { mode: 'resident', stored: [] }
}

export function withSectionDisplay(layout, section, patch) {
  if (!LAYOUT_SECTIONS.includes(section)) return layout
  return readLayout({ ...layout, display: { ...layout.display, [section]: { ...sectionDisplay(layout, section), ...patch } } })
}

/** Search is a temporary projection over the complete catalogue, independent of mode. */
export function visibleItems(items, display, query) {
  const needle = query.trim().toLowerCase()
  if (needle) return items.filter(item => `${item.name ?? ''} ${item.id ?? ''} ${item.description ?? ''}`.toLowerCase().includes(needle))
  return display.mode === 'all' ? items : items.filter(item => !display.stored.includes(item.id))
}

/** Saving a drawer only changes choices the owner actually saw. */
export function mergeStoredChoices(stored, items, residentIds) {
  const shownIds = new Set(items.map(item => item.id))
  return [...new Set([...stored.filter(id => !shownIds.has(id)), ...items.filter(item => !residentIds.includes(item.id)).map(item => item.id)])]
}

/**
 * Whether a layout stores any preference at all.
 *
 * Drives whether the console offers a reset control: offering one on a
 * catalogue nobody has reordered is a button that does nothing.
 * @param layout - the layout to inspect.
 * @returns true when at least one section is overridden.
 */
export function hasCustomOrder(layout) {
  return LAYOUT_SECTIONS.some(section => (layout.order[section] ?? []).length > 0)
}
