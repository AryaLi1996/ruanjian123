import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  assessQuality, scoreStars,
  type QualityInput, type QualityIssueId,
} from '../../utils/trainingQuality'

interface Props {
  result: QualityInput
  /** Restarts the form with this run's settings. */
  onRetrain: () => void
  /** Dismisses the report and keeps the model that was just saved. */
  onKeep:    () => void
  /**
   * Opens Data Preparation, where 执行降噪 lives. Offered only for the noise
   * issue — the tool is useless for a recording that is merely too short.
   */
  onOpenDenoise?: () => void
}

/**
 * Ticket T2: the report a finished run ends on.
 *
 * Before this, everything the engine knew about a bad run — that the upload
 * was 34 seconds against a 15-minute recommendation, that its SNR was under
 * the bar, that the exported model barely resembled its own training material
 * — arrived as grey warning banners stacked above a raw JSON dump of the
 * result. Users read the JSON, saw the word "error" somewhere in the log
 * panel, and concluded training had failed; the actual finding, and the fact
 * that it was fixable by recording more or denoising, went unread.
 *
 * So the findings get the foreground: a score, what is wrong with it, what to
 * do about it, and the two decisions actually available — train again, or
 * keep the model knowing what it is. The model is saved either way; this
 * dialog never deletes anything.
 */
export function QualityReport({ result, onRetrain, onKeep, onOpenDenoise }: Props): JSX.Element {
  const { t } = useTranslation()
  const { score, level, issues } = assessQuality(result)
  const stars = scoreStars(score)

  // Focus lands on "keep" — the run succeeded, and the non-destructive option
  // should be the one a stray Enter hits.
  const keepRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { keepRef.current?.focus() }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') { event.stopPropagation(); onKeep() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeep])

  // One tip per issue, in the same order — the tip is the actionable half of
  // the finding, so they are read as a pair rather than as two lists.
  const tipFor = (id: QualityIssueId): string => t(`quality.tip.${id}`)

  return (
    <div className="quality-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onKeep() }}>
      <div className="quality-card" role="alertdialog" aria-modal="true" aria-label={t('quality.title')}>
        <div className="quality-header">
          <div className="quality-title">{t('quality.title')}</div>
          <div className={`quality-verdict quality-${level}`}>{t(`quality.level.${level}`)}</div>
        </div>

        {/* Score: stars for the glance, a bar and a number for the detail. */}
        <div className="quality-score">
          <div className="quality-stars" aria-hidden="true">
            {'★'.repeat(stars)}{'☆'.repeat(5 - stars)}
          </div>
          <div className="quality-score-body">
            <div className="quality-bar" role="progressbar"
                 aria-valuenow={score == null ? 0 : Math.round(score * 100)}
                 aria-valuemin={0} aria-valuemax={100}
                 aria-label={t('quality.scoreLabel')}>
              <div className={`quality-bar-fill quality-${level}`}
                   style={{ width: `${score == null ? 0 : Math.round(score * 100)}%` }} />
            </div>
            <div className="quality-score-text">
              {score == null
                ? t('quality.scoreUnknown')
                : t('quality.scoreValue', { percent: Math.round(score * 100) })}
            </div>
          </div>
        </div>

        {issues.length === 0 ? (
          <p className="quality-clean">✅ {t('quality.clean')}</p>
        ) : (
          <>
            <div className="quality-section-title">{t('quality.issuesTitle')}</div>
            <ul className="quality-issues">
              {issues.map((issue) => (
                <li key={issue.id} className="quality-issue">
                  <span aria-hidden="true">❌</span>
                  <span>{t(`quality.issue.${issue.id}`, issue.values)}</span>
                </li>
              ))}
            </ul>

            <div className="quality-section-title">{t('quality.tipsTitle')}</div>
            <ul className="quality-tips">
              {issues.map((issue) => (
                <li key={issue.id} className="quality-tip">
                  <span aria-hidden="true">💡</span>
                  <span>
                    {tipFor(issue.id)}
                    {issue.id === 'snr' && onOpenDenoise && (
                      <button type="button" className="quality-link" onClick={onOpenDenoise}>
                        {t('quality.openDenoise')}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* The engine's own sentence, when it had one to add beyond the
            findings above — kept verbatim rather than paraphrased. */}
        {result.quality_warning && (
          <p className="quality-engine-note">{result.quality_warning}</p>
        )}

        <div className="quality-actions">
          <button type="button" className="btn btn-ghost quality-retrain" onClick={onRetrain}>
            {t('quality.retrain')}
          </button>
          <button ref={keepRef} type="button" className="quality-keep" onClick={onKeep}>
            {t('quality.keep')}
          </button>
        </div>
        <p className="quality-footnote">{t('quality.savedNote')}</p>
      </div>
    </div>
  )
}
