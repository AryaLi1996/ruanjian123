import { describe, expect, it } from 'vitest'
import { midiToNoteName, suggestedProtectionThreshold } from './pitch'

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
