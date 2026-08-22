import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'danger'
export type ButtonSize    = 'md' | 'sm'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant
  /**
   * 'md' (40px) is the standard control height. 'sm' (32px) exists for the
   * dense inline strips — waveform zoom, track rows, toolbars — where a
   * 40px control would break the row it sits in.
   */
  size?:    ButtonSize
  /** Leading glyph, rendered decoratively; the label carries the name. */
  icon?:    ReactNode
  loading?: boolean
  /** Stretches to the container's width. */
  block?:   boolean
  /** Escape hatch for page-specific spacing; variant styling stays here. */
  className?: string
  children?: ReactNode
}

/**
 * The app's standard button (Ticket UI-14).
 *
 * Styling lives in app.css under .ui-btn rather than in this file, so the
 * many existing `className="btn btn-primary"` call sites and this component
 * stay visually identical without one of them becoming a second source of
 * truth for the design tokens.
 */
export function Button({
  variant = 'primary', size = 'md', icon, loading, block, className, children, disabled, ...rest
}: Props): JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[
        'ui-btn', `ui-btn-${variant}`, `ui-btn-${size}`,
        block ? 'ui-btn-block' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
    >
      {loading
        ? <span className="ui-btn-spinner" aria-hidden="true" />
        : icon ? <span className="ui-btn-icon" aria-hidden="true">{icon}</span> : null}
      {children != null && <span className="ui-btn-label">{children}</span>}
    </button>
  )
}
