import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { app }   from 'electron'
import log from 'electron-log'

interface EngineTarget {
  /** Executable to spawn — an absolute path to the bundled engine (or system Python in dev). */
  executable:  string
  /** Argv entries to place before the JSON payload (e.g. the script path). Empty for the PyInstaller bundle, which embeds main.py. */
  scriptArgs:  string[]
}

// Resolved once per process and reused — process.resourcesPath and __dirname
// can't change mid-run, so there's no reason to re-stat the filesystem on
// every single engine call.
let cachedTarget: EngineTarget | null = null

/**
 * Resolve how to invoke the Python engine, or throw a clear, actionable
 * error if it can't be found.
 *
 * Ticket 39: production builds must resolve the bundled PyInstaller
 * executable and MUST NOT silently fall back to a bare `python`/`python3`
 * on PATH. On a clean Windows machine with no Python installed, a bare
 * `python` usually resolves to the built-in "App execution alias" stub at
 * %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe — a real .exe, so
 * child_process.spawn launches it successfully, but run non-interactively
 * (as spawn does) it exits immediately with code 9009 instead of the
 * ENOENT you'd get from a genuinely missing command. That's indistinguishable
 * from cmd.exe's own "not recognized" 9009 and gives no indication that the
 * *actual* problem is the bundled engine not being where the app expected
 * it — which is exactly the failure this ticket is about. So: resolve the
 * bundle or fail loudly, with the paths that were checked, before ever
 * spawning anything.
 */
function resolveEngine(): EngineTarget {
  if (cachedTarget) return cachedTarget

  if (app.isPackaged) {
    // 1. PyInstaller standalone bundle (created by scripts/package-engine.sh).
    //    This is the only engine target real production builds ship today —
    //    see win/mac/linux.extraResources in electron-builder.js.
    const bundleDir = join(process.resourcesPath, 'engine-dist', 'ruanjian-engine')
    const bundleExe = join(bundleDir,
      process.platform === 'win32' ? 'ruanjian-engine.exe' : 'ruanjian-engine')
    if (existsSync(bundleExe)) {
      log.info(`[python-bridge] using bundled engine executable: ${bundleExe}`)
      cachedTarget = { executable: bundleExe, scriptArgs: [] }
      return cachedTarget
    }

    // 2. Embedded portable Python distribution + script, for a future
    //    packaging mode that ships a raw interpreter instead of a
    //    PyInstaller bundle. Not produced by scripts/package-engine.sh
    //    today, but resolved correctly if it ever is.
    const portablePy = join(process.resourcesPath, 'python',
      process.platform === 'win32' ? 'python.exe' : join('bin', 'python3'))
    const engineScript = join(process.resourcesPath, 'engine', 'main.py')
    if (existsSync(portablePy) && existsSync(engineScript)) {
      log.info(`[python-bridge] using embedded Python: ${portablePy} ${engineScript}`)
      cachedTarget = { executable: portablePy, scriptArgs: [engineScript] }
      return cachedTarget
    }

    // Nothing usable found — do NOT fall back to system Python here. On an
    // end-user machine that's either absent (ENOENT) or, worse on Windows,
    // the misleading 9009 described above. Fail fast with a message that
    // actually says what's wrong.
    const checked = [bundleExe, portablePy]
    log.error(`[python-bridge] Python engine not found. Checked: ${checked.join('  |  ')}`)
    throw new Error(
      'Python engine is missing from this installation (expected at ' +
      `"${bundleExe}"). Please reinstall the application. ` +
      `[checked: ${checked.join(' ; ')}]`,
    )
  }

  // Development: engine/main.py run with the system interpreter. Windows
  // Python installs (python.org, the Microsoft Store package,
  // actions/setup-python) register the command as `python`; `python3` is
  // the macOS/Linux convention.
  const devScript = join(__dirname, '../../engine/main.py')
  const devPython = process.platform === 'win32' ? 'python' : 'python3'
  cachedTarget = { executable: devPython, scriptArgs: [devScript] }
  return cachedTarget
}

