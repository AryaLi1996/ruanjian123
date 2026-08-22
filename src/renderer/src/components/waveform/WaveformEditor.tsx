import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin, { type Region } from 'wavesurfer.js/plugins/regions'
import TimelinePlugin from 'wavesurfer.js/plugins/timeline'
import HoverPlugin from 'wavesurfer.js/plugins/hover'
import { useWaveformStore } from '../../store/useWaveformStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { formatDuration, formatTimeDs } from '../../utils/audio'
import { hexToRgb } from '../../utils/color'

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

// ── Zoom (Ticket UI-04 §2) ───────────────────────────────────────────────
// Zoom is expressed in wavesurfer's own unit, pixels-per-second. The lower
// bound is computed per-file rather than fixed: "zoomed all the way out"
// should mean "the whole clip fits the container", which depends on both the
// clip's length and the current container width. MAX_PX_PER_SEC is high
// enough to resolve individual cycles of a low bass note.
const MAX_PX_PER_SEC  = 800
const ZOOM_STEP_RATIO = 1.35   // one +/- button press, and one wheel notch

// Fraction of a wheel notch's deltaY that maps to one zoom step, so trackpad
// pixel-deltas and mouse-wheel line-deltas land in roughly the same place.
const WHEEL_ZOOM_DIVISOR = 200

