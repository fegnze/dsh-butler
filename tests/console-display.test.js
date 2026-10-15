import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOperationsSource } from '../src/ui/operations-source.ts'
import { emptyLayout, sectionDisplay, withSectionDisplay, withSectionOrder, visibleItems, mergeStoredChoices, readLayout } from '../src/ui/console-layout.ts'
import { createLayoutHandler } from '../src/host/layout.ts'

const originalFetch = globalThis.fetch
const items = [{ id: 'a', name: 'Alpha', state: 'running', autoStart: true }, { id: 'b', name: 'Beta', description: '检索说明', state: 'stopped', autoStart: false }]
const ids = list => list.map(item => item.id)
afterEach(() => { globalThis.fetch = originalFetch })

test('legacy layouts and new entries remain visible regardless of lifecycle or autostart', () => {
  const old = readLayout({ version: 1, order: { services: ['b', 'a'] } })
  expect(ids(visibleItems(items, sectionDisplay(old, 'services'), ''))).toEqual(['a', 'b'])
  const display = { mode: 'resident', stored: ['a'] }
  expect(ids(visibleItems([...items, { id: 'new', state: 'stopped' }], display, ''))).toEqual(['b', 'new'])
  expect(ids(visibleItems(items.map(item => ({ ...item, state: 'running', autoStart: true })), display, ''))).toEqual(['b'])
})

test('search includes stored name, id and description, then returns to the unchanged display mode', () => {
  const display = { mode: 'resident', stored: ['a', 'b'] }
  for (const [query, expected] of [['ALPHA', ['a']], [' b ', ['b']], ['检索', ['b']], ['missing', []]]) {
    expect(ids(visibleItems(items, display, query))).toEqual(expected)
  }
  expect(visibleItems(items, display, '')).toEqual([])
  expect(ids(visibleItems(items, { ...display, mode: 'all' }, ''))).toEqual(['a', 'b'])
  expect(display).toEqual({ mode: 'resident', stored: ['a', 'b'] })
})

test('section preferences stay independent, order edits preserve them, and absent ids survive a drawer save', () => {
  const layout = withSectionDisplay(emptyLayout(), 'services', { stored: ['a'], mode: 'all' })
  const tools = withSectionDisplay(layout, 'tools', { stored: ['x'] })
  expect(sectionDisplay(tools, 'services')).toEqual({ stored: ['a'], mode: 'all' })
  expect(sectionDisplay(tools, 'tools')).toEqual({ stored: ['x'], mode: 'resident' })
  expect(withSectionOrder(tools, 'services', ['b', 'a']).display).toEqual(tools.display)
  expect(mergeStoredChoices(['gone', 'a'], items, ['b'])).toEqual(['gone', 'a'])
})

function mockHost(layout = emptyLayout()) {
  const state = { layout, reject: false, holdRead: null, writes: [] }
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/layout')) {
      if (options?.method === 'PUT') {
        const next = JSON.parse(options.body); state.writes.push(next)
        if (state.reject) return Response.json({ error: 'disk full' }, { status: 500 })
        state.layout = next; return Response.json(next)
      }
      const read = structuredClone(state.layout)
      if (state.holdRead) await state.holdRead
      return Response.json(read)
    }
    if (String(url).endsWith('/operations')) return Response.json({ services: items, tools: [] })
    if (String(url).endsWith('/overview')) return Response.json({ tools: [] })
    throw new Error(`Unexpected request ${url}`)
  }
  return state
}

test('display saves round-trip, order reset preserves display, and refused saves restore the prior view', async () => {
  const host = mockHost({ version: 1, order: { services: ['b', 'a'] } })
  const source = createOperationsSource(); await source.refresh()
  expect(await source.setDisplay('services', { stored: ['a'] })).toEqual({ ok: true })
  const saved = structuredClone(source.getSnapshot().layout)
  const reloaded = createOperationsSource(); await reloaded.refresh()
  expect(reloaded.getSnapshot().layout).toEqual(saved)
  await source.reset()
  expect(source.getSnapshot().layout).toEqual({ ...saved, order: {} })
  host.reject = true
  expect(await source.setDisplay('services', { mode: 'all' })).toEqual({ ok: false, reason: 'disk full' })
  expect(source.getSnapshot().layout.display.services).toEqual(saved.display.services)
  expect(source.getSnapshot().layoutSaving).toBe(false)
  expect(source.getSnapshot().layoutError).toBe('disk full')
})

test('a slow poll started before a successful save cannot restore stale preferences', async () => {
  const host = mockHost(); const source = createOperationsSource(); await source.refresh()
  let release
  host.holdRead = new Promise(resolve => { release = resolve })
  const oldPoll = source.refresh()
  await source.setDisplay('services', { stored: ['a'], mode: 'resident' })
  release(); await oldPoll
  expect(source.getSnapshot().layout.display.services.stored).toEqual(['a'])
})

test('Host persists display preferences and rejects malformed or unknown choices without overwriting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-display-'))
  const handler = createLayoutHandler(dir)
  const call = async (method, value) => {
    const response = { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
    await handler({ method, async *[Symbol.asyncIterator]() { if (value) yield Buffer.from(JSON.stringify(value)) } }, response)
    return response
  }
  try {
    const layout = withSectionDisplay(emptyLayout(), 'services', { stored: ['a'], mode: 'all' })
    expect((await call('PUT', layout)).status).toBe(200)
    for (const display of [{ services: { mode: 'auto', stored: [] } }, { ghost: { mode: 'all', stored: [] } }, { services: { mode: 'resident', stored: ['a', 'a'] } }, { services: { mode: 'resident', stored: ['a'], autoStart: false } }]) {
      expect((await call('PUT', { ...layout, display })).status).toBe(400)
      expect(JSON.parse((await call('GET')).body)).toEqual(layout)
    }
    expect((await call('PUT', { version: 1, order: {} })).status).toBe(200)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
