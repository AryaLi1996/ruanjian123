import { create } from 'zustand'

export type ActiveView = 'training' | 'cover' | 'audio-tools' | 'playback' | 'subscription'

export interface TrainedModel {
  id:           string
  name:         string
  coverDataUrl: string | null
  mode:         'standard' | 'professional'
  trainedAt:    number
  onnxPath:     string
  demoAudioUrl: string | null   // object URL of a WAV blob
  epochs:       number
  bestLoss:     number
}

interface AppState {
  activeView:    ActiveView
  selectedModel: string | null
  engineBusy:    boolean
  engineStatus:  string
  trainedModels: TrainedModel[]

  setActiveView:    (view: ActiveView) => void
  setSelectedModel: (path: string | null) => void
  setEngineBusy:    (busy: boolean) => void
  setEngineStatus:  (status: string) => void
  addModel:         (m: TrainedModel) => void
  removeModel:      (id: string) => void
  updateModelDemo:  (id: string, demoAudioUrl: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  activeView:    'training',
  selectedModel: null,
  engineBusy:    false,
  engineStatus:  'idle',
  trainedModels: [],

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
}))
