declare global {
  interface Window {
    engine: {
      call:              (method: string, ...args: unknown[]) => Promise<unknown>
      onProgress:        (callback: (data: unknown) => void) => () => void
      stream:            (method: string, ...args: unknown[]) => Promise<unknown>
      saveTrainingFiles: (files: Array<{ name: string; buffer: ArrayBuffer }>) => Promise<string>
      readFile:          (filePath: string) => Promise<ArrayBuffer>
      saveRecording:     (buffer: ArrayBuffer, defaultName: string) => Promise<string | null>
      logRendererError:  (payload: unknown) => Promise<void>
      encryptModel:      (modelPath: string) => Promise<{ encPath: string; sizeBytes: number }>
      decryptVerify:     (encPath: string) => Promise<{ decrypted: boolean; error?: string }>
      getModelKeyHex:    () => Promise<string>
      isFirstLaunch:     () => Promise<boolean>
      markInitialized:   () => Promise<void>
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
