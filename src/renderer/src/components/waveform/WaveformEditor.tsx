import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin, { type Region } from 'wavesurfer.js/plugins/regions'
import { useWaveformStore } from '../../store/useWaveformStore'
import { formatTimeDs } from '../../utils/audio'

const ACCEPT_EXT = new Set(['.wav', '.mp3'])

function isAcceptedAudioFile(f: File): boolean {
  const ext = '.' + (f.name.split('.').pop() ?? '').toLowerCase()
  return ACCEPT_EXT.has(ext)
}

// Mirrors the main process's dialog:openFile filter (PATCH-01) — a file
// picked through the native dialog is read as raw bytes via
// window.engine.readFile, so it needs an explicit MIME type to become a
// Blob wavesurfer can load.
const MIME_BY_EXT: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', aac: 'audio/aac',
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

// Blue overlay for the selection region (Ticket 15's "highlighted with a
// blue overlay" requirement) — kept as a literal rather than var(--accent)
// since the accent colour is user-customizable and region selection should
// read unambiguously as "selection blue" regardless of theme.
const SELECTION_COLOR = 'rgba(37, 99, 235, 0.28)'

interface Props {
  /** PATCH-03: false when the host renders its own play/pause controls (the
   *  Model Data Preparation toolbar), so the two don't both show transport
   *  buttons. The time readout, loop toggle and selection info stay either
   *  way — nothing else surfaces them. */
  showTransportButtons?: boolean
}

