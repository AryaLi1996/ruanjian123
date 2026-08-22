import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  left:  React.ReactNode
  right: React.ReactNode
  /** localStorage key the ratio is remembered under. */
  storageKey: string
  /** Fraction of the width given to the left pane before the user drags. */
  defaultRatio?: number
  ariaLabel: string
}

/** Ratio bounds — neither pane may be squeezed into uselessness. */
const MIN_RATIO = 0.28
const MAX_RATIO = 0.78

/** Below this container width the panes stack instead of sitting side by side. */
const STACK_BELOW_PX = 900

const SPLITTER_PX = 10

function readRatio(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= MIN_RATIO && parsed <= MAX_RATIO ? parsed : fallback
  } catch {
    return fallback
  }
}

/**
 * Two panes with a draggable splitter (Ticket UI-13).
 *
 * The ratio is kept as a fraction rather than a pixel width so the split
 * survives a window resize proportionally — a pixel split would leave the
 * right pane at its old width and eat the left one as the window narrows.
 * Below STACK_BELOW_PX the panes stack and the splitter is withdrawn: at
 * that width a horizontal split leaves neither side usable.
 */
export function SplitPane({ left, right, storageKey, defaultRatio = 0.6, ariaLabel }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(() => readRatio(storageKey, defaultRatio))
  const [stacked, setStacked] = useState(false)
  const draggingRef = useRef(false)

  // Stacking is driven by the container's own width, not the viewport's —
  // this sits inside a sidebar-adjacent grid cell, so the window width says
  // little about how much room the split actually has.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = (): void => setStacked(el.clientWidth > 0 && el.clientWidth < STACK_BELOW_PX)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const persist = useCallback((value: number) => {
    try { localStorage.setItem(storageKey, String(value)) } catch { /* best-effort */ }
  }, [storageKey])

  const ratioFromEvent = useCallback((clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return ratio
    const next = (clientX - rect.left) / rect.width
    return Math.min(MAX_RATIO, Math.max(MIN_RATIO, next))
  }, [ratio])

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (stacked) return
    event.currentTarget.setPointerCapture(event.pointerId)
    draggingRef.current = true
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return
    setRatio(ratioFromEvent(event.clientX))
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    draggingRef.current = false
    // Only the settled ratio is written; persisting on every move would
    // hammer localStorage for every frame of a drag.
    persist(ratio)
  }

  function nudge(delta: number): void {
    const next = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio + delta))
    setRatio(next)
    persist(next)
  }

  const pct = Math.round(ratio * 100)

  return (
    <div
      ref={containerRef}
      className={`split-pane${stacked ? ' stacked' : ''}`}
      style={stacked ? undefined : { gridTemplateColumns: `minmax(0, ${ratio}fr) ${SPLITTER_PX}px minmax(0, ${1 - ratio}fr)` }}
    >
      <div className="split-pane-left">{left}</div>

      <div
        className="split-pane-splitter"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        role="separator"
        aria-orientation="vertical"
        aria-label={ariaLabel}
        aria-valuenow={pct}
        aria-valuemin={Math.round(MIN_RATIO * 100)}
        aria-valuemax={Math.round(MAX_RATIO * 100)}
        tabIndex={stacked ? -1 : 0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft')  { event.preventDefault(); nudge(-0.02) }
          if (event.key === 'ArrowRight') { event.preventDefault(); nudge(0.02) }
        }}
      >
        <span className="split-pane-grip" aria-hidden="true" />
      </div>

      <div className="split-pane-right">{right}</div>
    </div>
  )
}
