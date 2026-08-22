import { describe, expect, it } from 'vitest'
import {
  midiToNoteName, suggestedProtectionThreshold,
  keyToMidi, computeRecommendedShift, PITCH_SHIFT_MIN, PITCH_SHIFT_MAX,
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
