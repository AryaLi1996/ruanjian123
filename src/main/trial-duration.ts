/**
 * Ticket 42: pure trial-duration-cap math, split out of subscription-monitor.ts
 * so it has zero Electron/fs dependencies and can be unit tested directly
 * (see trial-duration.test.ts) — subscription-monitor.ts imports `electron`
 * at module scope, which makes it awkward to exercise in a plain Node/Vitest
 * environment.
 */
export interface TrialWindow {
  trialStart: number // Unix seconds
  trialEnd:   number // Unix seconds
}

/**
 * Caps `trialEnd` at `trialStart + durationDays`, for a trial record that
 * predates a config/server change which shortened the trial (e.g. Ticket 42:
 * 7 days -> 3 days). Never extends a trial — only ever pulls `trialEnd`
 * earlier — and leaves a record alone once it's already lapsed under its own
 * *stored* `trialEnd`, since it reads as expired either way and there's
 * nothing to correct. Idempotent: a window already within the cap is
 * returned unchanged with `changed: false`, so a caller only needs to
 * persist the result when `changed` is true.
 */
export function capTrialDuration(
  window: TrialWindow,
  durationDays: number,
  nowSec: number,
): { window: TrialWindow; changed: boolean } {
  const cappedEnd = window.trialStart + durationDays * 86400
  if (window.trialEnd <= cappedEnd || nowSec >= window.trialEnd) {
    return { window, changed: false }
  }
  return { window: { trialStart: window.trialStart, trialEnd: cappedEnd }, changed: true }
}
