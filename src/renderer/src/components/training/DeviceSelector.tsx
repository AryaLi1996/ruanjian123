import { useTranslation } from 'react-i18next'
import type { EngineDeviceInfo } from '../../global'
import {
  CPU_SLOWDOWN_MAX, CPU_SLOWDOWN_MIN, describeDevice, isGpuAvailable, type DeviceMode,
} from '../../utils/environmentCheck'

interface Props {
  device:   EngineDeviceInfo | null
  value:    DeviceMode
  onChange: (mode: DeviceMode) => void
}

/**
 * GPU / CPU selection (Ticket T2).
 *
 * The screenshot in the ticket showed "No GPU detected" next to a fully
 * enabled training button and mode cards quoting GPU times — nothing tied the
 * detection result to what the user could actually pick. Here the detected
 * device drives the selection: GPU is disabled outright when torch can't use
 * one, CPU is preselected, and the current device is stated in words.
 */
export function DeviceSelector({ device, value, onChange }: Props): JSX.Element {
  const { t } = useTranslation()
  const gpuAvailable = isGpuAvailable(device)

  return (
    <div className="device-selector">
      <div className="device-current">
        {t('training.currentDevice', { device: describeDevice(device) })}
      </div>

      <div className="device-options" role="radiogroup" aria-label={t('training.deviceMode')}>
        <button
          type="button"
          role="radio"
          aria-checked={value === 'gpu'}
          className={`device-option${value === 'gpu' ? ' selected' : ''}${gpuAvailable ? '' : ' disabled'}`}
          disabled={!gpuAvailable}
          // Disabled controls don't fire hover events in every browser, so the
          // reason also appears as static text below — this is a convenience.
          title={gpuAvailable ? undefined : t('training.gpuUnavailableHint')}
          onClick={() => onChange('gpu')}
        >
          <span className="device-option-name">{t('training.gpu')}</span>
          <span className="device-option-detail">
            {gpuAvailable ? (device?.gpu_name ?? t('training.gpuGeneric')) : t('training.notDetected')}
          </span>
        </button>

        <button
          type="button"
          role="radio"
          aria-checked={value === 'cpu'}
          className={`device-option${value === 'cpu' ? ' selected' : ''}`}
          onClick={() => onChange('cpu')}
        >
          <span className="device-option-name">{t('training.cpu')}</span>
          <span className="device-option-detail">
            {t('training.cpuSlower', { min: CPU_SLOWDOWN_MIN, max: CPU_SLOWDOWN_MAX })}
          </span>
        </button>
      </div>

      {!gpuAvailable && (
        <div className="cpu-notice">
          ⚠ {t('training.noGpuNotice', { min: CPU_SLOWDOWN_MIN, max: CPU_SLOWDOWN_MAX })}
          {device?.detail && <span className="device-detail-note"> {device.detail}</span>}
        </div>
      )}
    </div>
  )
}
