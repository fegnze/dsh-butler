/**
 * The panel's stylesheet — the console and the briefing share it.
 *
 * Inline styles got the first version of this page drawn, and then got it
 * stuck: hover, focus, drag and sticky states cannot be expressed inline, and
 * a page of `rgba(128,128,128,…)` literals has no opinion about theme. DSH
 * ships a full design-token set — typography scale, alias colours, borders,
 * elevation — so this file reads *those* instead of inventing values. That is
 * what makes the console change with the theme, and what makes a card's edge
 * the same edge as DSH's own panels.
 *
 * One sheet for both surfaces is deliberate: the briefing used to carry its
 * own vocabulary and its own white gradients, which read as a second skin
 * pasted next to the console. Now the two share the token block and the
 * component classes (bp-head / bp-tile / bp-btn / bp-chip / bp-dot / bp-note),
 * and each keeps only the layout it owns.
 *
 * Scope: everything is under `.bp-` (console) or `.bq-` (briefing), and the
 * sheet is installed once per plugin generation.
 */

/** The style element this stylesheet owns. */
const STYLE_ID = 'myspace-butler-panel-console'

/**
 * The identity marks.
 *
 * Eight hues, tuned per theme rather than derived: a saturated mid-tone that
 * reads on white is a muddy smudge on `#151517`, and a pastel that reads on
 * dark is invisible on white. Both lists keep the hue order aligned so a card
 * keeps its colour when the theme flips.
 */
const MARKS = [
  ['#3B5BDB', '#91A7FF'],
  ['#0B7285', '#66D9E8'],
  ['#9A6400', '#FFD43B'],
  ['#7048E8', '#B197FC'],
  ['#C2255C', '#F783AC'],
  ['#2B8A3E', '#8CE99A'],
  ['#1864AB', '#74C0FC'],
  ['#D9480F', '#FFA94D'],
]

/**
 * One `data-hue` rule per mark, in both themes.
 *
 * The fill is the same hue at a low alpha so the mark stays a *tinted* tile
 * over the translucent card rather than an opaque sticker that breaks the
 * glass. The glyph is the hue itself, which is what carries the contrast.
 * @returns the mark rules.
 */
function markRules() {
  return MARKS.map(([light, dark], index) => {
    const fill = (hex, alpha) => `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`
    return `
.bp-tile__mark[data-hue="${index}"] { background: ${fill(light, 0.12)}; color: ${light}; }
body[data-ds-dark-theme] .bp-tile__mark[data-hue="${index}"] { background: ${fill(dark, 0.18)}; color: ${dark}; }`
  }).join('')
}

/**
 * The sheet.
 *
 * Written as one template so the order of the cascade is visible in one place;
 * section comments mark the layers.
 */
