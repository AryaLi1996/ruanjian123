import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store/useAppStore'

type SepMode  = 'standard' | 'enhanced'
type JobStatus = 'pending' | 'processing' | 'done' | 'error'

interface SepJob {
  id:      string
  file:    File
  mode:    SepMode
  status:  JobStatus
  stems:   Record<string, string> | null
  error:   string | null
  elapsed: number | null
}

const STEM_LABELS: Record<string, string> = {
  vocals:        'Vocals',
  accompaniment: 'Accomp.',
  lead_dry:      'Lead',
  harmony_dry:   'Harmony',
}

async function triggerDownload(filePath: string, filename: string): Promise<void> {
  const buf  = await window.engine.readFile(filePath)
  const blob = new Blob([buf], { type: 'audio/wav' })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function AudioToolsView(): JSX.Element {
  const { t } = useTranslation()
  const setEngineBusy   = useAppStore((s) => s.setEngineBusy)
  const setEngineStatus = useAppStore((s) => s.setEngineStatus)

  const [jobs,          setJobs]          = useState<SepJob[]>([])
  const [dragging,      setDragging]      = useState(false)
  const [running,       setRunning]       = useState(false)
  const [liveElapsed,   setLiveElapsed]   = useState<Record<string, number>>({})
  const [deviceInfo,    setDeviceInfo]    = useState<string>('')
  const [downloadingAll, setDownloadingAll] = useState(false)

  const jobsRef       = useRef<SepJob[]>([])
  const processingRef = useRef(false)
  const inputRef      = useRef<HTMLInputElement>(null)

  useEffect(() => { jobsRef.current = jobs }, [jobs])

  // ── File management ───────────────────────────────────────
  function addFiles(files: File[]): void {
    const valid = files.filter(
      (f) => f.type.startsWith('audio/') || /\.(wav|flac|ogg|mp3|m4a)$/i.test(f.name)
    )
    if (!valid.length) return
    setJobs((prev) => [
      ...prev,
      ...valid.map((file) => ({
        id: crypto.randomUUID(), file,
        mode: 'enhanced' as SepMode,
        status: 'pending' as JobStatus,
        stems: null, error: null, elapsed: null,
      })),
    ])
  }

  function setJobMode(id: string, mode: SepMode): void {
    setJobs((prev) => prev.map((j) => j.id === id ? { ...j, mode } : j))
  }

  function removeJob(id: string): void {
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }

  // ── Process one job ───────────────────────────────────────
  async function processOne(jobId: string): Promise<void> {
    const job = jobsRef.current.find((j) => j.id === jobId)
    if (!job || job.status !== 'pending') return

    setJobs((prev) => prev.map((j) => j.id === jobId ? { ...j, status: 'processing' } : j))
    const t0 = Date.now()

    // Live elapsed timer — updates while the IPC call is in-flight
    const timerId = window.setInterval(() => {
      setLiveElapsed((prev) => ({ ...prev, [jobId]: (Date.now() - t0) / 1000 }))
    }, 300)

    try {
      const buf = await job.file.arrayBuffer()
      const dir = await window.engine.saveTrainingFiles([{ name: job.file.name, buffer: buf }])

      const res = await window.engine.call('separate', {
        mode:       job.mode,
        input_path: `${dir}/${job.file.name}`,
      }) as { stems: Record<string, string>; elapsed_sec: number }

      const elapsed = (Date.now() - t0) / 1000
      setJobs((prev) => prev.map((j) =>
        j.id === jobId ? { ...j, status: 'done', stems: res.stems, elapsed } : j
      ))
    } catch (err) {
      setJobs((prev) => prev.map((j) =>
        j.id === jobId ? { ...j, status: 'error', error: String(err) } : j
      ))
    } finally {
      clearInterval(timerId)
      setLiveElapsed((prev) => { const n = { ...prev }; delete n[jobId]; return n })
    }
  }

  // ── Run queue sequentially ────────────────────────────────
  async function runQueue(): Promise<void> {
    if (processingRef.current) return
    processingRef.current = true
    setRunning(true); setEngineBusy(true); setEngineStatus(t('status.separating'))

    const pendingIds = jobsRef.current
      .filter((j) => j.status === 'pending')
      .map((j) => j.id)

    for (const id of pendingIds) {
      await processOne(id)
    }

    processingRef.current = false
    setRunning(false); setEngineBusy(false); setEngineStatus(t('status.idle'))
  }

  // ── Download helpers ──────────────────────────────────────
  async function downloadAll(): Promise<void> {
    setDownloadingAll(true)
    try {
      for (const job of jobs.filter((j) => j.status === 'done' && j.stems)) {
        const base = job.file.name.replace(/\.[^.]+$/, '')
        for (const [key, path] of Object.entries(job.stems!)) {
          await triggerDownload(path, `${base}_${STEM_LABELS[key] ?? key}.wav`)
          await new Promise((r) => setTimeout(r, 120))  // brief gap so browser doesn't block
        }
      }
    } finally {
      setDownloadingAll(false)
    }
  }

  async function handleDetectDevice(): Promise<void> {
    setDeviceInfo('')
    try {
      const res = await window.engine.call('detect_device')
      const d = res as Record<string, unknown>
      setDeviceInfo(`EP: ${d.ep}  |  ${d.platform}  |  Python ${d.python}`)
    } catch (err) { setDeviceInfo(String(err)) }
  }

  // ── Derived counts ────────────────────────────────────────
  const doneCount    = jobs.filter((j) => j.status === 'done').length
  const pendingCount = jobs.filter((j) => j.status === 'pending').length
  const errorCount   = jobs.filter((j) => j.status === 'error').length

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">{t('audioTools.title')}</h1>
        <p className="view-desc">{t('audioTools.description')}</p>
      </div>

      {/* ── Hardware info ─────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <button className="btn btn-ghost" onClick={handleDetectDevice}>{t('audioTools.detect')}</button>
          {deviceInfo && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 12 }}>{deviceInfo}</span>
          )}
        </div>
      </div>

      {/* ── Drop zone ─────────────────────────────────────── */}
      <div
        className={`batch-dropzone${dragging ? ' drag-over' : ''}`}
        onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
        onDragOver={(e)  => { e.preventDefault(); setDragging(true) }}
        onDragLeave={()  => setDragging(false)}
        onDrop={(e)      => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)) }}
        onClick={()      => inputRef.current?.click()}
        role="button"
        aria-label="Drop audio files here or click to browse"
      >
        <input
          ref={inputRef} type="file" accept="audio/*" multiple
          style={{ display: 'none' }}
          onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
        />
        <div className="dropzone-icon">🎵</div>
        <div className="dropzone-primary">{t('audioTools.drop')}</div>
        <div className="dropzone-hint">{t('audioTools.formats')}</div>
      </div>

      {/* ── Queue controls ────────────────────────────────── */}
      {jobs.length > 0 && (
        <div className="queue-controls">
          <span className="queue-summary">
            {t('audioTools.files', { count: jobs.length })}
            {doneCount    > 0 && ` · ${t('audioTools.done', { count: doneCount })}`}
            {pendingCount > 0 && ` · ${t('audioTools.pending', { count: pendingCount })}`}
            {errorCount   > 0 && ` · ${t('audioTools.failed', { count: errorCount })}`}
          </span>
          <div className="row" style={{ gap: 8 }}>
            {doneCount > 0 && (
              <button className="btn btn-ghost" onClick={downloadAll} disabled={downloadingAll}>
                {downloadingAll ? '⏳…' : `⬇ ${t('audioTools.downloadAll', { count: doneCount })}`}
              </button>
            )}
            <button
              className="btn btn-ghost"
              style={{ color: 'var(--text-muted)', fontSize: 12 }}
              onClick={() => setJobs([])}
              disabled={running}
            >
              {t('audioTools.clear')}
            </button>
            <button
              className="btn btn-primary"
              onClick={runQueue}
              disabled={running || pendingCount === 0}
            >
              {running ? `⏳ ${t('audioTools.processing')}` : `▶ ${t('audioTools.process', { count: pendingCount })}`}
            </button>
          </div>
        </div>
      )}

      {/* ── Job list ──────────────────────────────────────── */}
      {jobs.length > 0 && (
        <div className="queue-list">
          {jobs.map((job, i) => (
            <div key={job.id} className={`queue-item status-${job.status}`}>

              {/* Index + filename */}
              <div className="qi-left">
                <span className="qi-index">{i + 1}</span>
                <span className="qi-name" title={job.file.name}>{job.file.name}</span>
              </div>

              {/* Mode selector (disabled while running/done/error) */}
              <select
                className="select qi-mode"
                value={job.mode}
                onChange={(e) => setJobMode(job.id, e.target.value as SepMode)}
                disabled={job.status !== 'pending'}
              >
                <option value="standard">Standard</option>
                <option value="enhanced">Enhanced</option>
              </select>

              {/* Status badge */}
              <div className="qi-status">
                  {job.status === 'pending'    && <span className="qi-badge pending">{t('audioTools.pendingStatus')}</span>}
                {job.status === 'processing' && (
                  <span className="qi-badge processing">
                    ⏳ {(liveElapsed[job.id] ?? 0).toFixed(1)}s
                  </span>
                )}
                {job.status === 'done'  && (
                  <span className="qi-badge done">✓ {job.elapsed?.toFixed(1)}s</span>
                )}
                  {job.status === 'error' && (
                  <span className="qi-badge err" title={job.error ?? ''}>{t('audioTools.errorStatus')}</span>
                )}
              </div>

              {/* Stem download buttons (shown only when done) */}
              <div className="qi-downloads">
                {job.status === 'done' && job.stems &&
                  Object.entries(job.stems).map(([key, path]) => (
                    <button
                      key={key}
                      className="btn btn-ghost qi-dl-btn"
                      onClick={() =>
                        triggerDownload(
                          path,
                          `${job.file.name.replace(/\.[^.]+$/, '')}_${STEM_LABELS[key] ?? key}.wav`
                        )
                      }
                      title={`Download ${STEM_LABELS[key] ?? key}`}
                    >
                      ⬇ {STEM_LABELS[key] ?? key}
                    </button>
                  ))
                }
              </div>

              {/* Remove button */}
              <button
                className="qi-remove"
                onClick={() => removeJob(job.id)}
                disabled={job.status === 'processing'}
                title="Remove"
                aria-label="Remove job"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
