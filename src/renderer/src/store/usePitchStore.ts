import { create } from 'zustand'

// Ticket 16: pitch analysis state — shared between the waveform region
// selector and the "分析音高" (Analyze Pitch) button/result display so
// either can live in a different part of the tree without prop drilling.
export interface PitchAnalysisResult {
  maxMidi: number         // highest MIDI note found in the analyzed region (0 = nothing voiced)
  avgMidi: number         // mean MIDI note across voiced frames
  contour: number[]       // per-frame MIDI note (0 = unvoiced) — kept for future waveform overlay
}

interface PitchState {
  // Selected region, in seconds, on the track currently being analyzed.
  // Both null means "no region selected" — analyze_pitch treats that as
  // "analyze the whole track".
  regionStart: number | null
  regionEnd:   number | null

  analyzing: boolean
  result:    PitchAnalysisResult | null
  error:     string | null

  setRegion:    (start: number, end: number) => void
  clearRegion:  () => void
  setAnalyzing: (busy: boolean) => void
  setResult:    (result: PitchAnalysisResult | null) => void
  setError:     (error: string | null) => void
  /** Full reset — called when the panel switches to analyzing a different file. */
  reset:        () => void
}

export const usePitchStore = create<PitchState>((set) => ({
  regionStart: null,
  regionEnd:   null,
  analyzing:   false,
  result:      null,
  error:       null,

  setRegion:    (start, end) => set({ regionStart: start, regionEnd: end }),
  clearRegion:  () => set({ regionStart: null, regionEnd: null }),
  setAnalyzing: (busy)  => set({ analyzing: busy }),
  setResult:    (result) => set({ result, error: null }),
  setError:     (error) => set({ error }),
  reset:        () => set({ regionStart: null, regionEnd: null, analyzing: false, result: null, error: null }),
}))
