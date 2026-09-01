/**
 * Ticket P3: turn an engine failure into something the user can act on.
 *
 * describeError() (errorMessage.ts) already unwraps Electron's IPC plumbing
 * down to the sentence the engine actually produced. That sentence is still
 * an English diagnostic aimed at a developer — "Python engine produced no
 * output for 300000 ms and was killed (likely hung)" tells a singer nothing
 * about the 10 minutes of material they just uploaded.
 *
 * classifyTrainingFailure() maps the three failures this pipeline actually
 * produces onto a localized explanation *and* its fix, keeping the raw text
 * as `detail` for the collapsible panel:
 *
 *  - stall timeout: no output for stallTimeoutMs. The engine only emits
 *    progress once per epoch (engine/trainer.py), and preprocessing runs
 *    before the first one, so a large upload on a CPU trips this while
 *    working perfectly well;
 *  - out of memory: the OS or PyTorch killed the run. A SIGKILL from the
 *    Linux/macOS OOM killer surfaces as exit code -9 or 137 with nothing on
 *    stderr, so the exit code is part of the signature;
 *  - DataLoader worker crash: a corrupt chunk, or not enough memory to fork.
 */
export const STALL_TIMEOUT_MARKER = 'ENGINE_STALL_TIMEOUT'

export type TrainingFailureKind = 'timeout' | 'oom' | 'dataLoader' | 'unknown'

export interface TrainingFailure {
  kind: TrainingFailureKind
  /** i18n key for the user-facing explanation, or null for `unknown`. */
  messageKey: string | null
  /** The engine's own words, for the "查看详细日志" panel. */
  detail: string
}

const OOM_PATTERNS = [
  /out of memory/i,
  /\bOOM\b/,
  /MemoryError/,
  /Cannot allocate memory/i,
  /DefaultCPUAllocator: can't allocate memory/i,
  // The OOM killer leaves no message — only the signal it killed with.
  /engine exited (?:-9|137)\b/i,
]

export function classifyTrainingFailure(message: string): TrainingFailure {
  const detail = message.trim()

  if (detail.includes(STALL_TIMEOUT_MARKER) || /produced no output for \d+ ms/i.test(detail)) {
    return { kind: 'timeout', messageKey: 'training.error.timeout', detail }
  }
  if (OOM_PATTERNS.some((p) => p.test(detail))) {
    return { kind: 'oom', messageKey: 'training.error.oom', detail }
  }
  if (/DataLoader worker/i.test(detail) || /worker \(pid \d+\) exited/i.test(detail)) {
    return { kind: 'dataLoader', messageKey: 'training.error.dataLoader', detail }
  }
  return { kind: 'unknown', messageKey: null, detail }
}
