import { create } from 'zustand'

export type ActiveView = 'training' | 'cover' | 'audio-tools' | 'playback' | 'subscription'

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
}

interface AppState {
  activeView:      ActiveView
  selectedModel:   string | null
  engineBusy:      boolean
  engineStatus:    string
  trainedModels:   TrainedModel[]
  modelsHydrated:  boolean   // true once the persisted library has been loaded — gates autosave
                              // so an early empty render can't overwrite the saved file with []

  setActiveView:    (view: ActiveView) => void
  setSelectedModel: (path: string | null) => void
  setEngineBusy:    (busy: boolean) => void
  setEngineStatus:  (status: string) => void
  addModel:         (m: TrainedModel) => void
  removeModel:      (id: string) => void
  updateModelDemo:  (id: string, demoAudioUrl: string) => void
  hydrateModels:    (models: TrainedModel[]) => void
}

export const useAppStore = create<AppState>((set) => ({
  activeView:     'training',
  selectedModel:  null,
  engineBusy:     false,
  engineStatus:   'idle',
  trainedModels:  [],
  modelsHydrated: false,

  setActiveView:    (view)  => set({ activeView: view }),
  setSelectedModel: (path)  => set({ selectedModel: path }),
  setEngineBusy:    (busy)  => set({ engineBusy: busy }),
  setEngineStatus:  (status) => set({ engineStatus: status }),
  addModel:         (m)     => set((s) => ({ trainedModels: [m, ...s.trainedModels] })),
  removeModel:      (id)    => set((s) => ({ trainedModels: s.trainedModels.filter((m) => m.id !== id) })),
  updateModelDemo:  (id, url) =>
    set((s) => ({
      trainedModels: s.trainedModels.map((m) => m.id === id ? { ...m, demoAudioUrl: url } : m),
    })),
  hydrateModels:    (models) => set({ trainedModels: models, modelsHydrated: true }),
}))
