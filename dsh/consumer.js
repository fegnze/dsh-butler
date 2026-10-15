// Consumer-facing agent extension. Mounting is intentionally agent-wide via
// the bundle patch; it has no restricted guard and uses the Host-published workdir.
import { applyConsumer } from './consumer-host.js'

export const name = 'myspace-butler-consumer'
export const inject = ['tools', 'subprocess']

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'butler',
    validate(value) {
      if (value == null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Consumer agent config must be an object' }] }
      if (value.allowedScopes !== undefined && (!Array.isArray(value.allowedScopes) || value.allowedScopes.some((scope) => typeof scope !== 'string' || !scope.trim()))) {
        return { issues: [{ message: 'allowedScopes must be an array of non-empty strings', path: ['allowedScopes'] }] }
      }
      return { value: { ...(value.allowedScopes ? { allowedScopes: value.allowedScopes } : {}) } }
    },
  },
}

export async function apply(ctx, config = {}) {
  await applyConsumer(ctx, config)
}
