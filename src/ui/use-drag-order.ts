/**
 * Reordering one grid of cards by dragging a grip.
 *
 * Three decisions worth stating, because each has a cheaper wrong version:
 *
 *  1. **A grip, not the whole card.** A card's body already opens its settings
 *     page on click. Making the same surface also start a drag means every
 *     click is a race, and the one that loses is the click. The grip is a real
 *     `<button>`, so it also carries the keyboard path.
 *  2. **An insertion line, not live reflow.** Grid cells are equal-sized, so
 *     reflowing during the drag means either re-rendering the array on every
 *     pointer move (the lifted card visibly jumps between cells) or lifting the
 *     card out of flow and reflowing the rest around a hole. A boundary line is
 *     unambiguous about where the card will land and costs one absolutely
 *     positioned span.
 *  3. **Boundaries, not indices.** The pointer sits *between* two cards, so the
 *     hook reports an insertion boundary in 0..n; turning that into an array
 *     index is `moveWithin`'s job and is tested there.
 *
 * Nothing here knows what a capability is: the hook is handed the visible id
 * order and reports a boundary, so it works for any of the console's sections
 * and for any future one.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** Gap between cards, in px; matches `.bp-grid`'s `gap`. Used to centre the line. */
const GAP = 12

/** How far the insertion line extends past the target card's corners. */
const INSET = 6

/**
 * The insertion boundary a pointer is nearest to.
 *
 * Reading order, row by row: above a card's row means "before that row";
 * inside a row, left of a card's centre means "before that card". Cards in one
 * row share a top and bottom because the grid stretches them, so this is a
 * clean test rather than a nearest-neighbour guess.
 * @param cards - the section's card elements, in DOM order.
 * @param x - pointer x in client coordinates.
 * @param y - pointer y in client coordinates.
 * @returns a boundary in 0..cards.length.
 */
function boundaryAt(cards, x, y) {
  for (let index = 0; index < cards.length; index += 1) {
    const rect = cards[index].getBoundingClientRect()
    if (y < rect.top) return index
    if (y <= rect.bottom && x < rect.left + rect.width / 2) return index
  }
  return cards.length
}

/**
 * Where to draw the line for a boundary.
 *
 * A boundary that lands on the first card of a row is really "after the last
 * card of the previous row", so it is drawn at that card's trailing edge
 * instead — which is where the card will actually appear.
 * @param cards - the section's card elements, in DOM order.
 * @param boundary - the boundary to mark.
 * @returns a grid-relative box, or null when there is nothing to draw.
 */
function lineAt(cards, boundary) {
  if (cards.length === 0) return null
  const line = (card, side) => ({
    left: side === 'before' ? card.offsetLeft - INSET : card.offsetLeft + card.offsetWidth + INSET - 1,
    top: card.offsetTop + INSET,
    height: Math.max(12, card.offsetHeight - INSET * 2),
  })
  if (boundary >= cards.length) return line(cards[cards.length - 1], 'after')
  const card = cards[boundary]
  const previous = cards[boundary - 1]
  if (previous && card.offsetTop > previous.offsetTop) return line(previous, 'after')
  return line(card, 'before')
}

/**
 * How far to step a boundary for a keyboard move.
 *
 * A rightward step has to clear the card's own slot: removing it first shifts
 * every later boundary down by one, so "one position right" is `+2` in
 * boundary terms, not `+1`.
 * @param index - the card's current index.
 * @param delta - `-1` or `1`.
 * @returns the boundary to move to.
 */
function stepBoundary(index, delta) {
  return delta < 0 ? index - 1 : index + 2
}

/**
 * Wire one section's grid for drag reordering.
 * @param options - the section key, the visible ids, whether reordering is
 *   allowed right now, and the commit callback.
 * @returns the props to spread onto the grid, and a factory for a card's grip.
 */
