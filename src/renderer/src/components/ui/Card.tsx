import type { ReactNode } from 'react'

interface Props {
  title?:  ReactNode
  /** Rendered at the card's top-right, opposite the title. */
  actions?: ReactNode
  children: ReactNode
  className?: string
}

/** Standard panel (Ticket UI-14) — the 16px-radius surface from UI-01. */
export function Card({ title, actions, children, className }: Props): JSX.Element {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <header className="ui-card-header">
          {title && <h2 className="ui-card-title">{title}</h2>}
          {actions && <div className="ui-card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}
