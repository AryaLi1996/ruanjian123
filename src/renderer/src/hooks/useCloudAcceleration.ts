/**
 * Cloud acceleration hook.
 *
 * Simulates the full lifecycle:
 *   encrypt material → chunked upload → trigger task → poll status →
 *   download encrypted model → decrypt → ready
 *
 * The cloud endpoint is mocked with timed delays so the UI can be
 * verified without a live serverless backend.  Swap the mock* functions
 * for real fetch() calls when the Alibaba FC / AWS Lambda endpoints exist.
 */
import { useState, useRef, useCallback } from 'react'
import {
  generateAESKey, encryptBuffer, decryptBuffer, exportKey,
  type EncryptedPayload,
} from '../utils/crypto'

// ── Cost table (USD) ─────────────────────────────────────────────────────────
const COST_TABLE = {
  standard:     { gpuHours: 0.08, ratePerHour: 0.90  },  // ~5 min GPU
  professional: { gpuHours: 1.50, ratePerHour: 2.40  },  // ~90 min GPU
}

export interface CostEstimate {
  gpuHours:     number
  ratePerHour:  number
  totalUSD:     number
  provider:     string
}

export function estimateCost(mode: 'standard' | 'professional'): CostEstimate {
  const { gpuHours, ratePerHour } = COST_TABLE[mode]
  return {
    gpuHours,
    ratePerHour,
    totalUSD: Math.round(gpuHours * ratePerHour * 100) / 100,
    provider: 'Alibaba Cloud FC / AWS Lambda',
  }
}

// ── State types ───────────────────────────────────────────────────────────────
export type CloudPhase =
  | 'idle' | 'encrypting' | 'uploading' | 'queued'
  | 'preprocessing' | 'training' | 'exporting'
  | 'downloading' | 'decrypting' | 'done' | 'error'

export interface CloudState {
  phase:       CloudPhase
  uploadPct:   number   // 0-100 during upload
  taskPct:     number   // 0-100 during cloud task
  elapsedSec:  number
  taskId:      string | null
  resultPath:  string | null
  error:       string | null
}

const INITIAL: CloudState = {
  phase: 'idle', uploadPct: 0, taskPct: 0,
  elapsedSec: 0, taskId: null, resultPath: null, error: null,
}

// ── Mock cloud API ────────────────────────────────────────────────────────────
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function mockUploadChunk(_chunk: ArrayBuffer, _index: number): Promise<void> {
  await delay(180 + Math.random() * 120)   // simulate 180–300 ms per chunk
}

async function mockTriggerTask(_mode: string): Promise<string> {
  await delay(600)
  return `task_${Date.now().toString(36).toUpperCase()}`
}

interface PollResult { phase: CloudPhase; taskPct: number; done: boolean }
function mockPollStatus(taskId: string, elapsedSec: number, mode: string): PollResult {
  // Standard: ~20s total  |  Professional: ~30s total
  const totalSec = mode === 'professional' ? 30 : 20
  const pct      = Math.min((elapsedSec / totalSec) * 100, 100)
  if (pct < 10)  return { phase: 'preprocessing', taskPct: pct * 1.5,          done: false }
  if (pct < 90)  return { phase: 'training',      taskPct: 15 + (pct - 10) * 0.938, done: false }
  if (pct < 100) return { phase: 'exporting',     taskPct: 90 + (pct - 90) * 10,    done: false }
  return { phase: 'exporting', taskPct: 100, done: true }
}

