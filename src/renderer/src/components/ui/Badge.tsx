import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

interface Props {
  tone?:  BadgeTone
  children: ReactNode
  title?: string
}

/** Small status pill (Ticket UI-14). */
export function Badge({ tone = 'neutral', children, title }: Props): JSX.Element {
  return <span className={`ui-badge ui-badge-${tone}`} title={title}>{children}</span>
}
