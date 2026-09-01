import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { getAudioInfo, formatDuration } from '../../utils/audio'

interface AudioFileEntry {
  id:          string
  file:        File
  duration:    number | null
  waveformUrl: string | null
  loading:     boolean
}

/**
 * One uploaded file plus the duration decoded for its waveform. Ticket P1:
 * the pre-flight needs both, and the dropzone has already paid for the
 * decode — re-deriving it at start time would decode every file a second
 * time just to answer "is this long enough?".
 */
export interface TrainingUpload {
  file:     File
  /** Seconds, or null while still decoding / when the browser could not decode it. */
  duration: number | null
}

interface Props {
  /**
   * Ticket P1: the selection, each file paired with the duration this
   * component has already decoded for its own display. It supersedes the
   * separate `onDurationChange` total (Ticket T3): the pre-flight needs
   * per-file durations — a clip too short to yield a training chunk is
   * invisible in a sum — and derives the total from the same list.
   */
  onFilesChange: (files: TrainingUpload[]) => void
}

const ACCEPT = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a'])

function isAudioFile(f: File): boolean {
  const ext = '.' + f.name.split('.').pop()!.toLowerCase()
  return ACCEPT.has(ext) || f.type.startsWith('audio/')
}

const toUploads = (entries: AudioFileEntry[]): TrainingUpload[] =>
  entries.map((e) => ({ file: e.file, duration: e.duration }))

export function AudioDropzone({ onFilesChange }: Props): JSX.Element {
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
      onFilesChange(toUploads(next))
      return next
    })

    // Load waveform + duration asynchronously per file, writing each result
    // back by stable id — not position — so a second drop or a removal that
    // lands while these are still resolving can't attach the wrong file's
    // waveform/duration to this entry.
    for (const placeholder of placeholders) {
      const info = await getAudioInfo(placeholder.file)
      setEntries((prev) => {
        const next = prev.map((e) =>
          e.id === placeholder.id
            ? { ...e, ...info, duration: info.duration > 0 ? info.duration : null, loading: false }
            : e
        )
        // Republish as each duration lands: the pre-flight's duration and
        // chunk checks are only as good as what has finished decoding.
        onFilesChange(toUploads(next))
        return next
      })
    }
  }, [onFilesChange])

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault(); setDragging(false)
    addFiles(Array.from(e.dataTransfer.files))
  }

  function handleRemove(id: string): void {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id)
      onFilesChange(toUploads(next))
      return next
    })
  }

  const totalDuration = entries.reduce((s, e) => s + (e.duration ?? 0), 0)

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
