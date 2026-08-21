import React from 'react'
import { useTranslation } from 'react-i18next'

export interface StepDef {
  number: number
  label:  string
  // Which earlier step must be completed to unlock this one. Defaults to
  // `number - 1` (the previous step) — set explicitly for Step 5, which
  // only needs synthesis (step 3) done, not the export step (4): building
  // a training dataset doesn't require having exported a mixdown first.
  requires?: number
}

interface Props {
  current:    number
  completed:  Set<number>
  onNavigate: (step: number) => void
}

export function StepWizard({ current, completed, onNavigate }: Props): JSX.Element {
  const { t } = useTranslation()
  const steps: StepDef[] = [
    { number: 1, label: t('cover.stepUpload') },
    { number: 2, label: t('cover.stepModel')  },
    { number: 3, label: t('cover.stepMix')    },
    { number: 4, label: t('cover.stepExport') },
    { number: 5, label: t('cover.stepTrainingData'), requires: 3 },
  ]

  return (
    <nav className="wizard-steps" aria-label={t('cover.workflowSteps')}>
      {steps.map((step, i) => {
        const isDone   = completed.has(step.number)
        const isActive = current === step.number
        const canNav   = isDone || isActive || completed.has(step.requires ?? step.number - 1)

        return (
          <React.Fragment key={step.number}>
            <button
              className={`wizard-step${isActive ? ' active' : ''}${isDone ? ' done' : ''}`}
              onClick={() => canNav && onNavigate(step.number)}
              disabled={!canNav}
              aria-current={isActive ? 'step' : undefined}
            >
              <span className="step-circle">{isDone ? '✓' : step.number}</span>
              <span className="step-label">{step.label}</span>
            </button>
            {i < steps.length - 1 && (
              <div className={`step-connector${isDone ? ' done' : ''}`} />
            )}
          </React.Fragment>
        )
      })}
    </nav>
  )
}
