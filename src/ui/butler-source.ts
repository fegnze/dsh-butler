/**
 * Butler data source: a plain observable over the plugin's own Host routes.
 *
 * This file deliberately knows nothing about React or Cordis. It exposes the
 * `getSnapshot` / `subscribe` pair that the slot registration's `inject` face
 * hands to the renderer, which turns it into a `useButler(selector)` prop.
 * Components never touch fetch, ctx, or this module's internals.
 *
 * These are same-origin paths served by the Host half (`dsh/index.js`), which
 * serves them from the DSH App. Calling a second service port from here
 * would be cross-origin and the browser discards the answer — the Dashboard
 * sends no `Access-Control-Allow-Origin`. That failure is invisible to curl
 * and to every local check; it only shows up as `offline` in a real page.
 */

/** Same-origin prefix mounted by this plugin's Host half. */
import { base } from './base.ts'

/** Poll cadence while at least one subscriber is attached. */
const POLL_MS = 15000

/** The snapshot shape every consumer reads. */
const EMPTY = {
  status: 'loading',
  error: null,
  checkedAt: null,
  doctor: { passed: 0, warnings: 0, failures: 0, lines: [] },
  journal: { records: 0, recent: { observation: 0, git: 0, session: 0 }, latest: null },
  spool: { records: 0, sources: 0 },
  suggested: { count: 0, promoted: 0, dismissed: 0 },
  distill: { read: 0, total: 0, waiting: 0, reference: 0, lastRunAt: null },
  endpoints: [],
  digest: null,
  attention: [],
  /** 核心能力（faculties）与其被守护拒绝的清单。 */
  faculties: [],
  rejected: [],
}

/**
 * Turn one raw `/myspace-butler/butler` payload into the panel's snapshot.
 * @param raw - decoded JSON body.
 * @param faculties - `/myspace-butler/catalog` faculties.
 * @param rejected - `/catalog` manifests the Host refused.
 * @returns normalized snapshot.
 */
function normalize(raw, faculties, rejected) {
  const doctorOutput = raw?.doctor?.output ?? ''
  const lines = doctorOutput.split('\n').filter(Boolean)

  /* 待处理：doctor 的 FAIL/WARN 在前，后面的来源若已在讲同一件事就跳过。
     每条带一个来源 tag，主人不用猜一句话是巡检说的还是积压说的。 */
  const todo = []
  const seen = new Set()
  const push = (item, key) => { if (!seen.has(key)) { seen.add(key); todo.push(item) } }

  for (const line of lines) {
    if (line.startsWith('[FAIL]')) push({ level: 'fail', tag: 'doctor', text: line.slice(6).trim() }, `d:${line}`)
  }
  for (const line of lines) {
    if (line.startsWith('[WARN]')) push({ level: 'warn', tag: 'doctor', text: line.slice(6).trim() }, `d:${line}`)
  }

  const spool = raw?.spool ?? { records: 0, sources: 0 }
  if (spool.records > 0 && !todo.some(item => /spool/.test(item.text))) {
    push({ level: 'warn', tag: 'spool', text: `spool 积压 ${spool.records} 条待合并` }, 'spool')
  }

  const endpoints = Array.isArray(raw?.endpoints) ? raw.endpoints : []
  for (const item of endpoints) {
    if (item.status === 'ok') continue
    if (todo.some(entry => entry.text.includes(`端点 ${item.id}`))) continue
    push({ level: item.status === 'legacy' ? 'warn' : 'fail', tag: 'endpoints', text: `端点 ${item.id} 未就绪（${item.status}）` }, `ep:${item.id}`)
  }

  /* 待你决定：只有蒸馏标出的「建议升级」才是真正等主人拍板的事。
     doctor 的 WARN 是运维信号，混进这一组只会让标题和数据对不上。 */
  const decide = []
  const suggested = Array.isArray(raw?.candidates?.items) ? raw.candidates.items : []
  for (const item of suggested) {
    decide.push({ level: 'info', tag: 'suggest', text: item.text || item.key, to: item.to, reason: item.reason, key: item.key })
  }

  return {
    status: raw?.status ?? 'unknown',
    health: raw?.health ?? 'unknown',
    queue: { spool: raw?.queue?.spool ?? 0 },
    suggested: {
      count: raw?.candidates?.count ?? suggested.length,
      promoted: raw?.candidates?.promoted ?? 0,
      dismissed: raw?.candidates?.dismissed ?? 0,
    },
    distill: {
      read: raw?.distill?.read ?? 0,
      total: raw?.distill?.total ?? 0,
      waiting: raw?.distill?.waiting ?? 0,
      reference: raw?.distill?.reference ?? 0,
      lastRunAt: raw?.distill?.lastRunAt ?? null,
    },
    error: null,
    checkedAt: raw?.checkedAt ?? null,
    doctor: {
      passed: raw?.doctor?.passed ?? 0,
      warnings: raw?.doctor?.warnings ?? 0,
      failures: raw?.doctor?.failures ?? 0,
      lines,
    },
    journal: {
      records: raw?.journal?.records ?? 0,
      recent: { observation: raw?.journal?.recent?.observation ?? 0, git: raw?.journal?.recent?.git ?? 0, session: raw?.journal?.recent?.session ?? 0 },
      latest: raw?.journal?.latest ?? null,
    },
    spool: { records: spool.records ?? 0, sources: spool.sources ?? 0 },
    endpoints,
    digest: raw?.latestDigest ?? null,
    /** 待你决定在前，待处理在后 —— 这正是页面分组的顺序。 */
    attention: [...decide, ...todo],
    faculties: Array.isArray(faculties) ? faculties : [],
    rejected: Array.isArray(rejected) ? rejected : [],
  }
}

