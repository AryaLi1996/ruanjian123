import { describe, expect, it } from 'vitest'
import {
  countErrors, interpretProgress, interpretTrainingResult, severityOf,
} from './engineLog'

const line = (kind: 'json' | 'diagnostic' | 'heartbeat' | 'error', text: string) =>
  ({ kind, line: text })

describe('severityOf', () => {
  it('mutes heartbeats and keeps protocol/stage lines plain', () => {
    expect(severityOf(line('heartbeat', '[engine:heartbeat] alive'))).toBe('muted')
    expect(severityOf(line('json', '{"status":"training","epoch":3}'))).toBe('info')
    expect(severityOf(line('diagnostic', '[engine] [trainer] dataloader worker crash; retrying'))).toBe('info')
  })

  it('never reports an interstitial {"error": ...} as an error', () => {
    expect(severityOf(line('error', '{"error": "invalid JSON payload"}'))).toBe('warn')
    expect(severityOf(line('error', '{"status": "error", "message": "worker died"}'))).toBe('warn')
  })

  it('treats library warnings as ordinary output', () => {
    expect(severityOf(line('error', '/usr/lib/torch/nn.py:42: UserWarning: dropout p=0'))).toBe('info')
    expect(severityOf(line('error', '  warnings.warn("deprecated")'))).toBe('info')
    expect(severityOf(line('error', ' 37%|███▋      | 37/100 [00:12<00:20,  3.1it/s]'))).toBe('info')
    expect(severityOf(line('error', 'INFO: onnxruntime using CPUExecutionProvider'))).toBe('info')
  })

  it('still flags output that describes a real failure', () => {
    expect(severityOf(line('error', 'Traceback (most recent call last):'))).toBe('error')
    expect(severityOf(line('error', 'RuntimeError: CUDA error: out of memory'))).toBe('error')
    expect(severityOf(line('error', 'torch.cuda.OutOfMemoryError: CUDA out of memory'))).toBe('error')
  })

  it('leaves unrecognised stderr as a warning rather than an error', () => {
    expect(severityOf(line('error', 'libpng: iCCP known incorrect sRGB profile'))).toBe('warn')
  })

  it('counts only genuine errors for the panel badge', () => {
    const entries = [
      line('heartbeat', '[engine:heartbeat] alive'),
      line('error', '{"error": "no noise sample"}'),
      line('error', 'UserWarning: something'),
      line('error', 'Traceback (most recent call last):'),
    ]
    expect(countErrors(entries)).toBe(1)
  })
})

describe('interpretProgress', () => {
  it('accepts only real progress as progress', () => {
    expect(interpretProgress({ status: 'training', percent: 40 }).kind).toBe('progress')
    expect(interpretProgress({ status: 'done', percent: 100 }).kind).toBe('progress')
  })

  it('reads a declared failure, with its reason when there is one', () => {
    expect(interpretProgress({ status: 'failed', message: 'dataset unreadable' }))
      .toEqual({ kind: 'failed', message: 'dataset unreadable' })
    expect(interpretProgress({ status: 'error', error: 'no space left' }))
      .toEqual({ kind: 'failed', message: 'no space left' })
    expect(interpretProgress({ status: 'failed' }))
      .toEqual({ kind: 'failed', message: null })
  })

  it('passes notices through, and drops empty ones', () => {
    expect(interpretProgress({ type: 'notice', message: 'single-process loading' }))
      .toEqual({ kind: 'notice', message: 'single-process loading' })
    expect(interpretProgress({ type: 'notice', message: '  ' }).kind).toBe('ignored')
  })

  it('ignores an interstitial error object and anything unrecognised', () => {
    expect(interpretProgress({ error: 'invalid JSON payload' }).kind).toBe('ignored')
    expect(interpretProgress({ hello: 'world' }).kind).toBe('ignored')
    expect(interpretProgress('done').kind).toBe('ignored')
    expect(interpretProgress(null).kind).toBe('ignored')
    expect(interpretProgress([1, 2]).kind).toBe('ignored')
  })
})

describe('interpretTrainingResult', () => {
  it('accepts a real result', () => {
    const raw = { status: 'done', output_path: '/models/a.onnx', epochs: 10 }
    expect(interpretTrainingResult(raw)).toEqual({ ok: true, result: raw })
  })

  it('rejects a bare error object with its message', () => {
    expect(interpretTrainingResult({ error: 'data_dir is required' }))
      .toEqual({ ok: false, message: 'data_dir is required' })
    expect(interpretTrainingResult({ status: 'failed', message: 'worker died' }))
      .toEqual({ ok: false, message: 'worker died' })
  })

  it('rejects a result with no model path', () => {
    expect(interpretTrainingResult({ status: 'done', epochs: 10 }))
      .toEqual({ ok: false, message: null })
    expect(interpretTrainingResult(null)).toEqual({ ok: false, message: null })
  })
})
