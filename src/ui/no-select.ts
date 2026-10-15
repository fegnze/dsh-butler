/**
 * Keep the left rail's controls from painting text-selection rectangles.
 *
 * Upstream's panel rows and "新会话" button compute to `user-select: auto`,
 * while the session tree below uses `none`. A double-click or a small drag can
 * therefore select the label text even though the control is a button. The
 * resulting blue rectangle looks like a second selected layer over the row.
 *
 * CSS is the first line of defence. A capturing `selectstart` guard is the
 * second: WebKit can establish a selection from rapid pointer gestures before
 * a late style recalculation, and HMR can briefly interleave old/new effects.
 * The guard is scoped to buttons in the sidebar shell, so conversation text
 * and every real text field remain selectable.
 */

/** The style element this plugin owns. */
const STYLE_ID = 'myspace-butler-panel-no-select'

/**
 * A semantic selector, not an upstream CSS-module hash.
 *
 * The first clause covers the global panel rail. The second covers the two
 * "新会话" controls immediately above it. `:has()` is available in the DSH
 * Chromium target and lets us anchor on the labelled nav without guessing the
 * shell's generated class.
 */
const CONTROL_SELECTOR = [
  'nav[aria-label] button',
  'button[aria-label="新建会话"]',
  'button[aria-label="New session"]',
].join(', ')

/** The rule text. `!important` is deliberate: this is a control invariant. */
const RULE = `
:where(${CONTROL_SELECTOR}) {
  -webkit-user-select: none !important;
  user-select: none !important;
  -webkit-touch-callout: none;
}
`

/**
 * Install the CSS and selection guard, returning a generation-safe disposer.
 *
 * Older code reused one style node and every disposer removed it. During HMR,
 * setup-new-before-teardown-old meant the old disposer deleted the live rule.
 * Each install now owns a unique token. Its disposer removes only the style
 * and listener created by that generation.
 * @returns a function removing only this installation.
 */
export function installNoSelectRule(): () => void {
  if (typeof document === 'undefined') return () => {}

  const previous = document.getElementById(STYLE_ID)
  const style = document.createElement('style')
  const token = `${Date.now()}-${Math.random()}`
  style.id = STYLE_ID
  style.dataset.owner = token
  style.dataset.plugin = 'myspace-butler-panel'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = RULE
  if (previous) previous.replaceWith(style)
  else document.head.append(style)

  const stopSelection = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    // Text inputs are real selection surfaces even when nested in a control.
    if (target.closest('input, textarea, [contenteditable="true"]')) return
    if (target.closest(CONTROL_SELECTOR)) {
      event.preventDefault()
      window.getSelection()?.removeAllRanges()
    }
  }
  document.addEventListener('selectstart', stopSelection, true)

  return () => {
    document.removeEventListener('selectstart', stopSelection, true)
    const live = document.getElementById(STYLE_ID)
    if (live?.dataset.owner === token) live.remove()
  }
}