/**
 * Create the shared Butler observable.
 *
 * The first subscriber starts polling; the last one to leave stops it. The
 * snapshot identity only changes when a fetch settles, so `useSyncExternalStore`
 * inside the renderer will not spin.
 * @returns the source face consumed by the slot registration.
 */
export function createButlerSource() {
  let snapshot = EMPTY
  let timer = null
  const listeners = new Set()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const pull = async (force) => {
    try {
      // 两条并行：快照、核心能力目录。分两拍会让服务来自这一
      // tick、能力来自下一 tick，行与行互相矛盾。
      const [status, catalog] = await Promise.all([
        fetch(`${base()}/butler${force ? '?refresh=1' : ''}`, { headers: { accept: 'application/json' } }),
        fetch(`${base()}/catalog`, { headers: { accept: 'application/json' } }),
      ])
      if (!status.ok) throw new Error(`HTTP ${status.status}`)
      const body = await status.json()
      // 附属两条各自降级：目录读不到不该把整份简报拖成 offline。
      const catalogBody = catalog.ok ? await catalog.json().catch(() => null) : null
      snapshot = normalize(
        body,
        catalogBody?.faculties ?? [],
        catalogBody?.rejected ?? [],
      )
    } catch (error) {
      snapshot = { ...EMPTY, status: 'offline', error: String(error?.message ?? error) }
    }
    emit()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      if (timer === null) {
        void pull()
        timer = setInterval(() => { void pull() }, POLL_MS)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }
    },
    refresh: () => pull(),
    /** 强制重跑 doctor 再取快照（`?refresh=1`），这是「重新巡检」按钮的语义。 */
    recheck: () => pull(true),
  }
}

/**
 * Run one faculty command.
 *
 * The Host re-checks the manifest and refuses anything with an effect
 * unless `confirmed` is true, so a caller that skips the confirm round trip
 * gets a 409 rather than a side effect.
 * @param {string} id - faculty id.
 * @param {string} itemId - command id as declared in `butler.json`.
 * @param {boolean} confirmed - whether the owner signed off on the effect.
 * @param {object} [args] - values for the command's manifest-declared `args`.
 * @returns {Promise<object>} the Host's run record.
 */
