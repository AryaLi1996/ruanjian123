import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { app }   from 'electron'
import log from 'electron-log'
import {
  DEFAULT_STARTUP_TIMEOUT_MS, STARTUP_HEARTBEAT_GRACE_FACTOR,
  classifyEngineLine, describeMissingInterpreter, describeSpawnFailure, describeStartupTimeout,
  parseEngineJsonLine, parseEngineStdout,
  resolveCommandOnPath, resolveStartupTimeoutMs, shouldRetryStartup, stripDiagnostics,
  DEFAULT_STALL_TIMEOUT_MS, resolveStallTimeoutMs, STALL_TIMEOUT_MARKER, tailLines,
} from './engine-preflight'

// Re-exported so callers keep importing engine plumbing from one module even
// though the pure, electron-free halves live in engine-preflight.ts (which is
// what makes them unit-testable — see vitest.config.ts).
export { DEFAULT_STALL_TIMEOUT_MS, MAX_STALL_TIMEOUT_MS, MIN_STALL_TIMEOUT_MS, resolveStallTimeoutMs } from './engine-preflight'

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

/**
 * Spawn environment for the Python engine — restricts network and user-site
 * access.
 *
 * `target` is the already-resolved EngineTarget (see resolveEngine() above)
 * for the process about to be spawned.
 */
function sandboxEnv(target: EngineTarget): NodeJS.ProcessEnv {
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

  // Ticket 41: on Windows, a spawned child process resolves its own DLL
  // search path from (among other things) its own PATH at spawn time — it
  // does NOT automatically inherit "next to whichever .exe launched it" the
  // way the OS loader does for the parent process itself. Make sure the
  // directory the engine executable lives in (which carries its own
  // PyInstaller-bundled onnxruntime/torch DLLs) and the directory holding
  // this app's own executable (where Electron's runtime DLLs, including
  // ffmpeg.dll, live) are always on PATH for the child, regardless of
  // what's on the parent's PATH in a given environment.
  if (process.platform === 'win32') {
    const dirs = [dirname(target.executable), dirname(process.execPath)]
    env['PATH'] = [...dirs, env['PATH'] ?? ''].join(';')
  }
  return env
}

/**
 * Verify the resolved engine can actually be launched, before spawning it.
 *
 * Ticket T1: a dev checkout with no Python on PATH, or an install whose
 * engine files antivirus quarantined, used to surface as a 15-second silence
 * followed by "Python engine failed to start" — no indication of *which*
 * of those it was. Checking first means the failure names itself.
 *
 * Returns null when everything checks out, or a ready-to-show message.
 */
export function preflightEngine(): string | null {
  let target: EngineTarget
  try {
    target = resolveEngine()
  } catch (error) {
    return (error as Error).message
  }

  const resolved = resolveCommandOnPath(target.executable, {
    pathEnv:  process.env.PATH,
    platform: process.platform,
    pathExt:  process.env.PATHEXT,
    exists:   existsSync,
  })
  if (!resolved) return describeMissingInterpreter(target.executable, process.platform)

  // The dev target also needs the script itself; a packaged bundle embeds it.
  const script = target.scriptArgs[0]
  if (script && !existsSync(script)) {
    return `找不到引擎脚本「${script}」。/ Engine script "${script}" is missing.`
  }
  return null
}

// ── Engine log fan-out ───────────────────────────────────────────────────
// Ticket T1/T3: everything the engine writes — JSON progress, verbose stage
// lines, heartbeats, and any raw traceback — is published here so the main
// process can forward it to the training log panel. Without this the only
// output that ever reached the UI was well-formed JSON on stdout, which is
// exactly the output a failing-to-start engine never produces.
export interface EngineLogEntry {
  method: string
  stream: 'stdout' | 'stderr'
  kind:   'json' | 'diagnostic' | 'heartbeat' | 'error'
  line:   string
  at:     number
}

type EngineLogListener = (entry: EngineLogEntry) => void
const logListeners = new Set<EngineLogListener>()

/** Subscribe to engine output. Returns an unsubscribe function. */
export function onEngineLog(listener: EngineLogListener): () => void {
  logListeners.add(listener)
  return () => { logListeners.delete(listener) }
}

function emitLog(entry: EngineLogEntry): void {
  for (const listener of logListeners) {
    try { listener(entry) } catch { /* a bad listener must not break the run */ }
  }
}

