import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '../../utils/audio'

export interface MixTrack {
  key:   string
  label: string
  path:  string
  color: string
}

export interface MixSettings {
  volumes:   Record<string, number>   // 0..1 per track key
  reverb:    number                   // 0..1 wet
  eqLow:     number                   // −12..+12 dB
  eqMid:     number
  eqHigh:    number
}

interface Props {
  tracks:            MixTrack[]
  onSettingsChange?: (s: MixSettings) => void
  /** Called with rendered Float32Array when export is triggered */
  onExportRequest:   (renderFn: () => Promise<Float32Array>) => void
}

function makeIR(ctx: BaseAudioContext, dur = 1.5, decay = 2.0): AudioBuffer {
  const len = Math.ceil(ctx.sampleRate * dur)
  const ir  = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const ch = ir.getChannelData(c)
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
    }
  }
  return ir
}

async function loadBuffer(ctx: BaseAudioContext, path: string): Promise<AudioBuffer> {
  const raw = await window.engine.readFile(path)
  return ctx.decodeAudioData(raw.slice(0))
}

function buildGraph(
  ctx:     BaseAudioContext,
  buffers: AudioBuffer[],
  tracks:  MixTrack[],
  settings: MixSettings,
): {
  gains:    GainNode[]
  dryGain:  GainNode
  revGain:  GainNode
  convolver: ConvolverNode
  eqLow:    BiquadFilterNode
  eqMid:    BiquadFilterNode
  eqHigh:   BiquadFilterNode
} {
  // Looked up by tracks[i].key, not by position in settings.volumes — the
  // two arrays only happen to agree on ordering by coincidence (volumes is
  // seeded once from tracks on mount and JS objects iterate insertion
  // order), and nothing enforces that stays true if tracks is ever
  // reordered or filtered differently after mount. buffers[i] always
  // corresponds to tracks[i] (both built by mapping over the same tracks
  // array), so that's the correct join key.
  const gains   = buffers.map((_, i) => {
    const g = ctx.createGain()
    g.gain.value = settings.volumes[tracks[i]?.key ?? ''] ?? 0.8
    return g
  })

  const dryGain  = ctx.createGain(); dryGain.gain.value  = 1 - settings.reverb
  const convolver = ctx.createConvolver(); convolver.buffer = makeIR(ctx)
  const revGain  = ctx.createGain(); revGain.gain.value  = settings.reverb

  const eqLow  = ctx.createBiquadFilter()
  eqLow.type   = 'lowshelf'; eqLow.frequency.value  = 200; eqLow.gain.value  = settings.eqLow
  const eqMid  = ctx.createBiquadFilter()
  eqMid.type   = 'peaking';  eqMid.frequency.value  = 1_000; eqMid.Q.value = 1.5; eqMid.gain.value = settings.eqMid
  const eqHigh = ctx.createBiquadFilter()
  eqHigh.type  = 'highshelf'; eqHigh.frequency.value = 8_000; eqHigh.gain.value = settings.eqHigh

  // Route: each source gain → dry split & reverb split → EQ chain → destination
  gains.forEach((g) => {
    g.connect(dryGain)
    g.connect(convolver)
  })
  convolver.connect(revGain)
  dryGain.connect(eqLow)
  revGain.connect(eqLow)
  eqLow.connect(eqMid).connect(eqHigh).connect(ctx.destination)

  return { gains, dryGain, revGain, convolver, eqLow, eqMid, eqHigh }
}

