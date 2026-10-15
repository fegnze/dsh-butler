/**
 * The rail and control glyphs for this package.
 *
 * The sidebar owns each button, its label, the collapsed tooltip and the
 * selected state; these components only draw at the edge length the rail asks
 * for. `active` is passed by the rail and deliberately ignored — colour comes
 * from `currentColor`, which the row already switches.
 */

/**
 * Render the workbench's panel layout in the sidebar's outline style.
 * @param props - the sidebar's icon share: requested edge length.
 * @returns the icon element.
 */
export function WorkbenchPanelIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M3 9h18M9 9v12" />
      </g>
    </svg>
  )
}

/**
 * Render the console's search glyph.
 *
 * Sized in `em` rather than px: it sits inside a control whose height comes
 * from the stylesheet, and an icon that carries its own scale fights that.
 * @param props - optional class name for the installing stylesheet.
 * @returns the icon element.
 */
export function SearchIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true" width="100%" height="100%">
      <circle cx="10.5" cy="10.5" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="m15 15 4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Render a drag grip: two columns of three dots.
 *
 * Drawn rather than typed so it never depends on the platform's font having a
 * braille or dingbat glyph, and stays crisp at the card's scale.
 * @param props - the requested edge length.
 * @returns the icon element.
 */
export function GripIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      {[2.5, 6, 9.5].map(y => (
        <g key={y}>
          <circle cx="4" cy={y} r="1.15" />
          <circle cx="8" cy={y} r="1.15" />
        </g>
      ))}
    </svg>
  )
}

/**
 * Render the console sliders.
 * @param props - the sidebar's icon share: requested edge length.
 * @returns the icon element.
 */
export function ConsoleIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
        <circle cx="16" cy="8" r="2" />
        <circle cx="10" cy="16" r="2" />
      </g>
    </svg>
  )
}

/**
 * Render the card's settings gear.
 * @param props - requested edge length.
 * @returns the icon element.
 */
export function GearIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8" />
      </g>
    </svg>
  )
}
