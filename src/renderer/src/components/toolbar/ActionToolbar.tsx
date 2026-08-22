import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * One button in the toolbar. `loading` and `disabled` are separate on
 * purpose: a loading action is also non-interactive, but it reads very
 * differently to the user and Ticket UI-06 asks for both states to be
 * visually distinct.
 */
export interface ToolbarAction {
  id:            string
  label:         string
  /** Leading glyph. Decorative — the label carries the accessible name. */
  icon?:         string
  onClick?:      () => void
  disabled?:     boolean
  loading?:      boolean
  /** Replaces `label` while `loading` is true. */
  loadingLabel?: string
  /** Tooltip — usually the reason an action is unavailable. */
  title?:        string
  /** Renders a "just succeeded" treatment instead of the normal one. */
  done?:         boolean
  /** Promotes this action to the always-visible core row. */
  core?:         boolean
}

interface Props {
  actions:   ToolbarAction[]
  /** Accessible name for the toolbar as a whole. */
  ariaLabel: string
}

/** How far the ‹ › arrows scroll the overflow carousel per press. */
const PAGE_FRACTION = 0.8

/**
 * Operations toolbar (Ticket UI-06).
 *
 * Keeps the handful of high-frequency actions permanently visible as
 * pill-shaped buttons, and files everything else behind a "更多操作"
 * disclosure that opens a horizontally-scrolling carousel — arrows to page
 * through it, and the mouse wheel scrolls it sideways.
 *
 * The component is deliberately presentational: callers own the actions'
 * enablement and busy state, so the same toolbar can front the data-prep
 * workspace and anything else that grows a crowded button row later.
 */
export function ActionToolbar({ actions, ariaLabel }: Props): JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const railRef = useRef<HTMLDivElement>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd]     = useState(true)

  const core     = actions.filter((a) => a.core)
  const overflow = actions.filter((a) => !a.core)

  // Arrow enablement has to track the rail's live scroll position, and the
  // rail only exists once expanded.
  const syncArrows = useCallback(() => {
    const rail = railRef.current
    if (!rail) return
    const max = rail.scrollWidth - rail.clientWidth
    setAtStart(rail.scrollLeft <= 1)
    // <=1 rather than ===: fractional layout widths mean scrollLeft rarely
    // lands exactly on the maximum.
    setAtEnd(max <= 1 || rail.scrollLeft >= max - 1)
  }, [])

  useEffect(() => {
    if (!expanded) return
    const rail = railRef.current
    if (!rail) return
    syncArrows()

    // Wheel → horizontal scroll (Ticket UI-06 acceptance). Only claims the
    // gesture when there is actually somewhere to scroll, so an overflow row
    // that already fits doesn't swallow the page's vertical scroll.
    const onWheel = (event: WheelEvent): void => {
      if (rail.scrollWidth <= rail.clientWidth) return
      if (event.deltaY === 0) return
      event.preventDefault()
      rail.scrollLeft += event.deltaY
    }
    rail.addEventListener('wheel', onWheel, { passive: false })
    rail.addEventListener('scroll', syncArrows, { passive: true })

    const observer = new ResizeObserver(syncArrows)
    observer.observe(rail)
    return () => {
      rail.removeEventListener('wheel', onWheel)
      rail.removeEventListener('scroll', syncArrows)
      observer.disconnect()
    }
  }, [expanded, syncArrows])

  function page(direction: -1 | 1): void {
    const rail = railRef.current
    if (!rail) return
    rail.scrollBy({ left: direction * rail.clientWidth * PAGE_FRACTION, behavior: 'smooth' })
  }

  function renderButton(action: ToolbarAction, variant: 'core' | 'overflow'): JSX.Element {
    const busy = action.loading === true
    const label = busy ? (action.loadingLabel ?? action.label) : action.label
    return (
      <button
        key={action.id}
        type="button"
        className={[
          'at-btn',
          variant === 'core' ? 'at-btn-core' : 'at-btn-overflow',
          action.done ? 'at-btn-done' : '',
          busy ? 'at-btn-loading' : '',
        ].filter(Boolean).join(' ')}
        onClick={action.onClick}
        disabled={action.disabled || busy}
        title={action.title ?? action.label}
        aria-busy={busy || undefined}
      >
        {busy
          ? <span className="at-spinner" aria-hidden="true" />
          : action.icon ? <span className="at-icon" aria-hidden="true">{action.icon}</span> : null}
        <span className="at-label">{label}</span>
      </button>
    )
  }

  return (
    <div className="at-toolbar" role="toolbar" aria-label={ariaLabel}>
      <div className="at-core">
        {core.map((a) => renderButton(a, 'core'))}

        {overflow.length > 0 && (
          <button
            type="button"
            className={`at-more${expanded ? ' expanded' : ''}`}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={t('toolbar.more')}
          >
            <span aria-hidden="true">⋯</span>
            <span className="at-label">{t('toolbar.more')}</span>
          </button>
        )}
      </div>

      {expanded && overflow.length > 0 && (
        <div className="at-overflow">
          <button
            type="button"
            className="at-arrow"
            onClick={() => page(-1)}
            disabled={atStart}
            aria-label={t('toolbar.scrollLeft')}
            title={t('toolbar.scrollLeft')}
          >
            ‹
          </button>
          <div className="at-rail" ref={railRef}>
            {overflow.map((a) => renderButton(a, 'overflow'))}
          </div>
          <button
            type="button"
            className="at-arrow"
            onClick={() => page(1)}
            disabled={atEnd}
            aria-label={t('toolbar.scrollRight')}
            title={t('toolbar.scrollRight')}
          >
            ›
          </button>
        </div>
      )}
    </div>
  )
}
