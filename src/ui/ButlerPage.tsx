/**
 * The Butler briefing, rendered into the root-scoped `main` keyed slot.
 *
 * It answers one question: what is distill doing, and what did it come up with.
 * Everything is a tile of the same size on one grid (the memory page's own
 * tiles), in two rows of meaning:
 *
 *   蒸馏      when it runs next, how much is waiting for it, what it has suggested
 *   待你决定  the suggestions themselves, each opening the memory page on its record
 *
 * What used to sit here — endpoint counts, the ledger and its holding area, the
 * capability commands and reports — is plumbing the owner never needed to
 * understand to use the memory. It is one fold away under 维护, not gone.
 *
 * Every shared element is the console's own class (`bp-*`); the tiles are the
 * memory page's (`bm-tile`), so the two tabs read as one app.
 *
 * Props arrive assembled by the renderer: `t` from the declared locale
 * namespace, and `useButler` / `recheck` from the registration's inject face.
 */

import { useEffect, useState } from 'react'
import { hueOf } from './ConsoleBody.tsx'
import { RecordRow } from './records.tsx'
import { runFacultyCommand, fetchFacultyReport, registerButlerAutomations, fetchAutomationStatus, fetchButlerSection } from './butler-source.ts'

/** The statuses `/myspace-butler/butler` reports, mapped to a dot tone and a sentence. */
const VERDICTS = {
  healthy: { tone: 'ok', key: 'verdict.healthy' },
  warning: { tone: 'warn', key: 'verdict.warning' },
  error: { tone: 'bad', key: 'verdict.error' },
}

/**
 * The tone of one doctor line, from its `[PASS]` / `[WARN]` / `[FAIL]` prefix.
 * @param {string} line - raw doctor output line.
 * @returns {'ok' | 'warn' | 'bad' | undefined} the dot tone, or none for INFO.
 */
function lineTone(line) {
  const mark = /^\[(\w+)\]/.exec(line)?.[1]
  return mark === 'PASS' ? 'ok' : mark === 'WARN' ? 'warn' : mark === 'FAIL' ? 'bad' : undefined
}

/**
 * A moment as the owner reads it: weekday, day and clock, in their own zone.
 * @param {string | null | undefined} iso - ISO time.
 * @returns {string} the short text, or an empty string when unreadable.
 */