// ── Start-up timeout configuration ───────────────────────────────────────
// Ticket T1 allows the user to raise this (Settings → engine start-up
// timeout) for a machine where even 60s isn't enough — an aggressive
// enterprise AV, or a network-mounted install directory.
let startupTimeoutOverrideMs: number | null = null

export function setEngineStartupTimeoutMs(ms: number | null): number {
  startupTimeoutOverrideMs = ms == null ? null : resolveStartupTimeoutMs(ms)
  return getEngineStartupTimeoutMs()
}

export function getEngineStartupTimeoutMs(): number {
  if (startupTimeoutOverrideMs != null) return startupTimeoutOverrideMs
  const fromEnv = process.env.RUANJIAN_ENGINE_STARTUP_TIMEOUT_MS
  return fromEnv ? resolveStartupTimeoutMs(fromEnv) : DEFAULT_STARTUP_TIMEOUT_MS
}

/**
 * Turn a non-zero engine exit code into an actionable message. Exit code
 * 9009 on Windows almost always means the thing that was spawned wasn't
 * the engine at all — see resolveEngine() above — so call that out
 * explicitly instead of surfacing the bare number.
 */
function describeExitError(code: number | null, executable: string, stderr: string): string {
  // Verbose diagnostics and heartbeats are noise in an error message — the
  // interesting part is whatever the failure itself printed.
  const detail = tailLines(stripDiagnostics(stderr))
  if (process.platform === 'win32' && code === 9009) {
    return (
      `Python engine exited 9009 (command not found) while trying to run "${executable}". ` +
      'This usually means the bundled engine executable could not be launched — try reinstalling the application.' +
      (detail ? ` Details: ${detail}` : '')
    )
  }
  return `Python engine exited ${code}${detail ? `: ${detail}` : ''}`
}

/**
 * Spawn the engine for one call.
 *
 * `verbose` adds --verbose, which makes engine/main.py narrate its stages and
 * emit a liveness heartbeat on stderr — see that module's header for why the
 * start-up logic depends on it.
 */
function spawnEngine(
  target: EngineTarget, method: string, args: unknown[], verbose: boolean,
): ChildProcessWithoutNullStreams {
  const payload   = JSON.stringify({ method, args })
  const spawnArgs = [...target.scriptArgs, ...(verbose ? ['--verbose'] : []), payload]
  return spawn(target.executable, spawnArgs, {
    env:         sandboxEnv(target),
    shell:       false,
    windowsHide: true,
  })
}

/** Route one stderr chunk to the log fan-out, and report what kind of lines it held. */
function publishStderr(method: string, chunk: string): { sawRealOutput: boolean; diagnostics: string[] } {
  let sawRealOutput = false
  const diagnostics: string[] = []
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    const kind = classifyEngineLine(line)
    if (kind !== 'heartbeat') sawRealOutput = true
    if (kind !== 'error') diagnostics.push(line.trim())
    emitLog({ method, stream: 'stderr', kind, line: line.trimEnd(), at: Date.now() })
  }
  return { sawRealOutput, diagnostics }
}

export function callPythonEngine(
  method: string, args: unknown[], timeoutMs = 30_000, attempt = 0,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let target: EngineTarget
    try {
      target = resolveEngine()
    } catch (error) {
      reject(error as Error)
      return
    }

    const proc = spawnEngine(target, method, args, true)
    const startupTimeoutMs = getEngineStartupTimeoutMs()

    let stdout   = ''
    let stderr   = ''
    let settled  = false
    // A one-shot call gets whichever budget is larger: its own (which callers
    // size for the *work*, e.g. 5 min for an export) or the start-up budget
    // (which covers getting the interpreter off the ground at all). Taking
    // the smaller of the two is how a slow cold start used to abort a call
    // that had plenty of time left for the work itself.
    const budgetMs = Math.max(timeoutMs, startupTimeoutMs)
    const timeout  = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      // Nothing at all came back: this is a start-up failure, not a slow
      // computation, so it is worth one automatic retry (Ticket T1) — a cold
      // filesystem cache or a first-run AV scan usually only bites once.
      const neverStarted = stdout === '' && stripDiagnostics(stderr) === ''
      if (neverStarted && shouldRetryStartup(attempt)) {
        log.warn(`[python-bridge] "${method}" produced no output in ${budgetMs} ms; retrying once`)
        callPythonEngine(method, args, timeoutMs, attempt + 1).then(resolve, reject)
        return
      }
      reject(new Error(
        neverStarted
          ? describeStartupTimeout(budgetMs, process.platform, false)
          : `Python engine timed out after ${budgetMs} ms`,
      ))
    }, budgetMs)

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      publishStderr(method, text)
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(new Error(describeExitError(code, target.executable, stderr)))
        return
      }
      // Ticket T2: take the last JSON *message* on stdout, not the last line.
      // The engine shares stdout with whatever its dependencies print, so the
      // final line is regularly a warning rather than the result — parsing it
      // blindly is what turned a successful run into "invalid JSON payload".
      const { result, textLines } = parseEngineStdout(stdout)
      // Plain-text stdout used to be discarded here; surface it in the log
      // panel, where it is often the only explanation of what went wrong.
      for (const line of textLines) {
        emitLog({ method, stream: 'stdout', kind: 'diagnostic', line, at: Date.now() })
      }
      if (result === undefined) {
        const tail = textLines.slice(-3).join(' | ') || '(no output)'
        reject(new Error(
          `Python engine produced no JSON result${textLines.length ? `; last output: ${tail}` : ''}`,
        ))
        return
      }
      resolve(result)
    })

    proc.on('error', (error) => {
      clearTimeout(timeout)
      if (settled) return
      settled = true
      log.error(`[python-bridge] failed to spawn "${target.executable}":`, error)
      reject(new Error(describeSpawnFailure(error as NodeJS.ErrnoException, {
        platform: process.platform, executable: target.executable,
      })))
    })
  })
}

