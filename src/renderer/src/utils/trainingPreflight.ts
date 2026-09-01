/**
 * Ticket P1: local self-check run *before* the Python engine is started.
 *
 * The reported failure — "点击训练没反应" — is what several silent, code-level
 * limits look like from the outside. None of them is announced anywhere in
 * the UI, and all of them are knowable before a single byte reaches the
 * engine:
 *
 *  - unsupported formats: AudioDropzone accepts .m4a, but the engine's
 *    preprocess_vocals()/validate_training_data() only read
 *    .wav/.flac/.ogg/.mp3 (engine/trainer.py) — an .m4a upload is listed in
 *    the UI and then silently ignored;
 *  - duplicate names: main's `engine:save-files` writes every file into one
 *    directory keyed by `file.name`, so same-named files overwrite each
 *    other and only the last one trains;
 *  - sub-chunk files: preprocess_vocals slices at CHUNK_FRAMES × SYNTH_HOP
 *    samples and drops the remainder, so anything shorter than one chunk
 *    (~2.97 s) produces no training data at all. When *every* file is that
 *    short, VocalDataset falls back to synthetic sine waves and "trains" a
 *    model that never heard the singer;
 *  - memory: the renderer reads every file into an ArrayBuffer at once and
 *    sends the lot over IPC in a single message, on top of PyTorch's own
 *    working set.
 *
 * Everything here is pure so the rules that decide what the user is warned
 * about are unit-testable without a DOM or an engine.
 */
import type { EngineDeviceInfo } from '../global'
import { CPU_SLOWDOWN_MAX, CPU_SLOWDOWN_MIN, engineDeviceFor, type DeviceMode } from './environmentCheck'
import { RECOMMENDED_DURATION_SEC, SHORT_DATA_WARN_SEC } from './trainingQuality'

/** Extensions the engine can actually read — mirrors engine/trainer.py's `exts`. */
export const ENGINE_AUDIO_EXTS = ['.wav', '.flac', '.ogg', '.mp3'] as const

/**
 * Shortest clip that yields one training chunk: CHUNK_FRAMES × SYNTH_HOP
 * samples at SYNTH_SR (engine/trainer.py) → 65536 / 22050 ≈ 2.97 s.
 */
export const MIN_CHUNK_SEC = (256 * 256) / 22_050

/**
 * Ticket P4: total material beyond which a run is worth trimming, per device.
 *
 * Not a cap — training a long upload is legal and sometimes right. It is the
 * point where the engine's per-epoch silence starts to approach the bridge's
 * budget (see CPU_PROFESSIONAL_STALL_TIMEOUT_MS) and where a laptop CPU turns
 * a 20-minute job into an evening. A GPU chews through far more before either
 * matters, so it gets a much higher bar.
 */
export const LONG_TOTAL_SEC = { cpu: 20 * 60, gpu: 60 * 60 } as const

/**
 * Above this many files, on a machine with less than MANY_FILES_RAM_GB, the
 * one-shot read-everything-into-memory upload path (TrainingView →
 * `engine:save-files`) is the thing most likely to fall over.
 */
export const MANY_FILES_COUNT = 5
export const MANY_FILES_RAM_GB = 16

/** Headroom on top of the raw upload: IPC copy + decode + the trainer's own working set. */
export const MEMORY_OVERHEAD_FACTOR = 1.5
export const MEMORY_BASE_GB = 2

export type TrainingModeId = 'standard' | 'professional'

/** ❌ blocks the run, ⚠ is advisory, ✔ passed. */
export type PreflightSeverity = 'blocker' | 'warning' | 'ok'

export interface PreflightItem {
  id:        string
  severity:  PreflightSeverity
  /** i18n key under `preflight.` carrying the user-facing sentence. */
  messageKey: string
  /** Interpolation values for messageKey. */
  params:    Record<string, string | number>
  /**
   * Ticket P4: the files this row is actually about, named and measured.
   * A warning that says "material is too long" leaves the user guessing
   * which of seven files to drop; this is the list the dialog prints under
   * the row so the next action is obvious.
   */
  files?:    TrainingFileInfo[]
  /**
   * Names the user can remove in one click to clear this row. Present only
   * when removing exactly these files resolves it — advice that needs
   * judgement (merge these, re-record that) carries `files` but no
   * `removable`, because a button that half-fixes a problem is worse than
   * a sentence that explains it.
   */
  removable?: string[]
}

export interface PreflightResult {
  items: PreflightItem[]
  /** No blockers — the run may start (possibly after acknowledging warnings). */
  canProceed: boolean
  /** A professional-mode run that will land on the CPU (Ticket P2). */
  cpuProfessional: boolean
  /** Estimated peak memory for this upload, in GB. */
  estimatedMemoryGb: number
}

/** One uploaded file as the dropzone knows it: the file plus its decoded duration. */
export interface TrainingFileInfo {
  name:     string
  sizeBytes: number
  /** Seconds, or null when the browser could not decode the file. */
  duration: number | null
}