export function useDragOrder({ ids, enabled, onMove }) {
  const gridRef = useRef(null)
  const state = useRef(null)
  const [drag, setDrag] = useState(null)

  /**
   * Stop a drag and drop every trace of it.
   *
   * Called from three paths — pointerup, pointercancel and unmount — so it
   * owns the body dataset as well as the React state; a drag interrupted by a
   * re-render that unmounted the grid would otherwise leave the whole document
   * stuck on `cursor: grabbing`.
   */
  const end = useCallback(() => {
    state.current = null
    setDrag(null)
    if (typeof document !== 'undefined') document.body.removeAttribute('data-bp-drag')
  }, [])

  useEffect(() => end, [end])

  const cards = useCallback(
    () => [...(gridRef.current?.querySelectorAll('[data-card-id]') ?? [])],
    [],
  )

  /**
   * Recompute the insertion line for a pointer position.
   * @param x - pointer x in client coordinates.
   * @param y - pointer y in client coordinates.
   */
  const track = useCallback((x, y) => {
    const active = state.current
    if (!active) return
    const list = cards()
    const boundary = boundaryAt(list, x, y)
    if (boundary === active.boundary) return
    state.current = { ...active, boundary }
    setDrag({ id: active.id, index: active.index, boundary, line: lineAt(list, boundary) })
  }, [cards])

  /**
   * Start a drag from a card's grip.
   * @param event - the pointerdown on the grip.
   * @param id - the capability id of the card being dragged.
   */
  const begin = useCallback((event, id) => {
    if (!enabled) return
    const list = cards()
    const index = ids.indexOf(id)
    if (index === -1) return
    // The grip is the only thing that may start a drag, and it must keep every
    // subsequent pointer event: without capture a fast drag leaves the grip and
    // the move stream stops mid-gesture.
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    document.body.setAttribute('data-bp-drag', 'true')
    state.current = { id, index, boundary: index }
    setDrag({ id, index, boundary: index, line: lineAt(list, index) })
  }, [cards, enabled, ids])

  /**
   * Finish a drag, committing the move when it landed somewhere new.
   *
   * `pointerup` and `pointercancel` are distinguished: a cancelled gesture
   * (Escape, a lost pointer) must not reorder anything.
   * @param event - the pointer event that ended the gesture.
   */
  const finish = useCallback((event) => {
    const active = state.current
    if (!active) return
    if (event.type === 'pointerup' && active.boundary !== active.index && active.boundary !== active.index + 1) {
      onMove(active.id, active.boundary)
    }
    end()
  }, [end, onMove])

  useEffect(() => {
    if (!drag) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); end() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [drag, end])

  const gridProps = {
    ref: gridRef,
    'data-dragging': drag ? 'true' : undefined,
    onPointerMove: drag ? (event) => track(event.clientX, event.clientY) : undefined,
    onPointerUp: drag ? finish : undefined,
    onPointerCancel: drag ? finish : undefined,
  }

  /**
   * The props for one card's grip.
   *
   * The labels are passed in rather than written here: the framework layer
   * carries no copy, and a grip whose announcement is in the wrong language is
   * worse than one with none.
   * @param id - the capability id.
   * @param label - the accessible name, e.g. "Feishu Gateway · reorder".
   * @param hint - the tooltip describing the drag and keyboard affordances.
   * @returns props to spread onto the grip button, or null when not sortable.
   */
  const gripProps = (id, label, hint) => {
    if (!enabled) return null
    const index = ids.indexOf(id)
    return {
      type: 'button',
      'aria-label': label,
      title: hint,
      onPointerDown: (event) => begin(event, id),
      onKeyDown: (event) => {
        const delta = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key]
        if (delta === undefined) return
        // Up/Left on the first card, Down/Right on the last: nothing to do, and
        // swallowing the key would trap focus navigation for no reason.
        const target = stepBoundary(index, delta)
        if (target < 0 || target > ids.length) return
        event.preventDefault()
        onMove(id, target)
      },
    }
  }

  return { gridProps, gripProps, dragId: drag?.id ?? null, dropLine: drag?.line ?? null }
}
