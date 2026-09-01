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

  it('leaves anything else to the generic message, keeping the raw text', () => {
    const failure = classifyTrainingFailure('Python engine is missing from this installation')
    expect(failure.kind).toBe('unknown')
    expect(failure.messageKey).toBeNull()
    expect(failure.detail).toBe('Python engine is missing from this installation')
  })
})
