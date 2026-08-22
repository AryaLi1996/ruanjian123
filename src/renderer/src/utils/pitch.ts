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

/**
 * The fixed 强制修音 threshold (Ticket 17 / PATCH-02): D#4. Mirrors the
 * `threshold_note: 63` the engine's apply_high_pitch_protection is called
 * with — kept here so the UI's reference line and the correction itself can
 * never drift apart.
 */
export const PROTECTION_THRESHOLD_MIDI = 63

/**
 * PATCH-02 §3: the MIDI range the pitch overlay's vertical axis spans, so a
 * contour and the D#4 threshold line can be drawn against the same scale on
 * top of the waveform.
 */
export interface PitchAxis {
  lo: number
  hi: number
}

// Breathing room above/below the outermost note so the contour never rides
// flush against the plot edge, and a floor on the total span so a nearly
// monotone passage doesn't blow a 1-semitone wobble up to full height.
const AXIS_PADDING_SEMITONES = 3
const MIN_AXIS_SPAN_SEMITONES = 12

/**
 * Derives the overlay's vertical MIDI range from an analyzed contour
 * (per-frame MIDI, 0 = unvoiced). The threshold is always included in the
 * range so its reference line stays on screen even when every note sits
 * well under (or over) it. Returns null when nothing was voiced — there is
 * no meaningful pitch axis to draw against in that case.
 */
export function computePitchAxis(
  contour: readonly number[],
  thresholdMidi: number = PROTECTION_THRESHOLD_MIDI,
): PitchAxis | null {
  let min = Infinity
  let max = -Infinity
  // A plain loop rather than Math.min(...voiced): contours run to thousands
  // of frames, well past the argument limit a spread would hit.
  for (const midi of contour) {
    if (midi <= 0) continue          // unvoiced frame
    if (midi < min) min = midi
    if (midi > max) max = midi
  }
  if (min === Infinity) return null

  let lo = Math.min(min, thresholdMidi) - AXIS_PADDING_SEMITONES
  let hi = Math.max(max, thresholdMidi) + AXIS_PADDING_SEMITONES

  const shortfall = MIN_AXIS_SPAN_SEMITONES - (hi - lo)
  if (shortfall > 0) {
    lo -= shortfall / 2
    hi += shortfall / 2
  }
  return { lo, hi }
}

/**
 * Maps a MIDI note onto the overlay's vertical axis as a fraction where 0 is
 * the top edge and 1 the bottom — i.e. higher notes sit higher on screen,
 * matching how the threshold line and contour are positioned in CSS/canvas
 * coordinates. Clamped, so a note outside the axis pins to the nearest edge
 * instead of drawing off-plot.
 */
export function midiToYFraction(midi: number, axis: PitchAxis): number {
  const span = axis.hi - axis.lo
  if (span <= 0) return 0.5
  const fromBottom = (midi - axis.lo) / span
  return 1 - Math.min(1, Math.max(0, fromBottom))
}

/**
 * Pitch-shift / key-change helpers — Ticket 19.
 *
 * The recommended-shift formula needs two numeric MIDI values that don't
 * exist as such elsewhere in the app:
 *
 *  - the cloud library song's `original_key` (Ticket 18) is a key *name*
 *    like "F#m", "Eb", "C" — keyToMidi() turns that into a single MIDI
 *    reference pitch (its tonic in a fixed octave).
 *  - the user's vocal range (Ticket 16) comes from usePitchStore's
 *    analyze_pitch result — see CoverView, which feeds that panel the
 *    separated lead vocal stem and reads back `result.maxMidi`.
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

/**
 * Ticket 22 ("应用高音提示" → auto-recommend a shift for the target song):
 * on top of computeRecommendedShift()'s single value, gives the "fits a
 * shift of N to M semitones, we recommend N" range the confirmation message
 * shows. `recommended` is the minimal shift needed (computeRecommendedShift,
 * unchanged); `cushioned` extends that by SHIFT_RANGE_CUSHION_SEMITONES
 * further in the same direction — a comfortable margin beyond the bare
 * minimum, capped at the slider's ±12 range same as `recommended` is. Null
 * whenever computeRecommendedShift is (no key/range yet) or resolves to 0
 * (no shift needed — there's no "direction" for a range to extend into).
 */
export const SHIFT_RANGE_CUSHION_SEMITONES = 2

export interface RecommendedShiftRange {
  recommended: number
  cushioned:   number
}

export function computeRecommendedShiftRange(
  originalKey: string | null | undefined,
  vocalRangeMaxMidi: number | null | undefined,
): RecommendedShiftRange | null {
  const recommended = computeRecommendedShift(originalKey, vocalRangeMaxMidi)
  if (recommended == null || recommended === 0) return null
  const sign = Math.sign(recommended)
  const cushioned = Math.max(
    PITCH_SHIFT_MIN,
    Math.min(PITCH_SHIFT_MAX, recommended + sign * SHIFT_RANGE_CUSHION_SEMITONES),
  )
  return { recommended, cushioned }
}
