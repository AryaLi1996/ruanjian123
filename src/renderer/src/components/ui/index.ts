// The app's shared UI primitives (Ticket UI-14).
//
// One import site for every standard control, so a page never has to know
// which file a primitive lives in:
//   import { Button, Input, Badge, Card, Tabs } from '../components/ui'
export { Button, type ButtonVariant, type ButtonSize } from './Button'
export { Input } from './Input'
export { Badge, type BadgeTone } from './Badge'
export { Card } from './Card'
export { Tabs, type TabItem } from './Tabs'
