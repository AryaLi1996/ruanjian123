import { describe, expect, it } from 'vitest'
import {
  assessQuality, scoreStars,
  type DataQualityReport,
} from './trainingQuality'

function report(overrides: Partial<DataQualityReport> = {}): DataQualityReport {
  return {
    n_files:          3,
    duration_sec:     900,
    min_required_sec: 900,
    duration_ok:      true,
    snr_db:           24,
    snr_ok:           true,
    min_snr_db:       15,
    warnings:         [],
    passed:           true,
    ...overrides,
  }
}

describe('assessQuality', () => {
  it('reports a clean run with no issues', () => {
    const a = assessQuality({ quality_score: 0.86, data_quality: report() })
    expect(a.issues).toEqual([])
    expect(a.level).toBe('good')
    expect(a.score).toBe(0.86)
  })

  it('grades a scoring-but-unremarkable run as fair', () => {
    expect(assessQuality({ quality_score: 0.55, data_quality: report() }).level).toBe('fair')
  })

  it('names the duration shortfall with the numbers to act on', () => {
    const a = assessQuality({
      quality_score: 0.9,
      data_quality: report({ duration_sec: 34, duration_ok: false, passed: false }),
    })
    expect(a.level).toBe('poor')
    expect(a.issues).toEqual([
      { id: 'duration', values: { minutes: 0.6, seconds: 34, recommended: 15 } },
    ])
  })

  it('names a low SNR against the engine-reported bar', () => {
    const a = assessQuality({
      quality_score: 0.8,
      data_quality: report({ snr_db: 8.42, snr_ok: false, min_snr_db: 15, passed: false }),
    })
    expect(a.issues).toEqual([{ id: 'snr', values: { snr: 8.4, required: 15 } }])
  })

  it('falls back to the documented SNR bar for older results', () => {
    const dq = report({ snr_db: 9, snr_ok: false, passed: false })
    delete dq.min_snr_db
    expect(assessQuality({ data_quality: dq }).issues[0].values.required).toBe(15)
  })

  it('reports both data problems together', () => {
    const a = assessQuality({
      data_quality: report({
        duration_sec: 60, duration_ok: false, snr_db: 6, snr_ok: false, passed: false,
      }),
    })
    expect(a.issues.map((i) => i.id)).toEqual(['duration', 'snr'])
  })

  it('calls out a run that fell back to demo data', () => {
    const a = assessQuality({
      quality_score: 0.95,
      data_quality: report({ n_files: 0, duration_sec: 0, duration_ok: false }),
    })
    expect(a.issues.map((i) => i.id)).toEqual(['noData'])
    expect(a.level).toBe('poor')
  })

  it('blames the fit only when the data itself was fine', () => {
    expect(assessQuality({ quality_score: 0.2, data_quality: report() }).issues)
      .toEqual([{ id: 'similarity', values: { percent: 20 } }])
    // With a data problem to explain it, the low score is not a separate finding.
    expect(assessQuality({
      quality_score: 0.2,
      data_quality: report({ duration_ok: false, duration_sec: 30, passed: false }),
    }).issues.map((i) => i.id)).toEqual(['duration'])
  })

  it('survives a result with no quality fields at all', () => {
    const a = assessQuality({})
    expect(a).toEqual({ score: null, level: 'good', issues: [] })
  })
})

describe('scoreStars', () => {
  it('maps a score onto one to five stars', () => {
    expect(scoreStars(1)).toBe(5)
    expect(scoreStars(0.62)).toBe(3)
    expect(scoreStars(0.01)).toBe(1)   // never zero stars for a real score
    expect(scoreStars(null)).toBe(0)
  })
})
