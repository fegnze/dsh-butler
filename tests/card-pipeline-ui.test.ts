import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const page = readFileSync(resolve(import.meta.dir, '../src/ui/CardPipelinePage.tsx'), 'utf8')
const wiring = readFileSync(resolve(import.meta.dir, '../src/ui/ButlerPage.tsx'), 'utf8')

describe('card pipeline UI safety and wiring', () => {
  test('switching away from session details clears them before the next tab renders', () => {
    const body = page.split('const switchTab = (next: Tab) => {')[1].split('\n  }')[0]
    const state: any = { selected: { messages: [] }, tab: 'sessions' }
    const listEpoch = { current: 1 }, detailEpoch = { current: 1 }
    const setters = ['setSelected','setItems','setEditing','setDetailLoading','setDetailFailed','setViewingEvidence','setReturnCandidateId','setError','setNotice','setTab']
    const callbacks = setters.map(name => name === 'setTab' ? (next: string) => { expect(state.selected).toBeNull(); state.tab = next } : (value: any) => { state[name.slice(3).replace(/^./, c => c.toLowerCase())] = value })
    const switchTab = new Function('next','tab','mutationLock','listEpoch','detailEpoch','skipNextTabLoad',...setters,body)
    switchTab('pending','sessions',{current:false},listEpoch,detailEpoch,{current:false},...callbacks)
    expect(state.tab).toBe('pending')
    expect(state.items).toEqual([])
    expect(detailEpoch.current).toBe(2)
    expect(listEpoch.current).toBe(2)
    expect(page).toContain('onClick={()=>switchTab(id)}')
    expect(page).toContain("typeof markdown === 'string' ? markdown : ''")
  })
  test('page owns full-width top-aligned geometry and a single-row search group', () => {
    const css = readFileSync(resolve(import.meta.dir, '../src/ui/card-pipeline-styles.ts'), 'utf8')
    expect(css).toContain('max-width:none;margin:0')
    expect(css).toContain('.bcp,.bcp *{box-sizing:border-box}')
    expect(css).toContain('min-width:0;max-width:100%')
    expect(page).toContain("tab==='pending' && editing ? <div className=\"bcp__editor\"")
    expect(page).not.toContain('{editing ? <div')
    expect(css).toContain('justify-content:flex-start')
    expect(css).toContain('.bcp .bcp__search-form{display:flex')
    expect(css).toContain('.bcp .bcp__layout[hidden]{display:none}')
    expect(page).toContain('className="bcp__search-form"')
    expect(page).not.toContain('<main')
    expect(page).not.toContain('<header')
    expect(page).toContain('hidden={!selected && visible.length === 0}')
  })
  test('maintenance record buttons have a read-only legacy viewer callback', () => {
    expect(wiring).toContain('openMemory={openLegacyRecords}')
    expect(wiring).toContain("await fetchButlerSection('memory')")
    expect(wiring).toContain("data.records?.observation?.records")
    expect(wiring).toContain('record.key === key')
    expect(wiring).toContain('aria-label="旧采集记录"')
    expect(wiring).toContain('加载失败：')
    expect(wiring).toContain('openSession={props.openSession}')
  })

  test('theme-aware contrast, one tab bar with reload, and no repeated chrome in sessions or maintenance', () => {
    const css = readFileSync(resolve(import.meta.dir, '../src/ui/card-pipeline-styles.ts'), 'utf8')
    // selected tab / primary button text follows the theme's inverted label, never a fixed white on a theme-flipping fill
    expect(css).toContain('color:var(--dsw-alias-label-primary-inverted,#fff)')
    expect(css).not.toMatch(/bcp__button--primary\{[^}]*color:white/)
    // the sticky action bar sits on the theme layer, not the UA Canvas (white in a dark theme)
    expect(css).toMatch(/\.bcp__actions\{[^}]*background:var\(--dsw-alias-bg-layer-1/)
    // reload rides in the tab bar; the sessions tab has no empty filter row
    expect(page).toContain('className="bcp__tabbar"')
    expect(page).toContain("tab !== 'maintenance' ? <button className=\"bcp__button bcp__reload\"")
    expect(page).toContain("{tab !== 'sessions' ? <div className=\"bcp__row\">")
    // the pending count is a badge kept across tabs, not an empty "()"
    expect(page).toContain('setPendingCount(rows.length)')
    expect(page).not.toContain("` (${tab==='pending'")
    // the embedded briefing drops its own head; an empty decision list is not rendered
    expect(wiring).toContain('<BriefingPage {...props} openMemory={openLegacyRecords} embedded />')
    expect(wiring).toContain('{embedded ? null : <div className="bp-head">')
    expect(wiring).toContain('decide.length === 0 && suggested.count === 0 ? null')
    expect(css).toContain('.bcp .bq-brief{height:auto;overflow:visible;padding:0}')
  })

  test('draft editor is spacious and maintenance does not expose generic commands', () => {
    const css = readFileSync(resolve(import.meta.dir, '../src/ui/card-pipeline-styles.ts'), 'utf8')
    expect(page).toContain('rows={18}')
    expect(page).toContain('正文（Markdown）')
    expect(css).toContain('min-height:420px;height:55vh')
    expect(css).toContain('resize:vertical')
    expect(wiring).not.toContain('faculties.map(')
    expect(wiring).toContain("endpoints.some(item => item.status !== 'ok')")
    expect(wiring).toContain('修复接入点')
  })

  test('uses text rendering only for Markdown and never injects HTML', () => {
    expect(page).toContain('React escapes every string')
    expect(page).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/)
    expect(page).toContain('renderSafeMarkdown')
  })

  test('starts on pending review, offers three main tabs and maintenance', () => {
    expect(page).toContain("useState<Tab>('pending')")
    for (const label of ['待确认', '卡库', '会话', '运行与设置']) expect(page).toContain(label)
    expect(wiring).toContain('maintenance={<BriefingPage')
    expect(wiring).toContain('<CardPipelinePage')
    expect(wiring).not.toContain('MemoryPage')
  })

  test('filters pending candidates, epochs async responses, and gates detail review', () => {
    expect(page).toContain("tab === 'cards' || tab === 'pending'")
    expect(page).toContain('listEpoch = useRef(0)')
    expect(page).toContain('detailEpoch = useRef(0)')
    expect(page).toContain('detailFailed || tab !== \'pending\'')
    expect(page).toContain('正在加载详情…')
    expect(page).toContain("formatSessionIntegrity(selected.integrity)")
    expect(page).toContain("JSON.stringify(value)")
    expect(page).toContain("查看来源")
    expect(page).toContain("返回候选审阅")
    expect(page).toContain("pipelineRequest<Session>('sessions.read', { id: sourceId })")
    expect(page).toContain('item.rationale')
    expect(page).toContain('item.evidence?.length')
    expect(page).toContain('selected.links.map')
    expect(page).toContain('selected.backlinks.map')
    expect(page).toContain('openCard(id)')
    expect(page).toContain('captureMode')
  })

  test('uses only explicit review actions and expected revision editing', () => {
    expect(page).toContain("reviewCandidate(selected, action")
    expect(page).toContain('expectedRevision: selected.revision')
    expect(page).toContain('草稿已保存；保存不等于批准。')
    expect(page).toContain('409）：请重载并重新审阅')
    expect(page).toContain("status: 'pending'")
    expect(page.match(/finally \{ if \(epoch === mutationEpoch\.current\) \{ mutationLock\.current = false; setBusy\(false\) \} \}/g)).toHaveLength(2)
    expect(page).toContain('mutationLock.current = false')
  })
})
