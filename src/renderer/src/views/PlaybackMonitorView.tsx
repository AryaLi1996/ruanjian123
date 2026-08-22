import { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store/useAppStore'
import { useSettingsStore } from '../store/useSettingsStore'
import { useSubscriptionStore } from '../store/useSubscriptionStore'
import { usePlayerStore } from '../store/usePlayerStore'
import { formatDuration, pcmToWavBlob } from '../utils/audio'
import { computePeaks, drawWaveform, crossCorrelateOffset } from '../utils/waveform'
import { parseLRC, findLyricIndex, extractEmbeddedLyrics, type LyricLine } from '../utils/lrc'
import { extractEmbeddedMetadata, parseArtistTitleFromFilename } from '../utils/metadata'
import { LyricsPanel } from '../components/playback/LyricsPanel'
import { SongList } from '../components/playback/SongList'
import { NowPlayingCard } from '../components/playback/NowPlayingCard'
import { stemLabelKey } from '../utils/stems'

type TrackKind = 'original' | 'stem' | 'cover' | 'recording'
type SepMode = 'standard' | 'enhanced'

interface Track {
  id:       string
  kind:     TrackKind
  label:    string
  color:    string
  buffer:   AudioBuffer
  peaks:    Float32Array
  volume:   number
  muted:    boolean
  solo:     boolean
  offsetSec: number   // A/B auto-align shift, seconds
}

interface Song {
  id:           string
  name:         string
  artist:       string | null
  duration:     number
  tracks:       Track[]
  lyrics:       LyricLine[]
  originalPath: string | null
  coverArtUrl:  string | null
  liked:        boolean
  addedAt:      number
}

const TRACK_COLORS = ['#6366f1', '#22d3ee', '#f59e0b', '#ec4899', '#34d399', '#a855f7']
const PX_PER_SEC_BASE = 40
const PEAK_BUCKETS = 3000

let colorCursor = 0
function nextColor(): string {
  const c = TRACK_COLORS[colorCursor % TRACK_COLORS.length]
  colorCursor++
  return c
}

function makeTrack(kind: TrackKind, label: string, buffer: AudioBuffer): Track {
  return {
    id: crypto.randomUUID(), kind, label, color: nextColor(),
    buffer, peaks: computePeaks(buffer, PEAK_BUCKETS),
    volume: 0.85, muted: false, solo: false, offsetSec: 0,
  }
}

// Every kind is re-localized on every render instead of trusting the label baked in
// at creation time (which would stay stuck in whatever language was active when the
// track was added). 'stem' tracks store the raw engine stem identifier (vocals/
// accompaniment/lead_dry/harmony_dry — see engine/separation.py) in `label`, which
// stemLabelKey() maps to a `tracks.*` translation key (Ticket 46).
function trackLabel(tr: Track, t: (key: string) => string): string {
  switch (tr.kind) {
    case 'original':  return t('playback.original')
    case 'cover':     return t('playback.cover')
    case 'recording': return t('playback.recordedClip')
    default:          return t(stemLabelKey(tr.label))
  }
}

async function decodeFile(file: File, ctx: AudioContext): Promise<AudioBuffer> {
  const buf = await file.arrayBuffer()
  return ctx.decodeAudioData(buf.slice(0))
}

async function decodePath(path: string, ctx: AudioContext): Promise<AudioBuffer> {
  const raw = await window.engine.readFile(path)
  return ctx.decodeAudioData(raw.slice(0))
}

export function PlaybackMonitorView(): JSX.Element {
  const { t } = useTranslation()
  const setEngineBusy   = useAppStore((s) => s.setEngineBusy)
  const setEngineStatus = useAppStore((s) => s.setEngineStatus)

  const [songs, setSongs] = useState<Song[]>([])
  const [activeSongId, setActiveSongId] = useState<string | null>(null)
  const [songListOpen, setSongListOpen] = useState(true)
  const [tracksOpen, setTracksOpen] = useState(true)
  const [nowPlayingHeight, setNowPlayingHeight] = useState(360)
  const resizingRef = useRef(false)
  const [loadingSong, setLoadingSong] = useState(false)

  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [masterVolume, setMasterVolume] = useState(0.85)
  const [loopPlayback, setLoopPlayback] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [sepMode, setSepMode] = useState<SepMode>('standard')
  const [separating, setSeparating] = useState(false)

  // A/B comparison
  const [trackAId, setTrackAId] = useState<string | null>(null)
  const [trackBId, setTrackBId] = useState<string | null>(null)
  const [activeAB, setActiveAB] = useState<'A' | 'B'>('A')
  const [aligning, setAligning] = useState(false)
  const [alignResult, setAlignResult] = useState<number | null>(null)

  // Recording
  const [recording, setRecording] = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const [micError, setMicError] = useState<string | null>(null)

  // Lyrics
  const [lyricsCollapsed, setLyricsCollapsed] = useState(false)
  const [currentLyricIndex, setCurrentLyricIndex] = useState(-1)
  const lyricsRef = useRef<LyricLine[]>([])
  const currentLyricIndexRef = useRef(-1)

  const subStatus = useSubscriptionStore((s) => s.status)
  const onlineSearchAllowed = subStatus === 'active' || subStatus === 'grace_period'
  const autoLyricsEnabled = useSettingsStore((s) => s.autoLyricsEnabled)

  const activeSong = songs.find((s) => s.id === activeSongId) ?? null
  const tracks = activeSong?.tracks ?? []
  const lyrics = activeSong?.lyrics ?? []

  useEffect(() => { lyricsRef.current = lyrics }, [lyrics])

  // ── Playback engine refs ──────────────────────────────────
  const playCtxRef     = useRef<AudioContext | null>(null)
  const gainNodesRef   = useRef<Map<string, GainNode>>(new Map())
  const sourceNodesRef = useRef<Map<string, AudioBufferSourceNode>>(new Map())
  const playStartRef   = useRef(0)
  const playOffsetRef  = useRef(0)
  const rafRef         = useRef<number | null>(null)
  const tracksRef      = useRef<Track[]>([])
  useEffect(() => { tracksRef.current = tracks }, [tracks])
  const masterVolumeRef = useRef(masterVolume)
  const loopPlaybackRef = useRef(loopPlayback)
  useEffect(() => { masterVolumeRef.current = masterVolume }, [masterVolume])
  useEffect(() => { loopPlaybackRef.current = loopPlayback }, [loopPlayback])
  const songsRef        = useRef<Song[]>([])
  useEffect(() => { songsRef.current = songs }, [songs])

  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null)

  // ── Recording engine refs ─────────────────────────────────
  const micCtxRef    = useRef<AudioContext | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const analyserRef  = useRef<AnalyserNode | null>(null)
  const recorderRef  = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const recCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const micRafRef    = useRef<number | null>(null)
  const lastDrawRef  = useRef(0)
  const recTimerRef  = useRef<number | null>(null)

  const engineBusy = useAppStore((s) => s.engineBusy)
  const engineBusyRef = useRef(engineBusy)
  useEffect(() => { engineBusyRef.current = engineBusy }, [engineBusy])

  function ensurePlayCtx(): AudioContext {
    if (!playCtxRef.current) playCtxRef.current = new AudioContext()
    return playCtxRef.current
  }

  function getGain(id: string, ctx: AudioContext): GainNode {
    let g = gainNodesRef.current.get(id)
    if (!g) { g = ctx.createGain(); g.connect(ctx.destination); gainNodesRef.current.set(id, g) }
    return g
  }

  function applyGains(): void {
    const list = tracksRef.current
    const anySolo = list.some((tr) => tr.solo)
    for (const tr of list) {
      const g = gainNodesRef.current.get(tr.id)
      if (!g) continue
      const audible = anySolo ? tr.solo : !tr.muted
      g.gain.value = audible ? tr.volume * masterVolumeRef.current : 0
    }
  }

  useEffect(() => { applyGains() }, [masterVolume])

  // ── Transport ──────────────────────────────────────────────
  function stopSources(): void {
    sourceNodesRef.current.forEach((src) => { try { src.stop() } catch { /* already stopped */ } })
    sourceNodesRef.current.clear()
  }

  const play = useCallback((fromSec: number) => {
    const ctx = ensurePlayCtx()
    stopSources()
    const now = ctx.currentTime
    playStartRef.current = now
    playOffsetRef.current = fromSec

    for (const tr of tracksRef.current) {
      const g = getGain(tr.id, ctx)
      const bufferPos = fromSec - tr.offsetSec
      if (bufferPos >= tr.buffer.duration) continue
      const src = ctx.createBufferSource()
      src.buffer = tr.buffer
      src.connect(g)
      if (bufferPos >= 0) src.start(now, bufferPos)
      else src.start(now + (-bufferPos), 0)
      sourceNodesRef.current.set(tr.id, src)
    }
    applyGains()
    setPlaying(true)

    const loop = (): void => {
      const elapsed = ctx.currentTime - playStartRef.current
      const pos = playOffsetRef.current + elapsed
      setPlayhead(pos)
      updateLyricIndex(pos)
      const maxDur = Math.max(0, ...tracksRef.current.map((tr) => tr.buffer.duration + tr.offsetSec))
      if (pos >= maxDur && maxDur > 0) {
        if (loopPlaybackRef.current) { play(0); return }
        pause(); setPlayhead(maxDur); return
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function updateLyricIndex(timeSec: number): void {
    const idx = findLyricIndex(lyricsRef.current, timeSec)
    if (idx !== currentLyricIndexRef.current) {
      currentLyricIndexRef.current = idx
      setCurrentLyricIndex(idx)
    }
  }

  function pause(): void {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    stopSources()
    setPlaying(false)
  }

  function togglePlay(): void {
    if (playing) { pause(); return }
    play(playhead)
  }

  function stop(): void {
    pause()
    setPlayhead(0)
    updateLyricIndex(0)
  }

  function seek(sec: number): void {
    const clamped = Math.max(0, sec)
    if (playing) play(clamped)
    else { setPlayhead(clamped); updateLyricIndex(clamped) }
  }

  // ── Song / track management ────────────────────────────────
  function patchSong(songId: string, patch: (song: Song) => Song): void {
    setSongs((prev) => prev.map((s) => s.id === songId ? patch(s) : s))
  }

  function addTrackToSong(songId: string, track: Track): void {
    patchSong(songId, (s) => ({ ...s, tracks: [...s.tracks, track] }))
  }

  /** Detaches the previous song's audio graph so gain nodes never leak between songs. */
  function resetPlaybackState(): void {
    pause()
    setPlayhead(0)
    currentLyricIndexRef.current = -1
    setCurrentLyricIndex(-1)
    setTrackAId(null); setTrackBId(null); setAlignResult(null)
    gainNodesRef.current.forEach((g) => g.disconnect())
    gainNodesRef.current.clear()
  }

  function selectSong(id: string): void {
    if (id === activeSongId) return
    resetPlaybackState()
    setActiveSongId(id)
  }

  function removeSong(id: string): void {
    setSongs((prev) => {
      const song = prev.find((s) => s.id === id)
      if (song?.coverArtUrl) URL.revokeObjectURL(song.coverArtUrl)
      return prev.filter((s) => s.id !== id)
    })
    if (id === activeSongId) {
      resetPlaybackState()
      setActiveSongId(null)
    }
  }

  function toggleLike(id: string): void {
    patchSong(id, (s) => ({ ...s, liked: !s.liked }))
  }

  async function showInFolder(path: string): Promise<void> {
    await window.engine.showInFolder(path)
  }

  function removeTrack(id: string): void {
    if (!activeSong) return
    gainNodesRef.current.get(id)?.disconnect()
    gainNodesRef.current.delete(id)
    sourceNodesRef.current.get(id)?.stop()
    sourceNodesRef.current.delete(id)
    patchSong(activeSong.id, (s) => ({ ...s, tracks: s.tracks.filter((tr) => tr.id !== id) }))
    if (trackAId === id) setTrackAId(null)
    if (trackBId === id) setTrackBId(null)
  }

  function patchTrack(id: string, patch: Partial<Track>): void {
    if (!activeSong) return
    patchSong(activeSong.id, (s) => ({
      ...s,
      tracks: s.tracks.map((tr) => tr.id === id ? { ...tr, ...patch } : tr),
    }))
    // Live-apply volume/mute/solo without waiting for the effect below
    requestAnimationFrame(applyGains)
  }

  useEffect(() => { applyGains() }, [tracks])

  // ── Loading files ──────────────────────────────────────────
  async function addSong(file: File): Promise<void> {
    setLoadingSong(true)
    try {
      const ctx = ensurePlayCtx()
      const buffer = await decodeFile(file, ctx)
      const track = makeTrack('original', t('playback.original'), buffer)
      const [embedded, meta] = await Promise.all([
        extractEmbeddedLyrics(file),
        extractEmbeddedMetadata(file),
      ])

      const buf = await file.arrayBuffer()
      const dir = await window.engine.saveTrainingFiles([{ name: file.name, buffer: buf }])

      // Song identification (Ticket 43 §1): embedded tags first, filename
      // pattern ("Artist - Title.ext") as the fallback when a tag is missing.
      // Blank (not just missing) treated the same as missing — some Vorbis
      // comments come through as an empty string (e.g. a bare "ARTIST=") rather
      // than absent, which `??` alone wouldn't catch.
      const filenameGuess = parseArtistTitleFromFilename(file.name)
      const metaTitle = meta.title?.trim() || null
      const metaArtist = meta.artist?.trim() || null
      const song: Song = {
        id: crypto.randomUUID(),
        name: metaTitle ?? filenameGuess.title ?? file.name.replace(/\.[^.]+$/, ''),
        artist: metaArtist ?? filenameGuess.artist,
        duration: buffer.duration,
        tracks: [track],
        lyrics: embedded ?? [],
        originalPath: `${dir}/${file.name}`,
        coverArtUrl: meta.coverArtUrl,
        liked: false,
        addedAt: Date.now(),
      }
      setSongs((prev) => [...prev, song])
      resetPlaybackState()
      setActiveSongId(song.id)
    } finally {
      setLoadingSong(false)
    }
  }

  async function importLyricsFile(file: File): Promise<void> {
    if (!activeSong) return
    const text = await file.text()
    const parsed = parseLRC(text)
    patchSong(activeSong.id, (s) => ({ ...s, lyrics: parsed }))
    lyricsRef.current = parsed
    updateLyricIndex(playhead)
  }

  function applySearchedLyrics(parsed: LyricLine[]): void {
    if (!activeSong) return
    patchSong(activeSong.id, (s) => ({ ...s, lyrics: parsed }))
    lyricsRef.current = parsed
    updateLyricIndex(playhead)
  }

  async function loadCover(file: File): Promise<void> {
    if (!activeSong) return
    const ctx = ensurePlayCtx()
    const buffer = await decodeFile(file, ctx)
    addTrackToSong(activeSong.id, makeTrack('cover', t('playback.cover'), buffer))
  }

  async function runSeparation(): Promise<void> {
    if (!activeSong?.originalPath) return
    const songId = activeSong.id
    setSeparating(true); setEngineBusy(true); setEngineStatus(t('status.separating'))
    try {
      const res = await window.engine.call('separate', {
        mode: sepMode, input_path: activeSong.originalPath,
      }) as { stems: Record<string, string> }

      const ctx = ensurePlayCtx()
      for (const [key, path] of Object.entries(res.stems)) {
        try {
          const buffer = await decodePath(path, ctx)
          addTrackToSong(songId, makeTrack('stem', key, buffer))
        } catch { /* skip unavailable stem */ }
      }
    } finally {
      setSeparating(false); setEngineBusy(false); setEngineStatus(t('status.idle'))
    }
  }

  // ── A/B comparison ─────────────────────────────────────────
  function switchAB(): void {
    if (!trackAId || !trackBId || !activeSong) return
    const next = activeAB === 'A' ? 'B' : 'A'
    setActiveAB(next)
    patchSong(activeSong.id, (s) => ({
      ...s,
      tracks: s.tracks.map((tr) => {
        if (tr.id === trackAId) return { ...tr, muted: next !== 'A' }
        if (tr.id === trackBId) return { ...tr, muted: next !== 'B' }
        return tr
      }),
    }))
    requestAnimationFrame(applyGains)
  }

  async function autoAlign(): Promise<void> {
    if (!trackAId || !trackBId) return
    const a = tracks.find((tr) => tr.id === trackAId)
    const b = tracks.find((tr) => tr.id === trackBId)
    if (!a || !b) return
    setAligning(true)
    try {
      const lag = await new Promise<number>((resolve) => {
        setTimeout(() => resolve(crossCorrelateOffset(a.buffer, b.buffer)), 0)
      })
      patchTrack(b.id, { offsetSec: lag })
      setAlignResult(lag)
    } finally {
      setAligning(false)
    }
  }

  // ── Recording ────────────────────────────────────────────
  async function startRecording(): Promise<void> {
    setMicError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      micStreamRef.current = stream
      const ctx = new AudioContext()
      micCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)
      analyserRef.current = analyser

      recChunksRef.current = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (e) => { if (e.data.size > 0) recChunksRef.current.push(e.data) }
      recorderRef.current = recorder
      recorder.start()

      setRecording(true); setRecSeconds(0)
      const startedAt = Date.now()
      recTimerRef.current = window.setInterval(() => {
        setRecSeconds((Date.now() - startedAt) / 1000)
      }, 250)

      drawMicWaveform()
    } catch (err) {
      setMicError(String(err))
    }
  }

  function drawMicWaveform(): void {
    const analyser = analyserRef.current
    const canvas = recCanvasRef.current
    if (!analyser || !canvas) return
    const data = new Uint8Array(analyser.fftSize)

    const loop = (now: number): void => {
      micRafRef.current = requestAnimationFrame(loop)
      const interval = engineBusyRef.current ? 1000 / 30 : 1000 / 60
      if (now - lastDrawRef.current < interval) return
      lastDrawRef.current = now

      analyser.getByteTimeDomainData(data)
      const ctx2d = canvas.getContext('2d')
      if (!ctx2d) return
      const w = canvas.width, h = canvas.height
      ctx2d.fillStyle = '#121212'
      ctx2d.fillRect(0, 0, w, h)
      // Neutral slate, not accent — the waveform trace itself should stay
      // out of the way so accent-coloured elements (record button, playhead
      // elsewhere) are what draws the eye (Ticket 29 §6).
      ctx2d.strokeStyle = '#64748b'
      ctx2d.lineWidth = 1.5
      ctx2d.beginPath()
      const step = w / data.length
      for (let i = 0; i < data.length; i++) {
        const v = data[i] / 128 - 1
        const x = i * step
        const y = h / 2 + v * (h / 2 - 2)
        if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y)
      }
      ctx2d.stroke()
    }
    micRafRef.current = requestAnimationFrame(loop)
  }

  async function stopRecording(): Promise<void> {
    const recorder = recorderRef.current
    if (!recorder) return
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })
    recorder.stop()
    await stopped
    cleanupRecording()

    const blob = new Blob(recChunksRef.current, { type: recorder.mimeType })
    const ctx = ensurePlayCtx()
    const arrayBuf = await blob.arrayBuffer()
    const decoded = await ctx.decodeAudioData(arrayBuf)
    const samples = decoded.getChannelData(0)
    const wavBlob = pcmToWavBlob(samples, decoded.sampleRate)
    const name = `recording-${Date.now()}.wav`

    if (activeSong) {
      addTrackToSong(activeSong.id, makeTrack('recording', t('playback.recordedClip'), decoded))
    }

    const savedPath = await window.engine.saveRecording(await wavBlob.arrayBuffer(), name)
    if (savedPath) setEngineStatus(t('status.saved', { path: savedPath }))
  }

  function cleanupRecording(): void {
    if (recTimerRef.current != null) { clearInterval(recTimerRef.current); recTimerRef.current = null }
    if (micRafRef.current != null) { cancelAnimationFrame(micRafRef.current); micRafRef.current = null }
    micStreamRef.current?.getTracks().forEach((tr) => tr.stop())
    micStreamRef.current = null
    micCtxRef.current?.close()
    micCtxRef.current = null
    recorderRef.current = null
    setRecording(false)
  }

  // ── Global player bar bridge (Ticket UI-02 §4) ────────────
  // This view owns the audio graph; the persistent bottom bar is a view over
  // usePlayerStore. Publish what it renders, and register the three commands
  // it dispatches. See usePlayerStore's header for why the engine stays here
  // rather than moving into the store.
  //
  // The transport commands are read through a ref so the registration below
  // can run once on mount: togglePlay/stop/seek are re-created every render
  // (they close over `playing`/`playhead`), and re-registering on each of
  // those would churn the store 60×/second during playback.
  const transportRef = useRef({ togglePlay, stop, seek, setVolume: setMasterVolume, setLoop: setLoopPlayback })
  transportRef.current = { togglePlay, stop, seek, setVolume: setMasterVolume, setLoop: setLoopPlayback }

  useEffect(() => {
    return usePlayerStore.getState().registerControls({
      togglePlay: () => transportRef.current.togglePlay(),
      stop:       () => transportRef.current.stop(),
      seek:       (sec) => transportRef.current.seek(sec),
      setVolume:  (volume) => transportRef.current.setVolume(volume),
      setLoop:    (loop) => transportRef.current.setLoop(loop),
    })
  }, [])

  useEffect(() => {
    usePlayerStore.getState().setNowPlaying({
      title:       activeSong?.name ?? null,
      artist:      activeSong?.artist ?? null,
      coverArtUrl: activeSong?.coverArtUrl ?? null,
    })
  }, [activeSong?.name, activeSong?.artist, activeSong?.coverArtUrl])

  // `playhead` updates every animation frame while playing, so publishing it
  // straight through would re-render the player bar at 60fps for a readout
  // that only shows whole seconds. Push play/pause and duration changes
  // through immediately, and let position ride a 250ms interval instead.
  const playheadRef = useRef(playhead)
  playheadRef.current = playhead
  const trackDuration = Math.max(0, ...tracks.map((tr) => tr.buffer.duration + tr.offsetSec))

  useEffect(() => {
    const publish = (): void => usePlayerStore.getState().setTransport({
      playing,
      position: playheadRef.current,
      duration: trackDuration,
    })
    publish()
    if (!playing) return
    const id = setInterval(publish, 250)
    return () => clearInterval(id)
  }, [playing, trackDuration])

  // ── Cleanup everything on unmount ─────────────────────────
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      stopSources()
      playCtxRef.current?.close()
      cleanupRecording()
      for (const s of songsRef.current) if (s.coverArtUrl) URL.revokeObjectURL(s.coverArtUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Waveform drawing ───────────────────────────────────────
  const maxDuration = Math.max(1, ...tracks.map((tr) => tr.buffer.duration + tr.offsetSec))
  const pxPerSec = PX_PER_SEC_BASE * zoom
  const canvasWidth = Math.max(600, Math.ceil(maxDuration * pxPerSec))
  const canvasHeight = Math.max(120, Math.min(280, tracks.length * 64))

  useEffect(() => {
    const canvas = waveCanvasRef.current
    if (!canvas) return
    canvas.width = canvasWidth
    canvas.height = canvasHeight
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return
    ctx2d.fillStyle = '#121212'
    ctx2d.fillRect(0, 0, canvasWidth, canvasHeight)

    tracks.forEach((tr, i) => {
      const trackH = canvasHeight / Math.max(1, tracks.length)
      const offsetPx = tr.offsetSec * pxPerSec
      const sub = document.createElement('canvas')
      sub.width = Math.max(1, Math.round(tr.buffer.duration * pxPerSec))
      sub.height = trackH
      drawWaveform(sub, tr.peaks, tr.color, { background: 'transparent' })
      ctx2d.globalAlpha = tr.muted ? 0.25 : 0.95
      ctx2d.drawImage(sub, offsetPx, i * trackH)
      ctx2d.globalAlpha = 1
    })
  }, [tracks, canvasWidth, canvasHeight, pxPerSec])

  function startResize(e: React.MouseEvent): void {
    e.preventDefault()
    resizingRef.current = true
    const startY = e.clientY
    const startHeight = nowPlayingHeight
    const onMove = (ev: MouseEvent): void => {
      if (!resizingRef.current) return
      setNowPlayingHeight(Math.max(220, Math.min(620, startHeight + (ev.clientY - startY))))
    }
    const onUp = (): void => {
      resizingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function handleWaveClick(e: React.MouseEvent<HTMLCanvasElement>): void {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    seek((e.clientX - rect.left) / pxPerSec)
  }

  const coverInputRef = useRef<HTMLInputElement>(null)

  function handleSongFiles(files: FileList | null): void {
    const list = Array.from(files ?? []).filter(
      (f) => f.type.startsWith('audio/') || /\.(wav|flac|ogg|mp3|m4a)$/i.test(f.name)
    )
    for (const file of list) void addSong(file)
  }

  return (
    <>
      <div className="view-header pbm-header">
        <div>
          <h1 className="view-title">{t('playback.title')}</h1>
          <p className="view-desc">{t('playback.description')}</p>
        </div>
        <button className="btn btn-ghost" onClick={() => setSongListOpen((v) => !v)}>
          {songListOpen ? `◀ ${t('playback.hideSongs')}` : `▶ ${t('playback.showSongs')}`}
        </button>
      </div>

      <div className={`pbm-grid${songListOpen ? '' : ' no-songs'}`}>
        {/* ── Left: song list ─────────────────────────────── */}
        {songListOpen && (
          <SongList
            songs={songs}
            activeSongId={activeSongId}
            playing={playing}
            loading={loadingSong}
            onSelect={selectSong}
            onRemove={removeSong}
            onShowInFolder={(path) => void showInFolder(path)}
            onAddFiles={handleSongFiles}
          />
        )}

        {/* ── Center: now playing/lyrics + waveform + transport + tracks ── */}
        <section className="pbm-center">
          <div className="pbm-now-lyrics-split" style={{ height: nowPlayingHeight }}>
            <NowPlayingCard
              title={activeSong?.name ?? null}
              artist={activeSong?.artist ?? null}
              coverArtUrl={activeSong?.coverArtUrl ?? null}
              liked={activeSong?.liked ?? false}
              onToggleLike={() => { if (activeSong) toggleLike(activeSong.id) }}
            />
            <LyricsPanel
              lines={lyrics}
              currentIndex={currentLyricIndex}
              collapsed={lyricsCollapsed}
              onToggleCollapse={() => setLyricsCollapsed((c) => !c)}
              onSeek={seek}
              onImportFile={(file) => void importLyricsFile(file)}
              onImportLyrics={(parsed) => applySearchedLyrics(parsed)}
              songId={activeSong?.id ?? null}
              songTitle={activeSong?.name ?? ''}
              songArtist={activeSong?.artist ?? null}
              songDuration={activeSong?.duration ?? 0}
              onlineSearchAllowed={onlineSearchAllowed}
              autoLyricsEnabled={autoLyricsEnabled}
              coverArtUrl={activeSong?.coverArtUrl ?? null}
            />
          </div>

          <div className="pbm-resizer" onMouseDown={startResize}
            role="separator" aria-orientation="horizontal" aria-label={t('playback.dragResize')} />

          <div className="pbm-panel-title pbm-monitoring-title">{t('playback.monitoring')}</div>

          <div className="card pbm-wave-card">
            <div className="pbm-toolbar-row">
              <span className="pbm-current-song" title={activeSong?.name}>
                {activeSong ? activeSong.name : t('playback.noSongSelected')}
              </span>
              <div className="pbm-toolbar-actions">
                <select className="select pbm-mode-select" value={sepMode}
                  onChange={(e) => setSepMode(e.target.value as SepMode)}
                  disabled={separating || !activeSong}>
                  <option value="standard">{t('playback.standard')}</option>
                  <option value="enhanced">{t('playback.enhanced')}</option>
                </select>
                <button className="btn btn-ghost" onClick={() => void runSeparation()}
                  disabled={separating || !activeSong?.originalPath}>
                  {separating ? t('playback.separating') : t('playback.separate')}
                </button>
                <button className="btn btn-ghost" onClick={() => coverInputRef.current?.click()}
                  disabled={!activeSong}>
                  {t('playback.loadCover')}
                </button>
                <input ref={coverInputRef} type="file" accept="audio/*" style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadCover(f) }} />
              </div>
            </div>

            <div className="pbm-scroll">
              <div style={{ position: 'relative', width: canvasWidth }}>
                <canvas ref={waveCanvasRef} onClick={handleWaveClick} className="pbm-canvas" />
                <div className="pbm-playhead" style={{ left: playhead * pxPerSec }} />
              </div>
            </div>

            <div className="pbm-transport">
              <button className="player-play-btn" onClick={togglePlay} disabled={!tracks.length}
                title={playing ? t('playback.pause') : t('playback.play')}>
                {playing ? '⏸' : '▶'}
              </button>
              <button className="btn btn-ghost" onClick={stop} disabled={!tracks.length}>
                {t('playback.stop')}
              </button>
              <span className="pbm-time">
                {formatDuration(playhead)} / {formatDuration(maxDuration)}
              </span>
              <div className="pbm-transport-spacer" />
              <button className="btn btn-ghost" onClick={() => setZoom((z) => Math.max(0.25, z / 1.5))}>
                − {t('playback.zoomOut')}
              </button>
              <button className="btn btn-ghost" onClick={() => setZoom((z) => Math.min(8, z * 1.5))}>
                + {t('playback.zoomIn')}
              </button>
            </div>

            <div className="pbm-ab-row">
              <span className="pbm-ab-label">{t('playback.abTitle')}</span>
              <select className="select" value={trackAId ?? ''}
                onChange={(e) => setTrackAId(e.target.value || null)}>
                <option value="">{t('playback.trackA')}</option>
                {tracks.map((tr) => <option key={tr.id} value={tr.id}>{trackLabel(tr, t)}</option>)}
              </select>
              <select className="select" value={trackBId ?? ''}
                onChange={(e) => setTrackBId(e.target.value || null)}>
                <option value="">{t('playback.trackB')}</option>
                {tracks.map((tr) => <option key={tr.id} value={tr.id}>{trackLabel(tr, t)}</option>)}
              </select>
              <button className="btn btn-ghost" disabled={!trackAId || !trackBId} onClick={switchAB}>
                {t('playback.switchAB')} ({activeAB})
              </button>
              <button className="btn btn-ghost" disabled={!trackAId || !trackBId || aligning}
                onClick={() => void autoAlign()}>
                {aligning ? t('playback.aligning') : t('playback.autoAlign')}
              </button>
              {alignResult != null && trackAId && trackBId && (
                <span className="pbm-align-note">
                  {t('playback.aligned', { offset: alignResult.toFixed(2) })}
                </span>
              )}
            </div>
          </div>

          <div className="card pbm-tracks-card">
            <div className="pbm-panel-header">
              <span className="pbm-panel-title">
                {t('playback.trackList')} ({tracks.length})
              </span>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setTracksOpen((v) => !v)}>
                {tracksOpen ? t('playback.collapse') : t('playback.expand')}
              </button>
            </div>
            {tracksOpen && (
              tracks.length === 0
                ? <div className="pbm-empty-hint">{t('playback.noTracks')}</div>
                : (
                  <div className="pbm-track-items">
                    {tracks.map((tr) => (
                      <div key={tr.id} className="pbm-track-item">
                        <div className="pbm-thumb" style={{ background: tr.color }} />
                        <div className="pbm-track-main">
                          <div className="pbm-track-name">{trackLabel(tr, t)}</div>
                          <div className="pbm-track-controls">
                            <button className={`btn btn-ghost pbm-mini-btn${tr.muted ? ' active' : ''}`}
                              onClick={() => patchTrack(tr.id, { muted: !tr.muted })}>
                              {t('playback.mute')}
                            </button>
                            <button className={`btn btn-ghost pbm-mini-btn${tr.solo ? ' active' : ''}`}
                              onClick={() => patchTrack(tr.id, { solo: !tr.solo })}>
                              {t('playback.solo')}
                            </button>
                            <input type="range" min={0} max={1} step={0.01} value={tr.volume}
                              onChange={(e) => patchTrack(tr.id, { volume: Number(e.target.value) })}
                              style={{ flex: 1, accentColor: tr.color }}
                              aria-label={t('playback.volume')} />
                            <button className="qi-remove" onClick={() => removeTrack(tr.id)}
                              title={t('playback.remove')}>×</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
            )}
          </div>
        </section>

        {/* ── Right: recording panel (always visible) ───────── */}
        <aside className="pbm-right">
          <div className="card pbm-recording">
            <div className="pbm-panel-title">{t('playback.recordingPanel')}</div>
            <canvas ref={recCanvasRef} width={280} height={90} className="pbm-mic-canvas" />
            <div className="pbm-rec-controls">
              <span className="pbm-time">{formatDuration(recSeconds)}</span>
              {!recording ? (
                // Idle: neutral — accent is reserved for the armed/recording
                // state so it reads as "live" rather than just "clickable"
                // (Ticket 29 §6).
                <button className="btn btn-ghost" onClick={() => void startRecording()}>
                  {t('playback.record')}
                </button>
              ) : (
                <button className="btn btn-record-active" onClick={() => void stopRecording()}>
                  {t('playback.stopRecording')}
                </button>
              )}
            </div>
            {micError && (
              <div className="pbm-empty-hint" style={{ color: 'var(--danger)' }}>
                {t('playback.micUnavailable')}
              </div>
            )}
          </div>
        </aside>
      </div>
    </>
  )
}
