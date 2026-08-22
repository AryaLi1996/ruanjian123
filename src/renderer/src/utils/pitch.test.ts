import { describe, expect, it } from 'vitest'
import {
  midiToNoteName, suggestedProtectionThreshold,
  keyToMidi, computeRecommendedShift, PITCH_SHIFT_MIN, PITCH_SHIFT_MAX,
  computeRecommendedShiftRange, SHIFT_RANGE_CUSHION_SEMITONES,
  PROTECTION_THRESHOLD_MIDI, computePitchAxis, midiToYFraction,
} from './pitch'

describe('midiToNoteName', () => {
  it('maps MIDI 60 to C4 (middle C)', () => {
    expect(midiToNoteName(60)).toBe('C4')
  })

  it('maps MIDI 77 to F5', () => {
    expect(midiToNoteName(77)).toBe('F5')
  })

  it('maps MIDI 66 to F#4', () => {
    expect(midiToNoteName(66)).toBe('F#4')
  })

  it('rounds fractional MIDI values before naming', () => {
    expect(midiToNoteName(76.6)).toBe('F5')
  })

  it('handles octave 0 and below correctly', () => {
    expect(midiToNoteName(12)).toBe('C0')
    expect(midiToNoteName(0)).toBe('C-1')
  })
})

describe('suggestedProtectionThreshold', () => {
  it('suggests D#4 for a max of F5 (matches ticket example)', () => {
    const thresholdMidi = suggestedProtectionThreshold(77) // F5
    expect(midiToNoteName(thresholdMidi)).toBe('D#4')
  })

  it('is always 14 semitones below the max', () => {
    expect(suggestedProtectionThreshold(70)).toBe(56)
  })
})

describe('keyToMidi', () => {
  it('maps a bare major key to its tonic MIDI note (C4 = 60)', () => {
    expect(keyToMidi('C')).toBe(60)
  })

  it('maps a minor key to the same pitch class as its major counterpart', () => {
    expect(keyToMidi('Am')).toBe(keyToMidi('A'))
  })

  it('handles sharps and flats', () => {
    expect(keyToMidi('F#m')).toBe(66)
    expect(keyToMidi('Eb')).toBe(63)
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(keyToMidi(' f#m ')).toBe(66)
  })

  it('returns null for a missing or unrecognised key', () => {
    expect(keyToMidi(null)).toBeNull()
    expect(keyToMidi(undefined)).toBeNull()
    expect(keyToMidi('')).toBeNull()
    expect(keyToMidi('H')).toBeNull()
    expect(keyToMidi('Cmaj7')).toBeNull()
  })

  it('honors a custom reference octave', () => {
    expect(keyToMidi('C', 5)).toBe(72)
  })
})

describe('computeRecommendedShift', () => {
  it('computes song_original_key - user_vocal_range', () => {
    // "C" tonic in the default reference octave is MIDI 60; a vocal range
    // topping out at 55 should recommend shifting the song down by -5.
    expect(computeRecommendedShift('C', 55)).toBe(5)
  })

  it('caps the recommendation at PITCH_SHIFT_MAX/MIN', () => {
    expect(computeRecommendedShift('C', 20)).toBe(PITCH_SHIFT_MAX)
    expect(computeRecommendedShift('C', 100)).toBe(PITCH_SHIFT_MIN)
  })

  it('returns null when the key is unrecognised', () => {
    expect(computeRecommendedShift(null, 60)).toBeNull()
    expect(computeRecommendedShift('???', 60)).toBeNull()
  })

  it('returns null when the vocal range is not yet known', () => {
    expect(computeRecommendedShift('C', null)).toBeNull()
    expect(computeRecommendedShift('C', undefined)).toBeNull()
  })
})

