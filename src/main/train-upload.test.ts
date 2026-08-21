import { describe, expect, it } from 'vitest'
import { computeMockStatus } from './train-upload'

describe('computeMockStatus() — Ticket 20 offline fallback', () => {
  it('reports uploading with an increasing percent during the upload window', () => {
    const startedAt = 1_000
    const early = computeMockStatus('t1', startedAt, startedAt + 200)
    const late  = computeMockStatus('t1', startedAt, startedAt + 1_800)
    expect(early.status).toBe('uploading')
    expect(late.status).toBe('uploading')
    expect(late.percent).toBeGreaterThan(early.percent)
  })

  it('moves to training once the upload window elapses', () => {
    const startedAt = 0
    const res = computeMockStatus('t1', startedAt, 2_500)
    expect(res.status).toBe('training')
    expect(res.percent).toBeGreaterThanOrEqual(0)
    expect(res.percent).toBeLessThan(100)
  })

  it('completes with a model_url once both windows elapse', () => {
    const startedAt = 0
    const res = computeMockStatus('t1', startedAt, 20_000)
    expect(res.status).toBe('completed')
    expect(res.percent).toBe(100)
    expect(res.model_url).toContain('t1')
  })

  it('is deterministic — same (taskId, startedAt, now) always agrees, so repeated', () => {
    const a = computeMockStatus('t1', 0, 5_000)
    const b = computeMockStatus('t1', 0, 5_000)
    expect(a).toEqual(b)
  })
})
