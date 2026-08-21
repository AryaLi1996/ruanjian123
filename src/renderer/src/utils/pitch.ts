/** MIDI/note-name helpers shared by the pitch analysis panel (Ticket 16). */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** Converts a MIDI note number to a note name, e.g. 60 -> "C4", 77 -> "F5". */
export function midiToNoteName(midi: number): string {
  const rounded = Math.round(midi)
  const name    = NOTE_NAMES[((rounded % 12) + 12) % 12]
  const octave  = Math.floor(rounded / 12) - 1
  return `${name}${octave}`
}

// Suggested high-note protection threshold: an octave and a whole tone below
// the detected peak (14 semitones) — e.g. a max of F5 suggests D#4. That
// margin gives the singer's model room to breathe before it's pushed past
// the highest note actually observed in the reference material.
const PROTECTION_MARGIN_SEMITONES = 14

export function suggestedProtectionThreshold(maxMidi: number): number {
  return maxMidi - PROTECTION_MARGIN_SEMITONES
}
