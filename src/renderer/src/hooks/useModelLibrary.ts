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
      .catch(() => hydrateModels([]))   // treat an unreadable registry as an empty library
    return () => { active = false }
    // Runs once on mount; hydrateModels is a stable Zustand action reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!modelsHydrated) return   // don't overwrite the saved file before the initial load lands
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
