/**
 * Standard project asset layout for Cover Creation (FC-02).
 *
 * Separation writes its stems next to whatever input file it was given, with
 * engine-internal names (`<input-stem>_lead_dry.wav`, …). That is fine for
 * playback inside the session, but the training step downstream needs a
 * stable, predictable place to read from — one that survives a re-separation
 * and doesn't depend on where the source audio happened to live (a cloud
 * library cache entry, a user upload directory, a temp file).
 *
 * So once a separation finishes, its outputs are copied into
 *
 *   <projectsDir>/<projectId>/
 *     ├── original.wav        original audio the separation ran on
 *     ├── vocals.wav          standard mode
 *     ├── accompaniment.wav   standard mode
 *     ├── lead_vocal.wav      enhanced mode
 *     ├── backing_vocal.wav   enhanced mode
 *     └── instrumentals.wav   enhanced mode
 *
 * and that map of asset name → absolute path is what the renderer stores and
 * the training panel validates against.
 *
 * electron-free on purpose (the caller passes `projectsDir` in) so it can be
 * unit-tested under Vitest — see vitest.config.ts's header comment.
 */
import { promises as fs } from 'fs'
import { join } from 'path'

export type SeparationMode = 'standard' | 'enhanced'

/** Asset file names, keyed by the stem name the Python engine emits. */
export const STEM_FILE_NAMES: Record<string, string> = {
  vocals:        'vocals.wav',
  accompaniment: 'accompaniment.wav',
  lead_dry:      'lead_vocal.wav',
  harmony_dry:   'backing_vocal.wav',
}

/** Name the original (pre-separation) audio is copied under. */
export const ORIGINAL_FILE_NAME = 'original.wav'

/**
 * In enhanced mode the accompaniment stem is the fully instrumental mix (the
 * vocals having been split out into lead + backing), so it is stored under
 * the ticket's `instrumentals.wav` name rather than `accompaniment.wav`.
 */
export function assetFileName(stemKey: string, mode: SeparationMode): string | null {
  if (mode === 'enhanced' && stemKey === 'accompaniment') return 'instrumentals.wav'
  return STEM_FILE_NAMES[stemKey] ?? null
}

/** Assets that must exist before the dataset built from them is worth training on. */
export function requiredAssets(mode: SeparationMode): string[] {
  return mode === 'enhanced'
    ? ['lead_vocal.wav', 'backing_vocal.wav', 'instrumentals.wav']
    : ['vocals.wav', 'accompaniment.wav']
}

/** Asset map produced by collectProjectAssets: file name → absolute path. */
export type TrainingAssets = Record<string, string>

/** Required assets that `assets` does not carry. Empty means "ready to train". */
export function missingAssets(assets: TrainingAssets | null, mode: SeparationMode): string[] {
  if (!assets) return requiredAssets(mode)
  return requiredAssets(mode).filter((name) => !assets[name])
}

export function isTrainingReady(assets: TrainingAssets | null, mode: SeparationMode): boolean {
  return missingAssets(assets, mode).length === 0
}

export interface CollectInput {
  /** Root directory holding all projects (userData/projects in the app). */
  projectsDir: string
  projectId:   string
  mode:        SeparationMode
  /** The audio separation ran on; copied to original.wav. Optional — a missing source is skipped, not fatal. */
  originalPath?: string | null
  /** Engine stem name → path, straight from the separation result. */
  stems:       Record<string, string>
}

export interface CollectResult {
  projectDir: string
  assets:     TrainingAssets
  /** Required assets that could not be produced — non-empty means training stays blocked. */
  missing:    string[]
}

/**
 * Copies a separation's outputs into the standard project folder.
 *
 * Copies rather than moves: the stem paths handed out by the engine are also
 * what the step-① stem player and the mixer are already playing from, and
 * pulling those files out from under a playing <audio> element would break
 * preview for the sake of saving a few megabytes.
 *
 * A stem that can't be copied (deleted under us, permissions) is left out of
 * the returned map rather than failing the whole call — `missing` then tells
 * the caller that training can't proceed, which is more useful than an
 * exception that loses the assets that did make it.
 */
export async function collectProjectAssets(input: CollectInput): Promise<CollectResult> {
  const projectDir = join(input.projectsDir, input.projectId)
  await fs.mkdir(projectDir, { recursive: true })

  const assets: TrainingAssets = {}

  const copies: Array<{ from: string; to: string }> = []
  if (input.originalPath) copies.push({ from: input.originalPath, to: ORIGINAL_FILE_NAME })
  for (const [stemKey, stemPath] of Object.entries(input.stems ?? {})) {
    const name = assetFileName(stemKey, input.mode)
    if (name && stemPath) copies.push({ from: stemPath, to: name })
  }

  for (const { from, to } of copies) {
    const dest = join(projectDir, to)
    try {
      await fs.copyFile(from, dest)
      assets[to] = dest
    } catch {
      // Best effort — see the doc comment above.
    }
  }

  return { projectDir, assets, missing: missingAssets(assets, input.mode) }
}