async function mockDownloadEncryptedModel(_taskId: string): Promise<ArrayBuffer> {
  await delay(1200)
  // Return a tiny fake payload — real impl fetches the encrypted ONNX from cloud storage
  const mock = new Uint8Array(256)
  crypto.getRandomValues(mock)
  return mock.buffer
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useCloudAcceleration() {
  const [state, setS] = useState<CloudState>(INITIAL)
  const abortRef      = useRef(false)
  const startRef      = useRef(0)
  const timerRef      = useRef<number | null>(null)

  function patch(delta: Partial<CloudState>) {
    setS((prev) => ({ ...prev, ...delta }))
  }

  function checkAbort() {
    if (abortRef.current) throw new Error('cancelled')
  }

  const start = useCallback(async (
    files:     File[],
    mode:      'standard' | 'professional',
    epochs:    number,
    localModelPath: string,            // fallback path if cloud unavailable
  ): Promise<void> => {
    abortRef.current = false
    startRef.current = Date.now()

    // Elapsed-time ticker
    if (timerRef.current != null) clearInterval(timerRef.current)
    timerRef.current = window.setInterval(() => {
      patch({ elapsedSec: (Date.now() - startRef.current) / 1000 })
    }, 500)

    try {
      const totalBytes = files.reduce((s, f) => s + f.size, 0) || 1024 * 512  // ≥512 KB for demo

      // ── 1. Encrypt ────────────────────────────────────────
      patch({ phase: 'encrypting', uploadPct: 0, taskPct: 0, error: null })
      checkAbort()
      const key = await generateAESKey()

      // Encrypt a representative sample (first file or stub) for the demo
      const sampleBuf = files.length
        ? await files[0].arrayBuffer()
        : new Uint8Array(1024).buffer
      const { ciphertext, iv }: EncryptedPayload = await encryptBuffer(sampleBuf, key)
      const keyRaw = await exportKey(key)
      await delay(300)
      checkAbort()

      // ── 2. Upload in chunks ───────────────────────────────
      patch({ phase: 'uploading' })
      const CHUNK = 512 * 1024   // 512 KB
      const totalEncryptedSize = totalBytes * 1.02
      const numChunks = Math.max(1, Math.ceil(totalEncryptedSize / CHUNK))

      for (let i = 0; i < numChunks; i++) {
        checkAbort()
        const start_ = i * CHUNK
        const slice  = ciphertext.slice(start_, Math.min(start_ + CHUNK, ciphertext.byteLength))
        await mockUploadChunk(slice, i)
        patch({ uploadPct: Math.round(((i + 1) / numChunks) * 100) })
      }

      // ── 3. Trigger cloud task ─────────────────────────────
      checkAbort()
      patch({ phase: 'queued', uploadPct: 100 })
      const taskId = await mockTriggerTask(mode)
      patch({ taskId })
      checkAbort()

      // ── 4. Poll task status ───────────────────────────────
      let done = false
      while (!done) {
        checkAbort()
        await delay(1000)
        const elapsed = (Date.now() - startRef.current) / 1000
        const poll    = mockPollStatus(taskId, elapsed, mode)
        patch({ phase: poll.phase, taskPct: Math.round(poll.taskPct) })
        done = poll.done
      }

      // ── 5. Download encrypted model ───────────────────────
      checkAbort()
      patch({ phase: 'downloading', taskPct: 100 })
      const encModel = await mockDownloadEncryptedModel(taskId)

      // ── 6. Decrypt model ──────────────────────────────────
      checkAbort()
      patch({ phase: 'decrypting' })
      // Real impl: await decryptBuffer({ ciphertext: encModel, iv }, key) → save ONNX
      // Mock: we reuse the local stub model path as the "result"
      await delay(300)

      // ── 7. Done ───────────────────────────────────────────
      patch({ phase: 'done', resultPath: localModelPath })

    } catch (err) {
      if ((err as Error).message !== 'cancelled') {
        patch({ phase: 'error', error: String(err) })
      } else {
        patch({ phase: 'idle' })
      }
    } finally {
      if (timerRef.current != null) { clearInterval(timerRef.current); timerRef.current = null }
    }
  }, [])

  const cancel = useCallback(() => {
    abortRef.current = true
    if (timerRef.current != null) { clearInterval(timerRef.current); timerRef.current = null }
    patch({ phase: 'idle', uploadPct: 0, taskPct: 0, elapsedSec: 0, taskId: null, error: null })
  }, [])

  const reset = useCallback(() => {
    abortRef.current = true
    setS(INITIAL)
  }, [])

  return { state, start, cancel, reset, estimateCost }
}
