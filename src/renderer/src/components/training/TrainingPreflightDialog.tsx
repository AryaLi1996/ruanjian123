import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '../../utils/audio'
import type { PreflightResult, PreflightSeverity } from '../../utils/trainingPreflight'

interface Props {
  result: PreflightResult
  /** Ticket P2: offered only for a professional-mode run that will land on the CPU. */
  onSwitchToStandard?: () => void
  /**
   * Ticket P4: drop these files from the selection and re-run the check.
   * Given the names a row names as removable, so "shorten your material"
   * becomes one click on the exact files the row is about.
   */
  onRemoveFiles?: (names: string[]) => void
  onConfirm: () => void
  onCancel:  () => void
}

const ICONS: Record<PreflightSeverity, string> = { blocker: '❌', warning: '⚠', ok: '✔' }

/**
 * Ticket P1: the self-check the user sees after pressing 开始本地训练.
 *
 * Everything on this list is decided locally, before the engine is spawned —
 * see utils/trainingPreflight.ts for why each item exists. A ❌ disables the
 * confirm button: those are the limits that would otherwise fail silently
 * (unreadable formats dropped, same-named files overwritten, material too
 * short to produce a single training chunk), which is exactly what made a
 * failed run look like a button that does nothing.
 */
export function TrainingPreflightDialog({
  result, onSwitchToStandard, onRemoveFiles, onConfirm, onCancel,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => { cancelRef.current?.focus() }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const blockers = result.items.filter((i) => i.severity === 'blocker')

  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        className="confirm-card preflight-card"
        role="alertdialog"
        aria-modal="true"
        aria-label={t('preflight.title')}
      >
        <div className="confirm-title">{t('preflight.title')}</div>
        <p className="confirm-message">
          {blockers.length > 0 ? t('preflight.blockedSummary', { count: blockers.length }) : t('preflight.summary')}
        </p>

        <ul className="preflight-list">
          {result.items.map((item) => (
            <li key={item.id} className={`preflight-item ${item.severity}`}>
              <span className="preflight-icon" aria-hidden="true">{ICONS[item.severity]}</span>
              <div className="preflight-body">
                <span className="preflight-text">{t(item.messageKey, item.params)}</span>

                {/* Ticket P4: which files this row is about, measured. A
                    warning the user can't act on is just a delay. */}
                {item.files && item.files.length > 0 && (
                  <ul className="preflight-files">
                    {item.files.map((f) => (
                      <li key={f.name}>
                        <span className="preflight-file-name">{f.name}</span>
                        <span className="preflight-file-dur">
                          {f.duration != null ? formatDuration(f.duration) : t('preflight.durationUnknown')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {item.removable && item.removable.length > 0 && onRemoveFiles && (
                  <button
                    type="button"
                    className="btn btn-ghost preflight-remove-btn"
                    onClick={() => onRemoveFiles(item.removable as string[])}
                  >
                    {t('preflight.removeSuggested', { count: item.removable.length })}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>

        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost confirm-cancel" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          {onSwitchToStandard && (
            <button type="button" className="btn btn-ghost" onClick={onSwitchToStandard}>
              {t('preflight.switchToStandard')}
            </button>
          )}
          <button
            type="button"
            className="confirm-ok"
            onClick={onConfirm}
            disabled={!result.canProceed}
            title={result.canProceed ? undefined : t('preflight.blockedHint')}
          >
            {result.cpuProfessional ? t('preflight.tryAnyway') : t('preflight.proceed')}
          </button>
        </div>

        {!result.canProceed && (
          <p className="preflight-blocked-hint" role="alert">{t('preflight.blockedHint')}</p>
        )}
      </div>
    </div>
  )
}