/**
 * Like callPythonEngine but calls onData for each JSON line during execution.
 *
 * Unlike callPythonEngine, a single overall timeout doesn't fit here — a
 * training run can legitimately take much longer than any fixed budget. So
 * instead this uses two timers:
 *
 *  * a **start-up** timeout, until the engine proves it is running. Heartbeat
 *    lines (see engine/main.py) push this out while the process is provably
 *    alive, up to a hard ceiling, so a slow `import torch` is no longer
 *    mistaken for a wedged process — that mistake is Ticket T1's
 *    "failed to start within 15000 ms".
 *  * a **stall** timeout afterwards, reset by real output only (never by a
 *    heartbeat, or a hung run would be immortal).
 */
// The streaming child currently in flight, if any (Ticket UI-10's 取消训练).
// Only one streaming run happens at a time — the UI blocks starting a second
// while one is in progress — so a single handle is enough, and it's cleared
// as soon as the run settles either way.
let activeStreamingProc: ChildProcessWithoutNullStreams | null = null

// Set by cancelPythonEngineStreaming so the close handler can tell a
// deliberate cancellation from a crash — killing the process makes it exit
// non-zero either way, and reporting a user-requested stop as an engine
// failure would be wrong.
let cancelRequested = false

/** Error message a cancelled run rejects with; recognised by the renderer. */
export const ENGINE_CANCELLED = 'ENGINE_CANCELLED'

/**
 * Kills the streaming run in flight, if there is one.
 *
 * Returns whether anything was actually killed, so the caller can tell
 * "cancelled" from "there was nothing to cancel" (a run that finished
 * between the user's click and the IPC arriving) rather than reporting a
 * successful cancellation of nothing.
 */
export function cancelPythonEngineStreaming(): boolean {
  const proc = activeStreamingProc
  if (!proc) return false
  cancelRequested = true
  activeStreamingProc = null
  proc.kill()
  return true
}

