import type { TrainedModel } from '../../store/useAppStore'
import { useTranslation } from 'react-i18next'

interface Props {
  model:    TrainedModel
  onDelete: () => void
  onRetrain: () => void
  onPlay:   () => void
}

export function ModelCard({ model, onDelete, onRetrain, onPlay }: Props): JSX.Element {
  const { t } = useTranslation()
  const date = new Date(model.trainedAt).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })

  return (
    <div className="model-card">
      <div className="model-card-cover">
        {model.coverDataUrl ? (
          <img src={model.coverDataUrl} alt={model.name} />
        ) : (
          <span className="model-card-cover-placeholder">🎤</span>
        )}
      </div>

      <div className="model-card-body">
        <div className="model-card-name" title={model.name}>{model.name}</div>
        <div className="model-card-meta">
          <span className={`badge badge-mode-${model.mode}`}>
            {model.mode === 'standard' ? t('training.standard') : t('training.pro')}
          </span>
          <span className="model-card-date">{date}</span>
        </div>
        {model.bestLoss != null && (
          <div className="model-card-loss">{t('training.lossLabel', { value: model.bestLoss.toFixed(5) })}</div>
        )}
      </div>

      <div className="model-card-actions">
        <button
          className="btn btn-primary"
          style={{ flex: 1, fontSize: 12, padding: '6px 0' }}
          onClick={onPlay}
          disabled={!model.demoAudioUrl}
          title={model.demoAudioUrl ? t('training.play') : t('training.noDemo')}
        >
          ▶ Demo
        </button>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '6px 10px' }}
          onClick={onRetrain}
          title={t('training.retrain')}
        >
          🔁
        </button>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '6px 10px', color: 'var(--danger)' }}
          onClick={onDelete}
          title={t('training.delete')}
        >
          🗑
        </button>
      </div>
    </div>
  )
}
