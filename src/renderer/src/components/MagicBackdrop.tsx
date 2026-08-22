import { useImmersiveStore } from '../store/useImmersiveStore'

/**
 * Animated "魔法色" backdrop (Ticket UI-12 §2).
 *
 * Two slowly-drifting radial gradients built from the current cover art's
 * palette. It sits behind everything and is inert to pointer events, so it
 * can stay mounted at all times — only its opacity changes — which is what
 * lets the colour transition smoothly between songs instead of the layer
 * popping in and out of the tree.
 */
export function MagicBackdrop(): JSX.Element {
  const palette    = useImmersiveStore((s) => s.palette)
  const hasPalette = useImmersiveStore((s) => s.hasPalette)
  const immersive  = useImmersiveStore((s) => s.immersive)

  return (
    <div
      className={`magic-backdrop${hasPalette ? ' active' : ''}${immersive ? ' immersive' : ''}`}
      aria-hidden="true"
      style={{
        '--magic-a': palette.dominant,
        '--magic-b': palette.accent,
      } as React.CSSProperties}
    />
  )
}
