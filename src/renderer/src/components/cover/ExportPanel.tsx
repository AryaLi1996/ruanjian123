import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '../../utils/audio'

type Format  = 'wav' | 'flac' | 'ogg'
type Bitrate = 128 | 256 | 320

interface Props {
  renderMix:    (() => Promise<Float32Array>) | null
  sampleRate?:  number
}

export function ExportPanel({ renderMix, sampleRate = 44_100 }: Props): JSX.Element {
  const { t } = useTranslation()
  const [format,   setFormat]   = useState<Format>('wav')
  const [bitrate,  setBitrate]  = useState<Bitrate>(256)
  const [exporting, setExporting] = useState(false)
  const [result,   setResult]   = useState<string | null>(null)
  const [error,    setError]    = useState<string | null>(null)

  async function handleExport(): Promise<void> {
    if (!renderMix) return
    setExporting(true); setResult(null); setError(null)
    try {
      // Ask where to save *before* rendering — every export used to land at
      // the same fixed temp path (e.g. /tmp/cover_export.wav), so exporting
      // a second cover silently overwrote the first with no warning and no
      // way to choose a name or location.
      const outputPath = await window.engine.chooseExportPath(
        `cover_export_${Date.now()}.${format}`, format,
      )
      if (!outputPath) { setExporting(false); return }   // user cancelled

      const pcm = await renderMix()

      // Ticket 44: the rendered mix used to be sent to the engine inline as
      // a JSON sample array through engine:call → the process argv. That
      // works for a toy payload, but a real song is millions of samples —
      // easily tens of MB of JSON text — and OS command lines cap a single
      // argv string far below that (Linux: MAX_ARG_STRLEN, ~128KB). The
      // Python process failed to even spawn, so every real export failed
      // silently or with an opaque error. Write the raw PCM to a temp file
      // (the same generic buffer→file IPC already used for song uploads)
      // and hand the engine a path instead.
      const pcmName = `mix_${Date.now()}.f32`
      const pcmDir  = await window.engine.saveTrainingFiles([
        { name: pcmName, buffer: pcm.buffer as ArrayBuffer },
      ])
      const pcmPath = `${pcmDir}/${pcmName}`

      const res  = await window.engine.call('export_audio', {
        pcm_path:    pcmPath,
        sample_rate: sampleRate,
        channels:    2,
        format,
        bitrate,
        output_path: outputPath,
      }) as { output_path: string; size_bytes: number; duration_sec: number }

      setResult(t('cover.exportResult', {
        path:     res.output_path,
        size:     (res.size_bytes / 1024 / 1024).toFixed(2),
        duration: formatDuration(res.duration_sec),
      }))
    } catch (err) {
      setError(t('errors.generic', { message: String(err) }))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      <div className="export-options">
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label>{t('cover.exportFormat')}</label>
          <select className="select" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            <option value="wav">{t('cover.exportFormatWav')}</option>
            <option value="flac">{t('cover.exportFormatFlac')}</option>
            <option value="ogg">{t('cover.exportFormatOgg')}</option>
          </select>
        </div>

        {format === 'ogg' && (
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label>{t('cover.exportQuality')}</label>
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
        {exporting ? `⏳ ${t('cover.exportRendering')}` : `⬇ ${t('cover.exportAction')}`}
      </button>

      {!renderMix && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>{t('cover.exportNeedsMix')}</div>}
      {result && <div className="result-box ok" style={{ marginTop: 12, whiteSpace: 'pre-line' }}>{result}</div>}
      {error  && <div className="result-box err" style={{ marginTop: 12 }}>{error}</div>}
    </div>
  )
}
