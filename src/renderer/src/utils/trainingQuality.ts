/**
 * Tickets T2/T3: turn the engine's quality numbers into something a singer
 * can act on.
 *
 * The engine has reported `data_quality` since Ticket 48, but the UI only ever
 * appended its `warnings[]` to a stack of banners under a raw JSON dump — so
 * the one thing a user needed after a disappointing model ("34 seconds of
 * audio is not enough, record more or denoise it") was indistinguishable from
 * the rest of the page. Everything here is a pure function of the report so
 * the presentation layer stays a translation of it, and so the thresholds are
 * testable without running a training job.
 */

/** Mirrors engine/trainer.py's DataQualityReport. */
export interface DataQualityReport {
  n_files:          number
  duration_sec:     number
  min_required_sec: number
  duration_ok:      boolean
  snr_db:           number | null
  snr_ok:           boolean
  /** Added alongside this ticket; older cached results won't carry it. */
  min_snr_db?:      number
  warnings:         string[]
  passed:           boolean
}

/**
 * Fallback for the SNR bar when a result predates the engine reporting it.
 * Keep in sync with MIN_SNR_DB in engine/trainer.py.
 */
export const DEFAULT_MIN_SNR_DB = 15

/**
 * Recommended material per mode, in seconds. Mirrors MIN_DURATION_SEC in
 * engine/trainer.py — the engine's own `min_required_sec` is preferred
 * wherever a report is available; this is for the pre-flight check (Ticket
 * T3), which runs before the engine has seen anything.
 */
export const RECOMMENDED_DURATION_SEC: Record<string, number> = {
  standard:     300,
  professional: 900,
}

/**
 * Below this much material a run is worth questioning before it starts.
 *
 * Deliberately far under the recommended minimum: a 4-minute upload is
 * merely short, and stopping to ask about it every time would train the user
 * to click through the dialog without reading it. Half a minute of audio, on
 * the other hand, cannot produce a usable voice on any setting — that is the
 * case this warning exists for.
 */
export const SHORT_DATA_WARN_SEC = 120

export type QualityLevel = 'good' | 'fair' | 'poor'

/** An identified problem with the finished model, in the order to show them. */
export type QualityIssueId = 'noData' | 'duration' | 'snr' | 'similarity'

export interface QualityIssue {
  id: QualityIssueId
  /** Numbers for the message — minutes, dB, whatever the issue is about. */
  values: Record<string, string | number>
}

export interface QualityAssessment {
  /** 0-1, or null when the engine didn't report one (older cached results). */
  score:  number | null
  level:  QualityLevel
  issues: QualityIssue[]
}

/** Shape of the finished-run fields this module reads. */
export interface QualityInput {
  quality_score?:   number
  quality_warning?: string | null
  data_quality?:    DataQualityReport
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * Grade a finished run.
 *
 * The score alone is not the verdict: a model can score well against its own
 * training material and still be useless because that material was 34 seconds
 * of a noisy phone recording. So a failed data check pins the level to `poor`
 * regardless of the score — the level is a statement about the model the user
 * is about to keep, not about the fit.
 */
export function assessQuality(result: QualityInput): QualityAssessment {
  const score = typeof result.quality_score === 'number' ? result.quality_score : null
  const dq    = result.data_quality
  const issues: QualityIssue[] = []

  // No readable audio at all means the engine trained on its synthetic
  // fallback — the model is a demo, and nothing about it resembles the
  // singer. That deserves to be said outright rather than left to be
  // inferred from a good-looking score against sine waves.
  if (dq && dq.n_files === 0) {
    issues.push({ id: 'noData', values: {} })
  } else if (dq) {
    if (!dq.duration_ok) {
      issues.push({
        id: 'duration',
        values: {
          minutes:    round1(dq.duration_sec / 60),
          seconds:    Math.round(dq.duration_sec),
          recommended: Math.round(dq.min_required_sec / 60),
        },
      })
    }
    if (!dq.snr_ok && dq.snr_db != null) {
      issues.push({
        id: 'snr',
        values: {
          snr:      round1(dq.snr_db),
          required: dq.min_snr_db ?? DEFAULT_MIN_SNR_DB,
        },
      })
    }
  }

  // A low fidelity score with no data problem to explain it is its own
  // finding: the run itself under-fitted, and more epochs (or a different
  // mode) is the lever, not more audio.
  const dataProblem = issues.some((i) => i.id !== 'similarity')
  if (score != null && score < 0.4 && !dataProblem) {
    issues.push({ id: 'similarity', values: { percent: Math.round(score * 100) } })
  }

  let level: QualityLevel
  if (issues.length > 0)          level = 'poor'
  else if (score != null && score < 0.7) level = 'fair'
  else                            level = 'good'

  return { score, level, issues }
}

/** Stars out of five for a 0-1 score; null scores show none. */
export function scoreStars(score: number | null): number {
  if (score == null) return 0
  return Math.max(1, Math.min(5, Math.round(score * 5)))
}

// ── Pre-flight check (Ticket T3) ───────────────────────────────────────────

export interface ShortDataWarning {
  /** Total material the dropzone could measure, in seconds. */
  seconds:     number
  /** Recommended minimum for the chosen mode, in minutes. */
  recommended: number
}

/**
 * Decide whether starting a run on this much audio deserves a confirmation.
 *
 * Returns null when there is nothing to warn about — including the
 * no-files-at-all case, which is already explained on the form (the run will
 * use demo data) and is not what this dialog is for.
 */
export function checkShortData(
  fileCount: number, totalSeconds: number, mode: string,
): ShortDataWarning | null {
  if (fileCount === 0) return null
  // Durations are decoded asynchronously; a total of zero across real files
  // means none of them have been measured yet, and guessing "0 seconds" would
  // put a false warning in front of a perfectly good dataset.
  if (totalSeconds <= 0) return null
  if (totalSeconds >= SHORT_DATA_WARN_SEC) return null

  const recommendedSec = RECOMMENDED_DURATION_SEC[mode] ?? RECOMMENDED_DURATION_SEC.standard
  return { seconds: Math.round(totalSeconds), recommended: Math.round(recommendedSec / 60) }
}
