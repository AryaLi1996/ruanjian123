import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EngineLogEntry } from '../../global'

interface Props {
  entries: EngineLogEntry[]
  /** Open on first render — used while a run is in flight. */
  defaultOpen?: boolean
}

/**
 * Collapsible raw-output panel for the Python engine (Ticket T3).
 *
 * The training console only ever showed parsed JSON progress, so anything the
 * engine said *before* it could report progress — the exact import that hung,
 * a library's warning, a traceback — was invisible; a silent failure was
 * indistinguishable from a slow start. This shows every line the bridge saw,
 * tagged by kind, collapsed by default so it doesn't dominate the page.
 */
export function EngineLogPanel({ entries, defaultOpen = false }: Props): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Same "follow the tail unless the user scrolled up" rule as the training
  // console — yanking the view down mid-read makes a log unusable exactly
  // when someone is trying to diagnose something with it.
  const pinnedRef = useRef(true)

  useEffect(() => {
    const el = bodyRef.current
    if (!el || !open || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [entries, open])

  function handleScroll(): void {
    const el = bodyRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const errorCount = entries.filter((e) => e.kind === 'error').length

  return (
    <div className="engine-log">
      <button
        type="button"
        className="engine-log-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {t('training.engineLog')}
        <span className="engine-log-count">
          {t('training.engineLogCount', { count: entries.length })}
        </span>
        {errorCount > 0 && (
          <span className="engine-log-errors">{t('training.engineLogErrors', { count: errorCount })}</span>
        )}
      </button>

      {open && (
        <div
          className="engine-log-body"
          ref={bodyRef}
          onScroll={handleScroll}
          role="log"
          aria-label={t('training.engineLog')}
        >
          {entries.length === 0 ? (
            <div className="engine-log-line engine-log-muted">{t('training.engineLogEmpty')}</div>
          ) : (
            entries.map((entry, i) => (
              <div key={i} className={`engine-log-line engine-log-${entry.kind}`}>
                {entry.line}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