export interface PreflightInput {
  files:      TrainingFileInfo[]
  mode:       TrainingModeId
  deviceMode: DeviceMode
  device:     EngineDeviceInfo | null
  /** From EnvironmentReport.available_ram_gb; null when the platform can't tell. */
  availableRamGb: number | null
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

export function isEngineReadable(name: string): boolean {
  return (ENGINE_AUDIO_EXTS as readonly string[]).includes(fileExtension(name))
}

/** Peak memory this upload is likely to need, in GB (see MEMORY_* above). */
export function estimateTrainingMemoryGb(totalBytes: number): number {
  return (totalBytes * MEMORY_OVERHEAD_FACTOR) / 1024 ** 3 + MEMORY_BASE_GB
}

function minutes(sec: number): string {
  return (sec / 60).toFixed(1)
}

/**
 * The fewest files to remove to bring `files` under `targetSec`, longest
 * first.
 *
 * Longest-first is what gets the total down in the fewest deletions, which is
 * the whole point of the suggestion: the user should not have to delete five
 * short takes when dropping one long one does it. Never suggests removing
 * everything — a suggestion that empties the dropzone is not a suggestion.
 */
export function suggestRemovals(files: TrainingFileInfo[], targetSec: number): TrainingFileInfo[] {
  const measured = files
    .filter((f) => f.duration != null && f.duration > 0)
    .sort((a, b) => (b.duration as number) - (a.duration as number))

  let total = measured.reduce((sum, f) => sum + (f.duration as number), 0)
  const remove: TrainingFileInfo[] = []
  for (const f of measured) {
    if (total <= targetSec) break
    if (remove.length >= measured.length - 1) break   // always leave one behind
    remove.push(f)
    total -= f.duration as number
  }
  return remove
}

/**
 * Run every local check and return the checklist the dialog renders.
 *
 * Order is deliberate: blockers first, then warnings, then passes, so the
 * items that stop the run are the ones the user reads first.
 */
export function checkTrainingInputs(input: PreflightInput): PreflightResult {
  const { files, mode, deviceMode, device, availableRamGb } = input
  const items: PreflightItem[] = []

  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)
  const estimatedMemoryGb = estimateTrainingMemoryGb(totalBytes)
  const cpuProfessional = mode === 'professional' && engineDeviceFor(deviceMode, device) === 'cpu'

  // ── Format ────────────────────────────────────────────────────────────
  const unreadable = files.filter((f) => !isEngineReadable(f.name))
  if (unreadable.length > 0) {
    items.push({
      id: 'format', severity: 'blocker', messageKey: 'preflight.format.fail',
      params: {
        count: unreadable.length,
        names: unreadable.map((f) => f.name).join('、'),
        exts:  ENGINE_AUDIO_EXTS.join(' / '),
      },
      files: unreadable,
      // Removing them unblocks the run honestly: they were never going to be
      // trained on. Converting them is the better fix, which the message says.
      removable: unreadable.map((f) => f.name),
    })
  } else if (files.length > 0) {
    items.push({ id: 'format', severity: 'ok', messageKey: 'preflight.format.ok', params: { count: files.length } })
  }

