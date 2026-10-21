/**
 * The secondary interface: a tool's own settings page, shown in place.
 *
 * Every registered tool is a separate process serving its own admin page on
 * its own port (`http://127.0.0.1:37891/admin` and friends). Those pages are
 * not ours and never will be — reimplementing them would mean reimplementing
 * every tool. So this is the one surface in the console that is deliberately
 * an iframe rather than a rewrite: the rule is that whatever belongs to the
 * thing being replaced gets rewritten, and whatever merely *was referenced by*
 * it stays referenced.
 *
 * Checked before relying on this: neither the tool ports nor DSH itself sends
 * `X-Frame-Options` or a `frame-ancestors` policy, so the embed is allowed.
 * The frame also keeps its own origin, which is what lets the tool's own POSTs
 * pass its own CSRF checks — something a fetch from this page could not do.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Tell the embedded page which theme to draw.
 *
 * The Dashboard does the same (`app.js:63`), and the tools already read the
 * parameter. Without it a dark console opens a white rectangle.
 * @param url - the tool's panel URL.
 * @param theme - `dark` or `light`.
 * @returns the URL with a theme parameter appended.
 */
function withTheme(url, theme) {
  return url + (url.includes('?') ? '&' : '?') + 'theme=' + theme
}

/**
 * Read the theme DSH is currently drawing in.
 *
 * The authority is DSH's own presenter (dsh-client-ui-layout ThemePresenter):
 * it stamps `data-ds-dark-theme` on <body> for the dark palette and removes it
 * for light. The base stylesheet keys every `--dsw-alias-*` token off that
 * attribute, so its presence doubles as the "DSH theming is live" signal. Only
 * outside DSH (preview.html, tests) do we fall back to `data-theme` and the OS
 * media query — trusting the media query first would invert the frame whenever
 * the user pins DSH against the OS scheme.
 * @returns `dark` or `light`.
 */
