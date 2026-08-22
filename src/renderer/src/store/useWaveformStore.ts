import { create } from 'zustand'

// Ticket 15: selection bounds (seconds) exposed to the rest of the app so
// downstream processing (crop/export/separation on just the selected span,
// etc.) can read what the user marked on the waveform without reaching into
// the WaveformEditor component itself.
export interface WaveformSelection {
  start: number
  end:   number
}

interface WaveformState {
  fileName:      string | null   // display name of the currently loaded clip, if any
  duration:      number          // seconds
  currentTime:   number          // seconds, follows the playhead
  isPlaying:     boolean
  selection:     WaveformSelection | null
  loopSelection: boolean         // when true, playback loops within `selection`

  setFileName:      (name: string | null) => void
  setDuration:      (duration: number) => void
  setCurrentTime:   (time: number) => void
  setIsPlaying:     (playing: boolean) => void
  setSelection:     (selection: WaveformSelection | null) => void
  clearSelection:   () => void
  setLoopSelection: (loop: boolean) => void
  reset:            () => void
}

export const useWaveformStore = create<WaveformState>((set) => ({
  fileName:      null,
  duration:      0,
  currentTime:   0,
  isPlaying:     false,
  selection:     null,
  loopSelection: false,

  setFileName:      (fileName)  => set({ fileName }),
  setDuration:      (duration)  => set({ duration }),
  setCurrentTime:   (time)      => set({ currentTime: time }),
  setIsPlaying:     (playing)   => set({ isPlaying: playing }),
  setSelection:     (selection) => set({ selection }),
  clearSelection:   ()          => set({ selection: null }),
  setLoopSelection: (loop)      => set({ loopSelection: loop }),
  reset: () => set({
    fileName: null, duration: 0, currentTime: 0, isPlaying: false, selection: null,
  }),
}))
