import { useTranslation } from 'react-i18next'
import { WaveformEditor } from '../components/waveform/WaveformEditor'

// Ticket 15: standalone waveform display + region-selection workspace.
// Selection bounds and playback state live in useWaveformStore so other
// features (crop/export, downstream engine calls, etc.) can read them
// without depending on this view being mounted.
export function WaveformEditorView(): JSX.Element {
  const { t } = useTranslation()

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">{t('waveformEditor.title')}</h1>
        <p className="view-desc">{t('waveformEditor.description')}</p>
      </div>

      <div className="card">
        <WaveformEditor />
      </div>
    </>
  )
}
