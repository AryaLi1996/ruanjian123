import { useTranslation } from 'react-i18next'

export type TrainingMode = 'standard' | 'professional'

interface ModeSpec {
  id:       TrainingMode
  label:    string
  tagline:  string
  gpuTime:  string
  cpuTime:  string
  vram:     string
  rank:     string
}

const MODES: ModeSpec[] = [
  {
    id:      'standard',
    label:   'Standard',
    tagline: 'LoRA rank-4 · timbre encoder only',
    gpuTime: '≤ 5 min',
    cpuTime: '≤ 20 min',
    vram:    '2 GB',
    rank:    'rank-4',
  },
  {
    id:      'professional',
    label:   'Professional',
    tagline: 'LoRA+ rank-8 · all layers · gradient checkpointing',
    gpuTime: '≤ 90 min',
    cpuTime: '≤ 6 h',
    vram:    '6 GB',
    rank:    'rank-8',
  },
]

interface Props {
  value:    TrainingMode
  onChange: (m: TrainingMode) => void
}


export function ModeSelector({ value, onChange }: Props): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="mode-grid">
      {MODES.map((m) => (
        <button
          key={m.id}
          className={`mode-card${value === m.id ? ' selected' : ''}`}
          onClick={() => onChange(m.id)}
          aria-pressed={value === m.id}
        >
          <div className="mode-card-header">
            <span className="mode-card-name">{t(`training.${m.id}`)}</span>
            {value === m.id && <span className="mode-card-check">✓</span>}
          </div>
          <div className="mode-card-tagline">{t(`training.${m.id}Tagline`)}</div>
          <div className="mode-card-specs">
            <div className="spec-row"><span>{t('training.trainingGpu')}</span><strong>{m.gpuTime}</strong></div>
            <div className="spec-row"><span>{t('training.trainingCpu')}</span><strong>{m.cpuTime}</strong></div>
            <div className="spec-row"><span>{t('training.trainingVram')}</span><strong>{m.vram}</strong></div>
          </div>
        </button>
      ))}
    </div>
  )
}
