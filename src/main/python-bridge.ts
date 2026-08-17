import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { app }   from 'electron'

function getPythonExecutable(): string {
  if (app.isPackaged) {
    // 1. PyInstaller standalone bundle (created by scripts/package-engine.sh)
    const bundleDir = join(process.resourcesPath, 'engine-dist', 'ruanjian-engine')
    const bundleExe = join(bundleDir,
      process.platform === 'win32' ? 'ruanjian-engine.exe' : 'ruanjian-engine')
    if (existsSync(bundleExe)) return bundleExe

    // 2. Bundled portable Python (Windows embedded distribution)
    const portablePy = join(process.resourcesPath,
      process.platform === 'win32' ? 'python\\python.exe' : 'python/bin/python3')
    if (existsSync(portablePy)) return portablePy

    // 3. Fallback: system Python (should not reach here in production)
    return process.platform === 'win32' ? 'python' : 'python3'
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

function getEngineScript(): string {
  if (app.isPackaged) {
    // When using the PyInstaller bundle, the script path is irrelevant —
    // the bundle already embeds main.py.  Pass a dummy path that is ignored.
    const bundleDir = join(process.resourcesPath, 'engine-dist', 'ruanjian-engine')
    const bundleExe = join(bundleDir,
      process.platform === 'win32' ? 'ruanjian-engine.exe' : 'ruanjian-engine')
    if (existsSync(bundleExe)) return '__bundled__'
    return join(process.resourcesPath, 'engine', 'main.py')
  }
  return join(__dirname, '../../engine/main.py')
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

export function callPythonEngine(method: string, args: unknown[], timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload    = JSON.stringify({ method, args })
    const script     = getEngineScript()
    const spawnArgs  = script === '__bundled__' ? [payload] : [script, payload]
    const proc = spawn(getPythonExecutable(), spawnArgs, {
      env: sandboxEnv(),
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
        reject(new Error(`Python engine exited ${code}: ${stderr.trim()}`))
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

    proc.on('error', (error) => { clearTimeout(timeout); reject(error) })
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
    const payload    = JSON.stringify({ method, args })
    const script     = getEngineScript()
    const spawnArgs  = script === '__bundled__' ? [payload] : [script, payload]
    const proc       = spawn(getPythonExecutable(), spawnArgs, {
      env: sandboxEnv(),
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
        reject(new Error(`Python engine exited ${code}: ${stderr.trim()}`))
        return
      }
      resolve(lastData)
    })

    proc.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      reject(error)
    })
  })
}