function when(iso) {
  const at = iso ? new Date(iso) : null
  if (!at || Number.isNaN(at.getTime())) return ''
  return at.toLocaleString([], { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * One tile of the briefing. Same markup and size as the memory page's tiles, so a row of them aligns.
 * @param props - the one-character mark, a name, a two-line description, the footer chip/slot and actions.
 * @returns the tile element.
 */
function Tile({ id, mark, name, desc, chip, slot = '', tone = 'none', onOpen = null, actions = null }) {
  const open = onOpen ? { role: 'button', tabIndex: 0, 'data-clickable': 'true', onClick: onOpen, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } } } : {}
  return (
    <article className="bp-tile bm-tile" data-tone={tone} data-card-id={id}>
      <span className="bp-tile__rail" aria-hidden="true" />
      <div className="bp-tile__head">
        <span className="bp-tile__mark bp-tile__mark--glyph" data-hue={hueOf(String(id))} aria-hidden="true">{mark}</span>
        <div className="bp-tile__open" {...open}>
          <h4 className="bp-tile__name">{name}</h4>
          <p className="bp-tile__desc">{desc}</p>
        </div>
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
 * Render the Butler overview page.
 * @param props - assembled slot props.
 * @returns the page element.
 */
function BriefingPage({ t, useButler, recheck, icon, lead = null, openMemory = null, embedded = false }) {
  const status = useButler(snapshot => snapshot.status)
  const attention = useButler(snapshot => snapshot.attention)
  const doctor = useButler(snapshot => snapshot.doctor)
  const distill = useButler(snapshot => snapshot.distill)
  const suggested = useButler(snapshot => snapshot.suggested)
  const endpoints = useButler(snapshot => snapshot.endpoints)
  const faculties = useButler(snapshot => snapshot.faculties)
  const rejected = useButler(snapshot => snapshot.rejected)
  const checkedAt = useButler(snapshot => snapshot.checkedAt)

  const decide = attention.filter(item => item.level === 'info')
  const verdict = VERDICTS[status] ?? { tone: undefined, key: 'verdict.unknown' }

  /* 命令与报告的就地结果，按 `report:<id>:<item>` / `command:<id>:<item>` 寻址。 */
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(null)
  const [recheckBusy, setRecheckBusy] = useState(false)
  /* 巡检 / 端点的详情，数据已在快照里，不额外请求。 */
  const [view, setView] = useState(null)
  /* 蒸馏任务在 DSH 日程里的位置：下次/上次什么时候。读不到就如实说读不到。 */
  const [schedule, setSchedule] = useState(null)
  const loadSchedule = () => { void fetchAutomationStatus().then(setSchedule) }
  useEffect(loadSchedule, [])

  const showReport = async (faculty, report) => {
    const key = `report:${faculty}:${report}`
    if (result?.key === key) { setResult(null); return }
    setBusy(key)
    try {
      const record = await fetchFacultyReport(faculty, report)
      setResult({ key, text: record.stdout || t('faculty.emptyOutput'), failed: record.exitCode !== 0 })
    } catch (error) {
      setResult({ key, text: String(error?.message ?? error), failed: true })
    } finally {
      setBusy(null)
    }
  }

  const runCommand = async (faculty, command, effect) => {
    const key = `command:${faculty}:${command}`
    if (result?.key === key) { setResult(null); return }
    /* effect=write/external 守护端要求 confirmed；这里把确认留给主人，而不是替他默认同意。 */
    if (effect && effect !== 'read' && !window.confirm(t('faculty.confirm').replace('%s', `${faculty} ${command}`))) return
    setBusy(key)
    try {
      const record = await runFacultyCommand(faculty, command, true)
      const tail = [record.stderr, record.stdout].filter(Boolean).join('\n').trim()
      setResult({
        key,
        text: (record.exitCode === 0 ? `${t('faculty.done')} (exit 0)` : `${t('faculty.failed')} (exit ${String(record.exitCode)})`) + (tail ? `\n${tail}` : ''),
        failed: record.exitCode !== 0,
      })
    } catch (error) {
      setResult({ key, text: String(error?.message ?? error), failed: true })
    } finally {
      setBusy(null)
    }
  }

  /* 在一个 butler 预设会话里幂等登记蒸馏任务（Host /automations）。 */
  const registerAutomations = async () => {
    const key = 'automations'
    if (!window.confirm(t('automations.confirm'))) return
    setBusy(key)
    try {
      const out = await registerButlerAutomations()
      setResult({ key, text: t('automations.done').replace('%c', String(out.created)).replace('%k', String(out.kept)).replace('%r', String(out.removed)).replace('%s', out.sessionId), failed: false })
      loadSchedule()
    } catch (error) {
      setResult({ key, text: String(error?.message ?? error), failed: true })
    } finally {
      setBusy(null)
    }
  }

  const recheckNow = async () => {
    setRecheckBusy(true)
    try { await recheck() } finally { setRecheckBusy(false) }
  }

  /* 蒸馏的三块状态。名字是结论，描述是解释，脚注是出处。 */
  const registered = schedule?.registered === true
  const nextName = schedule === null ? '…' : !schedule.available ? t('brief.next.unreadable') : registered && schedule.nextRunAt ? t('brief.next.name').replace('%s', when(schedule.nextRunAt)) : t('brief.next.unregistered')
  const lastText = distill.lastRunAt ? t('brief.next.last').replace('%s', when(distill.lastRunAt)) : t('brief.next.never')
  const nextDesc = schedule?.available === false ? t('brief.next.unreadableDesc') : registered ? lastText : `${t('brief.next.unregisteredDesc')} ${lastText}`
  const openRecords = () => openMemory?.('section:journal')

  return (
    <div className="bq-brief">
      {/* Embedded under the card page's own head and tabs, a second head would only repeat them. */}
      {embedded ? null : <div className="bp-head">
        <img className="bq-mark" src={icon} alt="" width="38" height="38" />
        <div>
          {lead ?? <h1 className="bp-head__title">{t('page.title')}</h1>}
          <p className="bp-head__sub">{t('page.subtitle')}</p>
        </div>
      </div>}

      {status === 'offline' ? <p className="bp-note" data-tone="bad">{t('page.offline')}</p> : null}
      {status === 'loading' ? <p className="bp-note">{t('page.loading')}</p> : null}

      {/* ── 展示区：蒸馏的过程与结果 ─────────────────────────────────── */}
      <div className="bq-zone bq-zone--show">
        <section className="bp-sec bm-sec" aria-label={t('brief.distill')}>
          <div className="bp-catalog-section-heading">
            <h3 className="bp-sec__title">{t('brief.distill')}</h3>
            <span className="bp-sec__rule" />
          </div>
          <div className="bp-grid">
            <Tile
              id="distill-next"
              mark="蒸"
              tone={schedule?.available === false || (schedule !== null && !registered) ? 'warn' : 'ok'}
              name={nextName}
              desc={nextDesc}
              chip={t('brief.distill')}
              slot={registered ? t('brief.registered') : ''}
              actions={schedule !== null && schedule.available !== false && !registered ? (
                <button type="button" className="bp-btn bp-btn--act" disabled={busy === 'automations'} onClick={registerAutomations}>{t('automations.register')}</button>
              ) : null}
            />
            <Tile
              id="distill-waiting"
              mark="待"
              name={t('brief.waiting.name').replace('%d', String(distill.waiting))}
              desc={distill.waiting === 0 ? t('brief.waiting.none') : `${t('brief.waiting.desc')}${distill.reference > 0 ? ` ${t('brief.waiting.ref').replace('%d', String(distill.reference))}` : ''}`}
              chip={t('memory.nav.journal')}
              slot={t('brief.waiting.of').replace('%a', String(distill.read)).replace('%b', String(distill.total))}
              onOpen={openRecords}
              actions={<button type="button" className="bp-btn bp-btn--act" onClick={openRecords}>{t('brief.waiting.view')}</button>}
            />
            <Tile
              id="distill-result"
              mark="果"
              tone={suggested.count > 0 ? 'warn' : 'none'}
              name={t('brief.result.name').replace('%d', String(suggested.count))}
              desc={t('brief.result.desc').replace('%p', String(suggested.promoted)).replace('%d', String(suggested.dismissed))}
              chip={t('brief.result.chip')}
              slot={suggested.count > 0 ? t('brief.result.open') : ''}
              onOpen={suggested.count > 0 ? openRecords : null}
              actions={suggested.count > 0 ? <button type="button" className="bp-btn bp-btn--act" onClick={openRecords}>{t('brief.result.view')}</button> : null}
            />
          </div>
        </section>

        {/* The 建议升级 tile already reports a zero; an empty decision list would only say it again. */}
        {decide.length === 0 && suggested.count === 0 ? null : <section className="bp-sec bm-sec" aria-label={t('brief.decide')}>
          <div className="bp-catalog-section-heading">
            <h3 className="bp-sec__title">{t('brief.decide')}</h3>
            <span className="bp-sec__count">{suggested.count}</span>
            <span className="bp-sec__rule" />
          </div>
          {decide.length === 0 ? <p className="bp-empty">{t('brief.decideEmpty')}</p> : (
            <div className="bp-grid">
              {decide.map(item => (
                <Tile
                  key={item.key}
                  id={item.key}
                  mark="荐"
                  tone="warn"
                  name={t('suggest.line').replace('%s', t(`memory.nav.${item.to}`)).replace('：%r', '').replace(':%r', '')}
                  desc={`${item.reason} · ${item.text ?? ''}`}
                  chip={t(`memory.nav.${item.to}`)}
                  slot={t('memory.candidate')}
                  onOpen={() => openMemory?.(item.key)}
                  actions={<button type="button" className="bp-btn bp-btn--act" onClick={() => openMemory?.(item.key)}>{t('memory.view')}</button>}
                />
              ))}
            </div>
          )}
          {suggested.count > decide.length ? <p className="bm-hint">{t('brief.decideMore').replace('%d', String(suggested.count - decide.length))}</p> : null}
        </section>}
      </div>

      {/* ── 维护：巡检与核心能力，默认收起 ───────────────────────────── */}
      <details className="bq-maint">
        <summary>
          <span className="bp-dot" data-tone={verdict.tone ?? undefined} />
          {t('brief.maint')}
          <em>{t(verdict.key)}{rejected.length > 0 ? ` · ${t('verdict.rejected').replace('%d', String(rejected.length))}` : ''}</em>
        </summary>
        <div className="bq-maint__bar">
          <button type="button" className="bp-btn" onClick={() => setView({ kind: 'doctor' })}>{t('view.doctor')}</button>
          <button type="button" className="bp-btn" onClick={() => setView({ kind: 'endpoints' })}>{t('view.endpoints')} {endpoints.filter(item => item.status === 'ok').length}/{endpoints.length}</button>
          <button type="button" className="bp-btn" onClick={recheckNow} disabled={recheckBusy}>{recheckBusy ? t('page.rechecking') : t('page.recheck')}</button>
          <span className="bq-top__stamp">{t('page.checked')} <b>{checkedAt ? new Date(checkedAt).toLocaleTimeString() : '—'}</b></span>
        </div>

        {endpoints.some(item => item.status !== 'ok') ? <div className="bq-maint__bar">
          <span>端点需要检查；修复会修改已配置的 Agent 接入文件。</span>
          <button type="button" className="bp-btn" disabled={busy !== null} onClick={() => runCommand('journal', 'install', 'external')}>修复接入点</button>
        </div> : null}
        {result ? <pre className="bq-out" role="status">{result.text}</pre> : null}
      </details>

      {view ? (
        <Detail
          t={t}
          view={view}
          doctor={doctor}
          endpoints={endpoints}
          onClose={() => setView(null)}
          onBackdrop={event => { if (event.target === event.currentTarget) setView(null) }}
        />
      ) : null}
    </div>
  )
}

/**
 * One detail viewer: the evidence behind the maintenance verdict. An overlay rather than a fold, because it is
 * only ever reached from one specific button. Both views read the snapshot the page already holds.
 * @param props - `t`, the view state, the snapshot parts it reuses, close/backdrop.
 * @returns the viewer element.
 */
function Detail({ t, view, doctor, endpoints, onClose, onBackdrop }) {
  const heading = {
    doctor: `${t('view.doctor')} · ${doctor.passed} / ${doctor.warnings} / ${doctor.failures}`,
    endpoints: `${t('view.endpoints')} · ${endpoints.filter(item => item.status === 'ok').length}/${endpoints.length}`,
  }[view.kind] ?? ''
  return (
    <div className="bq-view" onClick={onBackdrop}>
      <div className="bq-view__sheet" role="dialog" aria-modal="true" aria-label={heading}>
        <div className="bq-view__head">
          <span>{heading}</span>
          <button type="button" className="bp-btn bp-btn--ghost" onClick={onClose}>{t('view.close')}</button>
        </div>
        <div className="bq-view__body">
          {view.kind === 'doctor' ? (
            <ul className="bq-view__list">
              {doctor.lines.map(line => (
                <li key={line}>
                  <span className="bp-dot" data-tone={lineTone(line)} />
                  <span className="bq-view__line">{line.replace(/^\[\w+\]\s*/, '')}</span>
                  <em className="bq-view__tag">{/^\[(\w+)\]/.exec(line)?.[1] ?? ''}</em>
                </li>
              ))}
            </ul>
          ) : null}
          {view.kind === 'endpoints' ? (
            <ul className="bq-view__list">
              {endpoints.map(item => (
                <li key={item.id}>
                  <span className="bp-dot" data-tone={item.status === 'ok' ? 'ok' : item.status === 'legacy' ? 'warn' : 'bad'} />
                  <span className="bq-view__line">{item.id}</span>
                  <em className="bq-view__tag">{item.kind} · v{item.version}{item.installed ? '' : ` · ${t('endpoint.missing')}`}</em>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  )
}

import { CardPipelinePage } from './CardPipelinePage.tsx'

/** Keep the legacy briefing available only inside the secondary maintenance area. */
export function ButlerPage(props) {
  const [legacyView, setLegacyView] = useState(null)
  const openLegacyRecords = async (key) => {
    setLegacyView({ loading: true, key, records: [], error: '' })
    try {
      const data = await fetchButlerSection('memory')
      const records = Object.values(data.records ?? {}).flatMap((group: any) => group.records ?? [])
      setLegacyView(current => current?.key === key ? { loading: false, key, records: key === 'section:journal' ? (data.records?.observation?.records ?? []) : records.filter((record: any) => record.key === key), error: '' } : current)
    } catch (error) {
      setLegacyView(current => current?.key === key ? { ...current, loading: false, error: String(error?.message ?? error) } : current)
    }
  }
  return <><CardPipelinePage
    icon={props.icon}
    headless={props.headless === true}
    maintenance={<BriefingPage {...props} openMemory={openLegacyRecords} embedded />}
  />{legacyView ? <div className="bq-view" onClick={event => { if (event.target === event.currentTarget) setLegacyView(null) }}>
    <div className="bq-view__sheet bq-brief" role="dialog" aria-modal="true" aria-label="旧采集记录">
      <div className="bq-view__head"><strong>旧采集记录 · 只读</strong><button type="button" className="bp-btn" onClick={() => setLegacyView(null)}>关闭</button></div>
      <div className="bq-view__body">
        <p>这里是旧 journal 的观察记录，不是新版会话蒸馏队列；“待蒸馏”数量与此处历史记录总数不同。</p>
        {legacyView.loading ? <p role="status">正在加载记录…</p> : legacyView.error ? <p role="alert">加载失败：{legacyView.error}</p> : legacyView.records.length ? <ul className="bq-view__list">{legacyView.records.map(record => <RecordRow key={record.key} t={props.t} record={record} openSession={props.openSession} />)}</ul> : <p>没有找到对应的旧采集记录。</p>}
      </div>
    </div>
  </div> : null}</>
}
