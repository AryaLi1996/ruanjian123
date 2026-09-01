/**
 * Pure helpers behind the engine's start-up hardening (Ticket T1).
 *
 * Deliberately free of any `electron` import so it can be unit tested under
 * Vitest — see the note at the top of vitest.config.ts. Everything here is a
 * plain function of its inputs; python-bridge.ts owns the actual spawning.
 */

/** Tags engine/main.py writes its stderr diagnostics with — keep in sync. */
export const ENGINE_LOG_PREFIX       = '[engine]'
export const ENGINE_HEARTBEAT_PREFIX = '[engine:heartbeat]'

/**
 * How long a spawned engine gets to produce its first output.
 *
 * Was 15s, which is what users hit as "Python engine failed to start within
 * 15000 ms". That budget is simply too small for the work that happens before
 * the engine can print anything on a cold start: unpacking the PyInstaller
 * bundle, Windows Defender scanning a freshly written unsigned .exe on first
 * run, and `import torch` off a spinning disk are each capable of eating it
 * on their own. 60s covers all three with margin; the engine's own heartbeat
 * (--verbose) extends it further while the process is provably alive, so a
 * genuinely slow machine no longer looks like a broken one.
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000
export const MIN_STARTUP_TIMEOUT_MS     = 5_000
export const MAX_STARTUP_TIMEOUT_MS     = 10 * 60_000

/**
 * Ceiling on how far heartbeats may push the start-up deadline out. Without
 * a cap, an engine whose main thread is wedged while its heartbeat thread
 * keeps ticking would never time out at all.
 */
export const STARTUP_HEARTBEAT_GRACE_FACTOR = 4

/** A start-up timeout is retried once — see shouldRetryStartup below. */
export const STARTUP_RETRY_LIMIT = 1

/**
 * Clamp a user- or env-supplied start-up timeout into a sane range, falling
 * back to the default for anything unusable (unset, NaN, negative).
 */
export function resolveStartupTimeoutMs(configured?: number | string | null): number {
  const parsed = typeof configured === 'string' ? Number(configured) : configured
  if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STARTUP_TIMEOUT_MS
  return Math.min(MAX_STARTUP_TIMEOUT_MS, Math.max(MIN_STARTUP_TIMEOUT_MS, Math.round(parsed as number)))
}

export type EngineLineKind = 'heartbeat' | 'diagnostic' | 'error'

/**
 * Classify one stderr line from the engine.
 *
 * The distinction matters for the timeout logic: a heartbeat only proves the
 * process is alive (so it may extend *start-up*, but must not reset the stall
 * timer — otherwise a hung run would be immortal), while any other output is
 * real progress.
 */
export function classifyEngineLine(line: string): EngineLineKind {
  const trimmed = line.trimStart()
  if (trimmed.startsWith(ENGINE_HEARTBEAT_PREFIX)) return 'heartbeat'
  if (trimmed.startsWith(ENGINE_LOG_PREFIX))       return 'diagnostic'
  return 'error'
}

/**
 * Parse one stdout line as an engine JSON message, or return undefined.
 *
 * Ticket T2: stdout carries the JSON protocol, but a Python process shares
 * that stream with anything a library decides to print — a warning, a
 * progress bar, a stray `print()` in a dependency. Feeding those to
 * JSON.parse is what produced the flood of "invalid JSON payload" errors, so
 * a line is only treated as a message when it actually looks like one:
 *
 *  * it must parse, and
 *  * it must be an object or array. Without that check a bare `42` or a
 *    `null` printed by a library parses fine and would be handed to the UI
 *    as a progress update.
 *
 * Everything else is plain text, and belongs in the log panel verbatim.
 */
export function parseEngineJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

export interface EngineStdout {
  /** The last JSON message on stdout — the engine's result — if there was one. */
  result: unknown | undefined
  /** Non-JSON lines, in order: warnings and stray prints worth showing the user. */
  textLines: string[]
}

/**
 * Split a completed run's stdout into its JSON result and its plain-text noise.
 *
 * The result is the *last* JSON message rather than the last line, so a
 * warning printed after the result (an atexit handler, a `__del__` complaining
 * on interpreter shutdown) no longer turns a successful call into a parse
 * failure.
 */
export function parseEngineStdout(stdout: string): EngineStdout {
  let result: unknown | undefined
  const textLines: string[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const parsed = parseEngineJsonLine(line)
    if (parsed === undefined) textLines.push(line.trimEnd())
    else result = parsed
  }
  return { result, textLines }
}

/**
 * Strip the engine's own verbose diagnostics out of captured stderr, leaving
 * whatever a real failure printed. Verbose mode is on by default for
 * streaming runs, so without this every error message would be buried under
 * dozens of heartbeat lines.
 */
export function stripDiagnostics(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => line.trim() && classifyEngineLine(line) === 'error')
    .join('\n')
    .trim()
}

/** Retry a start-up timeout once: a cold cache or an AV scan usually only bites the first run. */
export function shouldRetryStartup(attempt: number, limit = STARTUP_RETRY_LIMIT): boolean {
  return attempt < limit
}

export interface SpawnFailureContext {
  platform:   string
  executable: string
}

