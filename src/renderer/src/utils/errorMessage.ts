/**
 * Ticket T2: make engine failures readable in the UI.
 *
 * Anything that crosses the IPC bridge comes back to the renderer wrapped by
 * Electron — `String(err)` on a rejected `ipcRenderer.invoke` yields
 *
 *   Error: Error invoking remote method 'engine:stream': Error: <the real message>
 *
 * Rendering that verbatim buried the one part the user needs (why the run
 * failed: no disk space, dataset unreadable, Python missing) behind two layers
 * of plumbing. describeError() unwraps it down to the message the engine
 * actually reported, and falls back to a caller-supplied sentence when there is
 * nothing readable left.
 */

const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']*':\s*/
const ERROR_PREFIX = /^(?:Uncaught\s+)?(?:[A-Z][A-Za-z]*)?Error:\s*/

export function describeError(err: unknown, fallback: string): string {
  let text = err instanceof Error ? err.message : String(err ?? '')

  // Strip the plumbing, innermost-last: the remote-method wrapper first, then
  // any number of stacked "Error: " prefixes it left behind.
  text = text.replace(ERROR_PREFIX, '').replace(REMOTE_METHOD_PREFIX, '')
  let previous = ''
  while (text !== previous) {
    previous = text
    text = text.replace(ERROR_PREFIX, '').replace(REMOTE_METHOD_PREFIX, '')
  }

  text = text.trim()
  return text.length > 0 ? text : fallback
}