function currentTheme() {
  if (typeof document === 'undefined') return 'light'
  const body = document.body
  if (body && getComputedStyle(body).getPropertyValue('--dsw-alias-bg-base').trim()) {
    return body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
  }
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark' || attr === 'light') return attr
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * The embedded admin pages share MySpace's neutral dashboard palette. Keep the
 * outer chrome on that same surface instead of using DSH's elevated blue
 * overlay token, which is intentionally different from a tool page.
 *
 * The mask, blur, radius and shadow below are the plugin's one dialog spec —
 * the briefing's detail viewer (panel-styles.ts, .bq-view*) reads the same
 * values. Change them here and there together, or the two dialogs drift back
 * into two skins.
 */
function panelPalette(theme) {
  return theme === 'dark'
    ? {
        surface: '#111318',
        text: '#eef1f6',
        muted: '#aeb6c3',
        line: '#3a414f',
        mask: 'rgba(0, 0, 0, 0.45)',
      }
    : {
        surface: '#ffffff',
        text: '#182033',
        muted: '#53627a',
        line: '#c4ccd8',
        mask: 'rgba(15, 17, 21, 0.30)',
      }
}

/**
 * Render the panel overlay.
 *
 * `panel` is `{ title, url }` or null; null renders nothing at all rather than
 * a hidden node, so a closed panel cannot keep a tool's page alive in the
 * background still polling its own backend.
 * @param props - the open panel and a close callback.
 * @returns the overlay element, or null when closed.
 */
const DEFAULT_PANEL_SIZE = { width: 1080, height: 720 }

function panelDimensions(size) {
  return {
    width: Math.min(2400, Math.max(320, Number.isInteger(size?.width) ? size.width : DEFAULT_PANEL_SIZE.width)),
    height: Math.min(1600, Math.max(240, Number.isInteger(size?.height) ? size.height : DEFAULT_PANEL_SIZE.height)),
  }
}

export function PanelModal({ panel, onClose, t }) {
  // Escape closes. Bound while open only: a listener that outlives the panel
  // would swallow Escape from whatever the user opens next.
  useEffect(() => {
    if (!panel) return undefined
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, onClose])

  // Follow theme changes while open. The overlay chrome is pure CSS variables
  // and repaints by itself; the embedded page cannot — it only learns the
  // theme from the URL parameter, so a flip has to reload it.
  const [theme, setTheme] = useState(currentTheme)
  useEffect(() => {
    if (!panel) return undefined
    const update = () => setTheme(currentTheme())
    const observer = new MutationObserver(update)
    // DSH currently writes the palette variables and dark marker to <body>.
    // Observe <html> as well: theme hosts are allowed to keep the palette on
    // the root and only change `color-scheme` or a class there. Watching both
    // prevents the iframe and the outer chrome from drifting apart after a
    // future presenter change.
    const targets = [document.body, document.documentElement].filter(Boolean)
    for (const target of targets) {
      observer.observe(target, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme', 'style', 'class'],
      })
    }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener?.('change', update)
    return () => {
      observer.disconnect()
      media?.removeEventListener?.('change', update)
    }
  }, [panel])

  if (!panel) return null
  const palette = panelPalette(theme)
  const dimensions = panelDimensions(panel.size)

  // Portal to the end of <body>. Chromium composites `-webkit-app-region` in
  // DOM order, not z-order: rendered inline, the host's later drag strips
  // (window title bar) override this header's `no-drag` button and swallow
  // the click on 关闭. Being the last node puts our regions on top.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={panel.title}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 40,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: palette.mask, backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', padding: 24,
      }}
    >
      {window.location.protocol === 'dsh-app:' ? <div aria-hidden="true" onClick={event => event.stopPropagation()} style={{ position: 'fixed', top: 0, left: 90, right: 0, height: 28, WebkitAppRegion: 'drag' }} /> : null}
      {/* The box stops the click that the backdrop uses to close, so a click
          inside the tool's own page does not dismiss it. */}
      <div
        onClick={event => event.stopPropagation()}
        style={{
          display: 'flex', flexDirection: 'column',
          width: `min(${dimensions.width}px, calc(100vw - 48px))`, height: `min(${dimensions.height}px, calc(100vh - 48px))`,
          borderRadius: 14, overflow: 'hidden',
          // Use the same base surface as the embedded tool, not DSH's elevated
          // overlay surface. `bg-overlay` is intentionally blue/elevated in
          // DSH dark mode, while tool pages normally start from `bg-base`; using
          // the former made the title bar look like a separate window chrome.
          // The fallbacks only apply outside DSH.
          background: palette.surface,
          color: palette.text,
          border: `1px solid ${palette.line}`,
          boxShadow: '0 24px 64px rgba(15, 17, 21, 0.3), 0 4px 14px rgba(15, 17, 21, 0.16)',
        }}
      >
        <header style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 14px',
          background: palette.surface,
          borderBottom: `1px solid ${palette.line}`,
          flexShrink: 0,
          WebkitAppRegion: window.location.protocol === 'dsh-app:' ? 'drag' : undefined,
        }}
        >
          <span style={{ fontSize: 13, fontWeight: 500 }}>{panel.title}</span>
          <span style={{
            fontSize: 11, fontFamily: 'ui-monospace, monospace',
            color: palette.muted, opacity: 0.78,
          }}>
            {panel.url}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('panel.close')}
            style={{
              WebkitAppRegion: 'no-drag',
              marginLeft: 'auto', fontSize: 12, padding: '3px 10px',
              borderRadius: 6, border: `1px solid ${palette.line}`,
              background: 'transparent', cursor: 'pointer',
              color: palette.text,
            }}
          >
            {t('panel.close')}
          </button>
        </header>
        <iframe
          key={panel.url + ':' + theme}
          src={withTheme(panel.url, theme)}
          title={panel.title}
          style={{ flex: 1, width: '100%', border: 'none', background: 'transparent' }}
        />
      </div>
    </div>,
    document.body,
  )
}
