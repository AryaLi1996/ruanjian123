import { create } from 'zustand'

// Ticket 15: selection bounds (seconds) exposed to the rest of the app so
// downstream processing (crop/export/separation on just the selected span,
// etc.) can read what the user marked on the waveform without reaching into
// the WaveformEditor component itself.
export interface WaveformSelection {
  start: number
  end:   number
}

// PATCH-03: the Model Data Preparation workspace drives playback from its own
// grouped toolbar, which lives outside <WaveformEditor>. WaveSurfer is an
// imperative instance owned by that component, so it registers these thin
// commands here on mount (and clears them on unmount) rather than the toolbar
// reaching for the instance itself.
export interface WaveformControls {
  play:  () => void
  pause: () => void
}

interface WaveformState {
  fileName:      string | null   // display name of the currently loaded clip, if any
  // PATCH-03: absolute filesystem path of the loaded clip, when there is one.
  // Only the native "Browse…" flow (PATCH-01) resolves a real path — a
  // dragged/browser-picked File carries none in this sandboxed renderer — and
  // the engine calls behind 分析音高/应用高音保护 need one, so the data-prep
  // toolbar reads this to decide whether those actions can run at all.
  filePath:      string | null
  duration:      number          // seconds
  currentTime:   number          // seconds, follows the playhead
  isPlaying:     boolean
  selection:     WaveformSelection | null
  loopSelection: boolean         // when true, playback loops within `selection`
  controls:      WaveformControls | null

  setFileName:      (name: string | null) => void
  setFilePath:      (path: string | null) => void
  setDuration:      (duration: number) => void
  setCurrentTime:   (time: number) => void
  setIsPlaying:     (playing: boolean) => void
  setSelection:     (selection: WaveformSelection | null) => void
  clearSelection:   () => void
  setLoopSelection: (loop: boolean) => void
  setControls:      (controls: WaveformControls | null) => void
  reset:            () => void
}

export const useWaveformStore = create<WaveformState>((set) => ({
  fileName:      null,
  filePath:      null,
  duration:      0,
  currentTime:   0,
  isPlaying:     false,
  selection:     null,
  loopSelection: false,
  controls:      null,

  setFileName:      (fileName)  => set({ fileName }),
  setFilePath:      (filePath)  => set({ filePath }),
  setDuration:      (duration)  => set({ duration }),
  setCurrentTime:   (time)      => set({ currentTime: time }),
  setIsPlaying:     (playing)   => set({ isPlaying: playing }),
  setSelection:     (selection) => set({ selection }),
  clearSelection:   ()          => set({ selection: null }),
  setLoopSelection: (loop)      => set({ loopSelection: loop }),
  setControls:      (controls)  => set({ controls }),
  reset: () => set({
    fileName: null, filePath: null, duration: 0, currentTime: 0, isPlaying: false, selection: null,
  }),
}))