export function callPythonEngineStreaming(
  method: string,
  args: unknown[],
  onData: (data: unknown) => void,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
  attempt = 0,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let target: EngineTarget
    try {
      target = resolveEngine()
    } catch (error) {
      reject(error as Error)
      return
    }

    // Checked here rather than only in the IPC layer so *every* streaming
    // caller gets the named failure instead of a silent timeout.
    const preflightError = preflightEngine()
    if (preflightError) {
      reject(new Error(preflightError))
      return
    }

    const proc = spawnEngine(target, method, args, true)

    activeStreamingProc = proc
    cancelRequested = false

    let stderr    = ''
    let lastData: unknown = null
    let partial   = ''
    let settled   = false
    // Distinguish "never even got going" from "legitimately busy". A stuck
    // spawn — antivirus holding the exe, a missing native dependency that
    // blocks before the engine can print anything — should fail fast; a
    // training run that's gone quiet *after* it has already proven it
    // started gets the full stall budget.
    let hasOutput = false
    const recentDiagnostics: string[] = []
    const startupTimeoutMs = getEngineStartupTimeoutMs()
    // Heartbeats may extend start-up, but only this far: an engine whose main
    // thread is wedged while its heartbeat thread keeps ticking must still
    // eventually fail rather than hang the UI forever.
    const startupDeadline = Date.now() + startupTimeoutMs * STARTUP_HEARTBEAT_GRACE_FACTOR

    let timer: ReturnType<typeof setTimeout>

    const fail = (message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (activeStreamingProc === proc) activeStreamingProc = null
      proc.kill()
      reject(new Error(message))
    }

    const armStartupTimer = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (settled) return
        // One automatic retry (Ticket T1): nothing has run yet, so restarting
        // is side-effect free, and the usual culprits (cold cache, first-run
        // AV scan of the executable) are one-shot.
        if (shouldRetryStartup(attempt)) {
          settled = true
          clearTimeout(timer)
          if (activeStreamingProc === proc) activeStreamingProc = null
          proc.kill()
          log.warn(`[python-bridge] "${method}" did not start within ${startupTimeoutMs} ms; retrying once`)
          emitLog({
            method, stream: 'stderr', kind: 'diagnostic', at: Date.now(),
            line: describeStartupTimeout(startupTimeoutMs, process.platform, true, recentDiagnostics),
          })
          callPythonEngineStreaming(method, args, onData, stallTimeoutMs, attempt + 1).then(resolve, reject)
          return
        }
        fail(describeStartupTimeout(startupTimeoutMs, process.platform, false, recentDiagnostics))
      }, startupTimeoutMs)
    }

    const armStallTimer = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        // Ticket P3: carry a stable marker and whatever the engine last said
        // on stderr. Without them the renderer can only show the raw English
        // sentence, and an OOM kill that printed a traceback right before
        // going quiet loses its one piece of evidence.
        const detail = stripDiagnostics(stderr)
        fail(
          `${STALL_TIMEOUT_MARKER}: Python engine produced no output for ${stallTimeoutMs} ms ` +
          `and was killed (likely hung)${detail ? `. Details: ${tailLines(detail)}` : ''}`
        )
      }, stallTimeoutMs)
    }

    /** Real output means the engine is working: switch to (and reset) the stall budget. */
    const noteRealOutput = (): void => {
      hasOutput = true
      armStallTimer()
    }

    /** A heartbeat only proves liveness — extend start-up, never the stall budget. */
    const noteHeartbeat = (): void => {
      if (hasOutput || Date.now() > startupDeadline) return
      armStartupTimer()
    }

    armStartupTimer()

    proc.stdout.on('data', (chunk: Buffer) => {
      noteRealOutput()
      partial += chunk.toString()
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const data = parseEngineJsonLine(line)
        if (data === undefined) {
          // Not a JSON message — a print() from a library, a warning, a
          // traceback frame. It is shown as plain text rather than parsed
          // (Ticket T2/T3): these lines are often the only clue about where a
          // run got stuck, and they must never be mistaken for progress.
          emitLog({ method, stream: 'stdout', kind: 'diagnostic', line: line.trimEnd(), at: Date.now() })
          continue
        }
        lastData = data
        onData(data)
        emitLog({ method, stream: 'stdout', kind: 'json', line: line.trimEnd(), at: Date.now() })
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      const { sawRealOutput, diagnostics } = publishStderr(method, text)
      for (const d of diagnostics) {
        recentDiagnostics.push(d)
        if (recentDiagnostics.length > 20) recentDiagnostics.shift()
      }
      if (sawRealOutput) noteRealOutput()
      else               noteHeartbeat()
    })

    proc.on('close', (code) => {
      if (activeStreamingProc === proc) activeStreamingProc = null
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (cancelRequested) {
        cancelRequested = false
        reject(new Error(ENGINE_CANCELLED))
        return
      }
      // A final line with no trailing newline — the engine's result when the
      // process exits immediately after printing it.
      if (partial.trim()) {
        const d = parseEngineJsonLine(partial)
        if (d !== undefined) { lastData = d; onData(d) }
        else emitLog({ method, stream: 'stdout', kind: 'diagnostic', line: partial.trimEnd(), at: Date.now() })
      }
      if (code !== 0) {
        reject(new Error(describeExitError(code, target.executable, stderr)))
        return
      }
      resolve(lastData)
    })

    proc.on('error', (error) => {
      if (activeStreamingProc === proc) activeStreamingProc = null
      if (settled) return
      settled = true
      clearTimeout(timer)
      log.error(`[python-bridge] failed to spawn "${target.executable}":`, error)
      reject(new Error(describeSpawnFailure(error as NodeJS.ErrnoException, {
        platform: process.platform, executable: target.executable,
      })))
    })
  })
}
