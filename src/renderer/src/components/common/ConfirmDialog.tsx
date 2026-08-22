import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  title:    string
  message:  string
  /** Label for the confirming action. Defaults to a generic confirm. */
  confirmLabel?: string
  /** Styles the confirm button as destructive. */
  danger?:  boolean
  onConfirm: () => void
  onCancel:  () => void
}

/**
 * Small modal confirmation for destructive actions (Ticket UI-11's delete).
 *
 * Focus lands on Cancel rather than Confirm: for an irreversible action the
 * safe option should be the one a stray Enter hits.
 */
export function ConfirmDialog({
  title, message, confirmLabel, danger, onConfirm, onCancel,
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

  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="confirm-card" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="confirm-title">{title}</div>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost confirm-cancel" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`confirm-ok${danger ? ' danger' : ''}`}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
