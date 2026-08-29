import React from 'react'
import { useTranslation } from 'react-i18next'
import { COVER_STEPS, stepStatus, unmetPrerequisites, type StepDef } from '../../utils/wizardSteps'

export type { StepDef } from '../../utils/wizardSteps'

interface Props {
  current:    number
  completed:  Set<number>
  onNavigate: (step: number) => void
  /**
   * FC-03: called instead of onNavigate when the user clicks a step that is
   * still locked, with the steps they need to finish first (ascending). The
   * button stays clickable on purpose — a disabled control that silently
   * swallows the click is exactly what left users wondering why the training
   * step "did nothing".
   */
  onBlocked?: (step: number, unmet: number[]) => void
}

export function StepWizard({ current, completed, onNavigate, onBlocked }: Props): JSX.Element {
  const { t } = useTranslation()
  const labels: Record<number, string> = {
    1: t('cover.stepUpload'),
    2: t('cover.stepModel'),
    3: t('cover.stepMix'),
    4: t('cover.stepExport'),
    5: t('cover.stepTrainingData'),
  }

  function handleClick(step: StepDef): void {
    const unmet = unmetPrerequisites(step, completed)
    if (step.number === current || completed.has(step.number) || unmet.length === 0) {
      onNavigate(step.number)
      return
    }
    onBlocked?.(step.number, unmet)
  }

  return (
    <nav className="wizard-steps" aria-label={t('cover.workflowSteps')}>
      {COVER_STEPS.map((step, i) => {
        const status = stepStatus(step, current, completed)
        const locked = status === 'locked'
        const unmet  = unmetPrerequisites(step, completed)

        return (
          <React.Fragment key={step.number}>
            <button
              className={`wizard-step ${status}`}
              onClick={() => handleClick(step)}
              // Not `disabled`: a locked step still explains itself when
              // clicked (see handleClick). aria-disabled keeps that visible
              // to assistive tech without making the button unreachable.
              aria-disabled={locked || undefined}
              aria-current={status === 'active' ? 'step' : undefined}
              title={locked
                ? t('cover.stepLockedTooltip', { steps: unmet.map((n) => labels[n]).join('、') })
                : undefined}
            >
              <span className="step-circle">
                {status === 'completed' ? '✓' : locked ? '🔒' : step.number}
              </span>
              <span className="step-label">{labels[step.number]}</span>
            </button>
            {i < COVER_STEPS.length - 1 && (
              <div className={`step-connector${completed.has(step.number) ? ' done' : ''}`} />
            )}
          </React.Fragment>
        )
      })}
    </nav>
  )
}
