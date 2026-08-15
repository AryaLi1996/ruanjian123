import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LyricLine } from '../../utils/lrc'

interface Props {
  lines:            LyricLine[]
  currentIndex:     number
  collapsed:        boolean
  onToggleCollapse: () => void
  onSeek:           (time: number) => void
  onImportFile:     (file: File) => void
  onlineSearchAllowed: boolean
}

const WINDOW = 20   // render current line ± WINDOW to cap DOM node count

export function LyricsPanel({
  lines, currentIndex, collapsed, onToggleCollapse, onSeek, onImportFile, onlineSearchAllowed,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [fontSize, setFontSize] = useState(16)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [dragging, setDragging] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const activeLineRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentIndex])

  function handleFiles(files: FileList | null): void {
    const file = files?.[0]
    if (file && /\.lrc$/i.test(file.name)) onImportFile(file)
  }

  const start = Math.max(0, currentIndex - WINDOW)
  const end = Math.min(lines.length, currentIndex + WINDOW + 1)
  const visible = lines.slice(start, end)

  return (
    <div className={`card pbm-lyrics${collapsed ? ' collapsed' : ''} theme-${theme}`}>
      <div className="pbm-lyrics-header">
        <span className="pbm-panel-title" style={{ marginBottom: 0 }}>{t('playback.lyrics')}</span>
        <div className="row" style={{ gap: 6 }}>
          {!collapsed && (
            <>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setFontSize((s) => Math.max(11, s - 2))}>A-</button>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setFontSize((s) => Math.min(28, s + 2))}>A+</button>
              <button className="btn btn-ghost pbm-mini-btn" onClick={() => setTheme((th) => th === 'dark' ? 'light' : 'dark')}>
                {theme === 'dark' ? '🌙' : '☀️'}
              </button>
            </>
          )}
          <button className="btn btn-ghost pbm-mini-btn" onClick={onToggleCollapse}>
            {collapsed ? t('playback.expand') : t('playback.collapse')}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={() => inputRef.current?.click()}>
              {t('playback.importLrc')}
            </button>
            <input ref={inputRef} type="file" accept=".lrc" style={{ display: 'none' }}
              onChange={(e) => handleFiles(e.target.files)} />
            <button className="btn btn-ghost" disabled={!onlineSearchAllowed} title={
              onlineSearchAllowed ? undefined : t('playback.subscribeForSearch')
            }>
              {t('playback.searchOnline')}
            </button>
          </div>

          {lines.length === 0 ? (
            <div
              className={`pbm-lyrics-empty${dragging ? ' drag-over' : ''}`}
              onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
            >
              <div className="view-desc">{t('playback.noLyrics')}</div>
              <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => inputRef.current?.click()}>
                {t('playback.importLrc')}
              </button>
            </div>
          ) : (
            <div
              className="pbm-lyrics-list"
              onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
              style={{ fontSize }}
            >
              {start > 0 && <div className="pbm-lyrics-spacer" />}
              {visible.map((line, i) => {
                const idx = start + i
                const active = idx === currentIndex
                return (
                  <div
                    key={idx}
                    ref={active ? activeLineRef : undefined}
                    className={`pbm-lyrics-line${active ? ' active' : ''}`}
                    onClick={() => onSeek(line.time)}
                  >
                    <div className="pbm-lyrics-text">{line.text}</div>
                    {line.translation && <div className="pbm-lyrics-translation">{line.translation}</div>}
                  </div>
                )
              })}
              {end < lines.length && <div className="pbm-lyrics-spacer" />}
            </div>
          )}
        </>
      )}
    </div>
  )
}