describe('computeRecommendedShiftRange', () => {
  it('extends the recommendation by the cushion, in the same direction (ticket example: -4 to -6)', () => {
    // "Ab" tonic (MIDI 68) against a protected vocal max of MIDI 72 (C5)
    // recommends -4; the range should extend to -6, i.e. "适合降4到6个调，建议降4个".
    expect(computeRecommendedShift('Ab', 72)).toBe(-4)
    expect(computeRecommendedShiftRange('Ab', 72)).toEqual({ recommended: -4, cushioned: -6 })
  })

  it('extends upward when the recommendation is positive', () => {
    expect(computeRecommendedShift('C', 55)).toBe(5)
    expect(computeRecommendedShiftRange('C', 55)).toEqual({ recommended: 5, cushioned: 5 + SHIFT_RANGE_CUSHION_SEMITONES })
  })

  it('caps the cushioned end at PITCH_SHIFT_MIN/MAX', () => {
    expect(computeRecommendedShiftRange('C', 20)).toEqual({ recommended: PITCH_SHIFT_MAX, cushioned: PITCH_SHIFT_MAX })
    expect(computeRecommendedShiftRange('C', 100)).toEqual({ recommended: PITCH_SHIFT_MIN, cushioned: PITCH_SHIFT_MIN })
  })

  it('returns null when no shift is recommended (already in range)', () => {
    expect(computeRecommendedShiftRange('C', 60)).toBeNull()
  })

  it('returns null when the underlying recommendation is null', () => {
    expect(computeRecommendedShiftRange(null, 60)).toBeNull()
    expect(computeRecommendedShiftRange('C', null)).toBeNull()
  })
})

describe('PROTECTION_THRESHOLD_MIDI', () => {
  it('is D#4, the fixed 强制修音 threshold the engine is called with', () => {
    expect(PROTECTION_THRESHOLD_MIDI).toBe(63)
    expect(midiToNoteName(PROTECTION_THRESHOLD_MIDI)).toBe('D#4')
  })
})

describe('computePitchAxis', () => {
  it('returns null when no frame is voiced', () => {
    expect(computePitchAxis([])).toBeNull()
    expect(computePitchAxis([0, 0, 0])).toBeNull()
  })

  it('spans the voiced range with padding on both ends', () => {
    // 55..79 is a 24-semitone span, already past the 12-semitone floor, so
    // only the ±3 padding applies.
    expect(computePitchAxis([55, 67, 79], 63)).toEqual({ lo: 52, hi: 82 })
  })

  it('ignores unvoiced (0) frames rather than treating them as a low note', () => {
    expect(computePitchAxis([0, 55, 0, 79, 0], 63)).toEqual({ lo: 52, hi: 82 })
  })

  it('always keeps the threshold on the axis, even when every note is far below it', () => {
    const axis = computePitchAxis([40, 42], 63)!
    expect(axis.lo).toBeLessThanOrEqual(40)
    expect(axis.hi).toBeGreaterThanOrEqual(63)
  })

  it('keeps the threshold on the axis when every note is far above it', () => {
    const axis = computePitchAxis([90, 92], 63)!
    expect(axis.lo).toBeLessThanOrEqual(63)
    expect(axis.hi).toBeGreaterThanOrEqual(92)
  })

  it('widens a near-monotone contour to the minimum span, centred on it', () => {
    // A single note at the threshold: padding alone gives a 6-semitone span,
    // so it grows symmetrically to the 12-semitone floor.
    const axis = computePitchAxis([63], 63)!
    expect(axis.hi - axis.lo).toBe(12)
    expect((axis.lo + axis.hi) / 2).toBe(63)
  })

  it('does not shrink a contour that already exceeds the minimum span', () => {
    const axis = computePitchAxis([50, 80], 63)!
    expect(axis.hi - axis.lo).toBeGreaterThan(12)
  })

  it('handles a contour far longer than the argument limit a spread would hit', () => {
    // 50..70 — already wider than the minimum span, so this asserts the
    // min/max scan alone rather than the widening on top of it.
    const contour = Array.from({ length: 200_000 }, (_, i) => 50 + (i % 21))
    const axis = computePitchAxis(contour, 63)!
    expect(axis.lo).toBe(47)   // min voiced 50, minus 3 padding
    expect(axis.hi).toBe(73)   // max voiced 70, plus 3 padding
  })
})

describe('midiToYFraction', () => {
  const axis = { lo: 50, hi: 80 }

  it('puts the top of the axis at 0 and the bottom at 1 (higher notes sit higher)', () => {
    expect(midiToYFraction(80, axis)).toBe(0)
    expect(midiToYFraction(50, axis)).toBe(1)
  })

  it('places the midpoint halfway down', () => {
    expect(midiToYFraction(65, axis)).toBeCloseTo(0.5)
  })

  it('clamps notes outside the axis to the nearest edge instead of drawing off-plot', () => {
    expect(midiToYFraction(120, axis)).toBe(0)
    expect(midiToYFraction(10, axis)).toBe(1)
  })

  it('falls back to centre for a degenerate (zero-width) axis', () => {
    expect(midiToYFraction(63, { lo: 63, hi: 63 })).toBe(0.5)
  })
})
