import { describe, expect, it } from 'vitest'
import {
  assessMemory, assessPace, SLOW_ETA_SEC, VERY_SLOW_ETA_SEC,
} from './trainingProgressAdvice'

describe('assessPace', () => {
  it('withholds judgement until the run has shown its pace', () => {
    expect(assessPace(null)).toBe('ok')
    expect(assessPace(Number.NaN)).toBe('ok')
    expect(assessPace(Number.POSITIVE_INFINITY)).toBe('ok')
  })

  it('stays quiet for a run that finishes soon', () => {
    expect(assessPace(0)).toBe('ok')
    expect(assessPace(SLOW_ETA_SEC - 1)).toBe('ok')
  })

  it('flags a slow run, and a very slow one separately', () => {
    expect(assessPace(SLOW_ETA_SEC)).toBe('slow')
    expect(assessPace(VERY_SLOW_ETA_SEC - 1)).toBe('slow')
    expect(assessPace(VERY_SLOW_ETA_SEC)).toBe('verySlow')
    expect(assessPace(3 * 3600)).toBe('verySlow')
  })
})

describe('assessMemory', () => {
  it('is quiet for a run with room to spare', () => {
    const status = assessMemory({ rss_gb: 2, available_gb: 9, total_gb: 16 })
    expect(status.critical).toBe(false)
    expect(status.usedRatio).toBeCloseTo(0.125, 5)
  })

  it('warns when the engine itself holds most of the machine', () => {
    expect(assessMemory({ rss_gb: 13, available_gb: 6, total_gb: 16 }).critical).toBe(true)
  })

  it('warns when the machine is out of memory regardless of who took it', () => {
    // A modest run, but a browser and a DAW have eaten the rest.
    expect(assessMemory({ rss_gb: 2, available_gb: 1.5, total_gb: 16 }).critical).toBe(true)
  })

  it('never warns on a figure the platform could not read', () => {
    expect(assessMemory({ rss_gb: null, available_gb: null, total_gb: null }).critical).toBe(false)
    expect(assessMemory({}).critical).toBe(false)
    expect(assessMemory(null).critical).toBe(false)
    expect(assessMemory(undefined).critical).toBe(false)
    // A partial sample judges on what it has, and stays quiet on what it doesn't.
    expect(assessMemory({ rss_gb: 12 }).critical).toBe(false)
    expect(assessMemory({ available_gb: 0.5 }).critical).toBe(false)
  })

  it('ignores nonsense figures rather than reading them as zero', () => {
    const status = assessMemory({ rss_gb: Number.NaN, available_gb: -1, total_gb: 0 })
    expect(status.critical).toBe(false)
    expect(status.rssGb).toBeNull()
    expect(status.availableGb).toBeNull()
    expect(status.usedRatio).toBeNull()
  })

  it('passes the raw figures through for display', () => {
    const status = assessMemory({ rss_gb: 3.5, available_gb: 4, total_gb: 16 })
    expect(status.rssGb).toBe(3.5)
    expect(status.totalGb).toBe(16)
    expect(status.availableGb).toBe(4)
  })
})
