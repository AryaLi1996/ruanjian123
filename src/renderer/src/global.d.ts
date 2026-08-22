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
      // Upload & Start Training (Ticket 20)
      uploadTrainDataset: (zipPath: string, taskId: string, config: TrainStartConfig) => Promise<TrainStartResult>
      getTrainStatus:     (taskId: string) => Promise<TrainStatusResult>
      logRendererError:  (payload: unknown) => Promise<void>
      showInFolder:      (filePath: string) => Promise<void>
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
