import type { InputHTMLAttributes, ReactNode } from 'react'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  /** Visible label; also wires up the accessible name. */
  label?:   ReactNode
  /** Error text — replaces `hint` and puts the field in its invalid state. */
  error?:   string | null
  hint?:    ReactNode
  className?: string
}

/** Standard text field (Ticket UI-14): 12px radius, accent focus glow. */
export function Input({ label, error, hint, className, id, ...rest }: Props): JSX.Element {
  const inputId = id ?? rest.name
  return (
    <div className={`ui-field${className ? ` ${className}` : ''}`}>
      {label && <label className="ui-field-label" htmlFor={inputId}>{label}</label>}
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={`ui-input${error ? ' invalid' : ''}`}
      />
      {error
        ? <span className="ui-field-error">{error}</span>
        : hint ? <span className="ui-field-hint">{hint}</span> : null}
    </div>
  )
}
