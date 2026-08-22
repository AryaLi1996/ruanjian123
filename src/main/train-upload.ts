/**
 * Upload & Start Training — Ticket 20's cloud half. The renderer's
 * TrainingDatasetPanel packages a `.zip` (merged_train.wav + optional dry
 * vocal, built by the Python engine — see engine/train_dataset.py) and hands
 * its local path here.
 *
 *  - uploadTrainDataset(): multipart-uploads the zip to cloud storage
 *    (S3/OSS) and then calls `POST /api/train/start` with
 *    `{ task_id, file_url, config }`, matching the ticket's contract.
 *  - getTrainStatus(): a single status check for `task_id` — the renderer
 *    polls this on an interval, the same "renderer drives the interval,
 *    main does one round-trip per call" pattern SubscriptionView already
 *    uses for payment-order polling (see subscription-monitor.ts's
 *    getOrderStatus()).
 *
 * Proxied through main for the same CSP reason as library.ts's
 * searchLibrary()/fetchLibraryAudio(): the renderer's CSP is `default-src
 * 'self'`, so it cannot fetch() a third-party training-cluster host itself.
 *
 * No real training cluster ships with this template (same situation as
 * library.ts's catalog backend and license-config.ts's payment provider —
 * see those files' header comments). Until TRAIN_API_URL is set, both
 * functions fall back to an in-memory mock that progresses a task from
 * "uploading" through "training" to "completed" over a fixed, deterministic
 * timeline, so the merge → package → upload → train → progress flow is
 * fully exercisable offline end to end.
 */
import { promises as fs } from 'fs'
import { basename } from 'path'

// Set TRAIN_API_URL to point at a real deployment of the ticket's
// `POST /api/train/start` (+ upload + status) endpoints. Nothing else in
// this file (or the IPC handlers / renderer code that calls it) needs to
// change to switch modes.
const TRAIN_API_URL = process.env['TRAIN_API_URL'] ?? ''

export interface TrainStartConfig {
  mode?:                 string
  pitchShiftSemitones?:  number
  highPitchProtection?:  boolean
  includeDryVocal?:      boolean
  [key: string]:         unknown
}

export interface TrainStartResult {
  task_id:  string
  file_url: string
  status:   string
}

export type TrainJobStatus = 'uploading' | 'queued' | 'training' | 'completed' | 'failed'

export interface TrainStatusResult {
  task_id:    string
  status:     TrainJobStatus
  percent:    number
  message?:   string
  model_url?: string
  error?:     string
}

// ── Upload + start ──────────────────────────────────────────────────────────

export async function uploadTrainDataset(
  zipPath: string, taskId: string, config: TrainStartConfig,
): Promise<TrainStartResult> {
  return TRAIN_API_URL
    ? uploadAndStartRemote(zipPath, taskId, config)
    : uploadAndStartMock(zipPath, taskId, config)
}

async function uploadAndStartRemote(
  zipPath: string, taskId: string, config: TrainStartConfig,
): Promise<TrainStartResult> {
  const base = TRAIN_API_URL.replace(/\/+$/, '')

  // Multipart upload to cloud storage (S3/OSS) — the whole file in one
  // request. Training datasets built by this flow are a few minutes of
  // audio at most, so reading the zip into memory here is simpler than
  // streaming and stays well within reason.
  const buf  = await fs.readFile(zipPath)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'application/zip' }), basename(zipPath))
  form.append('task_id', taskId)

  const uploadController = new AbortController()
  const uploadTimeout = setTimeout(() => uploadController.abort(), 5 * 60_000)
  let fileUrl: string
  try {
    const res = await fetch(`${base}/api/upload`, {
      method: 'POST', body: form, signal: uploadController.signal,
    })
    if (!res.ok) throw new Error(`upload responded ${res.status}`)
    const data = await res.json() as Record<string, unknown>
    fileUrl = String(data['file_url'] ?? data['url'] ?? '')
    if (!fileUrl) throw new Error('upload response missing file_url')
  } finally {
    clearTimeout(uploadTimeout)
  }

  const startController = new AbortController()
  const startTimeout = setTimeout(() => startController.abort(), 30_000)
  try {
    const res = await fetch(`${base}/api/train/start`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ task_id: taskId, file_url: fileUrl, config }),
      signal:  startController.signal,
    })
    if (!res.ok) throw new Error(`train/start responded ${res.status}`)
    const data = await res.json() as Record<string, unknown>
    return { task_id: taskId, file_url: fileUrl, status: String(data['status'] ?? 'queued') }
  } finally {
    clearTimeout(startTimeout)
  }
}

