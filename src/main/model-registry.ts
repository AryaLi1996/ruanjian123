/**
 * Persists the trained-model library to userData/models.json.
 *
 * The renderer's Zustand store is in-memory only, which meant every trained
 * model (each one potentially up to ~90 minutes of CPU work) vanished the
 * moment the app was closed. This module is the durable side: the renderer
 * loads this file on startup and writes it back whenever the library
 * changes (see the `models:load` / `models:save` IPC handlers in index.ts).
 *
 * Blob object URLs (demoAudioUrl) are intentionally never written here —
 * they're invalid the moment the process restarts. Only the durable
 * demoAudioPath is persisted; the renderer regenerates a fresh blob URL
 * from it on demand.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface PersistedModel {
  id:            string
  name:          string
  coverDataUrl:  string | null
  mode:          'standard' | 'professional'
  trainedAt:     number
  onnxPath:      string
  demoAudioPath: string | null
  epochs:        number
  bestLoss:      number
  qualityScore?:   number
  qualityWarning?: string | null
}

function registryPath(): string {
  return join(app.getPath('userData'), 'models.json')
}

export async function loadModels(): Promise<PersistedModel[]> {
  try {
    const raw  = await fs.readFile(registryPath(), 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data : []
  } catch {
    // Missing on first launch, or corrupt — either way, start from an empty library
    // rather than failing startup.
    return []
  }
}

export async function saveModels(models: PersistedModel[]): Promise<void> {
  await fs.writeFile(registryPath(), JSON.stringify(models, null, 2), 'utf8')
}