const CSS = `
/* ── local tokens ─────────────────────────────────────────────────────── */
/* Both surfaces (the console's .bp-console, the briefing's .bq-brief) declare
   the same names, so a component class dropped into either one resolves
   identically. The values live here exactly once. */
.bp-console,
.bq-brief {
  --bp-ink-1: var(--dsw-alias-label-primary);
  --bp-ink-2: var(--dsw-alias-label-secondary);
  --bp-ink-3: var(--dsw-alias-label-tertiary);
  --bp-ink-4: var(--dsw-alias-label-caption);
  --bp-hair: var(--dsw-alias-border-l2);
  --bp-hair-strong: var(--dsw-alias-border-l3);
  --bp-hover: var(--dsw-alias-interactive-bg-hover);
  --bp-ok: var(--dsw-alias-state-success-primary);
  --bp-warn: var(--dsw-alias-state-warn-primary);
  --bp-bad: var(--dsw-alias-state-error-primary);
  --bp-idle: var(--dsw-alias-label-caption);
  /* Frosted, not opaque: the canvas still shows through, but the card is
     lighter than it, which is what makes it read as a raised surface. */
  --bp-tile-a: rgba(255, 255, 255, 0.9);
  --bp-tile-b: rgba(255, 255, 255, 0.56);
  --bp-tile-solid: rgba(255, 255, 255, 0.72);
  --bp-band: rgba(255, 255, 255, 0.66);
  --bp-lift: 0 1px 2px rgba(15, 17, 21, 0.06);
  --bp-lift-hover: 0 6px 16px rgba(15, 17, 21, 0.1), 0 1px 3px rgba(15, 17, 21, 0.06);
  --bp-lift-drag: 0 14px 30px rgba(15, 17, 21, 0.18), 0 2px 6px rgba(15, 17, 21, 0.1);
}
body[data-ds-dark-theme] .bp-console,
body[data-ds-dark-theme] .bq-brief {
  --bp-tile-a: rgba(255, 255, 255, 0.06);
  --bp-tile-b: rgba(255, 255, 255, 0.02);
  --bp-tile-solid: rgba(255, 255, 255, 0.05);
  --bp-band: rgba(21, 21, 23, 0.62);
  --bp-lift: 0 1px 2px rgba(0, 0, 0, 0.4);
  --bp-lift-hover: 0 8px 20px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.4);
  --bp-lift-drag: 0 18px 36px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.45);
}

/* ── the workbench switch: lives inside each page's own title bar ─────── */
.bp-switch { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--bp-hair); border-radius: 8px; background: var(--bp-band); }
.bp-switch__tab { padding: 4px 12px; border: 0; border-radius: 6px; background: transparent; color: var(--bp-ink-3); font: 500 13px/20px var(--dsw-font-family); cursor: pointer; transition: background-color 0.12s ease, color 0.12s ease; }
.bp-switch__tab:hover { color: var(--bp-ink-1); }
.bp-switch__tab[aria-selected="true"] { background: var(--bp-tile-a); color: var(--bp-ink-1); box-shadow: var(--bp-lift); }
.bp-switch__tab:focus-visible { outline: 2px solid var(--bp-ink-3); outline-offset: 1px; }
.bp-switch__tab[aria-pressed="true"] { background: var(--bp-tile-a); color: var(--bp-ink-1); box-shadow: var(--bp-lift); }
.bp-switch--small { padding: 2px; border-radius: 8px; }
.bp-switch--small .bp-switch__tab { padding: 2px 10px; border-radius: 6px; font: 500 12px/20px var(--dsw-font-family); }
.bp-head > .bp-switch { flex: none; }

/* The Butler tab hosts the card page under the shared title bar. The card page
   scrolls itself, so the shell becomes a column and stops scrolling; the card
   page drops its own padding to sit on the same 16px inset as the bar. */
.bp-console[data-bench="butler"] { display: flex; flex-direction: column; overflow: hidden; padding-bottom: 0; }
.bp-console[data-bench="butler"] > .bp-head { flex: none; }
.bp-console[data-bench="butler"] > .bcp { flex: 1 1 0; height: auto; min-height: 0; padding: 0 16px 36px; }

/* ── page shell ───────────────────────────────────────────────────────── */
.bp-console {
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  padding: 0 clamp(16px, 2.4vw, 32px) 36px;
  font-family: var(--dsw-font-family);
  font-size: 13px;
  color: var(--bp-ink-1);
  -webkit-font-smoothing: antialiased;
}
.bp-console[data-wide="false"] { padding: 0 16px 22px; }

.bp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  box-sizing: border-box;
  min-height: 56px;
  padding: 10px 12px;
  /* The bar keeps the same 16px inset as every content group below it. It used
     to span the whole slot while the groups were inset, which left the bar
     32px wider than the content it heads. */
  margin: 12px 16px 0;
  /* Share the cards' surface and border in every theme. */
  position: static;
  background: linear-gradient(180deg, var(--bp-tile-a), var(--bp-tile-b));
  border: 1px solid var(--bp-hair);
  border-radius: 12px;
  box-shadow: var(--bp-lift);
}

/* The title bar and every content group keep the same 16px inset from the page
   slot, so the bar's edges line up with the content beneath it. */
.bp-console > .bp-sec {
  margin-left: 16px;
  margin-right: 16px;
}
.bp-console > .bp-sec:last-child { margin-bottom: 0; }

/* The float skin uses substring selectors such as [class*="card"]. Match
   its specificity without flattening the glass shell. Only the card internals
   and their separator surfaces are made stable and legible. */
[data-dsh-float] .bp-tile {
  border-radius: 12px;
  border-color: var(--bp-hair-strong);
}
[data-dsh-float] .bp-tile__head,
[data-dsh-float] .bp-tile__mark,
[data-dsh-float] .bp-tile__foot,
[data-dsh-float] .bp-tile__acts {
  border-radius: inherit;
}
[data-dsh-float] .bp-tile__foot {
  background: var(--bp-tile-solid);
  border-top-color: var(--bp-hair-strong);
}
[data-dsh-float] .bp-btn,
[data-dsh-float] .bp-chip,
[data-dsh-float] .bp-search {
  border-color: var(--bp-hair-strong);
  background: var(--bp-tile-solid);
}
/* Match the space between sections; headings sit closer to their own cards. */
.bp-console > .bp-head { margin-bottom: 16px; }
.bp-head__title { margin: 0; font: 600 13.5px/20px var(--dsw-font-family); letter-spacing: -0.005em; }
.bp-head__sub { font: 12px/18px var(--dsw-font-family); color: var(--bp-ink-3); }
.bp-head > .bp-switch .bp-switch__tab { font-weight: 600; }
.bp-head > .bp-search { box-sizing: border-box; }
.bp-head__spacer { flex: 1 1 auto; }
.bp-head__meta { font: var(--dsw-font-xxxs-11); color: var(--bp-ink-4); }

/* ── controls ─────────────────────────────────────────────────────────── */
.bp-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  min-width: 168px;
  border: 1px solid var(--bp-hair);
  border-radius: 8px;
  background: var(--bp-tile-solid);
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.bp-search:focus-within {
  border-color: var(--bp-hair-strong);
  box-shadow: 0 0 0 3px var(--bp-hover);
}
.bp-search__icon { flex: none; width: 13px; height: 13px; color: var(--bp-ink-4); }
.bp-search input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--bp-ink-1);
  font: var(--dsw-font-xxs-12);
}
.bp-search input::placeholder { color: var(--bp-ink-4); }
.bp-search__clear {
  flex: none; width: 16px; height: 16px; padding: 0; line-height: 1;
  border: 0; border-radius: 999px; background: transparent;
  color: var(--bp-ink-4); cursor: pointer; font-size: 13px;
}
.bp-search__clear:hover { background: var(--bp-hover); color: var(--bp-ink-2); }

.bp-btn {
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--bp-hair);
  border-radius: 8px;
  background: var(--bp-tile-solid);
  color: var(--bp-ink-2);
  font: var(--dsw-font-xxs-strong-12);
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.bp-btn:hover:not(:disabled) { background: var(--bp-hover); border-color: var(--bp-hair-strong); color: var(--bp-ink-1); }
.bp-btn:active:not(:disabled) { transform: translateY(0.5px); }
.bp-btn:disabled { opacity: 0.45; cursor: default; }
.bp-btn--ghost { background: transparent; border-color: transparent; color: var(--bp-ink-3); padding: 0 8px; }
.bp-btn--ghost:hover:not(:disabled) { background: var(--bp-hover); border-color: transparent; color: var(--bp-ink-1); }
.bp-btn--danger:hover:not(:disabled) { color: var(--bp-bad); border-color: var(--bp-bad); }

:where(.bp-btn, .bp-grip, .bp-search__clear, .bp-tile__open):focus-visible {
  outline: 2px solid var(--bp-ink-1);
  outline-offset: 2px;
}

/* ── 工作流 observation: SDK runner traces ────────────────────────────── */
/* The section sits first in the console: it is the live part of the page.
   Idle it collapses to its heading line, so it costs one row, not a block. */
.bp-runs[data-idle="true"] .bp-catalog-section-heading { margin-bottom: 0; }
.bp-runs__list { display: grid; gap: 10px; }
/* Brief highlight when a run was just routed here from elsewhere. */
@keyframes bp-runs-flash { from { box-shadow: 0 0 0 3px color-mix(in srgb, var(--bp-warn) 45%, transparent); } to { box-shadow: 0 0 0 3px transparent; } }
.bp-trace[data-flash="true"] { animation: bp-runs-flash 1.6s ease-out 1; }

/* Nudge in the frame overlay: only when the owner is on some other page.
   Literal surface colours: the overlay is outside any page surface, and a
   host bg alias may resolve to glass (see MEMORY: literal surface colours). */
/* The nudge lives outside both surfaces, so it borrows the ink/hair/state
   tokens it uses (same values as the block at the top of this sheet). */
.bp-nudge {
  --bp-ink-1: var(--dsw-alias-label-primary);
  --bp-ink-2: var(--dsw-alias-label-secondary);
  --bp-ink-3: var(--dsw-alias-label-tertiary);
  --bp-ink-4: var(--dsw-alias-label-caption);
  --bp-hair: var(--dsw-alias-border-l2);
  --bp-hair-strong: var(--dsw-alias-border-l3);
  --bp-hover: var(--dsw-alias-interactive-bg-hover);
  --bp-ok: var(--dsw-alias-state-success-primary);
  --bp-warn: var(--dsw-alias-state-warn-primary);
  --bp-bad: var(--dsw-alias-state-error-primary);
  --bp-tile-solid: rgba(255, 255, 255, 0.72);
}
.bp-nudge {
  position: fixed; right: 20px; bottom: 20px; z-index: 70;
  pointer-events: auto;
  display: flex; align-items: center; gap: 10px;
  max-width: min(420px, calc(100vw - 40px));
  padding: 10px 10px 10px 14px;
  border: 1px solid var(--bp-hair-strong);
  border-radius: 12px;
  background: #ffffff;
  color: var(--bp-ink-1);
  box-shadow: 0 10px 28px rgba(15, 17, 21, 0.16), 0 1px 3px rgba(15, 17, 21, 0.08);
}
body[data-ds-dark-theme] .bp-nudge { background: #1b1d22; box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5); }
.bp-nudge[data-reason="await"] { border-color: color-mix(in srgb, var(--bp-warn) 55%, var(--bp-hair-strong)); }
.bp-nudge__text { display: grid; min-width: 0; flex: 1 1 auto; }
.bp-nudge__label { font: var(--dsw-font-xxxs-11); color: var(--bp-ink-3); }
.bp-nudge__title { font: var(--dsw-font-xs-strong-13); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bp-nudge .bp-btn { flex: none; }
.bp-trace {
  border: 1px solid var(--bp-hair);
  border-radius: 12px;
  background: linear-gradient(180deg, var(--bp-tile-a), var(--bp-tile-b));
  box-shadow: var(--bp-lift);
  padding: 12px 14px;
  min-width: 0;
}
.bp-trace[data-status="error"], .bp-trace[data-status="interrupted"] { border-color: color-mix(in srgb, var(--bp-bad) 45%, var(--bp-hair)); }
.bp-trace__head { display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; }
.bp-trace__title { font: var(--dsw-font-xs-strong-13); overflow-wrap: anywhere; }
.bp-trace__target { font: var(--dsw-font-xxs-12); color: var(--bp-ink-3); max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bp-trace__meta { font: var(--dsw-font-xxs-12); color: var(--bp-ink-3); font-variant-numeric: tabular-nums; }
.bp-trace__error { margin-top: 8px; font: var(--dsw-font-xxs-12); color: var(--bp-bad); overflow-wrap: anywhere; }
.bp-trace__confirm { margin-top: 10px; padding: 10px 12px; display: grid; gap: 8px; border: 1px solid color-mix(in srgb, var(--bp-warn) 45%, var(--bp-hair)); border-radius: 10px; background: color-mix(in srgb, var(--bp-warn) 6%, transparent); }
.bp-trace__confirm-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.bp-trace__confirm-step { font: 600 13px/18px var(--dsw-font-family); color: var(--bp-ink-1); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bp-trace__confirm-head .bp-link { margin-left: auto; }
.bp-trace__confirm-summary { margin: 0; font: var(--dsw-font-xxs-12); color: var(--bp-ink-1); line-height: 1.6; }
.bp-trace__confirm-items { margin: 0; padding-left: 18px; font: var(--dsw-font-xxs-12); color: var(--bp-ink-2); line-height: 1.6; overflow-wrap: anywhere; max-height: 160px; overflow: auto; }
.bp-trace__confirm-acts { display: flex; justify-content: flex-end; gap: 8px; }
.bp-trace__links { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 12px; font: var(--dsw-font-xxs-12); }
.bp-flow__node[data-status="awaiting"] { border-color: var(--bp-warn); }
.bp-flow__node[data-status="awaiting"] .bp-flow__mark { background: var(--bp-warn); color: #fff; }
.bp-flow { display: flex; flex-wrap: wrap; align-items: center; row-gap: 12px; margin: 14px 0 2px; padding: 0; }
.bp-flow__tail { display: inline-flex; align-items: center; }
/* start / end terminals */
.bp-flow__term { display: inline-flex; align-items: center; gap: 6px; font: var(--dsw-font-xxs-12); color: var(--bp-ink-3); padding: 0 2px; }
.bp-flow__term-dot { width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--bp-ink-3); background: transparent; box-sizing: border-box; }
.bp-flow__term[data-state="on"] .bp-flow__term-dot { border-color: var(--bp-ok); background: var(--bp-ok); }
.bp-flow__term[data-state="ok"] .bp-flow__term-dot { border-color: var(--bp-ok); background: var(--bp-ok); box-shadow: 0 0 0 4px color-mix(in srgb, var(--bp-ok) 22%, transparent); }
.bp-flow__term[data-state="bad"] .bp-flow__term-dot { border-color: var(--bp-bad); background: var(--bp-bad); }
/* connectors: a track, plus a moving pulse while the next node is running */
.bp-flow__edge { position: relative; flex: 0 0 auto; width: 44px; height: 2px; margin: 0 6px; border-radius: 2px; background: var(--bp-hair); overflow: hidden; }
.bp-flow__edge[data-state="done"] { background: var(--bp-ok); }
.bp-flow__edge[data-state="error"] { background: var(--bp-bad); }
.bp-flow__edge[data-state="flowing"] {
  background: repeating-linear-gradient(90deg, var(--bp-warn) 0 6px, transparent 6px 11px);
  background-size: 22px 2px;
  animation: bp-edge-march 0.6s linear infinite;
}
.bp-flow__edge > i { position: absolute; top: -2px; left: -10px; width: 10px; height: 6px; border-radius: 3px; opacity: 0; }
.bp-flow__edge[data-state="flowing"] > i { opacity: 1; background: radial-gradient(circle, #fff 0 35%, var(--bp-warn) 70%); box-shadow: 0 0 8px var(--bp-warn); animation: bp-edge-pulse 1.1s ease-in infinite; }
.bp-flow__edge[data-state="done"] > i { opacity: 0; }
@keyframes bp-edge-march { to { background-position: 22px 0; } }
@keyframes bp-edge-pulse { from { left: -10px; } to { left: 100%; } }
/* step nodes */
.bp-flow__node {
  display: inline-flex; align-items: center; gap: 9px; min-width: 128px; max-width: 260px;
  padding: 8px 12px 8px 9px; border: 1px solid var(--bp-hair); border-radius: 10px;
  background: var(--bp-tile-solid); box-shadow: var(--bp-lift);
  transition: border-color .25s ease, box-shadow .25s ease, opacity .25s ease;
}
.bp-flow__body { display: grid; min-width: 0; }
.bp-flow__name { font: var(--dsw-font-xs-strong-13); color: var(--bp-ink-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bp-flow__sub { font: var(--dsw-font-xxs-12); color: var(--bp-ink-3); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bp-flow__mark { flex: 0 0 auto; display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; font-size: 11px; font-weight: 600; background: var(--bp-hover); color: var(--bp-ink-3); }
.bp-flow__node[data-status="pending"] { opacity: 0.6; border-style: dashed; }
.bp-flow__node[data-status="skipped"] { opacity: 0.45; border-style: dashed; }
.bp-flow__node[data-status="success"] .bp-flow__mark { background: var(--bp-ok); color: #fff; }
.bp-flow__node[data-status="error"] { border-color: var(--bp-bad); box-shadow: 0 0 0 3px color-mix(in srgb, var(--bp-bad) 16%, transparent); }
.bp-flow__node[data-status="error"] .bp-flow__mark { background: var(--bp-bad); color: #fff; }
.bp-flow__node[data-status="error"] .bp-flow__sub { color: var(--bp-bad); }
.bp-flow__node[data-status="running"] { border-color: var(--bp-warn); animation: bp-node-glow 1.4s ease-in-out infinite; }
.bp-flow__node[data-status="running"] .bp-flow__mark { background: transparent; color: transparent; border: 2px solid color-mix(in srgb, var(--bp-warn) 30%, transparent); border-top-color: var(--bp-warn); box-sizing: border-box; animation: bp-spin 0.8s linear infinite; }
@keyframes bp-node-glow { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--bp-warn) 22%, transparent); } }
@keyframes bp-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .bp-flow__edge[data-state="flowing"], .bp-flow__edge > i, .bp-flow__node[data-status="running"], .bp-flow__node[data-status="running"] .bp-flow__mark { animation: none; }
}

/* ── sections ─────────────────────────────────────────────────────────── */
.bp-sec { margin-bottom: 16px; }
.bp-catalog-section-heading {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 9px;
  box-sizing: border-box;
  min-height: 44px;
  padding: 8px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--bp-hair);
  border-radius: 9px;
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.bp-catalog-section-heading > .bp-sec__title,
.bp-catalog-section-heading > .bp-sec__count,
.bp-catalog-section-heading > .bp-sec__rule,
.bp-catalog-section-heading > .bp-sec__hint { position: relative; }
.bp-sec__title { margin: 0; font: 600 13px/20px var(--dsw-font-family); letter-spacing: -0.005em; }
.bp-sec__count {
  min-width: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bp-hover);
  color: var(--bp-ink-3);
  font: var(--dsw-font-xxxs-strong-11);
  line-height: 17px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
/* Keep the right-hand controls aligned with whitespace, without a divider. */
.bp-sec__rule { flex: 1 1 auto; }
.bp-sec__hint { font: var(--dsw-font-xxxs-11); color: var(--bp-ink-4); }
/* Display is a view mode; the section itself always remains present. */
.bp-catalog-section-heading:has(.bp-display-switch) { flex-wrap: wrap; }
.bp-display-switch { display: flex; align-items: center; gap: 8px; padding: 3px 0; border: 0; border-radius: 6px; background: transparent; color: var(--bp-ink-1); font: inherit; cursor: pointer; }
.bp-display-switch:disabled { cursor: default; }
.bp-display-switch:focus-visible { outline: 2px solid var(--bp-ink-1); outline-offset: 3px; }
.bp-display-chevron { display: inline-flex; justify-content: center; align-items: center; width: 12px; height: 18px; font: 22px/18px system-ui; color: var(--bp-ink-3); transition: transform 180ms ease; }
.bp-display-chevron[data-all="true"] { transform: rotate(90deg); }
.bp-display-mode { font: 400 11px/18px var(--dsw-font-family); color: var(--bp-ink-3); white-space: nowrap; }
.bp-display-manage { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.bp-display-manage svg { width: 14px; height: 14px; flex: none; }
.bp-display-manage > span { color: var(--bp-ink-3); }
.bp-section-content { padding: 2px; margin: -2px; }
.bp-resident-empty { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 12px; min-height: 76px; border-radius: 10px; background: var(--bp-hover); color: var(--bp-ink-3); font: 12px/18px var(--dsw-font-family); }
.bp-search-scope { margin: 0 16px 12px; color: var(--bp-ink-3); font: 12px/18px var(--dsw-font-family); }
.bp-stored-label { display: inline-block; margin-top: 4px; padding: 1px 5px; border-radius: 4px; background: var(--bp-hover); color: var(--bp-ink-3); font: 10px/15px var(--dsw-font-family); }
.bp-display-menu { flex: none; }
.bp-display-menu > .bp-grip { cursor: pointer; }
.bp-display-menu__popover { display: grid; gap: 2px; position: absolute; right: 12px; top: 39px; z-index: 3; padding: 5px; border: 1px solid var(--bp-hair-strong); border-radius: 9px; background: #fff; box-shadow: var(--bp-lift-hover); }
body[data-ds-dark-theme] .bp-display-menu__popover { background: #111318; }
.bp-display-menu__popover .bp-btn { border-color: transparent; }
/* Same dialog spec as .bq-view / PanelModal: dimmed, blurred mask and an
   OPAQUE sheet. --bp-tile-a is a frosted card fill (6% white in dark mode), so
   using it here let the console's cards show straight through the form. */
.bp-editor-backdrop { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 20px; background: rgba(15, 17, 21, 0.30); backdrop-filter: blur(6px) saturate(1.15); -webkit-backdrop-filter: blur(6px) saturate(1.15); }
body[data-ds-dark-theme] .bp-editor-backdrop { background: rgba(0, 0, 0, 0.45); }
.bp-console .bp-editor.bp-editor,
.bq-brief .bp-editor.bp-editor { width: min(520px, 100%); max-height: 90vh; overflow: auto; display: grid; gap: 12px; padding: 18px; border: 1px solid var(--bp-hair-strong); border-radius: 14px; background: #fff; color: var(--bp-ink-1); box-shadow: 0 24px 64px rgba(15, 17, 21, 0.3), 0 4px 14px rgba(15, 17, 21, 0.16); }
body[data-ds-dark-theme] .bp-console .bp-editor.bp-editor,
body[data-ds-dark-theme] .bq-brief .bp-editor.bp-editor { background: #111318; border-color: rgba(148, 180, 220, 0.2); box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5), 0 4px 14px rgba(0, 0, 0, 0.35); }
/* Behind tool/config dialogs, above the workbench. */
.bp-editor-backdrop.bp-display-backdrop { z-index: 35; place-items: stretch end; padding: 12px; }
.bp-console .bp-editor.bp-display-drawer { box-sizing: border-box; width: min(460px, 100%); max-height: calc(100dvh - 24px); display: flex; flex-direction: column; gap: 12px; overflow: hidden; animation: bp-drawer-in 180ms ease-out; }
.bp-display-drawer > .bp-editor__head, .bp-display-drawer > .bp-editor__note, .bp-display-summary, .bp-display-footer { flex: none; }
.bp-display-summary { display: flex; gap: 14px; padding: 9px 12px; border-radius: 8px; background: var(--bp-hover); color: var(--bp-ink-2); font: 12px/18px var(--dsw-font-family); }
.bp-display-list { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.bp-display-row { padding: 14px 2px; border-bottom: 1px solid var(--bp-hair); }
.bp-display-row:last-child { border-bottom: 0; }
.bp-display-row__identity { display: flex; gap: 10px; align-items: center; }
.bp-display-row__name { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.bp-display-row__name strong { font: 600 13px/18px var(--dsw-font-family); overflow-wrap: anywhere; }
.bp-display-row__state { display: flex; gap: 5px; align-items: center; color: var(--bp-ink-3); font: 11px/16px var(--dsw-font-family); }
.bp-editor label.bp-resident-choice { display: inline-flex; align-items: center; gap: 5px; flex: none; cursor: pointer; }
.bp-resident-choice input { width: 14px; height: 14px; padding: 0; margin: 0; accent-color: var(--bp-ink-1); }
.bp-display-row__actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; margin-top: 10px; }
.bp-display-footer { display: flex; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--bp-hair); }
.bp-display-footer > span { margin-right: auto; color: var(--bp-ink-3); font: 11px/16px var(--dsw-font-family); }
@keyframes bp-drawer-in { from { transform: translateX(16px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .bp-display-chevron { transition: none; } .bp-console .bp-editor.bp-display-drawer { animation: none; } }
.bp-console .bp-editor.bp-logview { width: min(920px, 100%); height: min(70vh, 640px); grid-template-rows: auto 1fr; }
.bp-logview__body { margin: 0; min-height: 0; overflow: auto; padding: 10px 12px; border: 1px solid var(--bp-hair); border-radius: 8px; background: var(--bp-hover); font: 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--bp-ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.bp-editor__note { margin: 0; font: var(--dsw-font-xxs-12); color: var(--bp-ink-3); line-height: 1.6; }
.bp-console .bp-editor.bp-editor[data-guide="true"] { width: min(760px, 100%); }
.bp-link { all: unset; cursor: pointer; color: var(--dsw-alias-brand-primary, #3b82f6); text-decoration: underline; text-underline-offset: 2px; }
.bp-link:focus-visible { outline: 2px solid var(--bp-hair-strong); outline-offset: 2px; border-radius: 3px; }
.bp-guide { border-top: 1px solid var(--bp-hair); padding-top: 4px; font: var(--dsw-font-xxs-12); line-height: 1.65; color: var(--bp-ink-2); }
.bp-guide h3 { margin: 14px 0 6px; font: var(--dsw-font-xs-strong-13); color: var(--bp-ink-1); }
.bp-guide ul { margin: 0; padding-left: 18px; display: grid; gap: 3px; }
.bp-guide p { margin: 8px 0 0; }
.bp-guide code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; padding: 0 4px; border-radius: 4px; background: var(--bp-hover); color: var(--bp-ink-1); }
.bp-guide__code { margin: 0; padding: 10px 12px; border: 1px solid var(--bp-hair); border-radius: 8px; background: var(--bp-hover); font: 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--bp-ink-1); overflow-x: auto; white-space: pre; }
.bp-guide__table { width: 100%; border-collapse: collapse; }
.bp-guide__table td { padding: 5px 8px; border-bottom: 1px solid var(--bp-hair); vertical-align: top; }
.bp-guide__table td:first-child { white-space: nowrap; width: 1%; }
.bp-guide__need { white-space: nowrap; width: 1%; color: var(--bp-ink-3); }
.bp-guide__need[data-required] { color: var(--bp-warn); }
.bp-editor__head, .bp-editor__acts { display: flex; align-items: center; gap: 8px; }
.bp-editor__head { justify-content: space-between; }
.bp-editor__head h2 { margin: 0; font: 600 15px/20px var(--dsw-font-family); }
.bp-editor label { display: grid; gap: 5px; font: var(--dsw-font-xxs-12); color: var(--bp-ink-2); }
.bp-editor input { min-width: 0; box-sizing: border-box; padding: 8px 9px; border: 1px solid var(--bp-hair); border-radius: 7px; background: transparent; color: inherit; font: inherit; }
.bp-editor input:disabled { opacity: .65; }
.bp-editor label.bp-editor__check { display: grid; grid-template-columns: auto 1fr; align-items: start; gap: 2px 8px; color: var(--bp-ink-1); }
.bp-editor label.bp-editor__check input { width: 15px; height: 15px; margin: 1px 0 0; padding: 0; accent-color: var(--bp-ink-1); }
.bp-editor__check small { grid-column: 2; color: var(--bp-ink-3); font: var(--dsw-font-xxs-12); }
.bp-iconpick { display: grid; gap: 7px; font: var(--dsw-font-xxs-12); color: var(--bp-ink-2); }
.bp-iconpick__row { display: flex; align-items: center; gap: 8px; }
.bp-editor input.bp-iconpick__text { width: 100%; }
.bp-editor__acts { justify-content: flex-end; margin-top: 4px; }
/* MCP 工具（设置弹层内只读段）：来源是 Butler 统一 MCP 服务的 /mcp/status。 */
.bp-mcp { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--bp-hair); }
.bp-mcp__head { display: flex; align-items: center; gap: 6px; }
.bp-mcp__head h3 { margin: 0 auto 0 0; font: 600 13px/18px var(--dsw-font-family); color: var(--bp-ink-1); }
.bp-mcp__endpoint { display: flex; align-items: center; gap: 8px; }
.bp-mcp__endpoint code { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--bp-hair); border-radius: 7px; background: var(--bp-hover); font: 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--bp-ink-1); overflow-wrap: anywhere; }
.bp-mcp__tools { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; max-height: 240px; overflow: auto; }
.bp-mcp__tools li { display: grid; gap: 2px; }
.bp-mcp__tools code { font: 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--bp-ink-1); }
.bp-mcp__tools small { font: var(--dsw-font-xxs-12); color: var(--bp-ink-3); line-height: 1.5; }
.bp-editor__kinds { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.bp-editor__kinds .bp-btn { height: 34px; }
.bp-editor__kinds .bp-btn[aria-pressed="true"] { background: var(--bp-hover); border-color: var(--bp-hair-strong); color: var(--bp-ink-1); }
.bp-editor select { min-width: 0; box-sizing: border-box; padding: 8px 9px; border: 1px solid var(--bp-hair); border-radius: 7px; background: transparent; color: inherit; font: inherit; }
.bp-editor label.bp-editor__check { display: flex; align-items: center; gap: 7px; }
.bp-tile[data-pending="true"] { opacity: 0.55; }
.bp-tile[data-tone="none"] .bp-tile__rail { background: transparent; }

/* ── the grid ─────────────────────────────────────────────────────────── */
.bp-grid {
  position: relative;
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(312px, 1fr));
  align-items: stretch;
}
.bp-console[data-wide="true"] .bp-sec[data-section] .bp-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 312px), 1fr)); }
.bp-console[data-wide="false"] .bp-grid { grid-template-columns: 1fr; gap: 10px; }

/* ── a card ───────────────────────────────────────────────────────────── */
.bp-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--bp-hair);
  border-radius: 12px;
  background: linear-gradient(180deg, var(--bp-tile-a), var(--bp-tile-b));
  box-shadow: var(--bp-lift);
  overflow: hidden;
  transition: border-color 0.14s ease, box-shadow 0.14s ease, transform 0.14s ease;
}
.bp-tile::before {
  /* The lit top edge. Without it a translucent card on a light canvas has no
     top boundary and the grid reads as loose text. */
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  background: rgba(255, 255, 255, 0.75);
  pointer-events: none;
}
body[data-ds-dark-theme] .bp-tile::before { background: rgba(255, 255, 255, 0.07); }
.bp-tile:hover { border-color: var(--bp-hair-strong); box-shadow: var(--bp-lift-hover); }

/* The state rail: 3px of colour down the leading edge. This is the cue that
   makes "which of these are up" answerable without reading a single word. */
.bp-tile__rail {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--bp-idle);
  opacity: 0.9;
}
.bp-tile[data-tone="ok"] .bp-tile__rail { background: var(--bp-ok); }
.bp-tile[data-tone="warn"] .bp-tile__rail { background: var(--bp-warn); }
.bp-tile[data-tone="bad"] .bp-tile__rail { background: var(--bp-bad); }

.bp-tile__head { display: flex; align-items: flex-start; gap: 11px; padding: 13px 13px 11px; }

.bp-tile__mark {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  font: 600 12px/1 var(--dsw-font-family);
  letter-spacing: 0.01em;
  user-select: none;
}
${markRules()}
.bp-tile__mark--image { overflow: hidden; background: var(--bp-hover); }
.bp-tile__mark--image img { width: 100%; height: 100%; object-fit: cover; display: block; }
.bp-tile__mark--glyph { font-size: 17px; }

.bp-tile__open { display: block; min-width: 0; flex: 1 1 auto; border-radius: 6px; }
.bp-tile__open[data-clickable="true"] { cursor: pointer; }
.bp-tile__open[data-clickable="true"]:hover .bp-tile__name { text-decoration: underline; text-underline-offset: 2px; }
.bp-tile__name {
  margin: 0;
  font: 600 13.5px/19px var(--dsw-font-family);
  letter-spacing: -0.005em;
  overflow-wrap: anywhere;
}
.bp-tile__desc {
  margin: 3px 0 0;
  font: 12px/16.5px var(--dsw-font-family);
  color: var(--bp-ink-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  min-height: 33px;
}
.bp-tile__desc[data-bad="true"] { color: var(--bp-bad); }
.bp-tile__desc[data-idle="true"] { color: var(--bp-ink-4); }

/* ── the grip ─────────────────────────────────────────────────────────── */
.bp-grip {
  flex: none;
  width: 22px;
  height: 22px;
  margin: -1px -2px 0 0;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--bp-ink-4);
  opacity: 0.5;
  cursor: grab;
  display: grid;
  place-items: center;
  touch-action: none;
  transition: opacity 0.12s ease, background-color 0.12s ease;
}
.bp-tile:hover .bp-grip, .bp-grip:focus-visible { opacity: 1; }
.bp-grip:hover { background: var(--bp-hover); color: var(--bp-ink-2); }
.bp-grip:active, body[data-bp-drag] .bp-grip { cursor: grabbing; }
.bp-cfg { cursor: pointer; margin-right: 0; }
.bp-cfg:active { cursor: pointer; }
body[data-bp-drag] { cursor: grabbing; }
body[data-bp-drag] * { cursor: grabbing !important; user-select: none !important; }

/* ── the card's own controls ──────────────────────────────────────────── */
.bp-tile__foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  padding: 10px 12px 12px;
  border-top: 1px solid var(--bp-hair);
  background: var(--bp-tile-solid);
}
/* min-content = the state chip (the widest single item), so the chip is never
   clipped; the port is the only thing allowed to give way. */
.bp-tile__meta { flex: 1 1 0; min-width: min-content; display: flex; flex-wrap: wrap; align-items: center; align-content: flex-start; column-gap: 8px; row-gap: 6px; height: 25px; line-height: 25px; overflow: hidden; }
/* Stored views can leave a single narrow card: keep state/port visible and
   let the action row wrap if a skin makes its buttons wider. */
.bp-sec[data-section] .bp-tile__foot { flex-wrap: wrap; row-gap: 8px; }
.bp-sec[data-section] .bp-tile__meta { flex: 1 0 auto; min-width: 0; height: auto; min-height: 25px; overflow: visible; flex-wrap: nowrap; }
.bp-tile__meta > * { height: 25px; display: inline-flex; align-items: center; }
.bp-tile__meta > .bp-chip { height: 19px; margin: 3px 0; }
.bp-tile__meta > .bp-chip { flex: none; }
/* The buttons keep their one line; only when the buttons alone outgrow the
   card (many tool actions on a narrow column) do they wrap among themselves. */
.bp-tile__acts { flex: 0 1 auto; min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; row-gap: 6px; margin-left: auto; }
.bp-btn--act {
  height: 25px;
  padding: 0 8px;
  border-radius: 7px;
  font: var(--dsw-font-xxxs-strong-11);
}
.bp-btn--primary {
  border-color: transparent;
  background: var(--bp-hover);
  color: var(--bp-ink-1);
}
.bp-btn--primary:hover:not(:disabled) { border-color: var(--bp-hair-strong); }

.bp-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 0 7px;
  height: 19px;
  border: 1px solid var(--bp-hair);
  border-radius: 6px;
  background: var(--bp-hover);
  color: var(--bp-ink-2);
  font: var(--dsw-font-xxxs-strong-11);
  white-space: nowrap;
}
.bp-chip[data-tone="ok"] { color: var(--bp-ink-1); }
.bp-chip--soft { background: transparent; border-style: dashed; color: var(--bp-ink-3); }
.bp-tile__slot {
  line-height: 25px;
  font: var(--dsw-font-xxxs-11);
  color: var(--bp-ink-4);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* One state dot, shared by a chip and a carrier row. The halo is the theme's
   hover wash rather than the dot's own colour at 13%: the colour needs no
   second alpha ramp, and an opaque halo reads on both themes. */
.bp-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--bp-idle);
  box-shadow: 0 0 0 3px var(--bp-hover);
}
.bp-dot[data-tone="ok"] { background: var(--bp-ok); }
.bp-dot[data-tone="warn"] { background: var(--bp-warn); }
.bp-dot[data-tone="bad"] { background: var(--bp-bad); }
.bp-run .bp-dot { width: 8px; height: 8px; }

/* ── drag state ───────────────────────────────────────────────────────── */
.bp-tile[data-dragging="true"] {
  opacity: 0.5;
  border-style: dashed;
  box-shadow: var(--bp-lift-drag);
}
.bp-drop {
  position: absolute;
  width: 2px;
  border-radius: 2px;
  background: var(--bp-ink-1);
  box-shadow: 0 0 0 3px var(--bp-hover);
  pointer-events: none;
  z-index: 4;
}
.bp-drop::before {
  content: "";
  position: absolute;
  top: -3px;
  left: -2.5px;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--bp-ink-1);
}

/* ── notes ────────────────────────────────────────────────────────────── */
.bp-note {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 14px;
  padding: 8px 11px;
  border: 1px solid var(--bp-hair);
  border-radius: 9px;
  background: var(--bp-hover);
  font: var(--dsw-font-xxs-12);
  color: var(--bp-ink-2);
}
.bp-note[data-tone="bad"] { color: var(--bp-bad); }
.bp-empty { margin: 0; padding: 10px 0; font: var(--dsw-font-xs-13); color: var(--bp-ink-3); }

/* ══ briefing (Butler 简报页) ═══════════════════════════════════════════
   Shares the token block and every component class above (bp-head / bp-tile /
   bp-btn / bp-chip / bp-dot / bp-note). Only the layout this page owns lives
   here: the status row, the metric strip, the two reading columns, the digest
   list, the capability block and the detail viewers. Sharing the classes is
   the whole point — the two surfaces must not drift into two skins. */

.bq-brief {
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  /* Same geometry as the console: the glass head and every content group share
     one inset, so the bar lines up with the content beneath it. A max-width of
     our own is what made the briefing read as a different app next to the
     console. */
  padding: 0 clamp(16px, 2.4vw, 32px) 36px;
  font-family: var(--dsw-font-family);
  font-size: 13px;
  color: var(--bp-ink-1);
  -webkit-font-smoothing: antialiased;
}
.bq-brief > .bq-metrics,
.bq-brief > .bq-zone,
.bq-brief > .bp-note {
  margin-left: 16px;
  margin-right: 16px;
}

.bq-mark { flex: none; width: 38px; height: 38px; border-radius: 11px; object-fit: cover; }
.bq-top__stamp { font: var(--dsw-font-xxxs-11); color: var(--bp-ink-4); font-variant-numeric: tabular-nums; }
.bq-top__stamp b { font-weight: 500; color: var(--bp-ink-2); }

/* ── 标题条状态簇：结论与时间戳同一行 ────────────────────────────────── */
/* 结论曾经叠成两行（chip 在上、时间戳在下），读过一次之后剩下的都是高度。
   现在 chip 本身就是查看入口，所以「巡检通过」只说一次，证据点开即得。 */
.bq-status { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.bq-chip--view { cursor: pointer; height: 24px; transition: border-color 0.12s ease, background-color 0.12s ease; }
.bq-chip--view:hover { border-color: var(--bp-hair-strong); color: var(--bp-ink-1); }
.bq-chip__more { font-style: normal; font: var(--dsw-font-xxxs-11); color: var(--bp-ink-4); margin-left: 2px; }
.bq-chip--view:hover .bq-chip__more { color: var(--bp-ink-2); text-decoration: underline; text-underline-offset: 2px; }

/* ── metric strip ─────────────────────────────────────────────────────── */
/* Every number here is a door. They used to be a second copy of the verdict
   above them, followed by two folds at the bottom holding the records they
   count; now the digit answers "how many" and the click answers "which". */
.bq-metrics {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  padding: 14px 0 13px;
  border-bottom: 1px solid var(--bp-hair);
  margin-bottom: 20px;
}
.bq-metric {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 0 16px;
  border-right: 1px solid var(--bp-hair);
  font: var(--dsw-font-xxs-12);
  color: var(--bp-ink-3);
}
.bq-metric:first-child { padding-left: 0; }
.bq-metric:last-child { border-right: 0; }
.bq-metric b { font: 600 14px/18px var(--dsw-font-family); color: var(--bp-ink-1); font-variant-numeric: tabular-nums; }
.bq-metric b[data-dim="true"] { color: var(--bp-ink-3); font-weight: 500; }
.bq-metric__gl { display: inline-flex; align-items: center; gap: 5px; }
.bq-metric--view {
  border: 0;
  border-right: 1px solid var(--bp-hair);
  background: none;
  cursor: pointer;
  padding: 4px 16px;
  border-radius: 7px;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.bq-brief .bq-metrics > .bq-metric--view:last-of-type { border-right: 0; }
.bq-metric--view:hover { background: var(--bp-hover); color: var(--bp-ink-2); }
.bq-metric--view b { font: 600 14px/18px var(--dsw-font-family); color: var(--bp-ink-1); font-variant-numeric: tabular-nums; }
.bq-metric--view b[data-dim="true"] { color: var(--bp-ink-3); font-weight: 500; }
.bq-metric__chev { font-style: normal; color: var(--bp-ink-4); font-size: 14px; line-height: 1; }
.bq-metric--view:hover .bq-metric__chev { color: var(--bp-ink-2); }

/* ── two reading columns: decisions beside the digests ────────────────── */
/* Spacing comes from the grid gap alone. A sibling margin here is what once
   put the right card 20px lower than the left one — the alignment bug. */
.bq-cols {
  display: grid;
  grid-template-columns: 352px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
@media (max-width: 1040px) {
  .bq-cols { grid-template-columns: minmax(0, 1fr); }
}

/* The page's tiles are the console's tiles (bp-tile); only the internals this
   page needs are added here. */
.bq-tile__count {
  min-width: 19px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bp-hover);
  color: var(--bp-ink-3);
  font: var(--dsw-font-xxxs-strong-11);
  line-height: 17px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.bq-tile__count[data-tone="warn"] { background: var(--bp-warn); color: var(--dsw-alias-label-on-accent, #1a1200); }
.bq-tile__count[data-tone="bad"] { background: var(--bp-bad); color: var(--dsw-alias-label-on-accent, #fff); }

.bq-group { padding: 11px 13px 13px; }
.bq-group + .bq-group { border-top: 1px dashed var(--bp-hair); }
.bq-brief .bp-note { flex-wrap: wrap; row-gap: 2px; }
.bq-brief .bq-group > .bp-note { margin-bottom: 0; }
.bq-group__label { display: flex; align-items: center; gap: 7px; font: var(--dsw-font-xxxs-11); color: var(--bp-ink-4); margin-bottom: 9px; }
.bq-group__label em { font-style: normal; font-variant-numeric: tabular-nums; }
.bq-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
.bq-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 11px;
  border-radius: 9px;
  border-left: 3px solid var(--bp-idle);
  background: var(--bp-tile-solid);
  font: 12.5px/1.5 var(--dsw-font-family);
}
.bq-row[data-tone="warn"] { border-left-color: var(--bp-warn); }
.bq-row[data-tone="bad"] { border-left-color: var(--bp-bad); }
.bq-row[data-tone="info"] { border-left-color: var(--bp-hair-strong); }
.bq-row__text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.bq-row__tag {
  flex: none;
  font: var(--dsw-font-xxxs-11);
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid var(--bp-hair);
  color: var(--bp-ink-4);
}
.bq-row__actions { flex: none; display: inline-flex; gap: 4px; }
.bq-row { flex-wrap: wrap; }
.bq-row__toggle { all: unset; cursor: pointer; text-decoration: underline dotted var(--bp-hair); text-underline-offset: 3px; }
.bq-row__toggle:focus-visible { outline: 2px solid var(--bp-hair); outline-offset: 2px; }
.bq-row__detail { flex: 1 0 100%; margin: 6px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 10px; font-size: 12px; }
.bq-row__detail dt { opacity: .65; }
.bq-row__detail dd { margin: 0; min-width: 0; }
.bq-row__detail pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
.bq-row__detail ul { margin: 0; padding-left: 16px; }
.bq-none { font: var(--dsw-font-xxs-12); color: var(--bp-ink-4); padding: 2px 0 4px; }

/* ── digest list ──────────────────────────────────────────────────────── */
.bq-tabs { display: flex; gap: 2px; padding: 9px 12px; border-bottom: 1px solid var(--bp-hair); background: var(--bp-band); }
.bq-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: var(--dsw-font-xxs-12);
  padding: 4px 11px;
  border-radius: 7px;
  border: 0;
  background: transparent;
  color: var(--bp-ink-2);
  cursor: pointer;
}
.bq-tab[aria-selected="true"] { background: var(--bp-tile-solid); color: var(--bp-ink-1); font-weight: 500; box-shadow: var(--bp-lift); }
.bq-tab__n { font: var(--dsw-font-xxxs-11); color: var(--bp-ink-4); font-variant-numeric: tabular-nums; }
.bq-issues { list-style: none; margin: 0; padding: 6px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
.bq-issue {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border-left: 2px solid transparent;
  cursor: pointer;
}
.bq-issue:hover { background: var(--bp-hover); }
.bq-issue[aria-current="true"] { background: var(--bp-hover); border-left-color: var(--bp-ink-1); }
.bq-issue__day { display: flex; flex-direction: column; width: 56px; flex: none; }
.bq-issue__day b { font: 600 12px/15px var(--dsw-font-family); font-variant-numeric: tabular-nums; }
.bq-issue__day em { font-style: normal; font: var(--dsw-font-xxxs-11); color: var(--bp-ink-4); }
.bq-issue__sum { flex: 1 1 auto; min-width: 0; font: var(--dsw-font-xxs-12); color: var(--bp-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bq-doc { padding: 14px 13px 16px; border-top: 1px solid var(--bp-hair); }
.bq-doc__title { margin: 0 0 8px; font: 600 13.5px/19px var(--dsw-font-family); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bq-doc__text { margin: 0; font: 12.5px/1.75 var(--dsw-font-family); color: var(--bp-ink-2); max-width: 74ch; }
.bq-doc__foot { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--bp-hair); font: var(--dsw-font-xxs-12); color: var(--bp-ink-4); }
.bq-pending { display: flex; gap: 11px; padding: 16px 13px; color: var(--bp-ink-2); }
.bq-pending b { display: block; font: 600 13px/18px var(--dsw-font-family); color: var(--bp-ink-1); }
.bq-pending span:last-child { font: var(--dsw-font-xxs-12); color: var(--bp-ink-3); }

/* 一行摘要 + 一个主日期已经说明了期号；星期是主人真正会找的那个字段。 */
.bq-issue__wd { color: var(--bp-ink-2); }

/* ── 展示区 / 操作区 ──────────────────────────────────────────────────── */
/* The page has two zones and they must not be mistaken for each other. The
   show zone is read-only prose and numbers (verdict, metrics, decisions,
   digests); the act zone is the only place with commands. It is a section of
   its own — the console's section heading, then a grid of the console's cards —
   so a button never shares a card with a sentence. The faculties used to be a
   tile wedged under the decisions in a 352px column, where every command and
   report wrapped into one pile of identical pills. */
.bq-zone { margin-top: 0; }
.bq-zone--show { margin-bottom: 26px; }
.bq-acts { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(312px, 1fr)); align-items: start; }
.bq-fac__body { display: grid; gap: 12px; padding: 11px 13px 13px; }
.bq-fac__group + .bq-fac__group { padding-top: 11px; border-top: 1px dashed var(--bp-hair); }
.bq-fac__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
/* One row per command. The button column is a fixed 96px, so every note starts
   on the same line whether or not its neighbours have one; a command with no
   description simply leaves its second cell empty instead of shifting the next
   button into it (what display: contents did). */
.bq-fac__list li { display: grid; grid-template-columns: 96px minmax(0, 1fr); align-items: center; gap: 10px; }
.bq-fac__list li > .bp-btn { justify-self: start; }
.bq-fac__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.bq-fac__note { font: var(--dsw-font-xxxs-11); color: var(--bp-ink-3); line-height: 1.5; overflow-wrap: anywhere; }
.bq-fac .bq-out { margin: 0 13px 13px; }
.bq-fac[data-tone="warn"] { border-color: var(--bp-warn); }
/* Commands run a declared exec with an effect; reports are read-only. The
   fill/outline pair says which is which without a legend line per row. */
.bp-btn--read { background: transparent; color: var(--bp-ink-2); }
.bp-btn--read:hover:not(:disabled) { background: var(--bp-hover); }
.bq-out { padding: 10px 11px; margin-top: 10px; border-radius: 8px; border: 1px solid var(--bp-hair); background: var(--bp-tile-solid); max-height: 260px; overflow: auto; }
.bq-out pre { margin: 0; font: 11px/1.7 var(--dsw-font-mono, ui-monospace, monospace); white-space: pre-wrap; color: var(--bp-ink-2); overflow-wrap: anywhere; }
.bq-out__state { font: var(--dsw-font-xxs-12); color: var(--bp-warn); }
.bq-fac__id { font: var(--dsw-font-xxxs-11); font-family: var(--dsw-font-mono, ui-monospace, monospace); color: var(--bp-ink-4); }
.bq-fac__reason { font: var(--dsw-font-xxs-12); color: var(--bp-warn); line-height: 1.6; overflow-wrap: anywhere; }

/* ── 详情查看器：数字与结论的落点 ────────────────────────────────────── */
/* Replaces the two folds that used to sit at the bottom of the page. The
   records were always reachable from a digit; the folds just made the owner
   scroll past the briefing to find them.

   The aqua skin repaints everything carrying role="dialog" as translucent
   glass — [data-dsh-aqua] body [role="dialog"], measured at
   rgba(255,255,255,0.45) on a viewer this sheet had painted opaque white,
   which turned the whole overlay into one grey wash. Renaming the class
   cannot dodge it: the selector keys off the ARIA role, not a class. So the
   role stays (it is the accessibility contract) and the surface is defended by
   specificity instead, doubled class included to outrank 0-2-1.

   Mask, blur, surface, radius and shadow below are the plugin's one dialog
   spec — PanelModal's panelPalette reads the same values. Change them
   together, or the two dialogs drift back into two skins. */
.bq-view { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: rgba(15, 17, 21, 0.30); backdrop-filter: blur(6px) saturate(1.15); }
body[data-ds-dark-theme] .bq-view { background: rgba(0, 0, 0, 0.45); }
.bq-brief .bq-view__sheet.bq-view__sheet { width: min(880px, calc(100vw - 96px)); max-height: min(78vh, 720px); display: flex; flex-direction: column; border: 1px solid var(--bp-hair-strong); border-radius: 14px; background: #fff; box-shadow: 0 24px 64px rgba(15, 17, 21, 0.3), 0 4px 14px rgba(15, 17, 21, 0.16); overflow: hidden; }
body[data-ds-dark-theme] .bq-brief .bq-view__sheet.bq-view__sheet { background: #111318; border-color: rgba(148, 180, 220, 0.2); box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5), 0 4px 14px rgba(0, 0, 0, 0.35); }
.bq-view__head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--bp-hair); font: 600 13px/20px var(--dsw-font-family); }
.bq-view__body { padding: 12px 14px 14px; overflow-y: auto; }
.bq-view__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.bq-view__list li { display: flex; align-items: center; gap: 9px; font: var(--dsw-font-xxs-12); color: var(--bp-ink-2); padding: 6px 8px; border-radius: 8px; }
.bq-view__list li:hover { background: var(--bp-hover); }
.bq-view__line { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.bq-view__tag { font-style: normal; font: var(--dsw-font-xxxs-11); color: var(--bp-ink-4); }
.bq-jlist { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.bq-jrec { display: flex; align-items: flex-start; gap: 8px; padding: 7px 8px; border-radius: 8px; }
.bq-jrec:hover { background: var(--bp-hover); }
.bq-jrec__ts { flex: none; font: var(--dsw-font-xxxs-11); color: var(--bp-ink-4); font-variant-numeric: tabular-nums; padding-top: 2px; }
.bq-jrec__text { flex: 1 1 auto; min-width: 0; font: var(--dsw-font-xxs-12); color: var(--bp-ink-2); line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
/* Expandable records: the row is a button; details sit under it full width. */
.bq-jrec { flex-wrap: wrap; }
.bq-jrec__main { all: unset; box-sizing: border-box; flex: 1 1 100%; min-width: 0; display: flex; align-items: flex-start; gap: 8px; cursor: pointer; text-align: left; }
.bq-jrec__main:focus-visible, .bq-spool__head:focus-visible { outline: 2px solid var(--bp-hair); outline-offset: 2px; border-radius: 6px; }
.bq-jrec[data-open] { background: var(--bp-hover); }
.bq-jrec[data-open] .bq-jrec__text { -webkit-line-clamp: unset; display: block; }
.bq-jrec__detail { padding: 4px 0 2px; }
.bq-jrec__detail code { font-size: 11px; overflow-wrap: anywhere; }
.bq-view__list.bq-spool__list > li.bq-spool { display: block; padding: 0; }
.bq-view__list.bq-spool__list > li.bq-spool:hover { background: none; }
.bq-spool__head { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.bq-spool__head:hover { background: var(--bp-hover); }
.bq-spool > .bq-jlist { margin: 4px 0 6px 18px; }

/* ── 记忆页 ───────────────────────────────────────────────────────────── */
/* Everything here is a console tile in the console's grid. The only things this
   page adds are a narrow category nav on the left (it changes what the grid
   holds, nothing else) and the opaque sheet an opened tile reads in. */
.bm-cols { display: grid; grid-template-columns: 188px minmax(0, 1fr); gap: 12px; align-items: start; margin-top: 12px; }
.bm-nav { display: grid; gap: 2px; padding: 6px; position: sticky; top: 12px; }
.bm-nav__item { all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: 8px; cursor: pointer; font: 500 13px/20px var(--dsw-font-family); color: var(--bp-ink-2); }
.bm-nav__item:hover { background: var(--bp-hover); color: var(--bp-ink-1); }
.bm-nav__item[aria-current="true"] { background: var(--bp-hover); color: var(--bp-ink-1); box-shadow: inset 2px 0 0 var(--bp-hair-strong); }
.bm-nav__item:focus-visible { outline: 2px solid var(--bp-hair-strong); outline-offset: -2px; }
.bm-nav__item em { font: var(--dsw-font-xxxs-11); font-style: normal; color: var(--bp-ink-4); font-variant-numeric: tabular-nums; }
.bq-maint { margin: 26px 16px 0; }
.bq-maint > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; font: 600 13px/20px var(--dsw-font-family); color: var(--bp-ink-2); }
.bq-maint > summary::-webkit-details-marker { display: none; }
.bq-maint > summary::before { content: "›"; color: var(--bp-ink-4); transition: transform 0.12s ease; }
.bq-maint[open] > summary::before { transform: rotate(90deg); }
.bq-maint > summary em { font-style: normal; font-weight: 400; font-size: 12px; color: var(--bp-ink-4); }
.bq-maint__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0 16px; }
.bq-brief > .bq-zone--show .bp-sec { margin-bottom: 22px; }
.bm-nav__group { display: grid; gap: 2px; }
.bm-nav__label { margin: 4px 10px 2px; font: var(--dsw-font-xxxs-11); color: var(--bp-ink-4); letter-spacing: 0.04em; }
.bm-nav__rule { height: 1px; margin: 7px 4px 5px; border: 0; background: var(--bp-hair); }
.bm-nav__hint { margin: 6px 10px 4px; font: var(--dsw-font-xxxs-11); color: var(--bp-ink-4); line-height: 1.5; }
.bm-sec { min-width: 0; margin-bottom: 0; }
.bm-hint { margin: -4px 0 10px; font: var(--dsw-font-xxs-12); color: var(--bp-ink-3); line-height: 1.5; }
.bm-tile .bp-tile__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bm-tile .bp-tile__foot { min-height: 52px; box-sizing: border-box; }
.bm-tile .bp-tile__slot { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Footer: the buttons keep their size and one line; the kind and slug take what is
   left and cut with an ellipsis. Without this a long slot ("已升级 · 知识卡 · …")
   holds the left side open and pushes the buttons onto a second row, which makes
   that one card taller than its neighbours. */
.bm-tile .bp-tile__meta { min-width: 0; flex-wrap: nowrap; }
.bm-tile .bp-tile__meta > .bp-tile__slot { flex: 0 1 auto; display: block; }
.bm-tile .bp-tile__acts { flex: none; flex-wrap: nowrap; }
/* auto-fill, not the console's auto-fit: with one or two cards auto-fit stretches
   each across the row, so the same card would be three widths in three sections. */
.bm-sec .bp-grid { grid-template-columns: repeat(auto-fill, minmax(312px, 1fr)); }
/* The same excerpt height whether it runs to two lines or one, so a section of
   short cards and a section of long ones lay out on the same rows. */
.bm-tile .bp-tile__desc { min-height: 33px; }
.bm-tile .bp-tile__head { min-height: 82px; box-sizing: border-box; }
.bq-brief .bp-editor.bm-dialog { width: min(560px, 100%); }
.bq-brief .bp-editor.bm-sheet { width: min(720px, 100%); }
.bm-meta { margin: 3px 0 0; font: var(--dsw-font-xxs-12); color: var(--bp-ink-3); overflow-wrap: anywhere; }
.bm-summary { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--bp-hover); font: var(--dsw-font-xxs-12); color: var(--bp-ink-2); line-height: 1.6; }
.bm-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.7 var(--dsw-font-family); color: var(--bp-ink-1); }
.bm-form { display: grid; gap: 10px; }
.bm-form label { display: grid; gap: 5px; font: var(--dsw-font-xxs-12); color: var(--bp-ink-2); }
.bm-form input, .bm-form textarea, .bm-dialog textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 9px; border: 1px solid var(--bp-hair); border-radius: 7px; background: transparent; color: inherit; font: 12.5px/1.65 var(--dsw-font-family); resize: vertical; }
.bm-form input:focus-visible, .bm-form textarea:focus-visible, .bm-dialog textarea:focus-visible { outline: 2px solid var(--bp-hair-strong); outline-offset: 0; }
.bm-sheet .bq-jrec__detail { margin: 0; }
.bm-kinds { grid-template-columns: repeat(2, 1fr); }
.bm-kinds--3 { grid-template-columns: repeat(3, 1fr); }
.bm-loading { margin: 12px 16px; }
.bp-editor__note[data-tone="bad"] { color: var(--bp-bad); }
@media (max-width: 860px) { .bm-cols { grid-template-columns: minmax(0, 1fr); } .bm-nav { position: static; } }
`

/**
 * Install the stylesheet, returning a generation-safe disposer.
 *
 * Same ownership rule as the rail's no-select rule: a unique token per
 * install, and a disposer that removes only its own generation's node, so an
 * HMR pass that sets up the new sheet before tearing down the old one cannot
 * delete the live rule.
 * @returns a function removing only this installation.
 */
export function installConsoleStyles(): () => void {
  if (typeof document === 'undefined') return () => {}

  const previous = document.getElementById(STYLE_ID)
  const style = document.createElement('style')
  const token = `${Date.now()}-${Math.random()}`
  style.id = STYLE_ID
  style.dataset.owner = token
  style.textContent = CSS
  // DSH claims unowned style tags for the next materialized plugin. Without
  // this package owner, reloading an unrelated theme can delete our sheet.
  style.dataset.plugin = 'myspace-butler-panel'
  style.dataset.pluginCss = 'myspace-butler-panel'
  if (previous) previous.replaceWith(style)
  else document.head.append(style)

  return () => {
    const live = document.getElementById(STYLE_ID)
    if (live?.dataset.owner === token) live.remove()
  }
}
