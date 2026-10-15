/**
 * Where the hosting plugin exposes its DSH App Host routes. The UI never talks
 * to a second service port: everything under this prefix is same-origin and the
 * Host half owns the address.
 *
 * The prefix is the plugin's choice, not the framework's; a plugin sets it once
 * at apply() before any source starts polling. The default matches butler-panel.
 */
let prefix = '/myspace-butler'

/**
 * Set the same-origin proxy prefix.
 * @param next - path prefix without a trailing slash.
 */
export function configureBase(next: string) {
  prefix = next.replace(/\/$/, '')
}

/**
 * Read the current proxy prefix.
 * @returns the prefix, no trailing slash.
 */
export function base() {
  return prefix
}
