/**
 * Cover Creation step-lock rules (FC-03).
 *
 * The wizard is strictly linear: a step is reachable only once everything it
 * depends on has actually finished. Previously the only thing enforcing that
 * was the nav bar's disabled attribute, which said nothing about *why* a step
 * was unavailable — so a user who landed on the training step with nothing
 * separated had no idea what to do about it. These helpers make the rule
 * explicit and testable, and give the UI the list of unmet prerequisites to
 * name in a tooltip/toast.
 *
 * Pure and dependency-free on purpose (no React, no i18n) — the step *labels*
 * are the caller's business; this module only decides reachability.
 */

export type StepStatus = 'completed' | 'active' | 'unlocked' | 'locked'

export interface StepDef {
  number: number
  /**
   * The last step that must be completed before this one unlocks; every step
   * before it must be completed too (see unmetPrerequisites). Defaults to the
   * immediately preceding step.
   */
  requires?: number
}

/**
 * Step 5 (training dataset) requires step 3 (synthesis) rather than step 4:
 * building a training dataset consumes the AI vocal, not an exported
 * mixdown, so demanding an export first would block the step on work it
 * never uses. Steps 1-3 still have to be done, which is what actually
 * prevents the "scroll down and train with nothing separated" case FC-03 is
 * about.
 */
export const COVER_STEPS: readonly StepDef[] = [
  { number: 1 },
  { number: 2 },
  { number: 3 },
  { number: 4 },
  { number: 5, requires: 3 },
] as const

export function prerequisiteOf(step: StepDef): number {
  return step.requires ?? step.number - 1
}

/**
 * Every step that must be completed for `step` to unlock but isn't, in
 * ascending order. Empty means the step is reachable. The first entry is the
 * one worth telling the user about — it's what they should do next.
 */
export function unmetPrerequisites(step: StepDef, completed: ReadonlySet<number>): number[] {
  const upTo = prerequisiteOf(step)
  const unmet: number[] = []
  for (let n = 1; n <= upTo; n++) {
    if (!completed.has(n)) unmet.push(n)
  }
  return unmet
}

/** Whether the user may navigate to `step` at all. */
export function isUnlocked(step: StepDef, current: number, completed: ReadonlySet<number>): boolean {
  // The step being viewed is always navigable-to (it's already on screen),
  // and a completed step stays revisitable so the user can go back and
  // change an earlier choice.
  if (step.number === current || completed.has(step.number)) return true
  return unmetPrerequisites(step, completed).length === 0
}

export function stepStatus(step: StepDef, current: number, completed: ReadonlySet<number>): StepStatus {
  if (step.number === current) return 'active'
  if (completed.has(step.number)) return 'completed'
  return unmetPrerequisites(step, completed).length === 0 ? 'unlocked' : 'locked'
}