/** Spawn environment for the Python engine — restricts network and user-site access. */
function sandboxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // Remove proxy vars so the engine cannot route network traffic
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'ALL_PROXY',
                   'http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy']) {
    delete env[k]
  }
  env['no_proxy']           = '*'
  env['NO_PROXY']           = '*'
  env['PYTHONNOUSERSITE']   = '1'   // no user site-packages
  env['PYTHONDONTWRITEBYTECODE'] = '1'
  // The packaged engine directory is read-only (DMG / Program Files), so give
  // the engine a writable location for models, exports and training scratch.
  env['RUANJIAN_DATA_DIR']  = join(app.getPath('userData'), 'engine-data')
  return env
}

/**
 * Turn a non-zero engine exit code into an actionable message. Exit code
 * 9009 on Windows almost always means the thing that was spawned wasn't
 * the engine at all — see resolveEngine() above — so call that out
 * explicitly instead of surfacing the bare number.
 */
function describeExitError(code: number | null, executable: string, stderr: string): string {
  const detail = stderr.trim()
  if (process.platform === 'win32' && code === 9009) {
    return (
      `Python engine exited 9009 (command not found) while trying to run "${executable}". ` +
      'This usually means the bundled engine executable could not be launched — try reinstalling the application.' +
      (detail ? ` Details: ${detail}` : '')
    )
  }
  return `Python engine exited ${code}${detail ? `: ${detail}` : ''}`
}

export function callPythonEngine(method: string, args: unknown[], timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let target: EngineTarget
    try {
      target = resolveEngine()
    } catch (error) {
      reject(error as Error)
      return
    }

    const payload    = JSON.stringify({ method, args })
    const spawnArgs  = [...target.scriptArgs, payload]
    const proc = spawn(target.executable, spawnArgs, {
      env:         sandboxEnv(),
      shell:       false,
      windowsHide: true,
    })
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error(`Python engine timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(describeExitError(code, target.executable, stderr)))
        return
      }
      // Use the last non-empty line (handles engines that emit progress before result)
      const lines = stdout.trim().split('\n').filter((l) => l.trim())
      const last  = lines[lines.length - 1] ?? '{}'
      try {
        resolve(JSON.parse(last))
      } catch {
        reject(new Error(`Invalid JSON from Python engine: ${last}`))
      }
    })

    proc.on('error', (error) => {
      clearTimeout(timeout)
      log.error(`[python-bridge] failed to spawn "${target.executable}":`, error)
      reject(error)
    })
  })
}

/**
 * Like callPythonEngine but calls onData for each JSON line during execution.
 *
 * Unlike callPythonEngine, a single overall timeout doesn't fit here — a
 * training run can legitimately take much longer than any fixed budget. So
 * instead this uses a *stall* timeout: it resets every time the process
 * produces any output (progress line or stderr chatter) and only fires when
 * the engine goes completely silent, which means it's hung rather than busy.
 */
export function callPythonEngineStreaming(
  method: string,
  args: unknown[],
  onData: (data: unknown) => void,
  stallTimeoutMs = 5 * 60_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let target: EngineTarget
    try {
      target = resolveEngine()
    } catch (error) {
      reject(error as Error)
      return
    }

    const payload    = JSON.stringify({ method, args })
    const spawnArgs  = [...target.scriptArgs, payload]
    const proc       = spawn(target.executable, spawnArgs, {
      env:         sandboxEnv(),
      shell:       false,
      windowsHide: true,
    })

    let stderr   = ''
    let lastData: unknown = null
    let partial  = ''
    let settled  = false

    let stallTimer: ReturnType<typeof setTimeout>
    const resetStallTimer = (): void => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        if (settled) return
        settled = true
        proc.kill()
        reject(new Error(
          `Python engine produced no output for ${stallTimeoutMs} ms and was killed (likely hung)`,
        ))
      }, stallTimeoutMs)
    }
    resetStallTimer()

    proc.stdout.on('data', (chunk: Buffer) => {
      resetStallTimer()
      partial += chunk.toString()
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const data = JSON.parse(line)
          lastData = data
          onData(data)
        } catch { /* non-JSON diagnostic lines are silently skipped */ }
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => { resetStallTimer(); stderr += chunk.toString() })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      if (partial.trim()) {
        try { const d = JSON.parse(partial); lastData = d; onData(d) } catch { /* ignore */ }
      }
      if (code !== 0) {
        reject(new Error(describeExitError(code, target.executable, stderr)))
        return
      }
      resolve(lastData)
    })

    proc.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      log.error(`[python-bridge] failed to spawn "${target.executable}":`, error)
      reject(error)
    })
  })
}
