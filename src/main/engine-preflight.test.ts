import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STARTUP_TIMEOUT_MS, MAX_STARTUP_TIMEOUT_MS, MIN_STARTUP_TIMEOUT_MS,
  classifyEngineLine, describeSpawnFailure, describeStartupTimeout,
  resolveCommandOnPath, resolveStartupTimeoutMs, shouldRetryStartup, stripDiagnostics,
} from './engine-preflight'

describe('resolveStartupTimeoutMs() — Ticket T1', () => {
  it('defaults to 60s, well above the 15s that was timing out', () => {
    expect(DEFAULT_STARTUP_TIMEOUT_MS).toBe(60_000)
    expect(resolveStartupTimeoutMs(undefined)).toBe(DEFAULT_STARTUP_TIMEOUT_MS)
    expect(resolveStartupTimeoutMs(null)).toBe(DEFAULT_STARTUP_TIMEOUT_MS)
  })

  it('accepts a user-supplied value, including as a string from an env var', () => {
    expect(resolveStartupTimeoutMs(90_000)).toBe(90_000)
    expect(resolveStartupTimeoutMs('90000')).toBe(90_000)
  })

  it('clamps absurd values instead of rejecting them', () => {
    expect(resolveStartupTimeoutMs(10)).toBe(MIN_STARTUP_TIMEOUT_MS)
    expect(resolveStartupTimeoutMs(60 * 60_000)).toBe(MAX_STARTUP_TIMEOUT_MS)
  })

  it('falls back to the default for unparseable input', () => {
    expect(resolveStartupTimeoutMs('soon')).toBe(DEFAULT_STARTUP_TIMEOUT_MS)
    expect(resolveStartupTimeoutMs(-1)).toBe(DEFAULT_STARTUP_TIMEOUT_MS)
  })
})

describe('classifyEngineLine() / stripDiagnostics()', () => {
  it('separates heartbeats from stage logs and real errors', () => {
    expect(classifyEngineLine('[engine:heartbeat] running train_model (5s)')).toBe('heartbeat')
    expect(classifyEngineLine('[engine] dispatching train_model')).toBe('diagnostic')
    expect(classifyEngineLine('Traceback (most recent call last):')).toBe('error')
  })

  it('keeps only the real failure output in an error message', () => {
    const stderr = [
      '[engine] engine started (pid 42, python 3.11.9)',
      '[engine:heartbeat] running train_model (5s)',
      'ModuleNotFoundError: No module named \'torch\'',
      '',
    ].join('\n')
    expect(stripDiagnostics(stderr)).toBe("ModuleNotFoundError: No module named 'torch'")
  })

  it('returns an empty string when the engine only produced diagnostics', () => {
    expect(stripDiagnostics('[engine] engine started\n[engine:heartbeat] starting (5s)\n')).toBe('')
  })
})

describe('shouldRetryStartup()', () => {
  it('retries the first start-up timeout exactly once', () => {
    expect(shouldRetryStartup(0)).toBe(true)
    expect(shouldRetryStartup(1)).toBe(false)
  })
})

describe('describeSpawnFailure() — actionable spawn errors', () => {
  const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

  it('explains a missing interpreter rather than surfacing ENOENT', () => {
    const msg = describeSpawnFailure(err('ENOENT'), { platform: 'darwin', executable: 'python3' })
    expect(msg).toContain('python3')
    expect(msg).toContain('was not found')
    expect(msg).not.toContain('ENOENT')
  })

  it('points at antivirus for a permission error on Windows', () => {
    const msg = describeSpawnFailure(err('EPERM'), { platform: 'win32', executable: 'engine.exe' })
    expect(msg).toContain('Windows Defender')
    expect(msg).toContain('exclusions')
  })

  it('suggests chmod, not antivirus, for the same error on macOS', () => {
    const msg = describeSpawnFailure(err('EACCES'), { platform: 'darwin', executable: '/opt/engine' })
    expect(msg).toContain('chmod')
    expect(msg).not.toContain('Defender')
  })

  it('still reports an unrecognised error with its own message', () => {
    const msg = describeSpawnFailure(err('EIO'), { platform: 'linux', executable: 'engine' })
    expect(msg).toContain('EIO')
  })
})

describe('describeStartupTimeout()', () => {
  it('announces the automatic retry instead of blaming antivirus first', () => {
    const msg = describeStartupTimeout(60_000, 'win32', true)
    expect(msg).toContain('60 s')
    expect(msg).toContain('Retrying once')
    expect(msg).not.toContain('exclusions')
  })

  it('names the likely Windows culprit once the retry is spent', () => {
    expect(describeStartupTimeout(60_000, 'win32', false)).toContain('Windows Defender')
  })

  it('quotes the last engine output so the user can see where it stalled', () => {
    const msg = describeStartupTimeout(60_000, 'linux', false, ['[engine] engine started', '[engine] dispatching train_model'])
    expect(msg).toContain('dispatching train_model')
  })

  it('says so explicitly when the engine printed nothing at all', () => {
    expect(describeStartupTimeout(60_000, 'linux', false, [])).toContain('no output at all')
  })
})

describe('resolveCommandOnPath() — Ticket T1 pre-flight', () => {
  it('finds a bare command on a POSIX PATH', () => {
    const found = resolveCommandOnPath('python3', {
      pathEnv: '/usr/local/bin:/usr/bin',
      platform: 'linux',
      exists: (c) => c === '/usr/bin/python3',
    })
    expect(found).toBe('/usr/bin/python3')
  })

  it('tries PATHEXT extensions on Windows', () => {
    const found = resolveCommandOnPath('python', {
      pathEnv: 'C:\\Python311',
      platform: 'win32',
      pathExt: '.COM;.EXE',
      exists: (c) => c === 'C:\\Python311\\python.EXE',
    })
    expect(found).toBe('C:\\Python311\\python.EXE')
  })

  it('returns null when nothing on PATH matches', () => {
    expect(resolveCommandOnPath('python3', {
      pathEnv: '/usr/bin', platform: 'linux', exists: () => false,
    })).toBeNull()
  })

  it('uses an explicit path as-is instead of searching PATH', () => {
    const exists = (c: string): boolean => c === '/opt/engine/ruanjian-engine'
    expect(resolveCommandOnPath('/opt/engine/ruanjian-engine', {
      pathEnv: '/usr/bin', platform: 'linux', exists,
    })).toBe('/opt/engine/ruanjian-engine')
    expect(resolveCommandOnPath('/opt/missing', {
      pathEnv: '/usr/bin', platform: 'linux', exists,
    })).toBeNull()
  })

  it('tolerates an unset PATH', () => {
    expect(resolveCommandOnPath('python3', {
      pathEnv: undefined, platform: 'linux', exists: () => true,
    })).toBeNull()
  })
})
