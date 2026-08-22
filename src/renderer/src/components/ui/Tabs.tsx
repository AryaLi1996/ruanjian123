export interface TabItem<T extends string> {
  key:   T
  label: string
}

interface Props<T extends string> {
  items:    ReadonlyArray<TabItem<T>>
  active:   T
  onChange: (key: T) => void
  ariaLabel: string
}

/** Underlined tab strip (Ticket UI-14). Scrolls horizontally when crowded. */
export function Tabs<T extends string>({ items, active, onChange, ariaLabel }: Props<T>): JSX.Element {
  return (
    <div className="ui-tabs" role="tablist" aria-label={ariaLabel}>
      {items.map(({ key, label }) => (
        <button
          key={key}
          role="tab"
          aria-selected={active === key}
          className={`ui-tab${active === key ? ' active' : ''}`}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
