/**
 * Ticket 65b — appId tagging for the shared License API.
 *
 * The License backend (Ticket 65a) serves several products from one Function
 * URL, so every request has to name the app it is about. Rather than sprinkle
 * `appId` through a dozen call sites in subscription-monitor.ts, that module's
 * single `_request()` chokepoint runs the path and body through the helpers
 * here — which keeps the rule ("POST carries it in the body, GET carries it in
 * the query string") in one place and, since this file deliberately imports
 * nothing from `electron`, makes it unit-testable (see vitest.config.ts's note
 * on why most of src/main/ isn't).
 */

/** Server error codes/messages that mean "this token/order belongs to another app". */
const APP_ID_MISMATCH_CODES = ['app_id_mismatch', 'appid_mismatch', 'wrong_app']

/**
 * Adds `appId` to a POST body. Callers that send no body at all still get one:
 * a bodyless POST would otherwise be the single request that reaches the
 * server untagged, and the server has no other place to read the app from.
 * An explicit `appId` already present in the body is left alone so a caller
 * can override it deliberately.
 */
export function withAppId(
  body: Record<string, unknown> | undefined, appId: string,
): Record<string, unknown> {
  return { appId, ...(body ?? {}) }
}

/**
 * Appends `appId=…` to a GET path's query string. Handles the three shapes the
 * call sites actually use: a bare route ('plans'), a route that already has
 * params ('order-status?orderId=…'), and the empty path (the verify route,
 * which is a POST today but costs nothing to support). Idempotent — a path
 * that already carries an appId param is returned unchanged, so this stays
 * safe if a call site ever builds its own.
 */
export function appendAppIdParam(path: string, appId: string): string {
  if (/[?&]appId=/.test(path)) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}appId=${encodeURIComponent(appId)}`
}

/**
 * True when the server rejected a request because the license/order belongs to
 * a different application. Matches on the machine-readable `code` first and
 * falls back to a substring check on the human-readable message, since the
 * error shape is the server's to change and a missed match here would silently
 * degrade to the generic "verification failed" path.
 */
export function isAppIdMismatch(resp: { code?: unknown; error?: unknown } | null | undefined): boolean {
  if (!resp) return false
  const code = typeof resp.code === 'string' ? resp.code.toLowerCase() : ''
  if (APP_ID_MISMATCH_CODES.includes(code)) return true
  const error = typeof resp.error === 'string' ? resp.error.toLowerCase() : ''
  if (!error) return false
  if (APP_ID_MISMATCH_CODES.some((c) => error.includes(c))) return true
  return error.includes('appid') && (error.includes('mismatch') || error.includes('does not match'))
}

/**
 * Backward compatibility (Ticket 65b §3): tokens minted before the server knew
 * about appId carry none, and the server backfills those on the next request —
 * so a missing appId is accepted, and only a token explicitly stamped for a
 * *different* app is rejected. Comparison is case-insensitive/trimmed because
 * the id travels as free-form text through two clients and a server.
 */
export function tokenAppIdMatches(tokenAppId: string | undefined | null, appId: string): boolean {
  if (tokenAppId == null || tokenAppId === '') return true
  return tokenAppId.trim().toLowerCase() === appId.trim().toLowerCase()
}

/**
 * The rule `_request()` applies to every License API call, in one testable
 * place: a POST carries `appId` in its JSON body, a GET carries it in the
 * query string. Returns the path/body to actually send.
 */
export function tagRequest(
  method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, appId: string,
): { path: string; body: Record<string, unknown> | undefined } {
  return method === 'POST'
    ? { path, body: withAppId(body, appId) }
    : { path: appendAppIdParam(path, appId), body }
}
