import { useEffect, useRef } from 'react'
import { useAppStore, type TrainedModel } from '../store/useAppStore'

/**
 * Bridges the in-memory trainedModels list to the durable registry the main
 * process persists at userData/models.json (see model-registry.ts).
 *
 * - On mount: loads the saved library and hydrates the store. demoAudioUrl
 *   starts null for every restored model — blob object URLs don't survive a
 *   restart, so it's regenerated on demand from demoAudioPath when the user
 *   presses Play (see TrainingView's handlePlay).
 * - After hydration: any change to trainedModels is saved back, debounced,
 *   with demoAudioUrl stripped out (it's never valid to reload, so it's
 *   pointless — and would bloat — to persist it).
 *
 * Mount this once near the app root.
 */
export function useModelLibrary(): void {
  const hydrateModels   = useAppStore((s) => s.hydrateModels)
  const modelsHydrated  = useAppStore((s) => s.modelsHydrated)
  const trainedModels   = useAppStore((s) => s.trainedModels)
  const saveTimer       = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set when the initial load rejects (IPC hiccup, main not ready yet —
  // model-registry.ts's own loadModels() never actually throws today, but
  // nothing guarantees that stays true). hydrateModels([]) below is only a
  // UI fallback so the app isn't stuck; it must NOT be allowed to trigger
  // the autosave effect, or that fallback would immediately overwrite a
  // possibly-intact models.json on disk with an empty array. Cleared after
  // the first skipped save so any real, user-driven change afterwards
  // (training/deleting a model) persists normally.
  const skipNextSave    = useRef(false)

  useEffect(() => {
    let active = true
    window.engine.loadModels()
      .then((saved) => {
        if (!active) return
        const restored: TrainedModel[] = saved.map((m) => ({
          ...m,
          demoAudioUrl: null,
        }))
        hydrateModels(restored)
      })
      .catch(() => {
        skipNextSave.current = true
        hydrateModels([])   // treat an unreadable registry as an empty library for the UI...
      })
    return () => { active = false }
    // Runs once on mount; hydrateModels is a stable Zustand action reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!modelsHydrated) return   // don't overwrite the saved file before the initial load lands
    if (skipNextSave.current) {   // ...but never autosave that fallback back over the real file
      skipNextSave.current = false
      return
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      // demoAudioUrl (a blob: URL) is deliberately dropped — it's already dead
      // by the time this file is ever read back.
      const persisted = trainedModels.map((m) => ({
        id: m.id, name: m.name, coverDataUrl: m.coverDataUrl, mode: m.mode,
        trainedAt: m.trainedAt, onnxPath: m.onnxPath, demoAudioPath: m.demoAudioPath,
        epochs: m.epochs, bestLoss: m.bestLoss,
      }))
      void window.engine.saveModels(persisted)
    }, 500)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [trainedModels, modelsHydrated])
}
