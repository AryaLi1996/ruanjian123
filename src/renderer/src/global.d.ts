import type {
  LicenseConfig,
  PaymentOrder,
  PaymentHistoryEntry,
  PaymentMethodInfo,
  PlanInfo,
} from './store/subscription-types'

export interface PersistedModel {
  id:            string
  name:          string
  coverDataUrl:  string | null
  mode:          'standard' | 'professional'
  trainedAt:     number
  onnxPath:      string
  demoAudioPath: string | null
  epochs:        number
  bestLoss:      number
  qualityScore?:   number
  qualityWarning?: string | null
}

// Cloud Library (云曲库) — Ticket 18. Mirrors main/library.ts's LibrarySong /
// LibrarySearchResult (renderer and main are separate TS programs — see
// PersistedModel above for why this file keeps its own copy).
export interface LibrarySong {
  id:            string
  title:         string
  artist:        string
  original_key:  string | null
  audio_url:     string
  /** Album art when the catalogue provides it; null otherwise (Ticket UI-08). */
  cover_url:     string | null
}
export interface LibrarySearchResult {
  results:  LibrarySong[]
  page:     number
  pageSize: number
  total:    number
  hasMore:  boolean
}

// Upload & Start Training (Ticket 20). Mirrors main/train-upload.ts's
// TrainStartResult / TrainStatusResult (see PersistedModel above for why
// renderer and main keep separate copies).
export type TrainJobStatus = 'uploading' | 'queued' | 'training' | 'completed' | 'failed'
export interface TrainStartResult {
  task_id:  string
  file_url: string
  status:   string
}
export interface TrainStatusResult {
  task_id:    string
  status:     TrainJobStatus
  percent:    number
  message?:   string
  model_url?: string
  error?:     string
}
export interface TrainStartConfig {
  mode?:                string
  pitchShiftSemitones?: number
  highPitchProtection?: boolean
  includeDryVocal?:     boolean
  [key: string]:        unknown
}

// ── Engine diagnostics & environment self-check (Tickets T1-T3) ────────────
// Mirrors main/python-bridge.ts's EngineLogEntry (renderer and main are
// separate TS programs — see PersistedModel above for why this file keeps
// its own copies).
export interface EngineLogEntry {
  method: string
  stream: 'stdout' | 'stderr'
  kind:   'json' | 'diagnostic' | 'heartbeat' | 'error'
  line:   string
  at:     number
}

export type EnvCheckStatus = 'ok' | 'warn' | 'fail'

/** One row of the pre-flight checklist — mirrors engine/env_check.py's Check. */
export interface EnvCheck {
  id:     string
  status: EnvCheckStatus
  label:  string
  detail: string
  fix:    string | null
}

/** Device facts from engine/device_detector.py's detect_device(). */
export interface EngineDeviceInfo {
  ep?:                  string
  provider?:            string
  providers?:           string[]
  platform?:            string
  python?:              string
  torch_available?:     boolean
  torch_version?:       string | null
  cuda_available?:      boolean
  mps_available?:       boolean
  gpu_available?:       boolean
  gpu_name?:            string | null
  /** "cuda" | "mps" | "cpu" — what a training run will actually use. */
  training_device?:     string
  cpu_slowdown_factor?: number
  detail?:              string | null
}

/** Mirrors engine/env_check.py's EnvironmentReport. */
export interface EnvironmentReport {
  passed:   boolean
  checks:   EnvCheck[]
  device:   EngineDeviceInfo
  platform: string
  python:   string | null
  missing:  string[]
}

interface WarmupResult {
  passed:     boolean
  ep?:        string
  elapsedMs?: number
  degraded?:  boolean
  error?:     string
}

// Mirrors main/background-store.ts (Ticket 27/30).
export interface BackgroundMeta {
  overlayOpacity: number
  blurPx:         number
  brightWarning:  boolean
}
export interface SaveBackgroundPayload {
  blurredDataUrl: string
  previewDataUrl: string
  sourceDataUrl:  string
  meta:           BackgroundMeta
}
// FC-01: per-chunk progress of a cloud-library audio download. Mirrors
// main/library.ts's DownloadProgress (see PersistedModel above for why
// renderer and main keep separate copies).
export interface LibraryDownloadProgress {
  id:       string
  received: number
  total:    number
  /** 0-100, or -1 when the server sent no Content-Length and no percentage can be computed. */
  percent:  number
}

// FC-02: standard per-project asset folder built from a finished separation.
// Mirrors main/project-assets.ts's CollectResult.
export interface ProjectAssetsResult {
  projectDir: string
  /** Standard file name (vocals.wav, lead_vocal.wav, …) → absolute path. */
  assets:     Record<string, string>
  /** Required assets that couldn't be produced — non-empty means training stays blocked. */
  missing:    string[]
}

export interface LoadedBackground {
  blurredDataUrl: string
  previewDataUrl: string
  meta:           BackgroundMeta
}