/**
 * Turn a raw spawn error into something a user can act on.
 *
 * `Error: spawn python ENOENT` tells a non-developer nothing; each branch
 * below names the actual cause and the fix, in both languages the app ships.
 */
export function describeSpawnFailure(error: NodeJS.ErrnoException, ctx: SpawnFailureContext): string {
  const { code } = error
  const exe = ctx.executable

  if (code === 'ENOENT') {
    return (
      `找不到 Python 引擎可执行文件「${exe}」。/ Python engine executable "${exe}" was not found. ` +
      '开发环境请确认已安装 Python 3 并在 PATH 中；安装版请重新安装应用。 / ' +
      'In a development checkout, install Python 3 and make sure it is on PATH; ' +
      'in an installed build, reinstall the application.'
    )
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return (
      `没有权限运行 Python 引擎「${exe}」。/ Permission denied launching the Python engine "${exe}". ` +
      (ctx.platform === 'win32'
        ? '这通常是 Windows Defender 或第三方杀毒软件拦截所致，请将应用安装目录加入信任列表后重试。 / ' +
          'This is usually Windows Defender or third-party antivirus blocking it — add the ' +
          "application's install folder to your antivirus exclusions and try again."
        : '请检查该文件的执行权限（chmod +x）。 / Check the file\'s execute permission (chmod +x).')
    )
  }
  if (code === 'EMFILE' || code === 'ENFILE') {
    return (
      '系统打开的文件数已达上限，无法启动 Python 引擎，请关闭部分程序后重试。 / ' +
      'The system ran out of file handles and could not start the Python engine. ' +
      'Close some applications and try again.'
    )
  }
  return `无法启动 Python 引擎「${exe}」：${error.message} / Failed to start the Python engine "${exe}": ${error.message}`
}

/**
 * Message for a start-up timeout, tailored to whether a retry is still coming
 * and to the platform's most likely culprit.
 */
export function describeStartupTimeout(
  timeoutMs: number, platform: string, willRetry: boolean, diagnostics: string[] = [],
): string {
  const seconds = Math.round(timeoutMs / 1000)
  const antivirus = platform === 'win32'
    ? 'Windows Defender 或杀毒软件可能正在拦截引擎，请将应用安装目录加入信任列表。 / ' +
      'Windows Defender or antivirus software may be blocking the engine — add the ' +
      "application's install folder to your antivirus exclusions."
    : '可能缺少依赖库或文件权限不足。 / A required dependency may be missing, or file permissions may be wrong.'

  const tail = diagnostics.length > 0
    ? ` 最后的引擎日志 / last engine output: ${diagnostics.slice(-3).join(' | ')}`
    : ' 引擎没有输出任何日志。 / The engine produced no output at all.'

  return (
    `Python 引擎在 ${seconds} 秒内未能启动。/ The Python engine did not start within ${seconds} s. ` +
    (willRetry ? '正在自动重试一次… / Retrying once automatically… ' : `${antivirus} `) +
    tail
  )
}


/**
 * Resolve a bare command (`python`, `python3`) against a PATH, the way spawn
 * itself will.
 *
 * Development builds spawn the system interpreter by name, so `existsSync`
 * can't be used to check it up front — and letting spawn fail instead yields
 * a bare ENOENT (or, on Windows, the App-execution-alias 9009 described in
 * python-bridge.ts) minutes into a training click. Dependency-injected
 * (`exists`, `pathEnv`) so it is testable on any host OS.
 */
export function resolveCommandOnPath(
  command: string,
  opts: {
    pathEnv:   string | undefined
    platform:  string
    exists:    (candidate: string) => boolean
    pathExt?:  string
  },
): string | null {
  const { pathEnv, platform, exists } = opts
  const isWindows = platform === 'win32'
  const sep = isWindows ? ';' : ':'
  const joinPath = (dir: string, file: string): string =>
    `${dir}${dir.endsWith(isWindows ? '\\' : '/') ? '' : isWindows ? '\\' : '/'}${file}`

  // An explicit path (absolute or relative) is used as-is — PATH lookup only
  // applies to bare command names, same as execvp/CreateProcess.
  if (command.includes('/') || command.includes('\\')) {
    return exists(command) ? command : null
  }

  const extensions = isWindows
    ? (opts.pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']

  for (const dir of (pathEnv ?? '').split(sep).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = joinPath(dir, command + ext)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/**
 * Message for "the interpreter this dev build wants isn't installed" — the
 * other half of Ticket T1's "verify the Python path before spawning".
 */
export function describeMissingInterpreter(command: string, platform: string): string {
  return (
    `未找到 Python 解释器「${command}」。/ Python interpreter "${command}" was not found on PATH. ` +
    (platform === 'win32'
      ? '请从 python.org 安装 Python 3.9 及以上版本，并在安装时勾选“Add python.exe to PATH”。 / ' +
        'Install Python 3.9+ from python.org and tick "Add python.exe to PATH" during setup.'
      : '请安装 Python 3.9 及以上版本（例如 brew install python 或 apt install python3）。 / ' +
        'Install Python 3.9+ (e.g. `brew install python` or `apt install python3`).') +
    ' 然后运行 pip install -r engine/requirements.txt 安装引擎依赖。 / ' +
    'Then run `pip install -r engine/requirements.txt` to install the engine dependencies.'
  )
}
