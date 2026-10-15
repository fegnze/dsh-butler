import { useEffect } from 'react'

const CSS = `
.bcp{--bp-text:var(--dsw-alias-label-primary);--bp-border:var(--dsw-alias-border-l2);--bp-surface:var(--dsw-alias-background-l1,transparent);--bp-accent:var(--dsw-alias-brand-primary,#526de3);display:flex;flex-direction:column;align-self:stretch;justify-content:flex-start;flex:1 1 0;width:100%;height:100%;min-width:0;min-height:0;max-width:none;margin:0;padding:24px 28px;overflow:auto;color:var(--bp-text);font:14px/1.5 var(--dsw-font-family,system-ui,sans-serif)}.bcp,.bcp *{box-sizing:border-box}.bcp__head{display:flex;align-items:center;gap:12px;margin-bottom:18px}.bcp__head img{border-radius:10px}.bcp__tabs,.bcp__filters{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.bcp button,.bcp input,.bcp select,.bcp textarea{font:inherit}.bcp button{cursor:pointer}.bcp__tab,.bcp__filter,.bcp__button{border:1px solid var(--bp-border, #8885);background:transparent;color:inherit;border-radius:8px;padding:8px 12px}.bcp [aria-selected=true],.bcp__button--primary{background:var(--bp-accent,#6b8afd);color:var(--dsw-alias-label-primary-inverted,#fff)}.bcp__layout{display:grid;grid-template-columns:minmax(220px, .8fr) minmax(0,1.6fr);gap:16px}.bcp__list,.bcp__detail,.bcp__card,.bcp__message{border:1px solid var(--bp-border,#8885);border-radius:12px;padding:14px;background:var(--bp-surface,transparent)}.bcp__list{display:grid;gap:8px;align-content:start;max-height:70vh;overflow:auto}.bcp__item{text-align:left;border:1px solid var(--bp-border,#8885);border-radius:8px;padding:10px;background:transparent;color:inherit}.bcp__item[aria-current=true]{outline:2px solid var(--bp-accent,#6b8afd)}.bcp__detail{min-width:0}.bcp__body{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65}.bcp__body h1,.bcp__body h2,.bcp__body h3{margin:.8em 0 .4em}.bcp__body pre{overflow:auto;padding:10px;background:#8881;border-radius:6px}.bcp__body code{font-family:monospace}.bcp__meta,.bcp__row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.bcp__row{justify-content:space-between}.bcp__notice{padding:10px;border-radius:8px;background:#8881}.bcp__notice[data-error=true]{color:var(--dsw-alias-state-error-primary,#c33)}.bcp__editor{display:grid;gap:8px}.bcp__editor input,.bcp__editor textarea,.bcp__search{width:100%;padding:9px;border:1px solid var(--bp-border,#8885);border-radius:7px;background:transparent;color:inherit}.bcp__editor textarea{min-height:100px}.bcp__evidence,.bcp__conflict{margin:8px 0;padding:10px;border-left:3px solid var(--bp-accent,#6b8afd);background:#8881}.bcp__messages{display:grid;gap:8px}.bcp__message[data-role=user]{border-left:3px solid #4b8}.bcp__message[data-role=assistant]{border-left:3px solid #78f}.bcp__message p{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}.bcp__actions{position:sticky;bottom:0;display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 0;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--bp-text)}.bcp__actions input{padding:8px 10px;border:1px solid var(--bp-border,#8885);border-radius:8px;background:transparent;color:inherit}.bcp__maint{margin-top:20px}.bcp__compare{display:grid;grid-template-columns:1fr 1fr;gap:10px}.bcp__muted{opacity:.7}@media(max-width:720px){.bcp__layout{grid-template-columns:1fr}.bcp__list{max-height:32vh}.bcp__compare{grid-template-columns:1fr}.bcp{padding:10px}}
/* Explicit page geometry: never inherit the host's generic main/header presentation. */
.bcp > *{flex-shrink:0;min-width:0;max-width:100%}
.bcp .bcp__layout > *{min-width:0;max-width:100%}
.bcp .bcp__item,.bcp .bcp__evidence{overflow-wrap:anywhere}
.bcp .bcp__detail pre{white-space:pre-wrap;overflow-wrap:anywhere}
.bcp .bcp__editor{scroll-margin-top:16px}
.bcp .bcp__editor h3{margin:0 0 8px}
.bcp .bcp__head{margin:0 0 20px;padding:0;min-height:48px;border:0;border-radius:0;background:none;box-shadow:none}
.bcp .bcp__head h1{margin:0 0 4px;font-size:22px;font-weight:650;line-height:1.3;letter-spacing:0}
.bcp .bcp__head img{width:38px;height:38px;flex:none}
.bcp .bcp__tabbar{display:flex;align-items:center;gap:12px;margin:0 0 16px;padding:0 0 12px;border-bottom:1px solid var(--bp-border)}
.bcp .bcp__tabs{flex:1 1 auto;margin:0;padding:0;border:0}
.bcp .bcp__reload{flex:none;margin-left:auto}
.bcp .bcp__tab{display:inline-flex;align-items:center;gap:6px}
.bcp .bcp__count{min-width:18px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-interactive-bg-active,#8883);font-size:12px;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}
/* The legacy briefing is embedded under 运行与设置: it adopts this page's inset and scroller and drops its own glass header. */
.bcp .bcp__maint{margin-top:0}
.bcp .bq-brief{height:auto;overflow:visible;padding:0}
.bcp .bq-brief > .bq-zone,.bcp .bq-brief > .bq-metrics,.bcp .bq-brief > .bp-note{margin-left:0;margin-right:0}
.bcp .bq-brief .bp-catalog-section-heading{position:static}
.bcp .bq-maint{margin:8px 0 0}
.bcp .bcp__row{justify-content:flex-start;gap:12px;margin-bottom:16px}
.bcp .bcp__filters{margin:0}
.bcp .bcp__row > .bcp__button:last-child{margin-left:auto}
.bcp .bcp__search-form{display:flex;align-items:center;gap:8px;flex:0 1 380px;min-width:0;margin:0 0 0 auto}
.bcp .bcp__search{flex:1 1 0;min-width:0;width:auto}
.bcp .bcp__search-form button{flex:none;white-space:nowrap}
.bcp button{font-size:13px;line-height:20px;white-space:normal}
.bcp .bcp__filter[aria-pressed=true]{background:var(--dsw-alias-background-l2,#8881);font-weight:600}
.bcp .bcp__layout{flex:1 0 360px;grid-template-columns:minmax(240px,320px) minmax(0,1fr);align-items:stretch}
.bcp .bcp__layout[hidden]{display:none}
.bcp .bcp__notice{margin:0 0 16px;padding:18px 20px;line-height:1.6}
.bcp .bcp__detail{overflow-wrap:anywhere}
.bcp .bcp__validity[data-usable=false]{color:var(--dsw-alias-state-error-primary,#c0392b);font-weight:600}
.bcp .bcp__validity-panel ul{margin:4px 0 8px;padding-left:18px}
.bcp .bcp__editor label{display:grid;gap:8px;font-weight:500}
.bcp .bcp__editor textarea{resize:vertical;line-height:1.65;font-weight:400}
.bcp .bcp__editor .bcp__body-editor{min-height:420px;height:55vh;font-family:var(--dsw-font-family,system-ui,sans-serif)}
@media(max-width:760px){.bcp{padding:16px}.bcp .bcp__layout{grid-template-columns:1fr}.bcp .bcp__search-form{flex:1 1 100%;margin:0}.bcp .bcp__head h1{font-size:20px}}
`

/** Install page-scoped styles only while the card pipeline page is mounted. */
export function useCardPipelineStyles() {
  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'myspace-butler-panel'
    style.dataset.pluginCss = 'myspace-butler-panel-card-pipeline'
    style.dataset.cardPipeline = 'true'
    style.textContent = CSS
    document.head.append(style)
    return () => style.remove()
  }, [])
}
