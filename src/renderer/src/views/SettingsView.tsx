import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ACCENT_PRESETS, useSettingsStore, type Appearance } from '../store/useSettingsStore'

const APPEARANCE_OPTIONS: { value: Appearance; icon: string }[] = [
  { value: 'system', icon: '🖥️' },
  { value: 'light',  icon: '☀️' },
  { value: 'dark',   icon: '🌙' },
]

// Longest side an uploaded photo is downscaled to before being stored as a
// data URL — keeps the avatar well under localStorage's per-origin quota
// regardless of how large the source photo is.
const AVATAR_MAX_SIZE = 256

export function SettingsView(): JSX.Element {
  const { t } = useTranslation()
  const appearance     = useSettingsStore((s) => s.appearance)
  const accentColor    = useSettingsStore((s) => s.accentColor)
  const avatarDataUrl  = useSettingsStore((s) => s.avatarDataUrl)
  const setAppearance  = useSettingsStore((s) => s.setAppearance)
  const setAccentColor = useSettingsStore((s) => s.setAccentColor)
  const setAvatar      = useSettingsStore((s) => s.setAvatar)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)

  function handlePhotoPick(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { setPhotoError(t('settings.photoInvalid')); return }
    setPhotoError(null)

    const img = new Image()
    const objectUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const scale = Math.min(1, AVATAR_MAX_SIZE / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { setPhotoError(t('settings.photoInvalid')); return }
      ctx.drawImage(img, 0, 0, w, h)
      try {
        // An SVG that references external resources can taint the canvas,
        // which throws a SecurityError on read — fail gracefully rather than
        // crash the settings page over a bad upload.
        setAvatar(canvas.toDataURL('image/jpeg', 0.88))
      } catch {
        setPhotoError(t('settings.photoInvalid'))
      }
    }
    img.onerror = () => { URL.revokeObjectURL(objectUrl); setPhotoError(t('settings.photoInvalid')) }
    img.src = objectUrl
  }

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">{t('settings.title')}</h1>
        <p className="view-desc">{t('settings.description')}</p>
      </div>

      {/* ── Appearance ─────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">{t('settings.appearance')}</div>
        <div className="appearance-grid">
          {APPEARANCE_OPTIONS.map(({ value, icon }) => (
            <button
              key={value}
              type="button"
              className={`appearance-option${appearance === value ? ' selected' : ''}`}
              onClick={() => setAppearance(value)}
              aria-pressed={appearance === value}
            >
              <span className="appearance-icon" aria-hidden="true">{icon}</span>
              <span>{t(`settings.${value}`)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Theme colour ───────────────────────────────────── */}
      <div className="card">
        <div className="card-title">{t('settings.themeColor')}</div>
        <div className="swatch-grid">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`swatch-btn${accentColor === preset.id ? ' selected' : ''}`}
              style={{ background: preset.accent }}
              onClick={() => setAccentColor(preset.id)}
              aria-pressed={accentColor === preset.id}
              aria-label={t(`settings.accent.${preset.id}`)}
              title={t(`settings.accent.${preset.id}`)}
            >
              {accentColor === preset.id && <span className="swatch-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Profile photo ──────────────────────────────────── */}
      <div className="card">
        <div className="card-title">{t('settings.profilePhoto')}</div>
        <div className="avatar-row">
          <label className="avatar-picker" title={t('settings.uploadPhoto')}>
            {avatarDataUrl
              ? <img src={avatarDataUrl} alt="" className="avatar-img" />
              : <span className="avatar-placeholder">🙂</span>}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handlePhotoPick}
            />
          </label>
          <div className="avatar-actions">
            <button type="button" className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>
              {t('settings.uploadPhoto')}
            </button>
            {avatarDataUrl && (
              <button type="button" className="btn btn-ghost" onClick={() => setAvatar(null)}>
                {t('settings.removePhoto')}
              </button>
            )}
            <p className="avatar-hint">{t('settings.photoHint')}</p>
            {photoError && <p className="avatar-error">{photoError}</p>}
          </div>
        </div>
      </div>
    </>
  )
}
