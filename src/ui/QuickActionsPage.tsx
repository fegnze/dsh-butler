import { useCallback, useEffect, useMemo, useState } from 'react'
import { deleteQuickAction, fetchQuickActions, runQuickAction, saveQuickAction, updateQuickAction } from './butler-source.ts'
import { hueOf } from './ConsoleBody.tsx'
import { SearchIcon } from './icons.tsx'

/**
 * The quick launchpad, drawn with the console's own vocabulary (bp-head,
 * bp-search, bp-btn, bp-sec, bp-grid, bp-tile, bp-editor) so the two halves of
 * the workbench read as one product. Nothing here carries inline colours or
 * geometry; the sheet in panel-styles.ts owns all of it.
 */

const TYPE_META = {
  url: { label: '网页', icon: '◉' },
  directory: { label: '目录', icon: '▣' },
  file: { label: '文件', icon: '▤' },
  app: { label: '应用', icon: '⌘' },
}

const FILTERS = [['all', '全部'], ['favorite', '收藏'], ['url', '网页'], ['directory', '目录'], ['file', '文件'], ['app', '应用']]

function targetKind(type) {
  if (type === 'directory') return 'path'
  return type
}

export function useQuickActions() {
  const [actions, setActions] = useState([])
  const [pending, setPending] = useState(null)
  const [failed, setFailed] = useState(null)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    const list = await fetchQuickActions()
    setActions(list)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const run = useCallback(async (id) => {
    setPending(id); setFailed(null)
    const ok = await runQuickAction(id)
    if (!ok) setFailed(id)
    setPending(null)
  }, [])

  const manage = useCallback(async (operation) => {
    setError(null)
    try { await operation(); await refresh(); return true }
    catch (value) { setError(value instanceof Error ? value.message : '管理快捷卡片失败'); return false }
  }, [refresh])
  const create = useCallback((entry) => manage(() => saveQuickAction(entry)), [manage])
  const toggleFavorite = useCallback((action) => manage(() => updateQuickAction(action.id, { favorite: !action.favorite })), [manage])
  const remove = useCallback((action) => manage(() => deleteQuickAction(action.id)), [manage])

  return { actions, pending, failed, error, run, create, toggleFavorite, remove }
}

/**
 * One launchpad entry as a console card: identity row on top (click opens it),
 * kind and category in the footer, favourite and delete as footer controls.
 * There is no state rail — an entry has no running/stopped to report.
 */
function Card({ action, pending, failed, onRun, onFavorite, onDelete }) {
  const meta = TYPE_META[action.kind] ?? TYPE_META.url
  const open = () => { if (pending !== action.id) void onRun(action.id) }
  return (
    <article className="bp-tile" data-card-id={action.id} data-tone="none" data-pending={pending === action.id ? 'true' : undefined}>
      <span className="bp-tile__rail" aria-hidden="true" />
      <div className="bp-tile__head">
        <span className="bp-tile__mark bp-tile__mark--glyph" data-hue={hueOf(action.id)} aria-hidden="true">{meta.icon}</span>
        <div
          className="bp-tile__open"
          data-clickable="true"
          role="button"
          tabIndex={0}
          title="点击打开"
          onClick={open}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } }}
        >
          <h4 className="bp-tile__name">{action.label}</h4>
          <p className="bp-tile__desc" data-bad={failed === action.id ? 'true' : undefined}>
            {failed === action.id ? '打开失败，请重试' : action.description || action.summary || action.id}
          </p>
        </div>
      </div>
      <div className="bp-tile__foot">
        <div className="bp-tile__meta">
          <span className="bp-chip bp-chip--soft">{meta.label}</span>
          <span className="bp-tile__slot">{action.category || '未分类'}</span>
        </div>
        <div className="bp-tile__acts">
          <button type="button" className="bp-btn bp-btn--act" aria-pressed={action.favorite ? 'true' : 'false'} onClick={() => { void onFavorite(action) }}>
            {action.favorite ? '★ 已收藏' : '☆ 收藏'}
          </button>
          <button
            type="button"
            className="bp-btn bp-btn--act bp-btn--danger"
            aria-label="删除快捷卡片"
            onClick={() => { if (globalThis.confirm?.(`删除“${action.label}”？`) !== false) void onDelete(action) }}
          >
            删除
          </button>
        </div>
      </div>
    </article>
  )
}

