import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cardUsability, pipelineRequest, reviewCandidate, type Candidate, type Card, type Session } from './card-pipeline-source.ts'
import { useCardPipelineStyles } from './card-pipeline-styles.ts'

type Tab = 'pending' | 'cards' | 'sessions' | 'maintenance'
type Kind = 'all' | 'knowledge' | 'profile' | 'rule'
const labels: Record<string, string> = { knowledge: '知识', profile: '身份资料', rule: '规则', create: '新建', revise: '修订', merge: '合并', archive: '归档', user: '用户', assistant: '助手', tool: '工具', covered: '已蒸馏', running: '蒸馏中', pending: '待蒸馏' }
const label = (value?: string) => labels[value || ''] || value || '未注明'

/** Safe, intentionally small Markdown renderer: text nodes only, no HTML parsing. */
export function renderSafeMarkdown(markdown: unknown) {
  const text = typeof markdown === 'string' ? markdown : ''
  return text.split(/\n/).map((line, index) => {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const Tag = `h${heading[1].length}` as 'h1' | 'h2' | 'h3'
      return <Tag key={index}>{inlineText(heading[2])}</Tag>
    }
    if (/^```/.test(line)) return <div key={index} className="bcp__muted">────────</div>
    if (/^\s*[-*]\s+/.test(line)) return <div key={index}>• {inlineText(line.replace(/^\s*[-*]\s+/, ''))}</div>
    return <div key={index}>{inlineText(line)}</div>
  })
}
function inlineText(text: string) {
  // React escapes every string. Inline code/bold are represented as plain text to avoid unsafe HTML.
  return text.replace(/`([^`]+)`/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1')
}
function errorText(error: any) {
  if (error?.code === 'store_not_active') return '新 Wiki 尚未激活或存储标记异常。旧资料未自动迁移；请先完成迁移预检与明确确认，再批准或检索正式卡。'
  return error?.status === 409 || error?.code === 'conflict' ? '状态或内容已变化（409）：请重载并重新审阅，不会显示为成功。' : `请求失败：${String(error?.message ?? error)}`
}
export function formatSessionIntegrity(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return '[完整性数据不可显示]' }
  }
  return '未注明'
}

/** Owner-facing validity: why a card is withheld from Agents and which checks guard it. */
function ValidityPanel({ card }: { card: Card }) {
  const validity = card.validity
  if (card.status && card.status !== 'active') return <p className="bcp__notice">已归档：不再注入、检索或供 Agent 读取。</p>
  if (!validity || (!validity.checks?.length && !validity.reasons?.length)) return <p className="bcp__muted">未设置有效性检查项；仅依靠人工审阅保持时效。</p>
  return <section className="bcp__validity-panel" aria-label="有效性"><h3>有效性</h3>
    {validity.state === 'suspended' ? <p className="bcp__notice" role="alert">已暂停：不注入、不出现在 Agent 检索中，读取时返回不可用。依据恢复或冲突候选被处理后自动恢复。</p> : null}
    {validity.reasons?.map((reason, i) => <div className="bcp__evidence" key={`r${i}`}>{reason.code === 'conflict' ? `冲突待审：候选 ${reason.candidateId || '未注明'}${reason.detail ? ` · ${reason.detail}` : ''}` : `依据失效：${reason.detail || '未注明'}`}</div>)}
    {validity.checks?.length ? <ul>{validity.checks.map((check, i) => <li key={`c${i}`}>{validity.results?.[i]?.ok === false ? '✗' : validity.results?.[i]?.ok ? '✓' : '·'} {check.type === 'quote' ? `原文 ${check.path}：「${check.text}」` : `路径 ${check.path}`}</li>)}</ul> : null}
    {validity.changedAt ? <p className="bcp__muted">状态更新：{new Date(validity.changedAt * 1000).toLocaleString()}</p> : null}
  </section>
}

export interface CardPipelinePageProps { t?: (key: string) => string; icon?: string; maintenance?: ReactNode; headless?: boolean }

export function CardPipelinePage({ icon, maintenance, headless = false }: CardPipelinePageProps) {
  useCardPipelineStyles()
  const [tab, setTab] = useState<Tab>('pending')
  const [kind, setKind] = useState<Kind>('all')
  const [items, setItems] = useState<any[]>([])
  const [selected, setSelected] = useState<any>(null)
  const [returnCandidateId, setReturnCandidateId] = useState<string | null>(null)
  const [viewingEvidence, setViewingEvidence] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ title: '', summary: '', body: '' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [reason, setReason] = useState('')
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  const skipNextTabLoad = useRef(false)
  const listEpoch = useRef(0)
  const detailEpoch = useRef(0)
  const mutationEpoch = useRef(0)
  const mutationLock = useRef(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailFailed, setDetailFailed] = useState(false)

  const load = async (which = tab, search = query, filter = kind) => {
    const epoch = ++listEpoch.current
    ++detailEpoch.current
    setDetailLoading(false); setDetailFailed(false)
    setLoading(true); setError(''); setNotice(''); setSelected(null); setViewingEvidence(false)
    try {
      if (which === 'pending') {
        const result = await pipelineRequest<{items: Candidate[]}>('candidates.list', { status: 'pending' })
        if (epoch === listEpoch.current) { const rows = Array.isArray(result?.items) ? result.items : []; setItems(rows); setPendingCount(rows.length) }
      } else if (which === 'cards') {
        // The owner's library also lists archived and suspended cards; consumers never see them.
        const result = await pipelineRequest<{items: Card[]}>('cards.search', { query: search, includeInactive: true, ...(filter === 'all' ? {} : { kind: filter }) })
        if (epoch === listEpoch.current) setItems(Array.isArray(result?.items) ? result.items : [])
      } else if (which === 'sessions') {
        const result = await pipelineRequest<{items: Session[]}>('sessions.list', {})
        if (epoch === listEpoch.current) setItems(Array.isArray(result?.items) ? result.items : [])
      }
    } catch (e) { if (epoch === listEpoch.current) { setItems([]); setError(errorText(e)) } }
    finally { if (epoch === listEpoch.current) setLoading(false) }
  }
  useEffect(() => {
    if (skipNextTabLoad.current) { skipNextTabLoad.current = false; return }
    void load(tab, query, kind)
  }, [tab])
  const switchTab = (next: Tab) => {
    if (mutationLock.current || next === tab) return
    // Clear detail synchronously with navigation: effects run after rendering.
    ++listEpoch.current; ++detailEpoch.current
    skipNextTabLoad.current = false
    setSelected(null); setItems([]); setEditing(false)
    setDetailLoading(false); setDetailFailed(false)
    setViewingEvidence(false); setReturnCandidateId(null)
    setError(''); setNotice(''); setTab(next)
  }
  useEffect(() => () => { ++listEpoch.current; ++detailEpoch.current; ++mutationEpoch.current }, [])
  const open = async (item: any) => {
    const epoch = ++detailEpoch.current
    setError(''); setNotice(''); setSelected(null); setDetailLoading(true); setDetailFailed(false); setEditing(false); setViewingEvidence(tab === 'sessions')
    try {
      const which = tab
      const result = which === 'pending' ? await pipelineRequest<Candidate>('candidates.get', { id: item.id }) : which === 'cards' ? await pipelineRequest<Card>('cards.read', { id: item.id, includeInactive: true }) : await pipelineRequest<Session>('sessions.read', { id: item.id })
      if (epoch !== detailEpoch.current) return
      setSelected(result)
      if (which === 'pending') setDraft({ title: result.title, summary: result.summary, body: result.body })
    } catch (e) { if (epoch === detailEpoch.current) { setDetailFailed(true); setError(errorText(e)) } }
    finally { if (epoch === detailEpoch.current) setDetailLoading(false) }
  }
  const openCard = async (id: string) => {
    const epoch = ++detailEpoch.current
    setError(''); setSelected(null); setDetailLoading(true); setDetailFailed(false)
    try {
      const result = await pipelineRequest<Card>('cards.read', { id, includeInactive: true })
      if (epoch !== detailEpoch.current) return
      setSelected(result)
    } catch (e) { if (epoch === detailEpoch.current) { setDetailFailed(true); setError(errorText(e)) } }
    finally { if (epoch === detailEpoch.current) setDetailLoading(false) }
  }
  const viewEvidenceSource = async (sourceId: string) => {
    if (!sourceId || busy || detailLoading) return
    const candidateId = selected?.id as string | undefined
    if (!candidateId) return
    skipNextTabLoad.current = tab !== 'sessions'
    setReturnCandidateId(candidateId); setViewingEvidence(true); setTab('sessions')
    const epoch = ++detailEpoch.current
    setSelected(null); setDetailLoading(true); setDetailFailed(false); setError('')
    try {
      const result = await pipelineRequest<Session>('sessions.read', { id: sourceId })
      if (epoch !== detailEpoch.current) return
      setSelected(result)
    } catch (e) { if (epoch === detailEpoch.current) { setDetailFailed(true); setError(errorText(e)) } }
    finally { if (epoch === detailEpoch.current) setDetailLoading(false) }
  }
  const returnToCandidate = async () => {
    const candidateId = returnCandidateId
    if (!candidateId || busy || detailLoading) return
    skipNextTabLoad.current = tab !== 'pending'
    setTab('pending'); setViewingEvidence(false); setReturnCandidateId(null); setSelected(null)
    const epoch = ++detailEpoch.current
    setDetailLoading(true)
    try {
      const result = await pipelineRequest<Candidate>('candidates.get', { id: candidateId })
      if (epoch !== detailEpoch.current) return
      setTab('pending'); setSelected(result); setDraft({ title: result.title, summary: result.summary, body: result.body }); setDetailFailed(false); setError('')
    } catch (e) { if (epoch === detailEpoch.current) { setTab('pending'); setDetailFailed(true); setError(errorText(e)) } }
    finally { if (epoch === detailEpoch.current) setDetailLoading(false) }
  }
  const save = async () => {
    if (!selected || mutationLock.current) return
    mutationLock.current = true
    const epoch = ++mutationEpoch.current
    setBusy(true); setError(''); setNotice('')
    try {
      const updated = await pipelineRequest<Candidate>('candidates.edit', { id: selected.id, expectedRevision: selected.revision, ...draft })
      if (epoch !== mutationEpoch.current) return
      setSelected(updated); setDraft({ title: updated.title, summary: updated.summary, body: updated.body }); setEditing(false)
      setItems(current => current.map(item => item.id === updated.id ? updated : item)); setNotice('草稿已保存；保存不等于批准。')
    } catch (e) { if (epoch === mutationEpoch.current) setError(errorText(e)) }
    finally { if (epoch === mutationEpoch.current) { mutationLock.current = false; setBusy(false) } }
  }
  const decide = async (action: 'approve' | 'reject') => {
    if (!selected || mutationLock.current || detailLoading || detailFailed || tab !== 'pending') return
    if (action === 'reject' && !window.confirm('确认拒绝此候选？')) return
    mutationLock.current = true
    const epoch = ++mutationEpoch.current
    setBusy(true); setError(''); setNotice('')
    try {
      await reviewCandidate(selected, action, action === 'reject' ? reason || undefined : undefined)
      if (epoch !== mutationEpoch.current) return
      setNotice(action === 'approve' ? '已批准并入库。' : '已拒绝此候选。')
      setItems(current => current.filter(item => item.id !== selected.id)); setSelected(null)
      setPendingCount(count => count === null ? null : Math.max(0, count - 1))
    } catch (e) { if (epoch === mutationEpoch.current) setError(errorText(e)) }
    finally { if (epoch === mutationEpoch.current) { mutationLock.current = false; setBusy(false) } }
  }
  const visible = useMemo(() => (tab === 'cards' || tab === 'pending') && kind !== 'all' ? items.filter(item => item.kind === kind) : items, [items, kind, tab])

  return <div className="bcp" role="main" aria-label="Butler 卡片知识">
    {/* Butler's own title sits below the workbench's shared navigation. */}
    {headless ? null : <div className="bcp__head">{icon ? <img src={icon} alt="" width="38" height="38"/> : null}<div><h1>Butler · 卡片知识</h1><div className="bcp__muted">候选先审阅，只有明确批准后进入正式卡库。</div></div></div>}
    <div className="bcp__tabbar">
      <nav className="bcp__tabs" role="tablist" aria-label="Butler 主导航">
        {([['pending','待确认'],['cards','卡库'],['sessions','会话'],['maintenance','运行与设置']] as [Tab,string][]).map(([id,name]) => <button type="button" className="bcp__tab" role="tab" disabled={busy} aria-selected={tab===id} key={id} onClick={()=>switchTab(id)}>{name}{id==='pending' && pendingCount ? <span className="bcp__count">{pendingCount}</span> : null}</button>)}
      </nav>
      {tab !== 'maintenance' ? <button className="bcp__button bcp__reload" type="button" disabled={busy} onClick={()=>void load(tab,query,kind)}>重载</button> : null}
    </div>
    {tab === 'maintenance' ? <section className="bcp__maint" aria-label="运行与设置">{maintenance || <p>暂无运行与设置内容。</p>}</section> : <>
      {tab !== 'sessions' ? <div className="bcp__row"><div className="bcp__filters" aria-label="按类型筛选">{(['all','knowledge','profile','rule'] as Kind[]).map(value => <button type="button" key={value} className="bcp__filter" aria-pressed={kind===value} disabled={busy} onClick={()=>{setKind(value); if(tab==='cards'||tab==='pending') void load(tab,query,value)}}>{value==='all'?'全部':label(value)}</button>)}</div>
      {tab==='cards' ? <form className="bcp__search-form" onSubmit={event=>{event.preventDefault(); void load(tab,query,kind)}}><input className="bcp__search" aria-label="搜索卡库" placeholder="搜索正式卡…" value={query} onChange={e=>setQuery(e.target.value)}/><button className="bcp__button" type="submit" disabled={busy}>搜索</button></form> : null}</div> : null}
      {loading ? <p role="status">正在加载…</p> : null}{error ? <p className="bcp__notice" data-error="true" role="alert">{error}</p> : null}{notice ? <p className="bcp__notice" role="status">{notice}</p> : null}
      {!loading && !error && visible.length===0 ? <p className="bcp__notice">{tab==='pending'?'当前没有待确认候选。':tab==='cards'?'没有匹配的正式卡。':'尚无会话记录。'}</p> : null}
      <div className="bcp__layout" hidden={!selected && visible.length === 0}><div className="bcp__list" role="list" aria-label="记录列表">{visible.map(item=><button type="button" key={item.id} className="bcp__item" aria-current={selected?.id===item.id} disabled={busy || loading} onClick={()=>void open(item)}><strong>{item.title || item.id}</strong>{tab==='sessions' ? <div className="bcp__meta"><span>{item.source || '来源未注明'}</span><span>{item.captureMode || '采集模式未知'}</span><span>完整性 {formatSessionIntegrity(item.integrity)}</span><span>{label(item.distillStatus)}</span></div> : <div className="bcp__meta"><span>{label(item.kind)}</span>{tab==='pending'?<><span>{label(item.operation)}</span><span>证据 {item.evidence?.length || 0}</span></>:null}{item.revision ? <span>v{item.revision}</span>:null}{tab==='cards' ? <span className="bcp__validity" data-usable={cardUsability(item).usable}>{cardUsability(item).text}</span>:null}</div>}{tab==='sessions' ? null : <div>{item.summary || ''}</div>}{tab==='pending' && item.rationale ? <div>理由：{item.rationale}</div>:null}</button>)}</div>
      <section className="bcp__detail" aria-label="详情" tabIndex={-1}>{viewingEvidence && tab==='sessions' && returnCandidateId ? <button type="button" className="bcp__button" disabled={busy || detailLoading} onClick={()=>void returnToCandidate()}>返回候选审阅</button>:null}{detailLoading ? <p className="bcp__muted" role="status">正在加载详情…</p> : detailFailed ? <p className="bcp__notice" role="alert">详情加载失败；请重载并重新审阅。</p> : !selected ? <p className="bcp__muted">选择一条记录查看详情。</p> : tab==='pending' && editing ? <div className="bcp__editor"><h3>编辑候选草稿</h3><label>标题<input aria-label="标题" value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label><label>摘要<textarea aria-label="摘要" rows={3} value={draft.summary} onChange={e=>setDraft({...draft,summary:e.target.value})}/></label><label>正文（Markdown）<textarea className="bcp__body-editor" aria-label="正文" rows={18} value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})}/></label><div className="bcp__actions"><button type="button" className="bcp__button bcp__button--primary" disabled={busy} onClick={()=>void save()}>保存草稿</button><button type="button" className="bcp__button" onClick={()=>setEditing(false)}>取消</button></div></div> : tab==='pending' ? <>
        <div className="bcp__row"><h2>{selected.title}</h2><span>{label(selected.kind)} · {label(selected.operation)} · v{selected.revision}</span><button type="button" className="bcp__button" disabled={busy} onClick={()=>{setEditing(true); requestAnimationFrame(()=>document.querySelector('.bcp__editor')?.scrollIntoView({block:'start'}))}}>编辑草稿</button></div><p>{selected.summary}</p>{selected.rationale ? <p><strong>为何值得保留：</strong>{selected.rationale}</p>:null}
        {selected.conflicts?.length ? <div className="bcp__conflict"><strong>冲突</strong>{selected.conflicts.map((c:any,i:number)=><pre key={i}>{typeof c==='string'?c:JSON.stringify(c,null,2)}</pre>)}</div>:null}
        {selected.targetId ? <section><h3>关联正式卡</h3><p>{selected.targetId} · 基准版本 {selected.baseRevision ?? '未知'}</p><div className="bcp__compare"><div><h4>旧内容</h4><div className="bcp__body">{renderSafeMarkdown(selected.currentTarget?.body || '未提供旧内容')}</div></div><div><h4>候选新内容</h4><div className="bcp__body">{renderSafeMarkdown(selected.body)}</div></div></div></section> : <section><h3>候选正文</h3><div className="bcp__body">{renderSafeMarkdown(selected.body)}</div></section>}
        <section><h3>证据来源（{selected.evidence?.length || 0}）</h3>{selected.evidence?.length ? selected.evidence.map((ev:any,i:number)=><article className="bcp__evidence" key={`${ev.sourceId}:${i}`}><strong>来源：{ev.sourcePath || ev.sourceId}</strong>{ev.sourceHash ? <div>旧文件快照 SHA-256：{ev.sourceHash}</div> : null}<div>消息：{ev.messageIds?.join('、') || '未提供消息定位'}</div>{ev.quote ? <blockquote>{ev.quote}</blockquote>:null}{ev.sourceId ? <button type="button" className="bcp__button" disabled={busy || detailLoading} onClick={()=>void viewEvidenceSource(ev.sourceId)}>查看来源</button>:null}</article>) : <p>该候选没有提供证据来源。</p>}</section>
        <div className="bcp__actions"><button type="button" className="bcp__button" disabled={busy} onClick={()=>{setEditing(true); requestAnimationFrame(()=>document.querySelector('.bcp__editor')?.scrollIntoView({block:'start'}))}}>编辑草稿</button><button type="button" className="bcp__button bcp__button--primary" disabled={busy || detailLoading || detailFailed} onClick={()=>void decide('approve')}>明确批准入库</button><input aria-label="拒绝理由（可选）" placeholder="拒绝理由（可选）" value={reason} onChange={e=>setReason(e.target.value)}/><button type="button" className="bcp__button" disabled={busy} onClick={()=>void decide('reject')}>拒绝</button></div>
      </> : tab==='cards' ? <><div className="bcp__row"><h2>{selected.title}</h2><span>{label(selected.kind)} · v{selected.revision} · <span className="bcp__validity" data-usable={cardUsability(selected).usable}>{cardUsability(selected).text}</span></span></div><p>{selected.summary}</p>{selected.appliesTo ? <p>适用范围：{selected.appliesTo}</p>:null}<p>批准时间：{selected.approvedAt || '未提供'}</p><ValidityPanel card={selected}/><div className="bcp__body">{renderSafeMarkdown(selected.body || '')}</div>{selected.links?.length ? <section><h3>关联卡片</h3>{selected.links.map((id:string,i:number)=><button type="button" className="bcp__button" key={`${id}:${i}`} disabled={busy || detailLoading} onClick={()=>void openCard(id)}>{id}</button>)}</section>:null}{selected.backlinks?.length ? <section><h3>反向链接</h3>{selected.backlinks.map((id:string,i:number)=><button type="button" className="bcp__button" key={`${id}:${i}`} disabled={busy || detailLoading} onClick={()=>void openCard(id)}>{id}</button>)}</section>:null}<h3>证据来源</h3>{selected.evidence?.map((ev:any,i:number)=><div className="bcp__evidence" key={i}>{ev.sourceId} · {ev.messageIds?.join('、')} {ev.quote || ''}</div>)}</> : <><div className="bcp__row"><h2>{selected.title || selected.id}</h2><span className="bcp__muted">{selected.source || '来源未注明'} · {selected.captureMode || '采集模式未知'}</span></div><p>完整性：{formatSessionIntegrity(selected.integrity)} · 蒸馏：{label(selected.distillStatus)} · 候选数：{selected.candidateCount ?? '未注明'}</p><h3>会话消息（{selected.messages?.length || 0}）</h3><div className="bcp__messages">{(selected.messages || []).slice().sort((a:any,b:any)=>a.sequence-b.sequence).map((message:any)=><article className="bcp__message" data-role={message.role} key={message.id}><strong>{label(message.role)} · #{message.sequence} · {message.id}</strong><p>{message.content}</p></article>)}</div></>}
      </section></div>
    </>}
  </div>
}