// ── Status polling ───────────────────────────────────────────────────────────

export async function getTrainStatus(taskId: string): Promise<TrainStatusResult> {
  return TRAIN_API_URL ? getTrainStatusRemote(taskId) : mockTrainStatus(taskId)
}

async function getTrainStatusRemote(taskId: string): Promise<TrainStatusResult> {
  const base = TRAIN_API_URL.replace(/\/+$/, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(
      `${base}/api/train/status?task_id=${encodeURIComponent(taskId)}`,
      { signal: controller.signal },
    )
    if (!res.ok) throw new Error(`train/status responded ${res.status}`)
    const data = await res.json() as Record<string, unknown>
    return {
      task_id:   taskId,
      status:    (data['status'] as TrainJobStatus | undefined) ?? 'training',
      percent:   Number(data['percent'] ?? 0),
      message:   typeof data['message'] === 'string' ? data['message'] as string : undefined,
      model_url: typeof data['model_url'] === 'string' ? data['model_url'] as string : undefined,
      error:     typeof data['error'] === 'string' ? data['error'] as string : undefined,
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ── Offline mock ─────────────────────────────────────────────────────────────
// Deterministic (time-based rather than a running setInterval) so repeated
// polls agree with each other without main needing to keep a live timer per
// task — the renderer's own polling interval is what drives progress, same
// as the getOrderStatus() mock/remote split it mirrors.

const MOCK_UPLOAD_DURATION_MS   = 2_000
const MOCK_TRAINING_DURATION_MS = 10_000

interface MockJob { startedAt: number }
const mockJobs = new Map<string, MockJob>()

async function uploadAndStartMock(
  zipPath: string, taskId: string, _config: TrainStartConfig,
): Promise<TrainStartResult> {
  // Confirm the zip is actually there (mirrors the real path failing loudly
  // on a bad file) before "starting" the mock job.
  await fs.stat(zipPath)
  mockJobs.set(taskId, { startedAt: Date.now() })
  return { task_id: taskId, file_url: `mock://train-upload/${basename(zipPath)}`, status: 'uploading' }
}

/** Pure so it's unit-testable without timers — see train-upload.test.ts. */
export function computeMockStatus(taskId: string, startedAt: number, now: number): TrainStatusResult {
  const elapsed = now - startedAt

  if (elapsed < MOCK_UPLOAD_DURATION_MS) {
    const percent = Math.round((elapsed / MOCK_UPLOAD_DURATION_MS) * 100)
    return { task_id: taskId, status: 'uploading', percent, message: `正在上传训练数据集… ${percent}%` }
  }

  const trainingElapsed = elapsed - MOCK_UPLOAD_DURATION_MS
  if (trainingElapsed < MOCK_TRAINING_DURATION_MS) {
    const percent = Math.round((trainingElapsed / MOCK_TRAINING_DURATION_MS) * 100)
    return { task_id: taskId, status: 'training', percent, message: `云端训练中… ${percent}%` }
  }

  return {
    task_id:   taskId,
    status:    'completed',
    percent:   100,
    message:   '训练完成',
    model_url: `mock://train-cluster/model-${taskId}.onnx`,
  }
}

function mockTrainStatus(taskId: string): TrainStatusResult {
  const job = mockJobs.get(taskId)
  if (!job) return { task_id: taskId, status: 'failed', percent: 0, error: `unknown task_id: ${taskId}` }
  return computeMockStatus(taskId, job.startedAt, Date.now())
}