/** `#rrggbb` -> `rgba(r, g, b, alpha)`, falling back to the input on a parse failure. */
function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex)
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})` : hex
}

/** Reads a CSS custom property off :root, with a fallback for first paint. */
function readCssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

// Ticket UI-04 §3: the unplayed waveform is a vertical gradient of the theme
// accent at 0.5 alpha; the played portion is the same accent at full
// opacity. Both are re-derived whenever the accent or light/dark appearance
// changes, so the waveform tracks the global theme rather than pinning the
// indigo default it was originally written against. Reading the values back
// off :root keeps app.css the single source of truth for the palette.
function themeWaveColors(): { waveColor: string[]; progressColor: string; cursorColor: string } {
  const accent = readCssVar('--accent', '#6366f1')
  return {
    waveColor: [withAlpha(accent, 0.5), withAlpha(accent, 0.22)],
    progressColor: accent,
    cursorColor: readCssVar('--text', '#e2e8f0'),
  }
}

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

  const timelineRef = useRef<HTMLDivElement>(null)
  // Current zoom in px/sec, and the "everything fits" floor recomputed on
  // load/resize. `null` zoom means "follow fit" — the state the editor
  // starts in and returns to via Reset.
  const [zoom, setZoom]       = useState<number | null>(null)
  const [fitPxPerSec, setFitPxPerSec] = useState(0)
  const zoomRef = useRef<number | null>(null)
  useEffect(() => { zoomRef.current = zoom }, [zoom])

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
    // Timeline and Hover (wavesurfer 7's cursor plugin) per Ticket UI-04 §1.
    // The timeline renders into its own element above the waveform so it
    // isn't clipped by the waveform's scroll container when zoomed in.
    // No `insertPosition` here on purpose: the plugin only appends *into*
    // the given container when insertPosition is absent — with it set it
    // calls insertAdjacentElement, which would drop the timeline beside
    // .wf-timeline rather than inside it.
    const timeline = TimelinePlugin.create({
      container: timelineRef.current ?? undefined,
      height: 18,
      // Deciseconds are right for the hover cursor and the region readout,
      // but too noisy repeated across every timeline tick — m:ss here.
      formatTimeCallback: (sec) => formatDuration(sec),
      style: { fontSize: '10px', color: 'var(--text-muted)' },
    })
    const hover = HoverPlugin.create({
      lineWidth: 1,
      labelSize: 10,
      formatTimeCallback: (sec) => formatTimeDs(sec),
    })
    const ws = WaveSurfer.create({
      container,
      height: 96,
      ...themeWaveColors(),
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      // Zooming past "fit" has to be able to scroll horizontally, and
      // autoScroll keeps the playhead in view while it does.
      autoScroll: true,
      // Left at the default (off) — enableDragSelection below claims the
      // same click-and-drag gesture on the waveform to draw a region, and
      // the two would otherwise fight over it. Plain clicks still seek.
      plugins: [regions, timeline, hover],
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
      // Ticket UI-05 §4: the precise bounds ride on the region itself, so
      // they stay readable while dragging an edge instead of only in the
      // summary line below the waveform.
      const label = `${formatTimeDs(region.start)} - ${formatTimeDs(region.end)}`
      if (region.content?.textContent !== label) region.setContent(label)
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
    // Ticket UI-05 §3: double-clicking the selection clears it. Removal is
    // enough — the region-removed handler above resets the store.
    const unsubDblClick = regions.on('region-double-clicked', (region, event) => {
      event.stopPropagation()
      region.remove()
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
      unsubCreated(); unsubUpdated(); unsubRemoved(); unsubDblClick(); unsubOut()
      unsubReady(); unsubTime(); unsubPlay(); unsubPause(); unsubFinish(); unsubError()
      ws.destroy()
      wsRef.current = null
      regionsRef.current = null
      if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null }
    }
    // Registered once — zustand setter functions are referentially stable
    // across renders, so this intentionally doesn't depend on them.
  }, [])

  // ── Zoom (Ticket UI-04 §2) ─────────────────────────────────────────
  // "Zoomed out" means the whole clip fits, which depends on the clip's
  // length *and* the live container width — so the floor is recomputed on
  // load and on every resize rather than being a constant.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !ready || duration <= 0) return

    const recomputeFit = (): void => {
      const width = container.clientWidth
      if (width > 0) setFitPxPerSec(width / duration)
    }
    recomputeFit()
    const observer = new ResizeObserver(recomputeFit)
    observer.observe(container)
    return () => observer.disconnect()
  }, [ready, duration])

  // Applies the current zoom to wavesurfer. A null zoom follows the fit
  // floor, which is also what keeps the waveform filling the container as
  // the window resizes while the user hasn't zoomed in.
  useEffect(() => {
    const ws = wsRef.current
    if (!ws || !ready || fitPxPerSec <= 0) return
    try {
      ws.zoom(zoom ?? fitPxPerSec)
    } catch {
      // wavesurfer throws if the instance is mid-teardown or has no decoded
      // data yet; the next zoom/ready pass re-applies it.
    }
  }, [zoom, fitPxPerSec, ready])

  const applyZoom = useCallback((next: number) => {
    const floor = fitPxPerSec > 0 ? fitPxPerSec : 1
    setZoom(Math.max(floor, Math.min(MAX_PX_PER_SEC, next)))
  }, [fitPxPerSec])

  const zoomBy = useCallback((ratio: number) => {
    applyZoom((zoomRef.current ?? fitPxPerSec) * ratio)
  }, [applyZoom, fitPxPerSec])

  // Ctrl+wheel zooming (Ticket UI-04 §2). Deliberately gated on Ctrl rather
  // than using wavesurfer's ZoomPlugin, which claims the plain wheel — that
  // would make it impossible to scroll a zoomed-in waveform. Wheel events
  // arrive far faster than frames, so they're accumulated and applied once
  // per rAF (the ticket's "use requestAnimationFrame for smooth zoom").
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let pending = 0
    let frame: number | null = null

    const flush = (): void => {
      frame = null
      const delta = pending
      pending = 0
      if (delta === 0) return
      zoomBy(Math.pow(ZOOM_STEP_RATIO, -delta / WHEEL_ZOOM_DIVISOR))
    }

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return   // plain wheel keeps scrolling
      event.preventDefault()
      pending += event.deltaY
      if (frame === null) frame = requestAnimationFrame(flush)
    }

    // Not passive: the whole point is to preventDefault the browser's own
    // ctrl+wheel page zoom.
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      container.removeEventListener('wheel', onWheel)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [zoomBy])

  // Ticket UI-04 §3: follow the global theme. The accent is user-settable
  // and the palette flips with light/dark, so the waveform's colours are
  // re-derived whenever either changes rather than being fixed at create
  // time. Reading them back off :root keeps one source of truth (app.css)
  // instead of duplicating the palette here.
  const accentColor        = useSettingsStore((s) => s.accentColor)
  const resolvedAppearance = useSettingsStore((s) => s.resolvedAppearance)
  useEffect(() => {
    wsRef.current?.setOptions(themeWaveColors())
  }, [accentColor, resolvedAppearance])

  // Loads `url` into wavesurfer.
  //
  // Ticket UI-04 §4 asked for chunked decoding to keep big files from
  // stalling the UI. Measured against a 52MB / 5-minute WAV, precomputing
  // peaks ourselves (decodeAudioData + a yielding reduction, handed over via
  // `load(url, peaks, duration)`) was no faster to first paint than letting
  // wavesurfer do it — ~1048ms vs ~1023ms over three runs each — and
  // materially *worse* for stutter: worst frame gap 383/67/483ms with two
  // stalls over 250ms, against 117/67/100ms and none for the direct path.
  // wavesurfer 7 already decodes off the main thread; adding a second full
  // decode in front of it only bought jank, so the direct path is what ships.
  const loadIntoWaveSurfer = useCallback(async (url: string) => {
    const ws = wsRef.current
    if (!ws) return
    // Every load starts from "fit" rather than inheriting the previous
    // clip's zoom, which would be meaningless against a different duration.
    setZoom(null)
    await ws.load(url)
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
      await loadIntoWaveSurfer(url)
    } catch (err) {
      setLoadError(String(err))
    }
  }, [clearSelection, loadIntoWaveSurfer, setFileName, setFilePath, t])

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
      await loadIntoWaveSurfer(url)
    } catch (err) {
      setLoadError(String(err))
    }
  }, [clearSelection, loadIntoWaveSurfer, setFileName, setFilePath])

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

  // Toolbar state derived from the zoom pair. `effectiveZoom` is what's
  // actually applied — the fit floor while the user hasn't zoomed in.
  const zoomEnabled  = hasFile && ready && fitPxPerSec > 0
  const effectiveZoom = zoom ?? fitPxPerSec
  const zoomedIn     = zoomEnabled && effectiveZoom > fitPxPerSec * 1.01
  const canZoomIn    = zoomEnabled && effectiveZoom < MAX_PX_PER_SEC * 0.99
  const zoomSliderValue = zoomEnabled && MAX_PX_PER_SEC > fitPxPerSec
    ? Math.round(1000 * Math.log(effectiveZoom / fitPxPerSec) / Math.log(MAX_PX_PER_SEC / fitPxPerSec))
    : 0
  const zoomFactorLabel = zoomEnabled ? `${(effectiveZoom / fitPxPerSec).toFixed(1)}×` : '—'

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

      {/* Zoom controls (Ticket UI-04 §2). Disabled until a clip is decoded —
          px-per-second has no meaning without a duration. */}
      <div className="wf-zoom-bar">
        <span className="wf-zoom-label">{t('waveformEditor.zoom')}</span>
        <button
          type="button"
          className="btn btn-ghost wf-zoom-btn"
          onClick={() => zoomBy(1 / ZOOM_STEP_RATIO)}
          disabled={!zoomEnabled || !zoomedIn}
          aria-label={t('waveformEditor.zoomOut')}
          title={t('waveformEditor.zoomOut')}
        >
          −
        </button>
        <input
          type="range"
          className="wf-zoom-slider"
          min={0}
          max={1000}
          value={zoomSliderValue}
          disabled={!zoomEnabled}
          onChange={(e) => {
            // Exponential: a linear slider over px/sec would spend most of
            // its travel in a zoom range nobody uses.
            const ratio = Number(e.target.value) / 1000
            applyZoom(fitPxPerSec * Math.pow(MAX_PX_PER_SEC / fitPxPerSec, ratio))
          }}
          aria-label={t('waveformEditor.zoom')}
        />
        <button
          type="button"
          className="btn btn-ghost wf-zoom-btn"
          onClick={() => zoomBy(ZOOM_STEP_RATIO)}
          disabled={!zoomEnabled || !canZoomIn}
          aria-label={t('waveformEditor.zoomIn')}
          title={t('waveformEditor.zoomIn')}
        >
          +
        </button>
        <button
          type="button"
          className="btn btn-ghost wf-zoom-reset"
          onClick={() => setZoom(null)}
          disabled={!zoomEnabled || !zoomedIn}
          title={t('waveformEditor.zoomReset')}
        >
          {t('waveformEditor.zoomFit')}
        </button>
        <span className="wf-zoom-readout">{zoomFactorLabel}</span>
        <span className="wf-zoom-hint">{t('waveformEditor.zoomHint')}</span>
      </div>

      <div
        className={`wf-shell${dragging ? ' drag-over' : ''}`}
        onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
        onDragOver={(e)  => { e.preventDefault(); setDragging(true) }}
        onDragLeave={()  => setDragging(false)}
        onDrop={handleDrop}
      >
        {/* Timeline renders here rather than inside the waveform's own scroll
            container, so it isn't clipped when zoomed in. */}
        <div ref={timelineRef} className="wf-timeline" />
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
