/**
 * Parse an observation's `ref` into something the briefing page can act on.
 *
 * Only `dsh://` refs are actionable (open that DSH session through
 * `uiWorkspace.openSession`); everything else is shown as text, because the
 * page must not invent navigation the App does not provide.
 */
export type RecordRef =
  | { kind: 'dsh'; sessionId: string; turn?: number }
  | { kind: 'git'; repo: string; sha: string }
  | { kind: 'proposal'; id: string }
  | { kind: 'other'; text: string }

export function parseRecordRef(ref: unknown): RecordRef | undefined {
  if (typeof ref !== 'string' || !ref) return undefined
  let m = /^dsh:\/\/([A-Za-z0-9._-]+)(?:#(\d+))?$/.exec(ref)
  if (m) return { kind: 'dsh', sessionId: m[1], ...(m[2] ? { turn: Number(m[2]) } : {}) }
  m = /^git:\/\/(.+)@([0-9a-f]{7,64})$/.exec(ref)
  if (m) return { kind: 'git', repo: m[1], sha: m[2] }
  m = /^proposal:\/\/(p-[0-9a-z]+)$/.exec(ref)
  if (m) return { kind: 'proposal', id: m[1] }
  return { kind: 'other', text: ref }
}