declare global {
  interface Window {
    engine: {
      call:              (method: string, ...args: unknown[]) => Promise<unknown>
      onProgress:        (callback: (data: unknown) => void) => () => void
      stream:            (method: string, ...args: unknown[]) => Promise<unknown>
      /** Ticket UI-10: kills the streaming run in flight; true if one was killed. */
      cancelStream:      () => Promise<boolean>
      /** Raw engine output — stage diagnostics, heartbeats, stray warnings (Tickets T1/T3). */
      onEngineLog:       (cb: (entry: EngineLogEntry) => void) => () => void
      /** Ticket T3: pre-flight environment self-check run before training starts. */
      checkEnvironment:  () => Promise<EnvironmentReport>
      /** Ticket T1: engine start-up timeout in ms; null resets to the default. */
      getEngineStartupTimeout: () => Promise<number>
      setEngineStartupTimeout: (ms: number | null) => Promise<number>
      saveTrainingFiles: (files: Array<{ name: string; buffer: ArrayBuffer }>) => Promise<string>
      readFile:          (filePath: string) => Promise<ArrayBuffer>
      saveRecording:     (buffer: ArrayBuffer, defaultName: string) => Promise<string | null>
      chooseExportPath:  (defaultName: string, extension: string) => Promise<string | null>
      searchLyrics:      (query: { track: string; artist?: string }) => Promise<Array<{
        id: number
        trackName: string
        artistName: string
        albumName: string
        duration: number | null
        instrumental: boolean
        syncedLyrics: string | null
        plainLyrics: string | null
      }>>
      // Automatic lyrics-match cache (Ticket 43 §4) — keyed by utils/autoLyrics.ts's
      // lyricsCacheKey(); durable copy lives at userData/lyrics-cache.json (main/lyrics-cache.ts).
      lyricsCacheLoad: () => Promise<Record<string, { raw: string; source: string; cachedAt: number }>>
      lyricsCacheSave: (cache: Record<string, { raw: string; source: string; cachedAt: number }>) => Promise<void>
      searchLibrary:     (keyword: string, page?: number, pageSize?: number) => Promise<LibrarySearchResult>
      fetchLibraryAudio: (song: LibrarySong) => Promise<{ path: string; cached: boolean }>
      // FC-01
      listCachedLibraryIds:      () => Promise<string[]>
      onLibraryDownloadProgress: (cb: (p: LibraryDownloadProgress) => void) => () => void
      // FC-02
      collectProjectStems: (
        projectId: string,
        mode: 'standard' | 'enhanced',
        stems: Record<string, string>,
        originalPath?: string | null,
      ) => Promise<ProjectAssetsResult>
      // Upload & Start Training (Ticket 20)
      uploadTrainDataset: (zipPath: string, taskId: string, config: TrainStartConfig) => Promise<TrainStartResult>
      getTrainStatus:     (taskId: string) => Promise<TrainStatusResult>
      logRendererError:  (payload: unknown) => Promise<void>
      showInFolder:      (filePath: string) => Promise<void>
      // Native "Browse…" file picker (PATCH-01 — Waveform Editor path field)
      openFileDialog:    () => Promise<string | null>
      encryptModel:      (modelPath: string) => Promise<{ encPath: string; sizeBytes: number }>
      decryptVerify:     (encPath: string) => Promise<{ decrypted: boolean; error?: string }>
      downloadModel:     (modelPath: string, defaultName: string) => Promise<string | null>
      loadModels:        () => Promise<PersistedModel[]>
      saveModels:        (models: PersistedModel[]) => Promise<void>
      deleteDataFile:    (filePath: string) => Promise<boolean>
      isFirstLaunch:     () => Promise<boolean>
      markInitialized:   () => Promise<void>
      getAppVersion:     () => Promise<string>
      setBackgroundColor: (hex: string) => Promise<void>
      getWarmupResult:   () => Promise<WarmupResult>
      retryWarmup:       () => Promise<WarmupResult>
      updaterCheck:       () => Promise<void>
      updaterDownload:    () => Promise<void>
      updaterQuitInstall: () => Promise<void>
      updaterGetLastResult: () => Promise<{ event: string; payload?: unknown } | null>
      onUpdaterEvent:    (cb: (event: string, data: unknown) => void) => () => void
      // Subscription
      getLicenseState:      () => Promise<unknown>
      activateLicense:      (key: string) => Promise<unknown>
      deactivateLicense:    () => Promise<void>
      refreshLicense:       () => Promise<void>
      getLicenseConfig:     () => Promise<LicenseConfig>
      onLicenseStateChange: (cb: (state: unknown) => void) => () => void
      // Server-computed plan pricing (Ticket 34)
      getPlans: () => Promise<PlanInfo[]>
      // Multi-channel payment (Ticket 28)
      createPaymentOrder: (planId: string, method: string) => Promise<PaymentOrder & { error?: string }>
      getOrderStatus:     (orderId: string) => Promise<{ status: string; order?: PaymentOrder; licensed?: boolean; error?: string }>
      getPaymentHistory:  () => Promise<PaymentHistoryEntry[]>
      getPaymentMethods:  (lang: string) => Promise<PaymentMethodInfo[]>
      openEmbeddedPayment:  (url: string) => Promise<void>
      closeEmbeddedPayment: () => Promise<void>
      onPaymentWindowClosed: (cb: () => void) => () => void
      // Custom background image persistence (Ticket 27/30)
      saveBackgroundImage:   (payload: SaveBackgroundPayload) => Promise<void>
      saveBackgroundMeta:    (meta: BackgroundMeta) => Promise<void>
      loadBackgroundImage:   () => Promise<LoadedBackground | { missing: true } | null>
      loadBackgroundSource:  () => Promise<string | null>
      removeBackgroundImage: () => Promise<void>
      // Main-process-originated notifications (Ticket 35 §2/§8) — see
      // main/notification-bridge.ts. Payload shape matches NotifyInput in
      // useNotificationStore.ts; kept as `unknown` here (rather than
      // importing that type) so global.d.ts doesn't need to know about the
      // notification store, matching how the rest of this file treats
      // main-process payloads (e.g. onLicenseStateChange's `state: unknown`).
      onMainNotification: (cb: (payload: unknown) => void) => () => void
    }
  }
}

export {}
