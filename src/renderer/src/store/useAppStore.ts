import { create } from 'zustand'

export type ActiveView = 'training' | 'cover' | 'audio-tools' | 'waveform' | 'playback' | 'subscription' | 'settings'

export interface TrainedModel {
  id:            string
  name:          string
  coverDataUrl:  string | null
  mode:          'standard' | 'professional'
  trainedAt:     number
  onnxPath:      string
  demoAudioUrl:  string | null   // object URL of a WAV blob — session-only, never persisted
  demoAudioPath: string | null   // durable file path the blob URL above was created from; used to
                                 // regenerate demoAudioUrl on demand after a restart
  epochs:        number
  bestLoss:      number
  // Ticket 48: SI-SNR-based proxy (0-1) for how faithfully this model
  // reproduces its training material, plus the plain-language warning
  // shown when it's low. Optional so models saved before this ticket keep
  // loading without either field.
  qualityScore?:   number
  qualityWarning?: string | null
}

// Ticket 18: the song picked in the Cloud Library (云曲库) modal — the
// "目标音频" that Cover Creation separates and replaces the vocal of.
// audioPath is a local file already downloaded/cached by the main process
// (see main/library.ts's fetchLibraryAudio), so consumers never touch the
// remote audio_url directly. Session-only, like selectedModel above — it's
// meant to persist "until changed" within a running session, not survive a
// restart.
//
// pitchShift/shiftedAudioPath (Ticket 19): the Tune slider's applied key
// change and the local, engine-cached result of running
// librosa.effects.pitch_shift on audioPath at that shift. shiftedAudioPath
// is null at shift 0 (nothing to shift — audioPath is used as-is); see
// CoverView's handleSeparate for where the two are chosen between.
export interface TargetSong {
  id:               string
  title:            string
  artist:           string
  originalKey:      string | null
  audioPath:        string
  pitchShift:       number
  shiftedAudioPath: string | null
}

interface AppState {
  activeView:      ActiveView
  selectedModel:   string | null
  engineBusy:      boolean
  engineStatus:    string
  // PATCH-02 §4: the toolbar only renders engineStatus while the engine is
  // busy, so an outcome worth *keeping* on screen after the work finishes
  // (e.g. "已应用模型音域，高音保护起点为D#4") would otherwise be set and
  // immediately invisible. A sticky status stays shown until the next
  // setEngineStatus call replaces it.
  statusSticky:    boolean
  trainedModels:   TrainedModel[]
  modelsHydrated:  boolean   // true once the persisted library has been loaded — gates autosave
                              // so an early empty render can't overwrite the saved file with []
  targetSong:      TargetSong | null
  // Whether the Cloud Library (云曲库) modal is open. Lifted out of
  // CoverView's local state for Ticket UI-02 so the sidebar's 云曲库 entry
  // can open the same modal the Cover page does, rather than a second copy
  // of it — CoverView still owns the modal element and the selection
  // handler (it has to clear its own local upload alongside it).
  libraryOpen:     boolean

  setActiveView:    (view: ActiveView) => void
  setSelectedModel: (path: string | null) => void
  setEngineBusy:    (busy: boolean) => void
  /** `sticky` keeps the status on the toolbar after the engine goes idle — see statusSticky. */
  setEngineStatus:  (status: string, sticky?: boolean) => void
  addModel:         (m: TrainedModel) => void
  removeModel:      (id: string) => void
  updateModelDemo:  (id: string, demoAudioUrl: string) => void
  hydrateModels:    (models: TrainedModel[]) => void
  setTargetSong:    (song: TargetSong | null) => void
  setLibraryOpen:   (open: boolean) => void
  // Ticket 19: records a newly-applied pitch shift (and its cached shifted
  // audio) on the current target song. No-ops if the song has since been
  // cleared/changed from under an in-flight shift request.
  setTargetSongShift: (shift: number, shiftedAudioPath: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  activeView:     'training',
  selectedModel:  null,
  engineBusy:     false,
  engineStatus:   'idle',
  statusSticky:   false,
  trainedModels:  [],
  modelsHydrated: false,
  targetSong:     null,
  libraryOpen:    false,

  setActiveView:    (view)  => set({ activeView: view }),
  setSelectedModel: (path)  => set({ selectedModel: path }),
  setEngineBusy:    (busy)  => set({ engineBusy: busy }),
  setEngineStatus:  (status, sticky = false) => set({ engineStatus: status, statusSticky: sticky }),
  addModel:         (m)     => set((s) => ({ trainedModels: [m, ...s.trainedModels] })),
  removeModel:      (id)    => set((s) => ({ trainedModels: s.trainedModels.filter((m) => m.id !== id) })),
  updateModelDemo:  (id, url) =>
    set((s) => ({
      trainedModels: s.trainedModels.map((m) => m.id === id ? { ...m, demoAudioUrl: url } : m),
    })),
  hydrateModels:    (models) => set({ trainedModels: models, modelsHydrated: true }),
  setTargetSong:    (song)   => set({ targetSong: song }),
  setLibraryOpen:   (open)   => set({ libraryOpen: open }),
  setTargetSongShift: (shift, shiftedAudioPath) =>
    set((s) => (s.targetSong ? { targetSong: { ...s.targetSong, pitchShift: shift, shiftedAudioPath } } : s)),
}))
