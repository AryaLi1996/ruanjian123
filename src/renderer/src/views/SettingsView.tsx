import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ACCENT_PRESETS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_STACKS,
  useSettingsStore,
  type Appearance,
  type FontFamily,
} from '../store/useSettingsStore'
import { contrastText, isValidHexColor } from '../utils/color'
import { BackgroundImageError, processBackgroundImage } from '../utils/backgroundImage'

const APPEARANCE_OPTIONS: { value: Appearance; icon: string }[] = [
  { value: 'system', icon: '🖥️' },
  { value: 'light',  icon: '☀️' },
  { value: 'dark',   icon: '🌙' },
]

const FONT_FAMILY_OPTIONS: { value: FontFamily; sample: string }[] = [
  { value: 'system', sample: 'Aa' },
  { value: 'sans',   sample: 'Aa' },
  { value: 'serif',  sample: 'Aa' },
  { value: 'mono',   sample: 'Aa' },
]

// Longest side an uploaded photo is downscaled to before being stored as a
// data URL — keeps the avatar well under localStorage's per-origin quota
// regardless of how large the source photo is.
const AVATAR_MAX_SIZE = 256

export function SettingsView(): JSX.Element {
  const { t } = useTranslation()
  const appearance        = useSettingsStore((s) => s.appearance)
  const accentColor       = useSettingsStore((s) => s.accentColor)
  const avatarDataUrl     = useSettingsStore((s) => s.avatarDataUrl)
  const fontFamily        = useSettingsStore((s) => s.fontFamily)
  const fontSize          = useSettingsStore((s) => s.fontSize)
  const backgroundImage   = useSettingsStore((s) => s.backgroundImage)
  const setAppearance     = useSettingsStore((s) => s.setAppearance)
  const setAccentColor    = useSettingsStore((s) => s.setAccentColor)
  const setAvatar         = useSettingsStore((s) => s.setAvatar)
  const setFontFamily     = useSettingsStore((s) => s.setFontFamily)
  const setFontSize       = useSettingsStore((s) => s.setFontSize)
  const setBackgroundImage = useSettingsStore((s) => s.setBackgroundImage)

  const isCustomAccent = accentColor.startsWith('#')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)

  const bgInputRef = useRef<HTMLInputElement>(null)
  const [bgError, setBgError] = useState<string | null>(null)
  const [bgBusy, setBgBusy] = useState(false)

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

  async function handleBgPick(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBgError(null)
    setBgBusy(true)
    try {
      const dataUrl = await processBackgroundImage(file)
      setBackgroundImage(dataUrl)
    } catch (err) {
      const reason = err instanceof BackgroundImageError ? err.message : 'unknown'
      setBgError(reason === 'too-large' ? t('settings.bgTooLarge') : t('settings.bgInvalid'))
    } finally {
      setBgBusy(false)
    }
  }

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">{t('settings.title')}</h1>
        <p className="view-desc">{t('settings.description')}</p>
      </div>

      {/* ── Font ───────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">{t('settings.font')}</div>
        <div className="font-family-grid">
          {FONT_FAMILY_OPTIONS.map(({ value, sample }) => (
            <button
              key={value}
              type="button"
              className={`font-family-option${fontFamily === value ? ' selected' : ''}`}
              style={{ fontFamily: FONT_STACKS[value] }}
              onClick={() => setFontFamily(value)}
              aria-pressed={fontFamily === value}
            >
              <span className="font-family-sample" aria-hidden="true">{sample}</span>
              <span>{t(`settings.fontFamily.${value}`)}</span>
            </button>
          ))}
        </div>

        <div className="font-size-row">
          <span className="field-label">{t('settings.fontSize')}</span>
          <input
            type="range"
            className="font-size-slider"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            aria-label={t('settings.fontSize')}
          />
          <span className="font-size-value">{fontSize}px</span>
        </div>
        <div className="font-size-preview">
          {t('settings.fontSizePreview')}
          <div className="font-size-preview-sub">{t('settings.fontSizePreviewSub')}</div>
        </div>
      </div>

      {/* ── Theme colour (incl. light/dark/system mode) ─────── */}
      <div className="card">
        <div className="card-title">{t('settings.themeColor')}</div>

        <div className="settings-subhead">{t('settings.appearance')}</div>
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

        <div className="settings-subhead settings-subhead-spaced">{t('settings.accentLabel')}</div>
        <div className="swatch-grid">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`swatch-btn${!isCustomAccent && accentColor === preset.id ? ' selected' : ''}`}
              style={{ background: preset.accent }}
              onClick={() => setAccentColor(preset.id)}
              aria-pressed={!isCustomAccent && accentColor === preset.id}
              aria-label={t(`settings.accent.${preset.id}`)}
              title={t(`settings.accent.${preset.id}`)}
            >
              {!isCustomAccent && accentColor === preset.id && (
                <span className="swatch-check" style={{ color: contrastText(preset.accent) }} aria-hidden="true">✓</span>
              )}
            </button>
          ))}
        </div>

        <div className="custom-accent-row">
          <input
            type="color"
            className="custom-accent-swatch"
            value={isValidHexColor(accentColor) ? accentColor : '#6366f1'}
            onChange={(e) => setAccentColor(e.target.value)}
            aria-label={t('settings.customColor')}
            title={t('settings.customColor')}
          />
          <span className="custom-accent-label">{t('settings.customColorHint')}</span>
        </div>
      </div>

      {/* ── Background image ────────────────────────────────── */}
      <div className="card">
        <div className="card-title">{t('settings.background')}</div>
        <div className="bg-upload-row">
          <label className="bg-preview" title={t('settings.uploadBackground')}>
            {backgroundImage
              ? <img src={backgroundImage} alt="" />
              : <span className="bg-preview-placeholder">🖼️</span>}
            <input
              ref={bgInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: 'none' }}
              onChange={handleBgPick}
            />
          </label>
          <div className="bg-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => bgInputRef.current?.click()}
              disabled={bgBusy}
            >
              {bgBusy ? t('common.loading') : t('settings.uploadBackground')}
            </button>
            {backgroundImage && (
              <button type="button" className="btn btn-ghost" onClick={() => setBackgroundImage(null)}>
                {t('settings.removeBackground')}
              </button>
            )}
            <p className="bg-hint">{t('settings.backgroundHint')}</p>
            {bgError && <p className="bg-error">{bgError}</p>}
          </div>
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
