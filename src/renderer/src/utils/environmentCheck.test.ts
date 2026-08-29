import { describe, expect, it } from 'vitest'
import {
  describeDevice, engineDeviceFor, estimateRemainingSec, fixHintKey,
  isGpuAvailable, needsCpuWarning, resolveDeviceMode, summarizeReport,
} from './environmentCheck'
import type { EnvCheck, EnvironmentReport } from '../global'

const check = (id: string, status: EnvCheck['status']): EnvCheck =>
  ({ id, status, label: id, detail: '', fix: null })

const report = (checks: EnvCheck[]): EnvironmentReport => ({
  passed: checks.every((c) => c.status !== 'fail'),
  checks,
  device: {},
  platform: 'test',
  python: '3.11.0',
  missing: [],
})

describe('summarizeReport() — Ticket T3 gating', () => {
  it('blocks training until a report has actually arrived', () => {
    expect(summarizeReport(null).canTrain).toBe(false)
  })

  it('allows training when nothing failed', () => {
    const s = summarizeReport(report([check('python', 'ok'), check('device', 'warn')]))
    expect(s.canTrain).toBe(true)
    expect(s.warnings.map((c) => c.id)).toEqual(['device'])
  })

  it('blocks training on any failed check, and lists it', () => {
    const s = summarizeReport(report([check('python', 'ok'), check('package.torch', 'fail')]))
    expect(s.canTrain).toBe(false)
    expect(s.failures.map((c) => c.id)).toEqual(['package.torch'])
  })

  it('treats a missing-GPU warning as non-blocking — CPU training still works', () => {
    expect(summarizeReport(report([check('device', 'warn')])).canTrain).toBe(true)
  })
})

describe('device detection — Ticket T2', () => {
  it('reports no GPU when torch sees neither CUDA nor MPS', () => {
    const device = { gpu_available: false, training_device: 'cpu' }
    expect(isGpuAvailable(device)).toBe(false)
    expect(resolveDeviceMode(device)).toBe('cpu')
    expect(describeDevice(device)).toBe('CPU')
  })

  it('reports a GPU by name when CUDA is usable', () => {
    const device = { gpu_available: true, training_device: 'cuda', gpu_name: 'NVIDIA RTX 4090' }
    expect(resolveDeviceMode(device)).toBe('gpu')
    expect(describeDevice(device)).toBe('GPU · NVIDIA RTX 4090')
    expect(engineDeviceFor('gpu', device)).toBe('cuda')
  })

  it('maps an Apple MPS machine to the mps torch device', () => {
    const device = { gpu_available: true, training_device: 'mps', gpu_name: 'Apple GPU (MPS)' }
    expect(engineDeviceFor('gpu', device)).toBe('mps')
  })

  it('falls back to CPU when GPU is forced but unavailable, and asks for confirmation', () => {
    const device = { gpu_available: false, training_device: 'cpu' }
    expect(engineDeviceFor('gpu', device)).toBe('cpu')
    expect(needsCpuWarning('gpu', device)).toBe(true)
  })

  it('warns for an explicit CPU choice even on a GPU machine', () => {
    const device = { gpu_available: true, training_device: 'cuda' }
    expect(needsCpuWarning('cpu', device)).toBe(true)
    expect(needsCpuWarning('gpu', device)).toBe(false)
  })

  it('assumes CPU when the engine reported nothing at all', () => {
    expect(isGpuAvailable(null)).toBe(false)
    expect(resolveDeviceMode(undefined)).toBe('cpu')
  })

  it('derives GPU availability from torch flags on older engine reports', () => {
    expect(isGpuAvailable({ cuda_available: true })).toBe(true)
    expect(isGpuAvailable({ ep: 'DirectML' })).toBe(false)
  })
})

describe('estimateRemainingSec() — live ETA', () => {
  it('scales the elapsed time by the remaining fraction', () => {
    expect(estimateRemainingSec(25, 60)).toBeCloseTo(180)
  })

  it('withholds an estimate below 1 %, where it would be nonsense', () => {
    expect(estimateRemainingSec(0.4, 30)).toBeNull()
  })

  it('withholds an estimate once complete, or with missing inputs', () => {
    expect(estimateRemainingSec(100, 60)).toBeNull()
    expect(estimateRemainingSec(undefined, 60)).toBeNull()
    expect(estimateRemainingSec(50, undefined)).toBeNull()
  })

  it('shrinks as a run progresses at constant speed', () => {
    expect(estimateRemainingSec(50, 100)).toBeLessThan(estimateRemainingSec(25, 50)!)
  })
})

describe('fixHintKey() — repair guidance', () => {
  it('maps every package check to the pip-install hint', () => {
    expect(fixHintKey(check('package.torch', 'fail'))).toBe('envCheck.fix.package')
  })

  it('maps known environment checks to their own hints', () => {
    expect(fixHintKey(check('disk', 'fail'))).toBe('envCheck.fix.disk')
    expect(fixHintKey(check('engine', 'fail'))).toBe('envCheck.fix.engine')
  })

  it('has no hint for a check it does not recognise', () => {
    expect(fixHintKey(check('something-new', 'fail'))).toBeNull()
  })
})