export function MixingConsole({ tracks, onSettingsChange, onExportRequest }: Props): JSX.Element {
  const { t } = useTranslation()
  const defaultVolumes = Object.fromEntries(tracks.map((t) => [t.key, 0.8]))
  const [settings, setSettingsRaw] = useState<MixSettings>({
    volumes: defaultVolumes, reverb: 0.15, eqLow: 0, eqMid: 0, eqHigh: 0,
  })
  const [playing, setPlaying]  = useState(false)
  const [loading, setLoading]  = useState(true)
  const [elapsed, setElapsed]  = useState(0)

  const ctxRef      = useRef<AudioContext | null>(null)
  const buffersRef  = useRef<AudioBuffer[]>([])
  const graphRef    = useRef<ReturnType<typeof buildGraph> | null>(null)
  const sourcesRef  = useRef<AudioBufferSourceNode[]>([])
  const startRef    = useRef<number>(0)
  const timerRef    = useRef<number | null>(null)

  // Load buffers once
  useEffect(() => {
    let alive = true
    async function init() {
      const ctx = new AudioContext()
      ctxRef.current = ctx
      const bufs = await Promise.all(tracks.map((t) => loadBuffer(ctx, t.path)))
      if (!alive) { ctx.close(); return }
      buffersRef.current = bufs
      graphRef.current   = buildGraph(ctx, bufs, tracks, settings)
      setLoading(false)
    }
    init()
    return () => {
      alive = false
      ctxRef.current?.close()
      if (timerRef.current != null) clearInterval(timerRef.current)
    }
  }, [tracks]) // eslint-disable-line react-hooks/exhaustive-deps

  function setSettings(patch: Partial<MixSettings>): void {
    setSettingsRaw((prev) => {
      const next = { ...prev, ...patch, volumes: { ...prev.volumes, ...(patch.volumes ?? {}) } }
      onSettingsChange?.(next)
      // Live-update audio nodes if playing
      if (graphRef.current) {
        const g = graphRef.current
        if (patch.reverb != null)  { g.dryGain.gain.value = 1 - patch.reverb; g.revGain.gain.value = patch.reverb }
        if (patch.eqLow  != null)  g.eqLow.gain.value  = patch.eqLow
        if (patch.eqMid  != null)  g.eqMid.gain.value  = patch.eqMid
        if (patch.eqHigh != null)  g.eqHigh.gain.value = patch.eqHigh
        if (patch.volumes) {
          tracks.forEach((t, i) => {
            if (g.gains[i] && patch.volumes![t.key] != null)
              g.gains[i].gain.value = patch.volumes![t.key]
          })
        }
      }
      return next
    })
  }

  function togglePlay(): void {
    const ctx  = ctxRef.current
    const bufs = buffersRef.current
    if (!ctx || !bufs.length) return

    if (playing) {
      sourcesRef.current.forEach((s) => { try { s.stop() } catch { /* already stopped */ } })
      sourcesRef.current = []
      setPlaying(false)
      if (timerRef.current != null) clearInterval(timerRef.current)
      return
    }

    // Rebuild graph each time to reset positions
    graphRef.current = buildGraph(ctx, bufs, tracks, settings)
    const g = graphRef.current
    const now = ctx.currentTime
    startRef.current = now

    sourcesRef.current = bufs.map((buf, i) => {
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(g.gains[i])
      src.start(now)
      src.onended = () => {
        if (i === 0) { setPlaying(false); if (timerRef.current != null) clearInterval(timerRef.current) }
      }
      return src
    })

    setPlaying(true)
    timerRef.current = window.setInterval(() => {
      setElapsed(ctx.currentTime - startRef.current)
    }, 250)
  }

  // Export render function registered with parent
  const renderMix = useCallback(async (): Promise<Float32Array> => {
    const bufs = buffersRef.current
    const maxLen = Math.max(...bufs.map((b) => b.length))
    const offline = new OfflineAudioContext(2, maxLen, 44_100)
    const g = buildGraph(offline, bufs, tracks, settings)
    bufs.forEach((buf, i) => {
      const src = offline.createBufferSource()
      src.buffer = buf
      src.connect(g.gains[i])
      src.start(0)
    })
    const rendered = await offline.startRendering()
    // Interleave L+R for the engine export_audio handler
    const L = rendered.getChannelData(0)
    const R = rendered.getChannelData(1)
    const out = new Float32Array(L.length * 2)
    for (let i = 0; i < L.length; i++) { out[i * 2] = L[i]; out[i * 2 + 1] = R[i] }
    return out
  }, [settings])

  useEffect(() => { onExportRequest(renderMix) }, [renderMix, onExportRequest])

  const maxDur = Math.max(...(buffersRef.current.map((b) => b.duration) ?? [0]))

  if (loading) {
    return <div style={{ padding: '16px 0', color: 'var(--text-muted)', fontSize: 12 }}>{t('cover.mixerLoading')}</div>
  }

  return (
    <div className="mixer">
      {/* Transport */}
      <div className="mixer-transport">
        <button className="player-play-btn" onClick={togglePlay}>
          {playing ? '⏸' : '▶'}
        </button>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>
          {formatDuration(elapsed)} / {formatDuration(maxDur)}
        </div>
      </div>

      {/* Fader tracks */}
      <div className="fader-tracks">
        {tracks.map((t) => (
          <div key={t.key} className="fader-track">
            <div className="fader-value" style={{ color: t.color }}>
              {Math.round(settings.volumes[t.key] * 100)}
            </div>
            <input
              type="range"
              className="fader-slider"
              min={0} max={1} step={0.01}
              value={settings.volumes[t.key] ?? 0.8}
              onChange={(e) => setSettings({ volumes: { [t.key]: Number(e.target.value) } })}
              aria-label={t.label}
            />
            <div className="fader-label" style={{ color: t.color }}>{t.label}</div>
          </div>
        ))}
      </div>

      {/* Effects */}
      <div className="effects-row">
        <div className="effect-group">
          <div className="effect-label">{t('cover.reverb')}</div>
          <input type="range" className="effect-slider" min={0} max={1} step={0.01}
            value={settings.reverb}
            onChange={(e) => setSettings({ reverb: Number(e.target.value) })} />
          <span className="effect-val">{Math.round(settings.reverb * 100)}%</span>
        </div>
        {(['eqLow', 'eqMid', 'eqHigh'] as const).map((band, i) => (
          <div className="effect-group" key={band}>
            <div className="effect-label">{[t('cover.eqLow'), t('cover.eqMid'), t('cover.eqHigh')][i]}</div>
            <input type="range" className="effect-slider" min={-12} max={12} step={0.5}
              value={settings[band]}
              onChange={(e) => setSettings({ [band]: Number(e.target.value) } as Partial<MixSettings>)} />
            <span className="effect-val">
              {settings[band] > 0 ? '+' : ''}{settings[band].toFixed(1)} dB
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