/** Display names for proposal kinds; a card kind is followed by its card id. */

/**
 * Register (or refresh) the Butler DSH automation tasks.
 * @returns `{ sessionId, created, kept, removed }` from the Host.
 */
export async function registerButlerAutomations() {
  const response = await fetch(`${base()}/automations`, { method: 'POST', headers: { accept: 'application/json' } })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
  return body
}

/**
 * Where the distill automation stands in DSH's schedule (read-only).
 * @returns `{ available, registered, nextRunAt?, lastRunAt? }`; unreachable counts as unavailable.
 */
export async function fetchAutomationStatus() {
  try {
    const response = await fetch(`${base()}/automations`, { headers: { accept: 'application/json' } })
    return response.ok ? await response.json() : { available: false, registered: false }
  } catch { return { available: false, registered: false } }
}

export async function runFacultyCommand(id, itemId, confirmed, args) {
  const response = await fetch(`${base()}/faculties/${encodeURIComponent(id)}/commands/${encodeURIComponent(itemId)}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: confirmed === true, ...(args ? { args } : {}) }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
  return body
}

/**
 * Read one detail section the Host already serves.
 *
 * The briefing's viewers answer "这 9 / 28 / 0 是什么" — the Host has these
 * `?section=journal|spool|endpoints|doctor` from the Host status route;
 * Sections are fetched on open rather
 * than folded into the 15 s poll, because the journal is unbounded and the
 * panel must not carry it between ticks it never displays.
 * @param {'journal' | 'spool' | 'endpoints' | 'doctor'} section - the section.
 * @param {string} [id] - `?id=` for the `endpoint` section.
 * @returns the section payload.
 */
export async function fetchButlerSection(section, id) {
  const query = new URLSearchParams({ section })
  if (id) query.set('id', id)
  const response = await fetch(`${base()}/butler?${query.toString()}`, {
    headers: { accept: 'application/json' },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
  return body
}

/**
 * Run one faculty report (declared read-only) and return its record.
 * @param {string} id - faculty id.
 * @param {string} itemId - report id as declared in `butler.json`.
 * @returns {Promise<object>} `{ stdout, exitCode, shape, … }`.
 */
export async function fetchFacultyReport(id, itemId) {
  const response = await fetch(`${base()}/faculties/${encodeURIComponent(id)}/reports/${encodeURIComponent(itemId)}`, {
    headers: { accept: 'application/json' },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
  return body
}

/**
 * Read the quick-action tree the Dashboard exposes.
 * @returns the enabled actions in display order, or an empty list.
 */
export async function fetchQuickActions() {
  try {
    const response = await fetch(`${base()}/quick-actions`, { headers: { accept: 'application/json' } })
    if (!response.ok) return []
    const body = await response.json()
    return (body?.actions ?? []).filter(action => action.enabled)
  } catch {
    return []
  }
}

async function mutateQuickAction(path, method, body) {
  const response = await fetch(`${base()}/quick-actions${path}`, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? '管理快捷卡片失败')
  return response.json()
}

export function saveQuickAction(entry) {
  return mutateQuickAction('', 'POST', { entry })
}

export function updateQuickAction(id, entry) {
  return mutateQuickAction(`/${encodeURIComponent(id)}`, 'PATCH', { entry })
}

export function deleteQuickAction(id) {
  return mutateQuickAction(`/${encodeURIComponent(id)}`, 'DELETE')
}

/**
 * Trigger one registered capability by id.
 * @param id - quick-action identity.
 * @returns whether the Dashboard accepted the run.
 */
export async function runQuickAction(id) {
  try {
    const response = await fetch(`${base()}/quick-actions/${encodeURIComponent(id)}`, { method: 'POST' })
    return response.ok
  } catch {
    return false
  }
}
