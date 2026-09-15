import { describe, expect, it } from 'vitest'
import { classifyTrainingFailure, STALL_TIMEOUT_MARKER } from './trainingError'

describe('classifyTrainingFailure', () => {
  it('recognises a stall timeout by its marker', () => {
    const failure = classifyTrainingFailure(
      `${STALL_TIMEOUT_MARKER}: Python engine produced no output for 300000 ms and was killed (likely hung)`
    )
    expect(failure.kind).toBe('timeout')
    expect(failure.messageKey).toBe('training.error.timeout')
  })

  it('still recognises a stall timeout from an older build with no marker', () => {
    expect(classifyTrainingFailure(
      'Python engine produced no output for 300000 ms and was killed (likely hung)'
    ).kind).toBe('timeout')
  })

  it('recognises out-of-memory failures, including a silent OOM kill', () => {
    for (const message of [
      'Python engine exited 1: RuntimeError: CUDA out of memory.',
      'MemoryError',
      'DefaultCPUAllocator: can\'t allocate memory: you tried to allocate 8589934592 bytes',
      'Python engine exited -9',
      'Python engine exited 137',
    ]) {
      expect(classifyTrainingFailure(message).kind, message).toBe('oom')
    }
  })

  it('recognises a DataLoader worker crash', () => {
    expect(classifyTrainingFailure(
      'Python engine exited 1: RuntimeError: DataLoader worker (pid 1984) exited unexpectedly'
    ).kind).toBe('dataLoader')
  })

  it('prefers the timeout reading when a stall message quotes a worker crash', () => {
    // The stall message now carries a stderr tail, so both signatures can
    // appear in one string; the timeout is what actually ended the run.
    expect(classifyTrainingFailure(
      `${STALL_TIMEOUT_MARKER}: ... Details: DataLoader worker (pid 12) exited unexpectedly`
    ).kind).toBe('timeout')
  })

  it('recognises the strict gate refusing material that is still noisy', () => {
    const raw = 'Training refused — 2 file(s) are still below 15 dB SNR after '
      + 'isolation: take01_lead_dry.wav, take02_lead_dry.wav. A model trained on '
      + 'these will reproduce the remaining noise. Re-record or remove them, or '
      + 'pass strict=false to train anyway.'
    const failure = classifyTrainingFailure(raw)
    expect(failure.kind).toBe('noisyMaterial')
    expect(failure.messageKey).toBe('training.error.noisyMaterial')
    // The offending file names are the actionable part, so they must survive
    // into the detail panel rather than being swallowed by the friendly text.
    expect(failure.detail).toContain('take01_lead_dry.wav')
  })

  it('does not mistake an ordinary isolation notice for the refusal', () => {
    expect(classifyTrainingFailure(
      'Isolated the lead vocal in 3 file(s) before training (SNR 4.1 → 19.8 dB)'
    ).kind).toBe('unknown')
  })

  it('leaves anything else to the generic message, keeping the raw text', () => {
    const failure = classifyTrainingFailure('Python engine is missing from this installation')
    expect(failure.kind).toBe('unknown')
    expect(failure.messageKey).toBeNull()
    expect(failure.detail).toBe('Python engine is missing from this installation')
  })
})
