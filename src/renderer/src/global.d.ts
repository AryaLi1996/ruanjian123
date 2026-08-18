import type {
  LicenseConfig,
  PaymentOrder,
  PaymentHistoryEntry,
  PaymentMethodInfo,
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
      logRendererError:  (payload: unknown) => Promise<void>
      showInFolder:      (filePath: string) => Promise<void>
      encryptModel:      (modelPath: string) => Promise<{ encPath: string; sizeBytes: number }>
      decryptVerify:     (encPath: string) => Promise<{ decrypted: boolean; error?: string }>
      loadModels:        () => Promise<PersistedModel[]>
      saveModels:        (models: PersistedModel[]) => Promise<void>
      deleteDataFile:    (filePath: string) => Promise<boolean>
      isFirstLaunch:     () => Promise<boolean>
      markInitialized:   () => Promise<void>
      getAppVersion:     () => Promise<string>
      setBackgroundColor: (hex: string) => Promise<void>
      getWarmupResult:   () => Promise<WarmupResult>
      retryWarmup:       () => Promise<WarmupResult>
      updaterDownload:    () => Promise<void>
      updaterQuitInstall: () => Promise<void>
      onUpdaterEvent:    (cb: (event: string, data: unknown) => void) => () => void
      // Subscription
      getLicenseState:      () => Promise<unknown>
      activateLicense:      (key: string) => Promise<unknown>
      deactivateLicense:    () => Promise<void>
      refreshLicense:       () => Promise<void>
      getLicenseConfig:     () => Promise<LicenseConfig>
      onLicenseStateChange: (cb: (state: unknown) => void) => () => void
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
    }
  }
}

export {}
