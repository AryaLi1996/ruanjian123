import { useState } from 'react'
import { formatDuration } from '../../utils/audio'

type Format  = 'wav' | 'flac' | 'ogg'
type Bitrate = 128 | 256 | 320

interface Props {
  renderMix:    (() => Promise<Float32Array>) | null
  sampleRate?:  number
}

export function ExportPanel({ renderMix, sampleRate = 44_100 }: Props): JSX.Element {
  const [format,   setFormat]   = useState<Format>('wav')
  const [bitrate,  setBitrate]  = useState<Bitrate>(256)
  const [exporting, setExporting] = useState(false)
  const [result,   setResult]   = useState<string | null>(null)
  const [error,    setError]    = useState<string | null>(null)

  async function handleExport(): Promise<void> {
    if (!renderMix) return
    setExporting(true); setResult(null); setError(null)
    try {
      const pcm  = await renderMix()
      const res  = await window.engine.call('export_audio', {
        audio:       Array.from(pcm),
        sample_rate: sampleRate,
        channels:    2,
        format,
        bitrate,
        output_path: `${window.navigator.userAgent.includes('Mac') ? '/tmp' : 'C:/Temp'}/cover_export.${format}`,
      }) as { output_path: string; size_bytes: number; duration_sec: number }

      setResult(
        `Exported: ${res.output_path}\n` +
        `Size: ${(res.size_bytes / 1024 / 1024).toFixed(2)} MB · ` +
        `Duration: ${formatDuration(res.duration_sec)}`
      )
    } catch (err) {
      setError(String(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      <div className="export-options">
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label>Format</label>
          <select className="select" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            <option value="wav">WAV (lossless)</option>
            <option value="flac">FLAC (lossless compressed)</option>
            <option value="ogg">OGG Vorbis (lossy)</option>
          </select>
        </div>

        {format === 'ogg' && (
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Quality / Bitrate</label>
            <select className="select" value={bitrate} onChange={(e) => setBitrate(Number(e.target.value) as Bitrate)}>
              <option value={128}>128 kbps</option>
              <option value={256}>256 kbps</option>
              <option value={320}>320 kbps</option>
            </select>
          </div>
        )}
      </div>

      <button
        className="btn btn-primary"
        style={{ width: '100%', marginTop: 14, padding: 11 }}
        onClick={handleExport}
        disabled={exporting || !renderMix}
      >
        {exporting ? '⏳ Rendering & exporting…' : '⬇ Export Audio'}
      </button>

      {result && <div className="result-box ok" style={{ marginTop: 12 }}>{result}</div>}
      {error  && <div className="result-box err" style={{ marginTop: 12 }}>{error}</div>}
    </div>
  )
}
