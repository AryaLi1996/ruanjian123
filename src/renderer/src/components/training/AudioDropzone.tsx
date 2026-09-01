import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { getAudioInfo, formatDuration } from '../../utils/audio'

interface AudioFileEntry {
  id:          string
  file:        File
  duration:    number | null
  waveformUrl: string | null
  loading:     boolean
}

interface Props {
  onFilesChange: (files: File[]) => void
  /**
   * Ticket T3: total measured duration of the current selection, in seconds,
   * reported as each file's metadata finishes decoding. The training view
   * uses it to question a run before it starts rather than after it has spent
   * an hour producing a model from 34 seconds of audio. Files whose duration
   * could not be read contribute nothing, so this is a lower bound.
   */
  onDurationChange?: (totalSeconds: number) => void
}

const ACCEPT = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a'])

function isAudioFile(f: File): boolean {
  const ext = '.' + f.name.split('.').pop()!.toLowerCase()
  return ACCEPT.has(ext) || f.type.startsWith('audio/')
}

export function AudioDropzone({ onFilesChange, onDurationChange }: Props): JSX.Element {
  const [entries, setEntries]   = useState<AudioFileEntry[]>([])
  const [dragging, setDragging] = useState(false)
  const inputRef                = useRef<HTMLInputElement>(null)
  const { t } = useTranslation()

  const addFiles = useCallback(async (incoming: File[]) => {
    const valid = incoming.filter(isAudioFile)
    if (!valid.length) return

    // Add placeholder entries immediately so the UI feels responsive
    const placeholders: AudioFileEntry[] = valid.map((f) => ({
      id: crypto.randomUUID(), file: f, duration: null, waveformUrl: null, loading: true,
    }))

    setEntries((prev) => {
      const next = [...prev, ...placeholders]
      onFilesChange(next.map((e) => e.file))
      return next
    })

    // Load waveform + duration asynchronously per file, writing each result
    // back by stable id — not position — so a second drop or a removal that
    // lands while these are still resolving can't attach the wrong file's
    // waveform/duration to this entry.
    for (const placeholder of placeholders) {
      const info = await getAudioInfo(placeholder.file)
      setEntries((prev) => prev.map((e) =>
        e.id === placeholder.id ? { ...e, ...info, loading: false } : e
      ))
    }
  }, [onFilesChange])

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault(); setDragging(false)
    addFiles(Array.from(e.dataTransfer.files))
  }

  function handleRemove(id: string): void {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id)
      onFilesChange(next.map((e) => e.file))
      return next
    })
  }

  const totalDuration = entries.reduce((s, e) => s + (e.duration ?? 0), 0)

  // Reported from an effect rather than from addFiles/handleRemove: durations
  // arrive asynchronously per file, so the total at the moment the list
  // changes is not the total once decoding settles.
  useEffect(() => { onDurationChange?.(totalDuration) }, [totalDuration, onDurationChange])

  return (
    <div>
      {/* Drop zone */}
      <div
        className={`dropzone${dragging ? ' drag-over' : ''}`}
        onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
        onDragOver={(e)  => { e.preventDefault(); setDragging(true) }}
        onDragLeave={()  => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        aria-label={t('training.dropAudio')}
      >
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
        />
        <div className="dropzone-icon">🎵</div>
        <div className="dropzone-primary">{t('training.dropAudio')}</div>
        <div className="dropzone-hint">{t('training.audioFormats')}</div>
      </div>

      {/* File list */}
      {entries.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('training.fileCount', { count: entries.length })} · {t('training.totalDuration', { duration: formatDuration(totalDuration) })}
            </span>
            <button
              className="btn btn-ghost"
              style={{ padding: '3px 10px', fontSize: 11 }}
              onClick={(e) => { e.stopPropagation(); setEntries([]); onFilesChange([]) }}
            >
              {t('training.clearAll')}
            </button>
          </div>

          <div className="audio-file-list">
            {entries.map((entry) => (
              <div key={entry.id} className="audio-file-item">
                <div className="audio-file-meta">
                  <span className="audio-file-name">{entry.file.name}</span>
                  <span className="audio-file-dur">
                    {entry.loading ? '…' : entry.duration != null ? formatDuration(entry.duration) : '?'}
                  </span>
                  <button
                    className="audio-file-remove"
                    onClick={(e) => { e.stopPropagation(); handleRemove(entry.id) }}
                    aria-label={t('training.removeFile')}
                  >
                    ×
                  </button>
                </div>
                {entry.loading ? (
                  <div className="waveform-placeholder">{t('training.loadingWaveform')}</div>
                ) : entry.waveformUrl ? (
                  <img className="waveform-img" src={entry.waveformUrl} alt={t('training.waveform')} />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
