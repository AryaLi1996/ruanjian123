import { useTranslation } from 'react-i18next'
import type { TrainedModel } from '../../store/useAppStore'

interface Props {
  model:      TrainedModel
  /** True when this model is the one selected for inference. */
  applied:    boolean
  onApply:    () => void
  onDelete:   () => void
  onRetrain:  () => void
  onPlay:     () => void
  onDownload: () => void
  /** True while this card's demo is the one playing. */
  playing:    boolean
}

export function ModelCard({
  model, applied, onApply, onDelete, onRetrain, onPlay, onDownload, playing,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const date = new Date(model.trainedAt).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })
  const hasDemo = Boolean(model.demoAudioUrl || model.demoAudioPath)

  return (
    <div className={`model-card${applied ? ' applied' : ''}`}>
      <div className="model-card-cover">
        {model.coverDataUrl
          ? <img src={model.coverDataUrl} alt="" />
          : <span className="model-card-cover-placeholder" aria-hidden="true">🎤</span>}

        {/* Ticket UI-11 §2: the audition control is a large circular button
            revealed over the cover, the way a playlist tile does it, rather
            than a small text button competing with the footer actions. */}
        <div className="mc-hover">
          <button
            type="button"
            className="mc-play"
            onClick={onPlay}
            disabled={!hasDemo}
            title={hasDemo ? t('training.play') : t('training.noDemo')}
            aria-label={hasDemo ? t('training.play') : t('training.noDemo')}
          >
            {playing ? '⏸' : '▶'}
          </button>
        </div>

        {applied && <span className="mc-applied-badge">✓ {t('training.applied')}</span>}
      </div>

      <div className="model-card-body">
        <div className="model-card-name" title={model.name}>{model.name}</div>

        <div className="model-card-meta">
          <span className={`badge badge-mode-${model.mode}`}>
            {model.mode === 'standard' ? t('training.standard') : t('training.pro')}
          </span>
          {/* A card only exists for a run that finished, so "ready" is the
              honest steady state; a low-quality export is the one degraded
              state this data model can actually distinguish. */}
          {model.qualityWarning
            ? <span className="mc-badge warn" title={model.qualityWarning}>⚠ {t('training.qualityLow')}</span>
            : <span className="mc-badge ok">{t('training.ready')}</span>}
        </div>

        <dl className="mc-stats">
          <div><dt>{t('training.stepsLabel')}</dt><dd>{model.epochs}</dd></div>
          <div><dt>{t('training.dateLabel')}</dt><dd>{date}</dd></div>
          {model.bestLoss != null && (
            <div><dt>{t('training.lossShort')}</dt><dd>{model.bestLoss.toFixed(4)}</dd></div>
          )}
        </dl>
      </div>

      <div className="model-card-actions">
        <button
          type="button"
          className={`mc-apply${applied ? ' applied' : ''}`}
          onClick={onApply}
          title={t('training.applyModel')}
        >
          {applied ? `✓ ${t('training.applied')}` : t('training.applyModel')}
        </button>

        <button type="button" className="mc-icon" onClick={onRetrain} title={t('training.retrain')} aria-label={t('training.retrain')}>🔁</button>
        <button type="button" className="mc-icon" onClick={onDownload} title={t('training.download')} aria-label={t('training.download')}>⬇</button>
        <button type="button" className="mc-icon danger" onClick={onDelete} title={t('training.delete')} aria-label={t('training.delete')}>🗑</button>
      </div>
    </div>
  )
}
