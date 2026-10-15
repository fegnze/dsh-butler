import { readFile } from 'node:fs/promises'
import { mountButler } from './host.js'

export const name = 'myspace-butler-panel'
// schedule / sessionController are NOT injected: cordis treats every inject
// entry as required, which would block Butler without the schedule bundle.
// The Host reads them lazily per request (see src/host/entry.ts shiftHost).
export const inject = ['webServer', 'subprocess']

/** DSH plugin configuration: Butler is an installable instance, not a MySpace singleton. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'butler',
    validate(value) {
      if (value == null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Butler config must be an object' }] }
      if (value.workdir !== undefined && (typeof value.workdir !== 'string' || !value.workdir.trim())) {
        return { issues: [{ message: 'Butler workdir must be a non-empty string', path: ['workdir'] }] }
      }
      return { value: { workdir: value.workdir } }
    },
  },
}

const ASSET_PATH = '/myspace-butler/assets/cat-butler-icon.png'
const ASSET = new URL('../assets/cat-butler-icon.png', import.meta.url)

function fail(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: message }))
}
function methodNotAllowed(res, allowed) {
  res.writeHead(405, { 'content-type': 'application/json', allow: allowed.join(', ') })
  res.end(JSON.stringify({ error: `method not allowed; expected ${allowed.join(' or ')}` }))
}

export async function apply(ctx, config = {}) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: ASSET_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
      try { const body = await readFile(ASSET); res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' }); res.end(body) }
      catch (error) { fail(res, 404, String(error?.message ?? error)) }
    },
  }), 'butler-panel: asset')
  await mountButler(ctx, config)
}
