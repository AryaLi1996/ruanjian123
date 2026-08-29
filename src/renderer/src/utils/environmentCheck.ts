import type { EngineDeviceInfo, EnvCheck, EnvironmentReport } from '../global'

/**
 * Pure helpers for the pre-flight self-check and device handling
 * (Tickets T2/T3). Kept out of the components so the rules that decide
 * "may this user press 开始本地训练?" are unit-testable without a DOM.
 */

/** What the user asked to train on, as opposed to what the machine can do. */
export type DeviceMode = 'gpu' | 'cpu'

/** How much slower a CPU run is than a GPU one — mirrors engine/device_detector.py. */
export const CPU_SLOWDOWN_MIN = 5
export const CPU_SLOWDOWN_MAX = 10

export interface ReportSummary {
  /** Nothing failed — training may start. Warnings never block. */
  canTrain:  boolean
  failures:  EnvCheck[]
  warnings:  EnvCheck[]
  passes:    EnvCheck[]
}

export function summarizeReport(report: EnvironmentReport | null): ReportSummary {
  const checks = report?.checks ?? []
  const failures = checks.filter((c) => c.status === 'fail')
  const warnings = checks.filter((c) => c.status === 'warn')
  const passes   = checks.filter((c) => c.status === 'ok')
  // A report that hasn't arrived yet is not a pass: the button stays disabled
  // until the check has actually run, which is the point of the ticket.
  return { canTrain: report != null && failures.length === 0, failures, warnings, passes }
}

/** True when PyTorch can really train on a GPU here (CUDA or Apple MPS). */
export function isGpuAvailable(device: EngineDeviceInfo | null | undefined): boolean {
  if (!device) return false
  if (device.gpu_available != null) return Boolean(device.gpu_available)
  // Older engine builds only reported the ONNX Runtime provider. Fall back to
  // it rather than claiming a GPU exists — CPU is the safe assumption.
  return Boolean(device.cuda_available || device.mps_available)
}

/**
 * The device mode the UI should preselect: GPU when one is genuinely usable,
 * CPU otherwise. The CPU option is always selectable; the GPU option is
 * disabled when unavailable, which is what stops the reported "training is
 * still clickable while it says No GPU detected" confusion.
 */
export function resolveDeviceMode(device: EngineDeviceInfo | null | undefined): DeviceMode {
  return isGpuAvailable(device) ? 'gpu' : 'cpu'
}

/**
 * The torch device string to send to the engine for a chosen mode.
 * Selecting GPU on a machine without one still resolves to "cpu" — the engine
 * would fall back anyway, and saying so up front keeps the progress display
 * honest about what is actually running.
 */
export function engineDeviceFor(mode: DeviceMode, device: EngineDeviceInfo | null | undefined): string {
  if (mode === 'cpu' || !isGpuAvailable(device)) return 'cpu'
  return device?.training_device === 'mps' ? 'mps' : 'cuda'
}

/** Short label for the device badge, e.g. "GPU · NVIDIA RTX 4090" or "CPU". */
export function describeDevice(device: EngineDeviceInfo | null | undefined): string {
  if (!isGpuAvailable(device)) return 'CPU'
  const name = device?.gpu_name
  return name ? `GPU · ${name}` : 'GPU'
}

/**
 * Whether starting a run needs the "this will be 5-10x slower" confirmation:
 * only when the run will actually happen on the CPU.
 */
export function needsCpuWarning(mode: DeviceMode, device: EngineDeviceInfo | null | undefined): boolean {
  return engineDeviceFor(mode, device) === 'cpu'
}

/**
 * Remaining seconds for a run, from percent complete and elapsed time.
 *
 * Ticket T2 asks for an estimate that tracks the *current* speed, so this is
 * deliberately derived from the run's own elapsed/percent rather than from
 * the static per-mode estimates on the mode cards — a CPU run and a GPU run
 * converge on their real ETA within the first couple of percent.
 */
export function estimateRemainingSec(percent: number | undefined, elapsedSec: number | undefined): number | null {
  if (percent == null || elapsedSec == null) return null
  if (!Number.isFinite(percent) || !Number.isFinite(elapsedSec)) return null
  // Below 1% the ratio is dominated by start-up cost and produces wild
  // numbers ("ETA 14 hours" two seconds in), so withhold it until it settles.
  if (percent <= 1 || percent >= 100 || elapsedSec <= 0) return null
  return (elapsedSec / percent) * (100 - percent)
}

/**
 * i18n key carrying repair instructions for a failed check, or null when the
 * engine's own `fix` string (e.g. the exact pip command) is the better answer.
 */
export function fixHintKey(check: EnvCheck): string | null {
  if (check.id.startsWith('package.')) return 'envCheck.fix.package'
  switch (check.id) {
    case 'python':   return 'envCheck.fix.python'
    case 'disk':     return 'envCheck.fix.disk'
    case 'writable': return 'envCheck.fix.writable'
    case 'engine':   return 'envCheck.fix.engine'
    case 'memory':   return 'envCheck.fix.memory'
    default:         return null
  }
}

/** i18n key for a check's display name, falling back to the engine's English label. */
export function checkLabelKey(check: EnvCheck): string {
  return check.id.startsWith('package.') ? 'envCheck.label.package' : `envCheck.label.${check.id}`
}
