import { useTranslation } from 'react-i18next'
import { useAppStore, type TrainedModel } from '../../store/useAppStore'

/**
 * The model these panels describe: the applied one, or — when nothing has
 * been applied — the most recently trained, flagged so the panel can say
 * which it is. Falling back matters because `selectedModel` is only set by
 * the model library's 应用模型 action, so without it a user who has trained
 * a model but never applied one would see empty panels and conclude the
 * feature is broken.
 */
function useDescribedModel(): { model: TrainedModel | null; isApplied: boolean } {
  const selectedModel = useAppStore((s) => s.selectedModel)
  const trainedModels = useAppStore((s) => s.trainedModels)

  const applied = trainedModels.find((m) => m.onnxPath === selectedModel) ?? null
  if (applied) return { model: applied, isApplied: true }

  const latest = trainedModels.reduce<TrainedModel | null>(
    (best, m) => (best === null || m.trainedAt > best.trainedAt ? m : best), null)
  return { model: latest, isApplied: false }
}

/**
 * The applied model's training parameters, and a schematic of the pipeline
 * its audio runs through (Ticket UI-13's 训练配置参数 / 模型结构简图 tabs).
 */
export function ModelConfigPanel(): JSX.Element {
  const { t } = useTranslation()
  const { model, isApplied } = useDescribedModel()

  if (!model) {
    return <p className="pbm-empty-hint">{t('playbackPanels.noModel')}</p>
  }

  const rows: Array<[string, string]> = [
    // Not training.name: that key carries a trailing " *" required-field
    // marker, which is meaningless in a read-only panel.
    [t('playbackPanels.configName'), model.name],
    [t('playbackPanels.configMode'),  model.mode === 'standard' ? t('training.standard') : t('training.pro')],
    [t('training.stepsLabel'),  String(model.epochs)],
    [t('training.lossShort'),   model.bestLoss.toFixed(5)],
    [t('training.dateLabel'),   new Date(model.trainedAt).toLocaleDateString()],
  ]
  if (model.qualityScore != null) {
    rows.push([t('playbackPanels.configQuality'), `${Math.round(model.qualityScore * 100)}%`])
  }

  return (
    <dl className="pbm-config-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd title={value}>{value}</dd>
        </div>
      ))}
      {!isApplied && (
        <p className="pbm-config-note">{t('playbackPanels.showingLatest')}</p>
      )}
      {model.qualityWarning && (
        <p className="pbm-config-warning">⚠ {model.qualityWarning}</p>
      )}
    </dl>
  )
}

/**
 * Schematic of the inference pipeline. Deliberately a hand-drawn SVG rather
 * than a rendering of the real ONNX graph: the graph has hundreds of nodes
 * and would be unreadable at this size, whereas the five stages below are
 * what a user actually needs to reason about when a result sounds wrong.
 */
export function ModelStructurePanel(): JSX.Element {
  const { t } = useTranslation()
  const { model } = useDescribedModel()
  const pro = model?.mode === 'professional'

  const stages = [
    { key: 'input',   label: t('playbackPanels.stageInput') },
    { key: 'encoder', label: t('playbackPanels.stageEncoder') },
    { key: 'adapter', label: pro ? 'LoRA+ r8' : 'LoRA r4' },
    { key: 'decoder', label: t('playbackPanels.stageDecoder') },
    { key: 'output',  label: t('playbackPanels.stageOutput') },
  ]

  return (
    <div className="pbm-structure">
      <svg viewBox="0 0 200 260" className="pbm-structure-svg" role="img" aria-label={t('playbackPanels.tabStructure')}>
        {stages.map((stage, i) => {
          const y = 8 + i * 50
          const isAdapter = stage.key === 'adapter'
          return (
            <g key={stage.key}>
              {i > 0 && (
                <line
                  x1="100" y1={y - 12} x2="100" y2={y}
                  stroke="var(--border)" strokeWidth="2" markerEnd="url(#pbm-arrow)"
                />
              )}
              <rect
                x="20" y={y} width="160" height="38" rx="10"
                fill={isAdapter ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : 'var(--bg)'}
                stroke={isAdapter ? 'var(--accent)' : 'var(--border)'}
                strokeWidth="1.5"
              />
              <text
                x="100" y={y + 23}
                textAnchor="middle"
                fontSize="12"
                fill={isAdapter ? 'var(--accent)' : 'var(--text)'}
              >
                {stage.label}
              </text>
            </g>
          )
        })}
        <defs>
          <marker id="pbm-arrow" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="var(--border)" />
          </marker>
        </defs>
      </svg>
      <p className="pbm-structure-note">
        {model ? t('playbackPanels.structureNote') : t('playbackPanels.noModel')}
      </p>
    </div>
  )
}
