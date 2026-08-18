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
      encryptModel:      (modelPath: string) => Promise<{ encPath: string; sizeBytes: number }>
      decryptVerify:     (encPath: string) => Promise<{ decrypted: boolean; error?: string }>
      loadModels:        () => Promise<PersistedModel[]>
      saveModels:        (models: PersistedModel[]) => Promise<void>
      deleteDataFile:    (filePath: string) => Promise<boolean>
      isFirstLaunch:     () => Promise<boolean>
      markInitialized:   () => Promise<void>
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
      getLicenseConfig:     () => Promise<{ checkoutUrl: string }>
      onLicenseStateChange: (cb: (state: unknown) => void) => () => void
    }
  }
}

export {}
