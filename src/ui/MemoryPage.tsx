import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RecordDetail, stampOf } from './records.tsx'
import { hueOf } from './ConsoleBody.tsx'
import { GripIcon, SearchIcon } from './icons.tsx'
import { moveWithin } from './console-layout.ts'
import { useDragOrder } from './use-drag-order.ts'
import { fetchButlerSection, runFacultyCommand } from './butler-source.ts'

/**
 * The memory page: browse and manage what Butler remembers about the owner.
 *
 * What lives here is the path a thing takes to become long-term memory:
 *
 *     record  ->  record card  ->  knowledge card | rule card | identity card
 *
 * Record cards are read-only and only ever come from collection (or "记一条观察");
 * they are promoted, never hand-made. Knowledge, rule and identity cards can also
 * be written and deleted by hand. Commit and turn-end records are kept apart as
 * their own sections for lookup and are not offered for promotion.
 *
 * Four kinds of card and two lookup sections: rule cards, knowledge cards, the
 * identity card, record cards, Git record cards, session record cards. Reads come from the Host's `memory` section in one
 * request; every write is a `journal` faculty command (`card-create`,
 * `card-update`, `card-delete`, `profile-set`, `intake`) because `Butler/self`
 * may only be written through faculty commands. The page never touches a file.
 *
 * Everything is a card, the same `bp-tile` the console uses: a rule, a
 * knowledge entry, the profile and one observation each look like one tile in
 * one grid. The tile shows identity and a short excerpt; opening it shows the
 * whole thing in a sheet, and editing happens in that sheet. There is no
 * master/detail split to keep in sync.
 *
 * The journal is a ledger and stays read-only: the one way to add to it from
 * here is `intake`, which lands in the spool and reaches the journal on the next
 * `run`, so the page says so instead of pretending the entry is already there.
 */

const FACULTY = 'journal'
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const SOURCE = /^[a-z0-9][a-z0-9-]*$/
/* Two kinds of thing, shown as two groups: the cards the owner keeps, and the records they come from. */
const CARD_SECTIONS = ['rule', 'knowledge', 'profile']
const RECORD_SECTIONS = ['journal', 'git', 'session']
/** Record sections and the Host's record group each one shows. */
const RECORD_GROUP = { journal: 'observation', git: 'git', session: 'session' }
const RECORD_MARK = { journal: '记', git: '提', session: '会' }
/** What an agent or the owner can report; `session` is a collector marker, never reported by hand. */
const TYPES = ['note', 'decision', 'fact', 'milestone', 'error']
/** Where a record can be promoted to. */
const TARGETS = ['knowledge', 'rule', 'profile']

/**
 * A card's excerpt: the text flattened to one flow with Markdown scaffolding
 * (headings, quotes, bullets, emphasis) dropped, so every kind of card shows its
 * words and not its syntax. CSS clamps it to two lines.
 * @param {string} text - card body, profile or record text.
 * @returns {string} plain excerpt, at most 240 characters.
 */
