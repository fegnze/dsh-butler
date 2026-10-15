// Agent-scoped half of myspace-butler-panel: mounted as a row inside the
// `butler` agent preset so the Butler tools exist only for that preset.
import { applyAgent } from './agent-host.js'

export const name = 'myspace-butler-agent'
export const inject = ['tools', 'subprocess']

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'butler',
    validate(value) {
      if (value == null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Butler agent config must be an object' }] }
      if (value.workdir !== undefined && (typeof value.workdir !== 'string' || !value.workdir.trim())) {
        return { issues: [{ message: 'Butler workdir must be a non-empty string', path: ['workdir'] }] }
      }
      return { value: { workdir: value.workdir } }
    },
  },
}

export async function apply(ctx, config = {}) {
  await applyAgent(ctx, config)
}
