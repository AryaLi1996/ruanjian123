import { describe, it, expect } from 'vitest'
import {
  COVER_STEPS, prerequisiteOf, unmetPrerequisites, isUnlocked, stepStatus,
} from './wizardSteps'

const step = (n: number) => COVER_STEPS.find((s) => s.number === n)!

describe('wizardSteps', () => {
  it('defaults a step\'s prerequisite to the previous step', () => {
    expect(prerequisiteOf(step(2))).toBe(1)
    expect(prerequisiteOf(step(4))).toBe(3)
  })

  it('gates the training step on synthesis, not on export', () => {
    expect(prerequisiteOf(step(5))).toBe(3)
    expect(unmetPrerequisites(step(5), new Set([1, 2, 3]))).toEqual([])
    expect(unmetPrerequisites(step(5), new Set([1, 2, 3, 4]))).toEqual([])
  })

  // The bug FC-03 is about: reaching the training step with nothing separated.
  it('locks the training step until separation and synthesis are done', () => {
    expect(unmetPrerequisites(step(5), new Set())).toEqual([1, 2, 3])
    expect(isUnlocked(step(5), 1, new Set())).toBe(false)
    expect(stepStatus(step(5), 1, new Set())).toBe('locked')
  })

  it('reports only the steps that are actually still missing', () => {
    expect(unmetPrerequisites(step(5), new Set([1]))).toEqual([2, 3])
    expect(unmetPrerequisites(step(3), new Set([1]))).toEqual([2])
  })

  it('locks every later step on a fresh wizard', () => {
    const fresh = new Set<number>()
    expect(COVER_STEPS.filter((s) => isUnlocked(s, 1, fresh)).map((s) => s.number)).toEqual([1])
  })

  it('unlocks the next step as each one completes', () => {
    expect(isUnlocked(step(2), 1, new Set([1]))).toBe(true)
    expect(isUnlocked(step(3), 2, new Set([1]))).toBe(false)
    expect(isUnlocked(step(3), 2, new Set([1, 2]))).toBe(true)
  })

  it('keeps the current and completed steps navigable', () => {
    expect(stepStatus(step(1), 1, new Set())).toBe('active')
    expect(stepStatus(step(1), 2, new Set([1]))).toBe('completed')
    // Revisiting a completed step is allowed even though later ones aren't.
    expect(isUnlocked(step(1), 3, new Set([1, 2]))).toBe(true)
  })

  it('treats an unlocked-but-unvisited step as neither active nor completed', () => {
    expect(stepStatus(step(2), 1, new Set([1]))).toBe('unlocked')
  })
})