function excerpt(text) {
  return String(text ?? '')
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

/**
 * Run one write command; a non-zero exit is an error the owner must see.
 * @param {string} item - command id in the journal faculty manifest.
 * @param {object} args - manifest-declared args (stdin args included).
 * @returns {Promise<object>} the Host's run record.
 */
async function write(item, args) {
  const record = await runFacultyCommand(FACULTY, item, true, args)
  if (record.exitCode !== 0) throw new Error((record.stderr || record.stdout || `exit ${record.exitCode}`).trim())
  return record
}

export function MemoryPage({ t, lead = null, icon, openSession = null, focus = null, onFocused = null }) {
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [section, setSection] = useState('rule')
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState(null)
  const [edit, setEdit] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const [typeFilter, setTypeFilter] = useState('all')
  const [promoting, setPromoting] = useState(null)

  /* What the endpoints just reported waits in a holding area until it is merged in; open the page and
     it is merged first, so the collected records are never behind what was actually collected. A failed
     merge is not the page's problem: it shows what is already there. */
  const merged = useRef(false)
  const load = useCallback(async () => {
    if (!merged.current) {
      merged.current = true
      try { await write('run', undefined) } catch { /* show what is already there */ }
    }
    try { setData(await fetchButlerSection('memory')); setLoadError(null) }
    catch (error) { setLoadError(String(error?.message ?? error)) }
  }, [])
  useEffect(() => { void load() }, [load])

  /* Arriving from the briefing's "suggested" row: land on the record cards with that
     record open, so the owner can read the reason and decide. If it is no longer there
     (decided meanwhile), say so rather than leave the page unexplained. */
  useEffect(() => {
    if (!focus || !data?.records) return
    if (focus.startsWith('section:')) {
      onFocused?.()
      const target = focus.slice('section:'.length)
      if (RECORD_SECTIONS.includes(target) || CARD_SECTIONS.includes(target)) setSection(target)
      return
    }
    const record = data.records.observation.records.find(item => item.key === focus)
    onFocused?.()
    setSection('journal')
    if (record) setOpened({ type: 'record', record })
    else setNotice({ tone: undefined, text: t('memory.focusGone') })
  }, [focus, data])

  /* An old Host (or one that has not rescanned the manifests) does not know the
     new section or commands; say that once, in words, instead of a raw 4xx. */
  const explain = (message) => (/不接受参数|没有这个命令|分区不存在/.test(message) ? t('memory.stale') : message)

  const act = async (item, args) => {
    setBusy(true)
    setNotice(null)
    try { await write(item, args); await load(); return true }
    catch (error) { setNotice({ tone: 'bad', text: explain(String(error?.message ?? error)) }); return false }
    finally { setBusy(false) }
  }

  const cards = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (data?.cards ?? []).filter(card => card.kind === section
      && (!needle || `${card.title} ${card.summary} ${card.slug} ${card.body}`.toLowerCase().includes(needle)))
  }, [data, section, query])

  const group = data?.records?.[RECORD_GROUP[section]]
  const records = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (group?.records ?? []).filter(record => (section !== 'journal' || typeFilter === 'all' || record.type === typeFilter)
      && (!needle || `${record.text ?? ''} ${record.source ?? ''} ${(record.tags ?? []).join(' ')}`.toLowerCase().includes(needle)))
  }, [group, section, query, typeFilter])

  const count = (key) => {
    if (!data || key === 'profile') return ''
    if (key === 'journal') {
      const open = data.records.observation.records.filter(record => record.candidate).length
      return open ? `荐 ${open} · ${data.records.observation.total}` : String(data.records.observation.total)
    }
    if (RECORD_GROUP[key]) return String(data.records[RECORD_GROUP[key]].total)
    return String(data.cards.filter(item => item.kind === key).length)
  }

  /* Dragging reorders one section of cards. It is off while a search narrows the
     list, because the visible ids are then not the section's order and writing
     them back would drop every hidden card to the end. */
  const sortable = (section === 'rule' || section === 'knowledge') && !query.trim() && !busy
  const move = useCallback((id, boundary) => {
    const ids = cards.map(card => card.id)
    const next = moveWithin(ids, id, boundary)
    if (next === ids) return
    setData(current => ({
      ...current,
      cards: [...current.cards.filter(card => card.kind !== section), ...next.map(key => current.cards.find(card => card.id === key))],
    }))
    void act('card-order', { kind: section, slugs: next.map(key => key.split('/')[1]).join('\n') }).then(ok => { if (!ok) void load() })
  }, [cards, section])
  const { gridProps, gripProps, dragId, dropLine } = useDragOrder({ ids: cards.map(card => card.id), enabled: sortable, onMove: move })
  const choose = (key) => { setSection(key); setOpened(null); setEdit(null); setNotice(null) }
  const close = () => { setOpened(null); setEdit(null); setPromoting(null) }

  const saveCard = async (event) => {
    event.preventDefault()
    const ok = await act('card-update', {
      id: edit.id, title: edit.title.trim(), body: edit.body,
      ...(edit.summary.trim() ? { summary: edit.summary.trim() } : {}),
    })
    if (ok) close()
  }
  const removeCard = async (card) => {
    if (!window.confirm(t('memory.confirmDelete').replace('%s', card.title))) return
    if (await act('card-delete', { id: card.id })) close()
  }
  const saveProfile = async (event) => {
    event.preventDefault()
    if (!window.confirm(t('memory.confirmProfile'))) return
    if (await act('profile-set', { body: edit.body })) close()
  }

  /* Promotion writes a new card (or one line of the identity card) that carries the
     record's handle, so the record can show where it went. */
  const promote = async (target, fields) => {
    const record = promoting
    if (target === 'profile') {
      if (!window.confirm(t('memory.confirmProfile'))) return
      if (!(await act('profile-append', { origin: record.key, line: fields.line.trim() }))) return
      setNotice({ tone: undefined, text: t('memory.promotedTo').replace('%s', t('memory.nav.profile')) })
    } else {
      const args = { id: `${target}/${fields.slug}`, title: fields.title.trim(), body: fields.body, origin: record.key, ...(fields.summary.trim() ? { summary: fields.summary.trim() } : {}) }
      if (!(await act('card-create', args))) return
      setNotice({ tone: undefined, text: t('memory.promotedTo').replace('%s', `${t(`memory.nav.${target}`)} · ${fields.slug}`) })
    }
    setPromoting(null)
    close()
  }
  /* "Not worth keeping": the faculty remembers it, so the suggestion goes away and
     distill never marks that record again. The record itself is untouched. */
  const dismiss = async (record) => {
    if (await act('candidate-dismiss', { origin: record.key })) close()
  }
  const jumpTo = (id) => {
    const kind = id === 'profile' ? 'profile' : id.split('/')[0]
    choose(kind)
    setOpened(kind === 'profile' ? { type: 'profile' } : { type: 'card', id })
  }
  const targetName = (id) => (id === 'profile' ? t('memory.nav.profile') : `${t(`memory.nav.${id.split('/')[0]}`)} · ${id.split('/')[1]}`)

  const head = (
    <div className="bp-head">
      <img className="bq-mark" src={icon} alt="" width="38" height="38" />
      <div>
        {lead ?? <h1 className="bp-head__title">{t('memory.title')}</h1>}
        <p className="bp-head__sub">{t('memory.subtitle')}</p>
      </div>
      <span className="bp-head__spacer" />
      {section !== 'profile' ? (
        <label className="bp-search">
          <SearchIcon className="bp-search__icon" />
          <input type="search" aria-label={t('memory.search')} value={query} placeholder={t('memory.search')} onChange={event => setQuery(event.target.value)} />
          {query ? <button type="button" className="bp-search__clear" aria-label={t('memory.clear')} onClick={() => setQuery('')}>×</button> : null}
        </label>
      ) : null}
      <button type="button" className="bp-btn" onClick={() => setDialog('observation')}>{t('memory.observe')}</button>
      <button type="button" className="bp-btn bp-btn--primary" onClick={() => setDialog('card')}>{t('memory.newCard')}</button>
    </div>
  )

  return (
    <div className="bq-brief">
      {head}
      {notice ? <p className="bp-note" data-tone={notice.tone} role={notice.tone === 'bad' ? 'alert' : 'status'}><span>{notice.text}</span></p> : null}
      {loadError ? <p className="bp-note" data-tone="bad" role="alert"><span>{t('view.failed')}{explain(loadError)}</span></p> : null}

      {data ? (
        <div className="bq-zone bm-cols">
          <nav className="bp-tile bm-nav" aria-label={t('memory.title')}>
            {[['cards', CARD_SECTIONS], ['records', RECORD_SECTIONS]].map(([group, keys], index) => (
              <div key={group} className="bm-nav__group" role="group" aria-label={t(`memory.navGroup.${group}`)}>
                {index > 0 ? <hr className="bm-nav__rule" /> : null}
                <p className="bm-nav__label">{t(`memory.navGroup.${group}`)}</p>
                {keys.map(key => (
                  <button key={key} type="button" className="bm-nav__item" aria-current={section === key ? 'true' : undefined} onClick={() => choose(key)}>
                    <span>{t(`memory.nav.${key}`)}</span>
                    <em>{count(key)}</em>
                  </button>
                ))}
              </div>
            ))}
            {data.trash > 0 ? <p className="bm-nav__hint">{t('memory.trash').replace('%d', String(data.trash))}</p> : null}
          </nav>

          <section className="bp-sec bm-sec">
            <div className="bp-catalog-section-heading">
              <h3 className="bp-sec__title">{t(`memory.nav.${section}`)}</h3>
              <span className="bp-sec__count">{RECORD_GROUP[section] ? records.length : section === 'profile' ? 1 : cards.length}</span>
              <span className="bp-sec__rule" />
              {section === 'journal' ? (
                <div className="bp-switch bp-switch--small" role="group" aria-label={t('memory.type')}>
                  {['all', ...TYPES].map(key => (
                    <button key={key} type="button" className="bp-switch__tab" aria-pressed={typeFilter === key ? 'true' : 'false'} onClick={() => setTypeFilter(key)}>
                      {key === 'all' ? t('memory.all') : key}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {RECORD_GROUP[section] ? <p className="bm-hint">{t(`memory.hint.${section}`).replace('%d', String(group.total)).replace('%n', String(group.records.length))}</p> : null}
            {section === 'rule' || section === 'knowledge' ? <p className="bm-hint">{t('memory.hint.cards')}</p> : null}

            <div className="bp-grid" {...gridProps}>
              {section === 'rule' || section === 'knowledge' ? cards.map(card => (
                <MemoryTile
                  key={card.id}
                  id={card.id}
                  dragging={dragId === card.id}
                  grip={gripProps(card.id, `${card.title} · ${t('console.drag')}`, t('console.dragHint'))}
                  mark={card.kind === 'rule' ? '规' : '知'}
                  name={card.title}
                  desc={excerpt(card.summary || card.body)}
                  chip={card.kind === 'rule' ? t('memory.nav.rule') : t('memory.nav.knowledge')}
                  slot={card.origin ? `${card.slug} · ${t('memory.fromRecord')}` : card.slug}
                  onOpen={() => { setOpened({ type: 'card', id: card.id }); setEdit(null) }}
                  actions={(
                    <>
                      <button type="button" className="bp-btn bp-btn--act" disabled={busy} onClick={() => { setOpened({ type: 'card', id: card.id }); setEdit({ id: card.id, title: card.title, summary: card.summary, body: card.body }) }}>{t('memory.edit')}</button>
                      <button type="button" className="bp-btn bp-btn--act bp-btn--danger" disabled={busy} onClick={() => { void removeCard(card) }}>{t('memory.delete')}</button>
                    </>
                  )}
                />
              )) : null}

              {section === 'profile' ? (
                <MemoryTile
                  id="profile"
                  mark="身"
                  name={t('memory.nav.profile')}
                  desc={excerpt(data.profile) || t('memory.empty')}
                  chip={t('memory.nav.profile')}
                  slot={t('memory.profileSlot')}
                  onOpen={() => { setOpened({ type: 'profile' }); setEdit(null) }}
                  actions={<button type="button" className="bp-btn bp-btn--act" disabled={busy} onClick={() => { setOpened({ type: 'profile' }); setEdit({ id: 'profile', body: data.profile }) }}>{t('memory.edit')}</button>}
                />
              ) : null}

              {RECORD_GROUP[section] ? records.map(record => (
                <MemoryTile
                  key={record.key}
                  id={record.key}
                  mark={record.promotedTo ? '升' : record.candidate ? '荐' : RECORD_MARK[section]}
                  name={stampOf(record.ts)}
                  desc={excerpt(record.text)}
                  chip={record.source}
                  slot={record.promotedTo ? `${t('memory.promoted')} · ${targetName(record.promotedTo)}` : record.candidate ? t('memory.candidate') : [record.type, ...(record.tags ?? [])].join(' · ')}
                  onOpen={() => setOpened({ type: 'record', record })}
                  actions={(
                    <>
                      <button type="button" className="bp-btn bp-btn--act" onClick={() => setOpened({ type: 'record', record })}>{t('memory.view')}</button>
                      {section === 'journal' && !record.promotedTo ? <button type="button" className="bp-btn bp-btn--act" disabled={busy} onClick={() => { setOpened({ type: 'record', record }); setPromoting(record) }}>{record.candidate ? t('memory.promoteNow').replace('%s', t(`memory.nav.${record.candidate.to}`)) : t('memory.promote')}</button> : null}
                    </>
                  )}
                />
              )) : null}
              {dropLine ? <span className="bp-drop" style={dropLine} aria-hidden="true" /> : null}
            </div>
            {(RECORD_GROUP[section] ? records.length : section === 'profile' ? 1 : cards.length) === 0
              ? <p className="bp-empty">{query ? t('memory.noMatch') : t('memory.empty')}</p> : null}
          </section>
        </div>
      ) : (loadError ? null : <p className="bp-note bm-loading"><span>{t('view.loading')}</span></p>)}

      {opened ? (
        <Sheet
          t={t}
          onClose={close}
          title={opened.type === 'card' ? (data.cards.find(c => c.id === opened.id)?.title ?? '') : opened.type === 'profile' ? t('memory.nav.profile') : t(`memory.nav.${section}`)}
          sub={opened.type === 'card' ? opened.id : opened.type === 'record' ? stampOf(opened.record.ts) : t('memory.profileHint')}
        >
          {opened.type === 'record' ? (
            <>
              {promoting && promoting.key === opened.record.key ? (
                <PromoteForm t={t} busy={busy} record={opened.record} onCancel={() => setPromoting(null)} onSubmit={promote} />
              ) : (
                <>
                  <RecordDetail t={t} record={opened.record} openSession={openSession} />
                  {opened.record.promotedTo ? (
                    <div className="bp-editor__acts">
                      <button type="button" className="bp-btn" onClick={() => jumpTo(opened.record.promotedTo)}>{t('memory.promotedAt').replace('%s', targetName(opened.record.promotedTo))}</button>
                    </div>
                  ) : section === 'journal' ? (
                    <>
                      {opened.record.candidate ? <p className="bm-summary">{t('memory.candidateAsk').replace('%s', t(`memory.nav.${opened.record.candidate.to}`)).replace('%r', opened.record.candidate.reason)}</p> : null}
                      <div className="bp-editor__acts">
                        {opened.record.candidate ? <button type="button" className="bp-btn" disabled={busy} onClick={() => { void dismiss(opened.record) }}>{t('memory.dismiss')}</button> : null}
                        <button type="button" className="bp-btn bp-btn--primary" disabled={busy} onClick={() => setPromoting(opened.record)}>{opened.record.candidate ? t('memory.promoteNow').replace('%s', t(`memory.nav.${opened.record.candidate.to}`)) : t('memory.promote')}</button>
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </>
          ) : null}
          {opened.type === 'card' ? (() => {
            const card = data.cards.find(c => c.id === opened.id)
            if (!card) return <p className="bp-empty">{t('memory.pick')}</p>
            return edit?.id === card.id ? (
              <form className="bm-form" onSubmit={saveCard}>
                <label>{t('memory.field.title')}<input required autoFocus value={edit.title} onChange={event => setEdit({ ...edit, title: event.target.value })} /></label>
                <label>{t('memory.field.summary')}<input value={edit.summary} placeholder={t('memory.summaryHint')} onChange={event => setEdit({ ...edit, summary: event.target.value })} /></label>
                <label>{t('memory.field.body')}<textarea required rows={14} value={edit.body} onChange={event => setEdit({ ...edit, body: event.target.value })} /></label>
                <div className="bp-editor__acts">
                  <button type="button" className="bp-btn" disabled={busy} onClick={() => setEdit(null)}>{t('memory.cancel')}</button>
                  <button type="submit" className="bp-btn bp-btn--primary" disabled={busy}>{t('memory.save')}</button>
                </div>
              </form>
            ) : (
              <>
                {card.origin ? <p className="bm-summary">{t('memory.fromRecordAt').replace('%s', card.origin.replace(/^journal:/, '').replace(/:.*$/, '').replace('T', ' ').replace(/Z$/, ''))}</p> : null}
                {card.summary && !card.body.includes(card.summary.replace(/…$/, '')) ? <p className="bm-summary">{card.summary}</p> : null}
                <pre className="bm-body">{card.body}</pre>
                <div className="bp-editor__acts">
                  <button type="button" className="bp-btn bp-btn--danger" disabled={busy} onClick={() => { void removeCard(card) }}>{t('memory.delete')}</button>
                  <button type="button" className="bp-btn" disabled={busy} onClick={() => setEdit({ id: card.id, title: card.title, summary: card.summary, body: card.body })}>{t('memory.edit')}</button>
                </div>
              </>
            )
          })() : null}
          {opened.type === 'profile' ? (
            edit?.id === 'profile' ? (
              <form className="bm-form" onSubmit={saveProfile}>
                <textarea required autoFocus rows={20} aria-label={t('memory.nav.profile')} value={edit.body} onChange={event => setEdit({ ...edit, body: event.target.value })} />
                <div className="bp-editor__acts">
                  <button type="button" className="bp-btn" disabled={busy} onClick={() => setEdit(null)}>{t('memory.cancel')}</button>
                  <button type="submit" className="bp-btn bp-btn--primary" disabled={busy}>{t('memory.save')}</button>
                </div>
              </form>
            ) : (
              <>
                <pre className="bm-body">{data.profile || t('memory.empty')}</pre>
                <div className="bp-editor__acts">
                  <button type="button" className="bp-btn" disabled={busy} onClick={() => setEdit({ id: 'profile', body: data.profile })}>{t('memory.edit')}</button>
                </div>
              </>
            )
          ) : null}
        </Sheet>
      ) : null}

      {dialog === 'card' ? <CardDialog t={t} busy={busy} onClose={() => setDialog(null)} onSubmit={async (kind, slug, fields) => {
        const ok = await act('card-create', { id: `${kind}/${slug}`, ...fields })
        if (ok) { setSection(kind); setQuery(''); setDialog(null) }
      }} /> : null}
      {dialog === 'observation' ? <ObservationDialog t={t} busy={busy} onClose={() => setDialog(null)} onSubmit={async (args) => {
        if (!(await act('intake', args))) return
        try { await write('run', undefined); await load() } catch { /* it is merged the next time the page opens or distill runs */ }
        setDialog(null); setNotice({ tone: undefined, text: t('memory.observed') })
      }} /> : null}
    </div>
  )
}

/**
 * One memory item as a console tile. All four kinds share this one shape: a
 * one-character mark, a one-line name, a two-line excerpt, then kind and slug in
 * the footer with the actions at its right. Same markup as the console's tiles,
 * so the tile styles apply unchanged.
 */
function MemoryTile({ id, mark, name, desc, chip, slot, onOpen, actions = null, grip = null, dragging = false }) {
  return (
    <article className="bp-tile bm-tile" data-tone="none" data-card-id={id} data-dragging={dragging ? 'true' : undefined}>
      <span className="bp-tile__rail" aria-hidden="true" />
      <div className="bp-tile__head">
        <span className="bp-tile__mark bp-tile__mark--glyph" data-hue={hueOf(String(id))} aria-hidden="true">{mark}</span>
        <div
          className="bp-tile__open"
          data-clickable="true"
          role="button"
          tabIndex={0}
          onClick={onOpen}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } }}
        >
          <h4 className="bp-tile__name">{name}</h4>
          <p className="bp-tile__desc">{desc}</p>
        </div>
        {grip ? <button className="bp-grip" {...grip}><GripIcon /></button> : null}
      </div>
      <div className="bp-tile__foot">
        <div className="bp-tile__meta">
          <span className="bp-chip bp-chip--soft">{chip}</span>
          <span className="bp-tile__slot">{slot}</span>
        </div>
        <div className="bp-tile__acts">{actions}</div>
      </div>
    </article>
  )
}

/**
 * The promote form: a record becomes a knowledge card, a rule card or one line
 * of the identity card. Everything is prefilled from the record and nothing is
 * written until the owner confirms, because a card is something the owner
 * stands behind — the record itself stays as it is either way.
 */
function PromoteForm({ t, busy, record, onCancel, onSubmit }) {
  const suggested = record.candidate?.to
  const text = String(record.text ?? '').trim()
  const first = text.split('\n')[0].slice(0, 80)
  const [target, setTarget] = useState(suggested ?? 'knowledge')
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState(first)
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState(text)
  const [line, setLine] = useState(first)
  const valid = target === 'profile' ? line.trim().length > 0 : SLUG.test(slug) && title.trim() && body.trim()
  return (
    <form className="bm-form" onSubmit={event => { event.preventDefault(); if (valid) void onSubmit(target, { slug, title, summary, body, line }) }}>
      <div className="bp-editor__kinds bm-kinds bm-kinds--3" role="group" aria-label={t('memory.promoteTo')}>
        {TARGETS.map(key => (
          <button key={key} type="button" className="bp-btn" aria-pressed={target === key ? 'true' : 'false'} onClick={() => setTarget(key)}>{t(`memory.nav.${key}`)}</button>
        ))}
      </div>
      {record.candidate ? <p className="bp-editor__note">{t('memory.candidateWhy').replace('%s', record.candidate.reason)}</p> : null}
      <p className="bp-editor__note">{t(`memory.promoteHint.${target}`)}</p>
      {target === 'profile' ? (
        <label>{t('memory.field.line')}<textarea required autoFocus rows={3} value={line} onChange={event => setLine(event.target.value)} /></label>
      ) : (
        <>
          <label>{t('memory.field.slug')}<input required autoFocus value={slug} placeholder="git-discipline" aria-invalid={slug && !SLUG.test(slug) ? 'true' : undefined} onChange={event => setSlug(event.target.value)} /></label>
          {slug && !SLUG.test(slug) ? <p className="bp-editor__note" data-tone="bad">{t('memory.slugRule')}</p> : null}
          <label>{t('memory.field.title')}<input required value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label>{t('memory.field.summary')}<input value={summary} placeholder={t('memory.summaryHint')} onChange={event => setSummary(event.target.value)} /></label>
          <label>{t('memory.field.body')}<textarea required rows={8} value={body} onChange={event => setBody(event.target.value)} /></label>
        </>
      )}
      <div className="bp-editor__acts">
        <button type="button" className="bp-btn" disabled={busy} onClick={onCancel}>{t('memory.cancel')}</button>
        <button type="submit" className="bp-btn bp-btn--primary" disabled={busy || !valid}>{t('memory.promote')}</button>
      </div>
    </form>
  )
}

/** The opaque sheet every opened card lives in; same shell as the console's editors. */
function Sheet({ t, title, sub, onClose, children }) {
  return (
    <div className="bp-editor-backdrop" role="presentation" onClick={onClose}>
      <div className="bp-editor bm-dialog bm-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
        <div className="bp-editor__head">
          <div>
            <h2>{title}</h2>
            <p className="bm-meta">{sub}</p>
          </div>
          <button type="button" className="bp-btn bp-btn--ghost" aria-label={t('view.close')} onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** The new-card dialog: kind, slug, title, optional summary, body. */
function CardDialog({ t, busy, onClose, onSubmit }) {
  const [kind, setKind] = useState('rule')
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const valid = SLUG.test(slug)
  return (
    <div className="bp-editor-backdrop" role="presentation" onClick={onClose}>
      <form
        className="bp-editor bm-dialog"
        role="dialog"
        aria-modal="true"
        onSubmit={event => { event.preventDefault(); if (valid) void onSubmit(kind, slug, { title: title.trim(), body, ...(summary.trim() ? { summary: summary.trim() } : {}) }) }}
        onClick={event => event.stopPropagation()}
      >
        <div className="bp-editor__head">
          <h2>{t('memory.newCard')}</h2>
          <button type="button" className="bp-btn bp-btn--ghost" aria-label={t('view.close')} onClick={onClose}>×</button>
        </div>
        <div className="bp-editor__kinds bm-kinds" role="group" aria-label={t('memory.kind')}>
          {['rule', 'knowledge'].map(key => (
            <button key={key} type="button" className="bp-btn" aria-pressed={kind === key ? 'true' : 'false'} onClick={() => setKind(key)}>{t(`memory.nav.${key}`)}</button>
          ))}
        </div>
        <p className="bp-editor__note">{t(`memory.kindHint.${kind}`)}</p>
        <label>{t('memory.field.slug')}<input required autoFocus value={slug} placeholder="git-discipline" aria-invalid={slug && !valid ? 'true' : undefined} onChange={event => setSlug(event.target.value)} /></label>
        {slug && !valid ? <p className="bp-editor__note" data-tone="bad">{t('memory.slugRule')}</p> : null}
        <label>{t('memory.field.title')}<input required value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>{t('memory.field.summary')}<input value={summary} placeholder={t('memory.summaryHint')} onChange={event => setSummary(event.target.value)} /></label>
        <label>{t('memory.field.body')}<textarea required rows={8} value={body} onChange={event => setBody(event.target.value)} /></label>
        <div className="bp-editor__acts">
          <button type="button" className="bp-btn" onClick={onClose}>{t('memory.cancel')}</button>
          <button type="submit" className="bp-btn bp-btn--primary" disabled={busy || !valid}>{t('memory.create')}</button>
        </div>
      </form>
    </div>
  )
}

/** The record-an-observation dialog: it feeds `intake`, i.e. the spool. */
function ObservationDialog({ t, busy, onClose, onSubmit }) {
  const [source, setSource] = useState('manual')
  const [type, setType] = useState('note')
  const [tag, setTag] = useState('')
  const [text, setText] = useState('')
  const valid = SOURCE.test(source)
  return (
    <div className="bp-editor-backdrop" role="presentation" onClick={onClose}>
      <form
        className="bp-editor bm-dialog"
        role="dialog"
        aria-modal="true"
        onSubmit={event => { event.preventDefault(); if (valid) void onSubmit({ source, type, text, ...(tag.trim() ? { tag: tag.trim() } : {}) }) }}
        onClick={event => event.stopPropagation()}
      >
        <div className="bp-editor__head">
          <h2>{t('memory.observe')}</h2>
          <button type="button" className="bp-btn bp-btn--ghost" aria-label={t('view.close')} onClick={onClose}>×</button>
        </div>
        <p className="bp-editor__note">{t('memory.observeHint')}</p>
        <label>{t('memory.field.text')}<textarea required autoFocus rows={6} value={text} onChange={event => setText(event.target.value)} /></label>
        <label>{t('memory.type')}
          <select value={type} onChange={event => setType(event.target.value)}>
            {TYPES.map(key => <option key={key} value={key}>{key}</option>)}
          </select>
        </label>
        <label>{t('memory.field.source')}<input required value={source} aria-invalid={source && !valid ? 'true' : undefined} onChange={event => setSource(event.target.value)} /></label>
        {source && !valid ? <p className="bp-editor__note" data-tone="bad">{t('memory.sourceRule')}</p> : null}
        <label>{t('memory.field.tags')}<input value={tag} placeholder="a,b" onChange={event => setTag(event.target.value)} /></label>
        <div className="bp-editor__acts">
          <button type="button" className="bp-btn" onClick={onClose}>{t('memory.cancel')}</button>
          <button type="submit" className="bp-btn bp-btn--primary" disabled={busy || !valid}>{t('memory.record')}</button>
        </div>
      </form>
    </div>
  )
}
