import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ACCENT_PRESETS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_STACKS,
  getEffectiveAccent,
  useSettingsStore,
  type Appearance,
  type FontFamily,
} from '../store/useSettingsStore'
import { contrastText, isValidHexColor } from '../utils/color'
import {
  BackgroundImageError, processBackgroundImage,
  MIN_BLUR_PX, MAX_BLUR_PX, MIN_OVERLAY_OPACITY, MAX_OVERLAY_OPACITY,
} from '../utils/backgroundImage'
import {
  notify,
  useNotificationStore,
  type NotificationCategory,
  TOAST_DURATION_MIN, TOAST_DURATION_MAX,
} from '../store/useNotificationStore'
import { BrandLogo } from '../components/brand/BrandLogo'

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
  const resolvedAppearance = useSettingsStore((s) => s.resolvedAppearance)
  const accentColor       = useSettingsStore((s) => s.accentColor)
  const avatarDataUrl     = useSettingsStore((s) => s.avatarDataUrl)
  const fontFamily        = useSettingsStore((s) => s.fontFamily)
  const fontSize          = useSettingsStore((s) => s.fontSize)
  const backgroundImage   = useSettingsStore((s) => s.backgroundImage)
  const backgroundPreview = useSettingsStore((s) => s.backgroundPreview)
  const backgroundOverlayOpacity = useSettingsStore((s) => s.backgroundOverlayOpacity)
  const backgroundBlurPx  = useSettingsStore((s) => s.backgroundBlurPx)
  const backgroundBrightWarning = useSettingsStore((s) => s.backgroundBrightWarning)
  const backgroundImageMissing  = useSettingsStore((s) => s.backgroundImageMissing)
  const setAppearance     = useSettingsStore((s) => s.setAppearance)
  const setAccentColor    = useSettingsStore((s) => s.setAccentColor)
  const setAvatar         = useSettingsStore((s) => s.setAvatar)
  const setFontFamily     = useSettingsStore((s) => s.setFontFamily)
  const setFontSize       = useSettingsStore((s) => s.setFontSize)
  const setBackgroundImage = useSettingsStore((s) => s.setBackgroundImage)
  const setBackgroundOverlayOpacity = useSettingsStore((s) => s.setBackgroundOverlayOpacity)
  const setBackgroundBlurPx = useSettingsStore((s) => s.setBackgroundBlurPx)

  const isCustomAccent = accentColor.startsWith('#')
  // Recomputed on every render that touches accentColor/resolvedAppearance
  // (both are subscribed above), so it always reflects what's actually on
  // screen — resolvedAppearance comes from the store rather than reading
  // document.documentElement here, since 'system' mode has no single fixed
  // light/dark value of its own.
  const effectiveAccent = getEffectiveAccent(accentColor, resolvedAppearance)
  const contrastPasses = effectiveAccent.contrastOnSurface >= 4.5

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)

  const bgInputRef = useRef<HTMLInputElement>(null)
  const [bgError, setBgError] = useState<string | null>(null)
  const [bgBusy, setBgBusy] = useState(false)
  const [bgUpdated, setBgUpdated] = useState(false)

  // Notification preferences (Ticket 35 §6)
  const notifPrefs = useNotificationStore((s) => s.preferences)
  const setNotifPreferences = useNotificationStore((s) => s.setPreferences)

  // About card (Ticket 32 §5)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  useEffect(() => { window.engine.getAppVersion().then(setAppVersion).catch(() => setAppVersion(null)) }, [])

  // Updates card (Ticket 37) — manual "Check for Updates", rendered inline
  // instead of through the notification system. Reuses the same
  // window.engine.onUpdaterEvent channel TopToolbar listens on (both the
  // startup check and this page's manual check broadcast over it), so this
  // reacts to whichever one last ran rather than tracking its own request id.
  type UpdateCheckStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'failed'
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckStatus>('idle')
  const [latestVersion, setLatestVersion] = useState<string | null>(null)

  useEffect(() => {
    function applyUpdaterEvent(event: string, data: unknown): void {
      if (event === 'updater:checking')     setUpdateStatus('checking')
      if (event === 'updater:not-available') setUpdateStatus('up-to-date')
      if (event === 'updater:available') {
        setLatestVersion((data as { version?: string })?.version ?? null)
        setUpdateStatus('available')
      }
      // Ticket 37 §1: shown only here, inline — never as a toast or
      // notification-center entry (see auto-updater.ts's 'error' handler).
      if (event === 'updater:error') setUpdateStatus('failed')
    }

    // Subscribe first so no live event is missed while the query below is
    // in flight, then guard against the query's answer landing *after* a
    // live event already arrived (e.g. Settings opens mid-check) — in that
    // race the live event is newer and must win, not the stale snapshot.
    let receivedLiveEvent = false
    const unsub = window.engine.onUpdaterEvent((event, data) => {
      receivedLiveEvent = true
      applyUpdaterEvent(event, data)
    })

    // Improvement over the initial cut: without this, opening Settings any
    // time after the automatic startup check already ran left the card on
    // "idle" until the user clicked "Check for Updates" again, even though
    // main already knew the answer.
    window.engine.updaterGetLastResult()
      .then((last) => { if (last && !receivedLiveEvent) applyUpdaterEvent(last.event, last.payload) })
      .catch(() => {})

    return unsub
  }, [])

  function handleCheckForUpdates(): void {
    setUpdateStatus('checking')
    setLatestVersion(null)
    void window.engine.updaterCheck()
  }
  // The blur slider needs to feel instant while dragging without triggering
  // a canvas re-blur on every pixel of movement — see the commit handler
  // below. The overlay slider has no such cost, so it stays fully
  // controlled by the store (setBackgroundOverlayOpacity on every change).
  const [localBlurPx, setLocalBlurPx] = useState(backgroundBlurPx)
  useEffect(() => setLocalBlurPx(backgroundBlurPx), [backgroundBlurPx])

  useEffect(() => {
    if (!bgUpdated) return
    const timer = setTimeout(() => setBgUpdated(false), 2500)
    return () => clearTimeout(timer)
  }, [bgUpdated])

  function commitBlur(): void {
    if (localBlurPx !== backgroundBlurPx) void setBackgroundBlurPx(localBlurPx)
  }

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
    setBgUpdated(false)
    setBgBusy(true)
    try {
      // Blur at the user's current preference (or the default, for a first
      // upload) — Ticket 30 §5/§8: the applied blur/overlay should already
      // reflect the effect actually delivered, not a misleading "applied"
      // message masking a broken result.
      const processed = await processBackgroundImage(file, backgroundBlurPx)
      setBackgroundImage(processed)
      setBgUpdated(true)
    } catch (err) {
      const reason = err instanceof BackgroundImageError ? err.message : 'unknown'
      setBgError(reason === 'too-large' ? t('settings.bgTooLarge') : t('settings.bgInvalid'))
      // Ticket 35 §5: low-priority "custom" category — off by default toggle
      // lives in the Notifications section below.
      notify({
        category: 'custom',
        titleKey: 'notification.custom.bgUploadFailed.title',
        messageKey: 'notification.custom.bgUploadFailed.message',
        action: { type: 'view', view: 'settings' },
      })
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
          {ACCENT_PRESETS.map((preset) => {
            // Swatches show the contrast-corrected colour that will actually
            // be applied (Ticket 29), not the raw brand hex — several bases
            // (indigo, netease red) are too subtle against the panel on
            // their own, so showing the raw value here would mislead.
            const presetAccent = getEffectiveAccent(preset.id, resolvedAppearance).accent
            const selected = !isCustomAccent && accentColor === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                className={`swatch-item${selected ? ' selected' : ''}`}
                onClick={() => setAccentColor(preset.id)}
                aria-pressed={selected}
                title={t(`settings.accent.${preset.id}`)}
              >
                {/* A name label is shown alongside every swatch, not just on
                    hover — several presets (red/netease/applemusic/youtube)
                    are all reds that collapse to near-identical hues under
                    protanopia/deuteranopia, so picking the right one can't
                    depend on colour discrimination alone (Ticket 29 §10). */}
                <span className="swatch-btn" style={{ background: presetAccent }} aria-hidden="true">
                  {selected && (
                    <span className="swatch-check" style={{ color: contrastText(presetAccent) }}>✓</span>
                  )}
                </span>
                <span className="swatch-name">{t(`settings.accent.${preset.id}`)}</span>
              </button>
            )
          })}
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

        {/* Live preview + contrast readout (Ticket 29 §9/§10) — reflects the
            colour actually applied, hover/active included, so prominence and
            legibility can be judged before/without leaving this page. */}
        <div className="accent-preview">
          <button type="button" className="btn btn-primary" tabIndex={-1}>{t('settings.previewButton')}</button>
          <span
            className="accent-preview-tab"
            style={{ color: effectiveAccent.accent, background: `color-mix(in srgb, ${effectiveAccent.accent} 15%, transparent)` }}
          >
            {t('settings.previewTab')}
          </span>
          <span
            className="accent-preview-lyric"
            style={{ color: effectiveAccent.accent, background: `color-mix(in srgb, ${effectiveAccent.accent} 10%, transparent)` }}
          >
            {t('settings.previewLyric')}
          </span>
          <span className="accent-preview-spacer" />
          <span className={`contrast-badge ${contrastPasses ? 'pass' : 'fail'}`}>
            {contrastPasses ? '✓' : '✕'} {t('settings.contrastRatio', { ratio: effectiveAccent.contrastOnSurface.toFixed(1) })}
          </span>
        </div>
      </div>

      {/* ── Background image ────────────────────────────────── */}
      <div className="card">
        <div className="card-title">{t('settings.background')}</div>

        {backgroundImageMissing && (
          <p className="bg-error">{t('settings.bgMissing')}</p>
        )}

        <div className="bg-upload-row">
          <label className="bg-preview" title={t('settings.uploadBackground')}>
            {/* Shows the original (unblurred) upload, not the applied
                blurred result — Ticket 30 §5, so the user can tell what
                they actually picked rather than only ever seeing it
                blurred. Falls back to the blurred image for a background
                saved before this preview field existed. */}
            {backgroundPreview || backgroundImage
              ? <img src={backgroundPreview ?? backgroundImage ?? undefined} alt="" />
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
            {bgUpdated && !bgError && <p className="bg-success">{t('settings.bgUpdated')}</p>}
          </div>
        </div>

        {backgroundImage && (
          <div className="bg-adjust-grid">
            <div className="bg-adjust-row">
              <span className="field-label">{t('settings.bgBlurIntensity')}</span>
              <input
                type="range"
                className="bg-adjust-slider"
                min={MIN_BLUR_PX}
                max={MAX_BLUR_PX}
                step={1}
                value={localBlurPx}
                onChange={(e) => setLocalBlurPx(Number(e.target.value))}
                onMouseUp={commitBlur}
                onTouchEnd={commitBlur}
                onKeyUp={commitBlur}
                aria-label={t('settings.bgBlurIntensity')}
              />
              <span className="bg-adjust-value">{localBlurPx}px</span>
            </div>
            <div className="bg-adjust-row">
              <span className="field-label">{t('settings.bgOverlayOpacity')}</span>
              <input
                type="range"
                className="bg-adjust-slider"
                min={Math.round(MIN_OVERLAY_OPACITY * 100)}
                max={Math.round(MAX_OVERLAY_OPACITY * 100)}
                step={5}
                value={Math.round(backgroundOverlayOpacity * 100)}
                onChange={(e) => setBackgroundOverlayOpacity(Number(e.target.value) / 100)}
                aria-label={t('settings.bgOverlayOpacity')}
              />
              <span className="bg-adjust-value">{Math.round(backgroundOverlayOpacity * 100)}%</span>
            </div>
            {backgroundBrightWarning && <p className="bg-hint bg-warning">{t('settings.bgBrightWarning')}</p>}
          </div>
        )}
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

      {/* ── Notifications (Ticket 35 §6) ────────────────────── */}
      <div className="card">
        <div className="card-title">{t('settings.notifications.title')}</div>
        <p className="view-desc" style={{ marginTop: -6, marginBottom: 14 }}>
          {t('settings.notifications.description')}
        </p>

        <div className="settings-subhead">{t('settings.notifications.categories')}</div>
        <div className="notif-pref-categories">
          {(['taskCompletion', 'taskFailure', 'subscription', 'system', 'custom'] as NotificationCategory[]).map((cat) => (
            <label key={cat} className="notif-pref-toggle">
              <input
                type="checkbox"
                checked={notifPrefs.categoriesEnabled[cat]}
                onChange={(e) => setNotifPreferences({
                  categoriesEnabled: { ...notifPrefs.categoriesEnabled, [cat]: e.target.checked },
                })}
              />
              <span>{t(`settings.notifications.category.${cat}`)}</span>
            </label>
          ))}
        </div>

        <div className="settings-subhead settings-subhead-spaced">{t('settings.notifications.duration')}</div>
        <div className="font-size-row">
          <input
            type="range"
            className="font-size-slider"
            min={TOAST_DURATION_MIN}
            max={TOAST_DURATION_MAX}
            step={1}
            value={notifPrefs.toastDurationSec}
            onChange={(e) => setNotifPreferences({ toastDurationSec: Number(e.target.value) })}
            aria-label={t('settings.notifications.duration')}
          />
          <span className="font-size-value">{notifPrefs.toastDurationSec}s</span>
        </div>

        <div className="settings-subhead settings-subhead-spaced">{t('settings.notifications.position')}</div>
        <div className="appearance-grid">
          {(['top-right', 'bottom-right'] as const).map((pos) => (
            <button
              key={pos}
              type="button"
              className={`appearance-option${notifPrefs.position === pos ? ' selected' : ''}`}
              onClick={() => setNotifPreferences({ position: pos })}
              aria-pressed={notifPrefs.position === pos}
            >
              <span>{t(`settings.notifications.${pos === 'top-right' ? 'positionTopRight' : 'positionBottomRight'}`)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Updates (Ticket 37) ─────────────────────────────── */}
      <div className="card">
        <div className="card-title">{t('settings.updates.title')}</div>
        {appVersion && (
          <p className="updates-current-version">{t('settings.about.version', { version: appVersion })}</p>
        )}
        <div className="updates-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleCheckForUpdates}
            disabled={updateStatus === 'checking'}
          >
            {updateStatus === 'checking' ? t('settings.updates.checking') : t('settings.updates.checkButton')}
          </button>
          {updateStatus === 'available' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.engine.updaterDownload()}
            >
              {t('settings.updates.updateNow')}
            </button>
          )}
        </div>
        {updateStatus === 'up-to-date' && (
          <p className="updates-status is-success">{t('settings.updates.upToDate')}</p>
        )}
        {updateStatus === 'available' && (
          <p className="updates-status">{t('settings.updates.newVersion', { version: latestVersion ?? '' })}</p>
        )}
        {updateStatus === 'failed' && (
          <p className="updates-status is-error">{t('settings.updates.failed')}</p>
        )}
      </div>

      {/* ── About ──────────────────────────────────────────── */}
      <div className="card about-card">
        <div className="card-title">{t('settings.about.title')}</div>
        <div className="about-content">
          <BrandLogo variant="full" size={96} className="about-logo" />
          <div className="about-name-zh">{t('app.nameZh')}</div>
          <div className="about-name-en">{t('app.nameEn')}</div>
          <div className="about-slogan-zh">{t('app.sloganZh')}</div>
          <div className="about-slogan-en">{t('app.sloganEn')}</div>
          <div className="about-meta">
            {appVersion && <span>{t('settings.about.version', { version: appVersion })}</span>}
            <span>{t('settings.about.developer')}: {t('settings.about.developerName')}</span>
          </div>
        </div>
      </div>
    </>
  )
}
