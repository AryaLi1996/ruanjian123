/**
 * Pitch-shift / key-change helpers — Ticket 19.
 *
 * The recommended-shift formula needs two numeric MIDI values that don't
 * exist as such elsewhere in the app:
 *
 *  - the cloud library song's `original_key` (Ticket 18) is a key *name*
 *    like "F#m", "Eb", "C" — keyToMidi() turns that into a single MIDI
 *    reference pitch (its tonic in a fixed octave).
 *  - the user's vocal range (Ticket 16) is produced by the engine's
 *    analyze_vocal_range call (see engine/pitch_tools.py) as {min_midi,
 *    max_midi}; only the max is needed here.
 *
 * Kept dependency-free (no librosa/electron) so it's unit-testable under
 * Vitest, same rationale as library-search.ts's split from library.ts.
 */

const NOTE_PITCH_CLASS: Record<string, number> = {
  C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, FB: 4,
  'E#': 5, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9,
  'A#': 10, BB: 10, B: 11, CB: 11,
}

// Letter + optional #/b accidental + optional "m"/"min"/"minor" quality
// suffix (the quality doesn't change the tonic's pitch class, so it's only
// used to accept the string — see keyToMidi's comment below).
const KEY_RE = /^([A-Ga-g])([#b]?)(m(?:in(?:or)?)?)?$/

/**
 * Maps a key name ("C", "F#m", "Eb", "Am") to a MIDI note number for its
 * tonic in `refOctave` (MIDI 60 = C4, the standard MIDI octave numbering
 * where C-1 = 0). Major and minor share the same tonic pitch class, so a
 * trailing "m" only validates the string — it doesn't select a different
 * note. Returns null for anything that isn't a recognisable key name (e.g.
 * a catalog entry with no known key, original_key === null).
 */
export function keyToMidi(key: string | null | undefined, refOctave = 4): number | null {
  if (!key) return null
  const m = KEY_RE.exec(key.trim())
  if (!m) return null
  const [, letter, accidental] = m
  const pitchClass = NOTE_PITCH_CLASS[letter.toUpperCase() + accidental.toUpperCase()]
  if (pitchClass == null) return null
  return (refOctave + 1) * 12 + pitchClass
}

export const PITCH_SHIFT_MIN = -12
export const PITCH_SHIFT_MAX = 12

/**
 * recommended_shift = song_original_key − user_vocal_range, capped to the
 * slider's ±12 semitone range. Either input missing (no recognised key, or
 * vocal-range analysis hasn't run yet this session) means no recommendation
 * can be made — callers should treat null as "don't show a marker".
 */
export function computeRecommendedShift(
  originalKey: string | null | undefined,
  vocalRangeMaxMidi: number | null | undefined,
): number | null {
  const keyMidi = keyToMidi(originalKey)
  if (keyMidi == null || vocalRangeMaxMidi == null) return null
  const raw = Math.round(keyMidi - vocalRangeMaxMidi)
  return Math.max(PITCH_SHIFT_MIN, Math.min(PITCH_SHIFT_MAX, raw))
}
