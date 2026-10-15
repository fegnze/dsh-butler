import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

const scope = process.env.DSH_SCOPE_OVERRIDE ?? join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai')
const loaderPath = join(scope, 'dsh-client-modules/lib/client.js')
const hmrPath = join(scope, 'dsh-client-hmr/lib/client.js')

// Execute the installed DSH ownership sweep and cleanup, not a copy of them.
test.skipIf(!existsSync(loaderPath) || !existsSync(hmrPath))('theme HMR cannot claim or remove Butler effect styles', async () => {
  const nodes: any[] = []
  const document = {
    createElement: () => ({
      id: '', dataset: {} as Record<string, string>, textContent: '',
      setAttribute(key: string, value: string) { this.dataset[key.slice(5)] = value },
      getAttribute(key: string) { return this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null },
      remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1) },
      replaceWith(node: any) { nodes.splice(nodes.indexOf(this), 1, node) },
    }),
    head: { append: (node: any) => nodes.push(node) },
    getElementById: (id: string) => nodes.find(node => node.id === id),
    addEventListener() {}, removeEventListener() {},
    querySelectorAll(selector: string) {
      if (selector === 'style:not([data-plugin])') return nodes.filter(node => !('plugin' in node.dataset))
      if (selector === 'style[data-plugin]') return nodes.filter(node => 'plugin' in node.dataset)
      const owner = JSON.parse(selector.slice('style[data-plugin='.length, -1))
      return nodes.filter(node => node.dataset.plugin === owner)
    },
  }
  const disposers: (() => void)[] = []
  // Bundle each actual installer, intercepting only React's effect scheduler.
  for (const [file, entry] of [
    ['panel-styles.ts', 'installConsoleStyles'],
    ['no-select.ts', 'installNoSelectRule'],
    ['card-pipeline-styles.ts', 'useCardPipelineStyles'],
  ]) {
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, '../src/ui', file!)], target: 'browser', format: 'cjs', external: ['react'] })
    expect(build.success).toBe(true)
    const module = { exports: {} as any }
    runInNewContext(await build.outputs[0]!.text(), {
      document, module, exports: module.exports,
      require: () => ({ useEffect: (setup: () => () => void) => disposers.push(setup()) }),
    })
    const dispose = module.exports[entry!]()
    if (dispose) disposers.push(dispose)
  }
  const butlerStyles = [...nodes]
  expect(butlerStyles).toHaveLength(3)
  const aqua = '@deepseek-ai/dsh-client-ui-aqua'
  const unowned = document.createElement()
  document.head.append(unowned)
  function loadDSH(path: string, extra = {}): any {
    let result: any
    runInNewContext(readFileSync(path, 'utf8'), {
      document, ...extra,
      window: { __ModuleLoader__: { load: (registration: any) => { result = registration.factory() } } },
    })
    return result
  }
  const { ClientModuleSystem } = loadDSH(loaderPath)
  const modules = new ClientModuleSystem({
    manifest: { rev: 'test', modules: [] }, staticModules: {},
    bootstrapModule: { id: '@deepseek-ai/dsh-client-modules', exports: {} },
    registrationTarget: { mode: 'queue', pendingQueue: [] },
  })
  modules.register({ id: aqua, factory: () => ({}) })
  modules.materialize(aqua)
  // Control proves the upstream sweep ran: an anonymous style IS claimed.
  expect(unowned.dataset.plugin).toBe(aqua)
  for (const node of butlerStyles) expect(node.dataset.plugin).toBe('myspace-butler-panel')

  let receive!: (event: { data: string }) => void
  let refreshed!: () => void
  const complete = new Promise<void>(resolve => { refreshed = resolve })
  const hmr = loadDSH(hmrPath, {
    EventSource: class {
      addEventListener(_name: string, callback: typeof receive) { receive = callback }
      close() {}
    },
  })
  hmr.apply({
    modules: { invalidate() {}, async prefetch() {} },
    loader: { entries: () => [{ options: { name: aqua }, refresh: refreshed }] },
    effect: (setup: () => () => void) => disposers.push(setup()),
    logger: { warn: (message: string) => { throw new Error(message) }, error: (error: Error) => { throw error } },
  })
  receive({ data: JSON.stringify({ type: 'rebuilt', id: aqua, rev: 'next' }) })
  await complete
  expect(nodes).toEqual(butlerStyles)
  for (const dispose of disposers.reverse()) dispose()
  expect(nodes).toHaveLength(0)
})