  // ── Duplicate file names ──────────────────────────────────────────────
  const seen = new Map<string, number>()
  for (const f of files) seen.set(f.name, (seen.get(f.name) ?? 0) + 1)
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name)
  if (duplicates.length > 0) {
    items.push({
      id: 'duplicateNames', severity: 'blocker', messageKey: 'preflight.duplicateNames.fail',
      params: { names: duplicates.join('、') },
    })
  } else if (files.length > 1) {
    items.push({ id: 'duplicateNames', severity: 'ok', messageKey: 'preflight.duplicateNames.ok', params: {} })
  }

  // ── Clips too short to produce a single training chunk ─────────────────
  const readable   = files.filter((f) => isEngineReadable(f.name))
  const measurable = readable.filter((f) => f.duration != null && f.duration > 0)
  const tooShort   = measurable.filter((f) => (f.duration as number) < MIN_CHUNK_SEC)
  if (measurable.length > 0 && tooShort.length === measurable.length) {
    // Every usable file would be dropped → the engine trains on synthetic
    // sine waves and reports success. Never let that leave here. No
    // `removable` here on purpose: removing them all empties the dropzone,
    // and what this needs is longer recordings, not fewer files.
    items.push({
      id: 'chunkable', severity: 'blocker', messageKey: 'preflight.chunkable.fail',
      params: { seconds: MIN_CHUNK_SEC.toFixed(1) },
      files: tooShort,
    })
  } else if (tooShort.length > 0) {
    items.push({
      id: 'chunkable', severity: 'warning', messageKey: 'preflight.chunkable.warn',
      params: { count: tooShort.length, seconds: MIN_CHUNK_SEC.toFixed(1) },
      // These contribute nothing to training either way, so removing them is
      // pure clean-up: it changes what the list claims is being trained on,
      // not what the model sees.
      files: tooShort,
      removable: tooShort.map((f) => f.name),
    })
  }

  // ── Total duration ────────────────────────────────────────────────────
  const totalSec = measurable.reduce((sum, f) => sum + (f.duration as number), 0)
  // Same thresholds the short-data dialog used before this checklist absorbed
  // it (Ticket T3) — kept in trainingQuality.ts so the pre-flight and the
  // finished-run report speak about duration in one voice.
  const recommended = RECOMMENDED_DURATION_SEC[mode] ?? RECOMMENDED_DURATION_SEC.standard
  if (files.length === 0) {
    items.push({ id: 'duration', severity: 'warning', messageKey: 'preflight.duration.none', params: {} })
  } else if (measurable.length === 0) {
    items.push({ id: 'duration', severity: 'warning', messageKey: 'preflight.duration.unknown', params: {} })
  } else if (totalSec < SHORT_DATA_WARN_SEC || totalSec < recommended) {
    items.push({
      id: 'duration', severity: 'warning', messageKey: 'preflight.duration.short',
      params: { actual: minutes(totalSec), recommended: minutes(recommended) },
    })
  } else {
    items.push({
      id: 'duration', severity: 'ok', messageKey: 'preflight.duration.ok',
      params: { actual: minutes(totalSec) },
    })
  }

  // ── Material long enough to be worth trimming (Ticket P4) ─────────────
  // Deliberately a warning, not a blocker: a long upload trains fine on a
  // GPU, and refusing it would be the hard cap this whole feature avoids.
  // What it earns is a concrete list — which files, how long each is — so
  // "shorten your material" is an action rather than a puzzle.
  const onCpu     = engineDeviceFor(deviceMode, device) === 'cpu'
  const longLimit = onCpu ? LONG_TOTAL_SEC.cpu : LONG_TOTAL_SEC.gpu
  if (measurable.length > 0 && totalSec > longLimit) {
    const trim = suggestRemovals(measurable, longLimit)
    items.push({
      id: 'longMaterial', severity: 'warning', messageKey: 'preflight.longMaterial.warn',
      params: {
        actual: minutes(totalSec),
        limit:  minutes(longLimit),
        count:  trim.length,
      },
      files: trim,
      removable: trim.map((f) => f.name),
    })
  }

  // ── File count against available memory (Ticket P4) ───────────────────
  // No `removable`: which files to merge (or drop) is a judgement about the
  // material, and the fix the message proposes — merge takes into one file —
  // isn't a deletion at all.
  if (files.length > MANY_FILES_COUNT && availableRamGb != null && availableRamGb < MANY_FILES_RAM_GB) {
    items.push({
      id: 'fileCount', severity: 'warning', messageKey: 'preflight.fileCount.warn',
      params: {
        count: files.length,
        available: availableRamGb.toFixed(1),
        suggested: MANY_FILES_COUNT,
      },
    })
  }

  // ── Memory ────────────────────────────────────────────────────────────
  if (availableRamGb == null) {
    items.push({
      id: 'memory', severity: 'warning', messageKey: 'preflight.memory.unknown',
      params: { needed: estimatedMemoryGb.toFixed(1) },
    })
  } else if (estimatedMemoryGb > availableRamGb) {
    items.push({
      id: 'memory', severity: 'warning', messageKey: 'preflight.memory.low',
      params: { available: availableRamGb.toFixed(1), needed: estimatedMemoryGb.toFixed(1) },
    })
  } else {
    items.push({
      id: 'memory', severity: 'ok', messageKey: 'preflight.memory.ok',
      params: { available: availableRamGb.toFixed(1), needed: estimatedMemoryGb.toFixed(1) },
    })
  }

  // ── Device (Ticket P2) ────────────────────────────────────────────────
  // Professional-on-CPU is its own row rather than an extra sentence on the
  // generic one: it is the combination that reliably outruns the engine's
  // silence budget on the kind of laptop this was reported from, and it is
  // the only row that offers a way out (switch to standard mode).
  if (cpuProfessional) {
    items.push({ id: 'device', severity: 'warning', messageKey: 'preflight.cpuProfessional.warn', params: {} })
  } else if (engineDeviceFor(deviceMode, device) === 'cpu') {
    items.push({
      id: 'device', severity: 'warning', messageKey: 'preflight.device.cpu',
      params: { min: CPU_SLOWDOWN_MIN, max: CPU_SLOWDOWN_MAX },
    })
  } else {
    items.push({ id: 'device', severity: 'ok', messageKey: 'preflight.device.gpu', params: {} })
  }

  const rank: Record<PreflightSeverity, number> = { blocker: 0, warning: 1, ok: 2 }
  items.sort((a, b) => rank[a.severity] - rank[b.severity])

  return {
    items,
    canProceed: items.every((i) => i.severity !== 'blocker'),
    cpuProfessional,
    estimatedMemoryGb,
  }
}
