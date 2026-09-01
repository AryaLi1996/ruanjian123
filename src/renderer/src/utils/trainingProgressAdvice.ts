/**
 * Ticket P5: what the progress panel should say about a run in flight.
 *
 * A CPU run reports progress once per epoch, so the panel can sit still for
 * minutes at a time while everything is fine. The ETA (estimateRemainingSec)
 * answers "how long", but two questions it doesn't answer are the ones that
 * actually decide whether the user should keep waiting:
 *
 *  - is this pace worth accepting, or should the run be restarted in a
 *    cheaper mode? (a 40-minute professional CPU run is usually a mistake
 *    discovered too late);
 *  - is the machine about to run out of memory? Nothing in the UI showed
 *    this, so an OOM kill arrived as a dead process with no warning — the
 *    engine now reports its own RSS with each epoch (engine/trainer.py).
 *
 * Pure so both thresholds are testable without a training run.
 */

/** ETA beyond which the run is worth commenting on / offering a way out of. */
export const SLOW_ETA_SEC     = 10 * 60
export const VERY_SLOW_ETA_SEC = 20 * 60

/**
 * Fraction of total RAM at or above which memory counts as critical, whether
 * measured as what the engine holds or as what is left for everyone else.
 */
export const MEMORY_CRITICAL_USED_RATIO  = 0.8
export const MEMORY_CRITICAL_FREE_RATIO  = 0.2

export type PaceLevel = 'ok' | 'slow' | 'verySlow'

/**
 * How a run's remaining time reads to someone waiting on it.
 *
 * `null` (no ETA yet — the first epoch hasn't landed) is 'ok': withholding
 * judgement is right until the run has shown its pace, and warning about a
 * number that doesn't exist yet is how the ETA itself used to read "14 hours"
 * two seconds in.
 */
export function assessPace(etaSec: number | null): PaceLevel {
  if (etaSec == null || !Number.isFinite(etaSec)) return 'ok'
  if (etaSec >= VERY_SLOW_ETA_SEC) return 'verySlow'
  if (etaSec >= SLOW_ETA_SEC)      return 'slow'
  return 'ok'
}

/** Memory figures the engine reports alongside each epoch. All optional. */
export interface MemorySample {
  /** Resident set size of the engine process, in GB. */
  rss_gb?:       number | null
  /** System memory still available, in GB. */
  available_gb?: number | null
  /** Total physical RAM, in GB. */
  total_gb?:     number | null
}

export interface MemoryStatus {
  /** True when the run is close enough to the limit to be worth saying so. */
  critical: boolean
  rssGb:    number | null
  totalGb:  number | null
  availableGb: number | null
  /** Engine RSS as a share of total RAM, 0-1, or null when unknowable. */
  usedRatio: number | null
}

/**
 * Whether memory is tight enough to warn about.
 *
 * Two independent signals, because either one alone can miss the failure:
 * the engine's own RSS says this run is the problem, while free memory says
 * the machine is out regardless of who took it (a browser and a DAW can
 * starve a modest run). A missing figure never raises a warning — the
 * platforms where these can't be read (see engine/env_check.py) would
 * otherwise show a permanent red banner they can never clear.
 */
export function assessMemory(sample: MemorySample | null | undefined): MemoryStatus {
  const rssGb       = numberOrNull(sample?.rss_gb)
  const totalGb     = numberOrNull(sample?.total_gb)
  const availableGb = numberOrNull(sample?.available_gb)

  const usedRatio = rssGb != null && totalGb != null && totalGb > 0 ? rssGb / totalGb : null
  const freeRatio = availableGb != null && totalGb != null && totalGb > 0 ? availableGb / totalGb : null

  const critical =
    (usedRatio != null && usedRatio >= MEMORY_CRITICAL_USED_RATIO) ||
    (freeRatio != null && freeRatio <= MEMORY_CRITICAL_FREE_RATIO)

  return { critical, rssGb, totalGb, availableGb, usedRatio }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