function AddDialog({ open, onClose, onCreate, error }) {
  const [type, setType] = useState('url')
  const [label, setLabel] = useState('')
  const [target, setTarget] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('工作')
  const [favorite, setFavorite] = useState(true)
  const [saving, setSaving] = useState(false)
  if (!open) return null
  const submit = async (event) => {
    event.preventDefault(); setSaving(true)
    const id = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || `shortcut-${Date.now()}`
    const entry = { id, label: label.trim(), description: description.trim(), category, favorite, target: { kind: targetKind(type), ...(type === 'url' ? { url: target.trim() } : type === 'app' ? { app: target.trim() } : { path: target.trim() }) } }
    const ok = await onCreate(entry)
    setSaving(false)
    if (ok) { setLabel(''); setTarget(''); setDescription(''); onClose() }
  }
  return (
    <div className="bp-editor-backdrop" role="presentation" onClick={onClose}>
      <form className="bp-editor" role="dialog" aria-modal="true" onSubmit={(event) => { void submit(event) }} onClick={(event) => event.stopPropagation()}>
        <div className="bp-editor__head">
          <h2>添加快捷卡片</h2>
          <button type="button" className="bp-btn bp-btn--ghost" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className="bp-editor__kinds" role="group" aria-label="选择类型">
          {Object.entries(TYPE_META).map(([key, value]) => (
            <button key={key} type="button" className="bp-btn" aria-pressed={type === key ? 'true' : 'false'} onClick={() => setType(key)}>
              {value.icon} {value.label}
            </button>
          ))}
        </div>
        <label>名称<input required autoFocus value={label} placeholder="例如：MySpace Wiki" onChange={(event) => setLabel(event.target.value)} /></label>
        <label>地址 / 路径<input required value={target} placeholder={type === 'url' ? 'https://…' : type === 'app' ? 'Terminal' : '/Users/…'} onChange={(event) => setTarget(event.target.value)} /></label>
        <label>备注（可选）<input value={description} placeholder="一句话说明它是什么" onChange={(event) => setDescription(event.target.value)} /></label>
        <label>分类
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option>工作</option><option>开发</option><option>知识</option><option>素材</option>
          </select>
        </label>
        <label className="bp-editor__check"><input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} />加入收藏</label>
        {error ? <p className="bp-note" data-tone="bad" role="alert">{error}</p> : null}
        <div className="bp-editor__acts">
          <button type="button" className="bp-btn" onClick={onClose}>取消</button>
          <button type="submit" className="bp-btn bp-btn--primary" disabled={saving}>{saving ? '保存中…' : '保存卡片'}</button>
        </div>
      </form>
    </div>
  )
}

/**
 * Render the launchpad.
 * @param props - `t`, and `lead`: the workbench's tab switch, which this page
 *   puts at the start of its title bar in place of a title of its own.
 * @returns the page element.
 */
export function QuickActionsPage({ t, lead = null }) {
  const { actions, pending, failed, error, run, create, toggleFavorite, remove } = useQuickActions()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [dialog, setDialog] = useState(false)
  const filtered = useMemo(() => actions.filter((action) => {
    const text = `${action.label} ${action.description || ''} ${action.summary || ''}`.toLowerCase()
    return (!query || text.includes(query.toLowerCase())) && (filter === 'all' || (filter === 'favorite' ? action.favorite : action.kind === filter))
  }), [actions, filter, query])
  const title = filter === 'all' ? '全部快捷卡片' : FILTERS.find(([key]) => key === filter)?.[1]
  return (
    <div className="bp-console" data-wide="true">
      <div className="bp-head">
        {lead ?? <h1 className="bp-head__title">{t('actions.title')}</h1>}
        <span className="bp-head__sub">{t('actions.subtitle')}</span>
        <span className="bp-head__spacer" />
        <label className="bp-search">
          <SearchIcon className="bp-search__icon" />
          <input type="search" aria-label="搜索快捷卡片" value={query} placeholder="搜索卡片" onChange={(event) => setQuery(event.target.value)} />
          {query ? <button type="button" className="bp-search__clear" aria-label="清除搜索" onClick={() => setQuery('')}>×</button> : null}
        </label>
        <button type="button" className="bp-btn" onClick={() => setDialog(true)}>添加快捷卡片</button>
      </div>

      <section className="bp-sec">
        <div className="bp-catalog-section-heading">
          <h3 className="bp-sec__title">{title}</h3>
          <span className="bp-sec__count">{filtered.length}</span>
          <span className="bp-sec__rule" />
          <div className="bp-switch bp-switch--small" role="group" aria-label="筛选类型">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" className="bp-switch__tab" aria-pressed={filter === key ? 'true' : 'false'} onClick={() => setFilter(key)}>{label}</button>
            ))}
          </div>
        </div>
        {filtered.length === 0
          ? (
              <p className="bp-empty">
                {actions.length ? '没有匹配的快捷卡片' : t('actions.empty')}
                {actions.length ? null : <>{' '}<button type="button" className="bp-link" onClick={() => setDialog(true)}>添加第一张卡片</button></>}
              </p>
            )
          : (
              <div className="bp-grid">
                {filtered.map((action) => <Card key={action.id} action={action} pending={pending} failed={failed} onRun={run} onFavorite={toggleFavorite} onDelete={remove} />)}
              </div>
            )}
      </section>

      <AddDialog open={dialog} onClose={() => setDialog(false)} onCreate={create} error={error} />
    </div>
  )
}
