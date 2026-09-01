/**
 * Ticket T1: decide how loud each line of engine output is allowed to be.
 *
 * The bridge (src/main/python-bridge.ts) classifies stderr by one rule only —
 * anything without the `[engine]` tag is `error` — because that classification
 * exists to drive *timeouts*, not presentation. Feeding it straight into the
 * UI is what covered a perfectly healthy run in red: every `import torch`
 * UserWarning, every ONNX Runtime notice, and every `{"error": ...}` line the
 * engine prints while it recovers from something became an "error" in the log
 * panel and pushed the panel's red error count up, so a user watching a run
 * finish successfully was told it had failed a dozen times over.
 *
 * The rules below draw the line where the user's mental model does: a run has
 * failed when the run says it failed (`{"status":"failed"}`, a rejected call),
 * not when a library printed something on stderr. Everything else is still
 * shown — verbatim, in the collapsed developer panel — just not in red.
 */

import type { EngineLogEntry } from '../global'

/**
 * How prominently one engine log line is shown.
 *
 *  * `muted` — heartbeats: pure liveness, no information.
 *  * `info`  — normal output: JSON protocol, `[engine]` stage lines, library
 *              chatter that is expected during a healthy run.
 *  * `warn`  — something worth reading but not a failure, including the
 *              interstitial `{"error": ...}` objects this ticket is about.
 *  * `error` — output that genuinely describes a failure (a traceback, a
 *              fatal exception line).
 */
export type LogSeverity = 'muted' | 'info' | 'warn' | 'error'

/**
 * Library output that is normal on a healthy run. These are matched against
 * stderr lines the bridge could only label `error`, since it has no way to
 * tell a warning from a crash.
 */
const BENIGN_STDERR = [
  /\b(?:User|Future|Deprecation|Runtime|Resource|Import)Warning\b/,
  /\bwarnings\.warn\(/,
  /^\s*(?:INFO|DEBUG|NOTE)\b/i,
  // tqdm-style progress bars: "  37%|███▋      | 37/100 [00:12<00:20,  3.1it/s]"
  /\d+%\|/,
  /\b\d+(?:\.\d+)?it\/s\b/,
]

/** Output that really is describing a failure. */
const FATAL_STDERR = [
  /^Traceback \(most recent call last\)/,
  /^\s*[A-Za-z_.]*(?:Error|Exception)\b.*:/,
  /\bFATAL\b/i,
  /\bCUDA out of memory\b/i,
]

/** Parse a line as a JSON object, or return null for anything else. */
function asJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Presentation severity for one engine log entry.
 *
 * Unrecognised stderr defaults to `warn`, not `error`: the engine writes a
 * great deal to stderr that has nothing to do with success or failure, and
 * being wrong in the quiet direction costs a user nothing — the line is still
 * there to read — while being wrong in the loud direction is exactly the
 * false alarm this ticket exists to remove.
 */
export function severityOf(entry: Pick<EngineLogEntry, 'kind' | 'line'>): LogSeverity {
  if (entry.kind === 'heartbeat') return 'muted'
  if (entry.kind === 'json' || entry.kind === 'diagnostic') return 'info'

  const line = entry.line.trim()
  if (!line) return 'info'

  // A structured `{"error": ...}` is the engine reporting a problem through
  // its protocol. Whether it ends the run is decided by the run's own result,
  // never by the presence of this line — engine handlers return one for
  // recoverable conditions too (a file it skipped, a probe that came back
  // empty), and those used to read as a failed training run.
  const json = asJsonObject(line)
  if (json) return 'error' in json || json.status === 'error' || json.status === 'failed' ? 'warn' : 'info'

  if (BENIGN_STDERR.some((re) => re.test(line))) return 'info'
  if (FATAL_STDERR.some((re) => re.test(line)))  return 'error'
  return 'warn'
}

/** How many entries the log panel should report as real errors. */
export function countErrors(entries: Array<Pick<EngineLogEntry, 'kind' | 'line'>>): number {
  return entries.reduce((n, entry) => (severityOf(entry) === 'error' ? n + 1 : n), 0)
}

// ── Progress stream ────────────────────────────────────────────────────────

/**
 * One message from the `engine:progress` channel, interpreted.
 *
 *  * `progress` — a real progress update; the only thing that may move the bar.
 *  * `notice`   — a non-fatal mid-run notice, shown as its own banner.
 *  * `failed`   — the run declaring itself failed. The only terminal failure
 *                 the stream itself can report.
 *  * `ignored`  — anything else, including the interstitial `{"error": ...}`
 *                 objects. It has already been captured verbatim in the
 *                 developer log panel, so the training console drops it
 *                 rather than showing the user a red-looking JSON blob.
 */
export type ProgressEvent =
  | { kind: 'progress'; data: { status: 'training' | 'done' } & Record<string, unknown> }
  | { kind: 'notice';   message: string }
  | { kind: 'failed';   message: string | null }
  | { kind: 'ignored' }

function textField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function interpretProgress(raw: unknown): ProgressEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'ignored' }
  const data = raw as Record<string, unknown>

  if (data.status === 'training' || data.status === 'done') {
    return { kind: 'progress', data: data as { status: 'training' | 'done' } & Record<string, unknown> }
  }
  if (data.status === 'failed' || data.status === 'error') {
    return { kind: 'failed', message: textField(data, 'message') ?? textField(data, 'error') }
  }
  if (data.type === 'notice') {
    const message = textField(data, 'message')
    return message ? { kind: 'notice', message } : { kind: 'ignored' }
  }
  return { kind: 'ignored' }
}

/**
 * A finished `train_model` call, checked before it is treated as a model.
 *
 * The bridge resolves a streaming run with the last JSON object the engine
 * printed, which is normally the final stats — but is a bare `{"error": ...}`
 * when a handler bailed out without raising. That used to flow on as if it
 * were a model: an undefined output_path handed to the demo synthesiser, a
 * card added to the library pointing at nothing, and no error anywhere in the
 * UI. Now it is what it is — a failed run with a reason.
 */
export type TrainingOutcome<T> =
  | { ok: true;  result: T }
  | { ok: false; message: string | null }

export function interpretTrainingResult<T extends { output_path?: unknown }>(
  raw: unknown,
): TrainingOutcome<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: null }
  }
  const data = raw as Record<string, unknown>
  if (data.status === 'failed' || data.status === 'error' || 'error' in data) {
    return { ok: false, message: textField(data, 'message') ?? textField(data, 'error') }
  }
  if (typeof data.output_path !== 'string' || !data.output_path) {
    return { ok: false, message: null }
  }
  return { ok: true, result: data as T }
}
