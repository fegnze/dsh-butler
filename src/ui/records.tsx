import { useState } from 'react'
import { parseRecordRef } from './record-ref.ts'

/* Shared by the briefing's journal/spool viewer and the memory page's ledger:
   one observation is one row in both, so it is one component. */

/**
 * `MM-DD HH:mm` for a journal record's ISO timestamp.
 * @param {string} iso - the record's `ts`.
 * @returns {string} local time, or a dash when the stamp is unreadable.
 */
export function stampOf(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Everything one observation carries: text, time, tags, workspace, tools,
 * files, commits and its provenance. Shared by the expanding row and by the
 * memory page's card dialog, so both read an observation the same way.
 */
export function RecordDetail({ t, record, openSession }) {
  const ref = parseRecordRef(record.ref)
  // Observation field `toolsUsed` (what a turn ran) — unrelated to the console's extended tool set.
  const { toolsUsed: usedTools = [] } = record
  return (
    <dl className="bq-row__detail bq-jrec__detail">
      <dt>{t('record.text')}</dt><dd><pre>{record.text ?? ''}</pre></dd>
      {record.ts ? <><dt>{t('record.time')}</dt><dd>{new Date(record.ts).toLocaleString()}</dd></> : null}
      {record.tags?.length ? <><dt>{t('record.tags')}</dt><dd>{record.tags.join(' · ')}</dd></> : null}
      {record.workspace ? <><dt>{t('record.workspace')}</dt><dd><code>{record.workspace}</code></dd></> : null}
      {usedTools.length ? <><dt>{t('record.usedTools')}</dt><dd>{usedTools.join(', ')}</dd></> : null}
      {record.filesTouched?.length ? <><dt>{t('record.files')}</dt><dd><ul>{record.filesTouched.map(file => <li key={file}><code>{file}</code></li>)}</ul></dd></> : null}
      {record.gitCommits?.length ? <><dt>{t('record.commits')}</dt><dd><ul>{record.gitCommits.map(commit => <li key={commit.sha}><code>{commit.sha?.slice(0, 7)}</code> {commit.subject}</li>)}</ul></dd></> : null}
      {record.failed ? <><dt>{t('record.failed')}</dt><dd>{t('record.failedYes')}</dd></> : null}
      {ref ? (
        <>
          <dt>{t('record.source')}</dt>
          <dd>
            {ref.kind === 'dsh' && openSession ? (
              <button type="button" className="bp-btn" onClick={() => openSession(ref.sessionId)}>
                {t('record.openSession')}{ref.turn !== undefined ? ` #${ref.turn}` : ''}
              </button>
            ) : null}
            {ref.kind === 'dsh' && !openSession ? <code>{record.ref}</code> : null}
            {ref.kind === 'git' ? <code>{ref.repo} @ {ref.sha.slice(0, 7)}</code> : null}
            {ref.kind === 'proposal' ? <code>{ref.id}</code> : null}
            {ref.kind === 'other' ? <code>{ref.text}</code> : null}
          </dd>
        </>
      ) : null}
    </dl>
  )
}

/**
 * One journal/spool observation: summary row that expands to full text and
 * provenance. A `dsh://` ref opens its session through the App's own
 * navigation; other refs are shown, not invented into links.
 */
export function RecordRow({ t, record, openSession }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="bq-jrec" data-open={open ? 'true' : undefined}>
      <button type="button" className="bq-jrec__main" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="bq-jrec__ts">{stampOf(record.ts)}</span>
        <span className="bp-chip">{record.source}</span>
        <span className="bp-chip bp-chip--soft">{record.type}</span>
        <span className="bq-jrec__text">{record.text}</span>
      </button>
      {open ? <RecordDetail t={t} record={record} openSession={openSession} /> : null}
    </li>
  )
}