export function WaveformEditor({ showTransportButtons = true }: Props = {}): JSX.Element {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef         = useRef<WaveSurfer | null>(null)
  const regionsRef     = useRef<RegionsPlugin | null>(null)
  const selectionIdRef = useRef<string | null>(null)
  const objectUrlRef    = useRef<string | null>(null)

  const [ready, setReady]     = useState(false)
  const [dragging, setDragging] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const fileName      = useWaveformStore((s) => s.fileName)
  const filePath       = useWaveformStore((s) => s.filePath)
  const duration       = useWaveformStore((s) => s.duration)
  const currentTime    = useWaveformStore((s) => s.currentTime)
  const isPlaying      = useWaveformStore((s) => s.isPlaying)
  const selection       = useWaveformStore((s) => s.selection)
  const loopSelection  = useWaveformStore((s) => s.loopSelection)
  const setFileName     = useWaveformStore((s) => s.setFileName)
  const setFilePath     = useWaveformStore((s) => s.setFilePath)
  const setControls     = useWaveformStore((s) => s.setControls)
  const setDuration    = useWaveformStore((s) => s.setDuration)
  const setCurrentTime = useWaveformStore((s) => s.setCurrentTime)
  const setIsPlaying   = useWaveformStore((s) => s.setIsPlaying)
  const setSelection   = useWaveformStore((s) => s.setSelection)
  const clearSelection = useWaveformStore((s) => s.clearSelection)
  const setLoopSelection = useWaveformStore((s) => s.setLoopSelection)

  // Kept in refs alongside the store values above: the wavesurfer event
  // handlers below are registered once (on mount) and closed over these, so
  // plain state/props would go stale after the first render.
  const loopSelectionRef = useRef(loopSelection)
  useEffect(() => { loopSelectionRef.current = loopSelection }, [loopSelection])

  // ── Create the WaveSurfer instance once ───────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const regions = RegionsPlugin.create()
    const ws = WaveSurfer.create({
      container,
      height: 96,
      waveColor: '#6366f1',
      progressColor: '#4346ff',
      cursorColor: '#e2e8f0',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      // Left at the default (off) — enableDragSelection below claims the
      // same click-and-drag gesture on the waveform to draw a region, and
      // the two would otherwise fight over it. Plain clicks still seek.
      plugins: [regions],
    })
    wsRef.current = ws
    regionsRef.current = regions

    // A single selection at a time: dragging on empty waveform starts a new
    // region. `region-created` fires for it — drop any previously-existing
    // region so the store's `selection` always mirrors exactly one span.
    const disableDragSelection = regions.enableDragSelection({
      color: SELECTION_COLOR,
    })

    const syncSelection = (region: Region): void => {
      selectionIdRef.current = region.id
      setSelection({ start: region.start, end: region.end })
    }

    const unsubCreated = regions.on('region-created', (region) => {
      for (const other of regions.getRegions()) {
        if (other.id !== region.id) other.remove()
      }
      syncSelection(region)
    })
    const unsubUpdated = regions.on('region-updated', (region) => {
      if (region.id === selectionIdRef.current) syncSelection(region)
    })
    const unsubRemoved = regions.on('region-removed', (region) => {
      if (region.id === selectionIdRef.current) {
        selectionIdRef.current = null
        clearSelection()
      }
    })
    // Loop-within-selection (Ticket 15 acceptance criteria): once playback
    // crosses the region's end, replay it from the start when looping is on.
    const unsubOut = regions.on('region-out', (region) => {
      if (region.id === selectionIdRef.current && loopSelectionRef.current) {
        region.play()
      }
    })

    const unsubReady = ws.on('ready', (dur) => { setDuration(dur); setReady(true) })
    const unsubTime  = ws.on('timeupdate', (time) => setCurrentTime(time))
    const unsubPlay  = ws.on('play',  () => setIsPlaying(true))
    const unsubPause = ws.on('pause', () => setIsPlaying(false))
    const unsubFinish = ws.on('finish', () => setIsPlaying(false))
    const unsubError = ws.on('error', (err) => setLoadError(err.message))

    return () => {
      disableDragSelection()
      unsubCreated(); unsubUpdated(); unsubRemoved(); unsubOut()
      unsubReady(); unsubTime(); unsubPlay(); unsubPause(); unsubFinish(); unsubError()
      ws.destroy()
      wsRef.current = null
      regionsRef.current = null
      if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null }
    }
    // Registered once — zustand setter functions are referentially stable
    // across renders, so this intentionally doesn't depend on them.
  }, [])

  // ── Load a dropped/picked file ────────────────────────────────────
  const loadFile = useCallback(async (file: File) => {
    const ws = wsRef.current
    if (!ws) return
    if (!isAcceptedAudioFile(file)) {
      setLoadError(t('waveformEditor.unsupportedFormat'))
      return
    }
    setLoadError(null)
    setReady(false)
    regionsRef.current?.clearRegions()
    selectionIdRef.current = null
    clearSelection()

    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    const url = URL.createObjectURL(file)
    objectUrlRef.current = url
    setFileName(file.name)
    // A dropped/browser-picked File never carries a real filesystem path in
    // this sandboxed/contextIsolated renderer — only the native dialog flow
    // below (loadFromPath) resolves one, so the path field reflects that.
    setFilePath(null)
    try {
      await ws.load(url)
    } catch (err) {
      setLoadError(String(err))
    }
  }, [clearSelection, setFileName, setFilePath, t])

  // ── Load a file chosen via the native "Browse…" dialog (PATCH-01) ─────
  // Unlike loadFile above, this starts from an absolute path rather than a
  // File object, so it reads the bytes over IPC and wraps them in a Blob
  // wavesurfer can load the same way.
  const loadFromPath = useCallback(async (path: string) => {
    const ws = wsRef.current
    if (!ws) return
    setLoadError(null)
    setReady(false)
    regionsRef.current?.clearRegions()
    selectionIdRef.current = null
    clearSelection()

    try {
      const buf = await window.engine.readFile(path)
      const ext = path.split('.').pop()?.toLowerCase() ?? ''
      const blob = new Blob([buf], { type: MIME_BY_EXT[ext] ?? 'application/octet-stream' })

      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      const url = URL.createObjectURL(blob)
      objectUrlRef.current = url
      setFileName(baseName(path))
      setFilePath(path)
      await ws.load(url)
    } catch (err) {
      setLoadError(String(err))
    }
  }, [clearSelection, setFileName, setFilePath])

  // Opens the native file-open dialog (main process) and loads whatever the
  // user picks. Guarded against re-entry so a double-click / repeat click
  // while the dialog or the subsequent load is in flight can't stack calls
  // (acceptance criteria: "防止用户重复点击").
  const handleBrowse = useCallback(async () => {
    if (browsing) return
    setBrowsing(true)
    try {
      const path = await window.engine.openFileDialog()
      if (!path) return // cancelled — dialog closes, input content stays as-is
      await loadFromPath(path)
    } catch (err) {
      setLoadError(String(err))
    } finally {
      setBrowsing(false)
    }
  }, [browsing, loadFromPath])

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void loadFile(file)
  }

  // ── Transport ──────────────────────────────────────────────────────
  const togglePlayPause = useCallback(() => {
    const ws = wsRef.current
    if (!ws || !ready) return
    if (ws.isPlaying()) { ws.pause(); return }

    const region = selectionIdRef.current
      ? regionsRef.current?.getRegions().find((r) => r.id === selectionIdRef.current)
      : null
    if (region) region.play(!loopSelectionRef.current)
    else void ws.play()
  }, [ready])

  function handleStop(): void {
    wsRef.current?.stop()
  }

  function handleClearSelection(): void {
    regionsRef.current?.clearRegions()
    selectionIdRef.current = null
    clearSelection()
  }

  // PATCH-03: publish play/pause for the Model Data Preparation toolbar,
  // which renders outside this component and so can't reach wsRef itself.
  // Registered after togglePlayPause exists so both paths share one code
  // path (region-aware playback, loop handling) rather than diverging.
  useEffect(() => {
    setControls({
      play:  () => { const ws = wsRef.current; if (ws && !ws.isPlaying()) togglePlayPause() },
      pause: () => { const ws = wsRef.current; if (ws && ws.isPlaying()) ws.pause() },
    })
    return () => setControls(null)
  }, [togglePlayPause, setControls])

  // Spacebar toggles play/pause (Ticket 15 acceptance criteria) — ignored
  // while the user is typing into any focusable text control elsewhere in
  // the app, and prevented so it doesn't also scroll the page.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.code !== 'Space' && e.key !== ' ') return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      e.preventDefault()
      togglePlayPause()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePlayPause])

  const hasFile = fileName !== null

  return (
    <div>
      {/* File path field + native "Browse…" button (PATCH-01) — clicking
          either the field or the folder icon opens the OS file dialog;
          canceling leaves the field untouched. */}
      <div className="wf-path-row">
        <div className="wf-path-input-wrap" onClick={() => void handleBrowse()}>
          <input
            className="wf-path-input"
            type="text"
            readOnly
            value={filePath ?? ''}
            placeholder={t('waveformEditor.pathPlaceholder')}
            aria-label={t('waveformEditor.browse')}
          />
          {browsing && <span className="wf-path-spinner" aria-hidden="true" />}
        </div>
        <button
          type="button"
          className="btn btn-ghost wf-browse-btn"
          onClick={() => void handleBrowse()}
          disabled={browsing}
          aria-label={t('waveformEditor.browse')}
          title={t('waveformEditor.browse')}
        >
          {browsing ? <span className="wf-path-spinner" aria-hidden="true" /> : '📁'}
        </button>
      </div>

      <div
        className={`wf-shell${dragging ? ' drag-over' : ''}`}
        onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
        onDragOver={(e)  => { e.preventDefault(); setDragging(true) }}
        onDragLeave={()  => setDragging(false)}
        onDrop={handleDrop}
      >
        <div ref={containerRef} className="wf-waveform" />

        {!hasFile && (
          <div
            className="wf-empty-overlay"
            onClick={() => inputRef.current?.click()}
            role="button"
            aria-label={t('waveformEditor.drop')}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".wav,.mp3,audio/wav,audio/mpeg"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadFile(f) }}
            />
            <div className="dropzone-icon">🌊</div>
            <div className="dropzone-primary">{t('waveformEditor.drop')}</div>
            <div className="dropzone-hint">{t('waveformEditor.formats')}</div>
          </div>
        )}
      </div>

      {loadError && <div className="wf-error">{loadError}</div>}

      <div className="wf-transport">
        {showTransportButtons && (
          <>
            <button
              className="btn btn-ghost wf-transport-btn"
              onClick={togglePlayPause}
              disabled={!hasFile || !ready}
              aria-label={isPlaying ? t('waveformEditor.pause') : t('waveformEditor.play')}
              title={`${isPlaying ? t('waveformEditor.pause') : t('waveformEditor.play')} (Space)`}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>
            <button
              className="btn btn-ghost wf-transport-btn"
              onClick={handleStop}
              disabled={!hasFile || !ready}
              aria-label={t('waveformEditor.stop')}
              title={t('waveformEditor.stop')}
            >
              ⏹
            </button>
          </>
        )}

        <span className="wf-time">
          {formatTimeDs(currentTime)} / {formatTimeDs(duration)}
        </span>

        <label className="wf-loop-toggle">
          <input
            type="checkbox"
            checked={loopSelection}
            onChange={(e) => setLoopSelection(e.target.checked)}
            disabled={!selection}
          />
          {t('waveformEditor.loopSelection')}
        </label>

        {selection && (
          <button className="btn btn-ghost wf-clear-btn" onClick={handleClearSelection}>
            {t('waveformEditor.clearSelection')}
          </button>
        )}

        {fileName && <span className="wf-filename" title={fileName}>{fileName}</span>}
      </div>

      {selection && (
        <div className="wf-selection-info">
          {t('waveformEditor.selectionInfo', {
            start: formatTimeDs(selection.start),
            end:   formatTimeDs(selection.end),
            dur:   formatTimeDs(selection.end - selection.start),
          })}
        </div>
      )}
    </div>
  )
}
