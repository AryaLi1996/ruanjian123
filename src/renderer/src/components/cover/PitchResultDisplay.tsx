import { useTranslation } from 'react-i18next'
import { midiToNoteName, suggestedProtectionThreshold } from '../../utils/pitch'
import type { PitchAnalysisResult } from '../../store/usePitchStore'

interface Props {
  result: PitchAnalysisResult | null
}

/** Ticket 16: shows the outcome of "分析音高" — highest note found and a
 *  suggested high-note protection threshold derived from it. */
export function PitchResultDisplay({ result }: Props): JSX.Element | null {
  const { t } = useTranslation()
  if (!result) return null

  const hasPitch = result.maxMidi > 0
  const maxNote       = hasPitch ? midiToNoteName(result.maxMidi) : '—'
  const thresholdNote = hasPitch ? midiToNoteName(suggestedProtectionThreshold(result.maxMidi)) : '—'

  if (!hasPitch) {
    return (
      <div className="pitch-result" role="status">
        <p className="pitch-result-empty">{t('pitch.noPitchDetected')}</p>
      </div>
    )
  }

  return (
    <div className="pitch-result" role="status">
      <p className="pitch-result-summary">
        {t('pitch.summary', { maxNote, thresholdNote })}
      </p>
      <div className="pitch-result-stats">
        <div className="pitch-stat">
          <span className="pitch-stat-label">{t('pitch.maxDetected')}</span>
          <span className="pitch-stat-value pitch-stat-max">{maxNote}</span>
        </div>
        <div className="pitch-stat">
          <span className="pitch-stat-label">{t('pitch.suggestedThreshold')}</span>
          <span className="pitch-stat-value pitch-stat-threshold">{thresholdNote}</span>
        </div>
        <div className="pitch-stat">
          <span className="pitch-stat-label">{t('pitch.avgDetected')}</span>
          <span className="pitch-stat-value">{midiToNoteName(result.avgMidi)}</span>
        </div>
      </div>
    </div>
  )
}
