import { describe, expect, it } from 'vitest'
import { capTrialDuration } from './trial-duration'

const DAY = 86400

describe('capTrialDuration()', () => {
  it('truncates a still-active trial that spans more than durationDays', () => {
    // Old 7-day trial, 1 day in — still active, but over the new 3-day cap.
    const now    = 1_000_000
    const window = { trialStart: now - 1 * DAY, trialEnd: now - 1 * DAY + 7 * DAY }

    const { window: capped, changed } = capTrialDuration(window, 3, now)

    expect(changed).toBe(true)
    expect(capped).toEqual({ trialStart: window.trialStart, trialEnd: window.trialStart + 3 * DAY })
    expect(now).toBeLessThan(capped.trialEnd) // still active under the new cap
  })

  it('truncating can immediately expire a trial that already passed the new cap', () => {
    // Old 7-day trial, 5 days in — already past where a 3-day trial would end.
    const now    = 1_000_000
    const window = { trialStart: now - 5 * DAY, trialEnd: now - 5 * DAY + 7 * DAY }

    const { window: capped, changed } = capTrialDuration(window, 3, now)

    expect(changed).toBe(true)
    expect(capped.trialEnd).toBe(window.trialStart + 3 * DAY)
    expect(now).toBeGreaterThanOrEqual(capped.trialEnd)
  })

  it('leaves an already-expired trial untouched', () => {
    const now    = 1_000_000
    const window = { trialStart: now - 10 * DAY, trialEnd: now - 3 * DAY } // lapsed before `now`

    const { window: result, changed } = capTrialDuration(window, 3, now)

    expect(changed).toBe(false)
    expect(result).toBe(window) // same reference — no copy made when nothing changes
  })

  it('is a no-op for a record already within the cap', () => {
    const now    = 1_000_000
    const window = { trialStart: now - 1 * DAY, trialEnd: now - 1 * DAY + 3 * DAY }

    const { window: result, changed } = capTrialDuration(window, 3, now)

    expect(changed).toBe(false)
    expect(result).toBe(window)
  })

  it('is a no-op for a record shorter than durationDays (never extends)', () => {
    const now    = 1_000_000
    const window = { trialStart: now - 1 * DAY, trialEnd: now - 1 * DAY + 1 * DAY } // a 1-day trial

    const { window: result, changed } = capTrialDuration(window, 3, now)

    expect(changed).toBe(false)
    expect(result).toBe(window)
  })

  it('is idempotent — re-applying to an already-capped window changes nothing', () => {
    const now    = 1_000_000
    const window = { trialStart: now - 1 * DAY, trialEnd: now - 1 * DAY + 7 * DAY }

    const first  = capTrialDuration(window, 3, now)
    const second = capTrialDuration(first.window, 3, now)

    expect(second.changed).toBe(false)
    expect(second.window).toEqual(first.window)
  })
})
