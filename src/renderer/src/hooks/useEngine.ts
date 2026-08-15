import { useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'

export function useEngine() {
  const setEngineBusy   = useAppStore((s) => s.setEngineBusy)
  const setEngineStatus = useAppStore((s) => s.setEngineStatus)

  const call = useCallback(
    async (method: string, ...args: unknown[]): Promise<unknown> => {
      setEngineBusy(true)
      setEngineStatus(`running: ${method}`)
      try {
        const result = await window.engine.call(method, ...args)
        setEngineStatus('idle')
        return result
      } catch (err) {
        setEngineStatus(`error: ${String(err)}`)
        throw err
      } finally {
        setEngineBusy(false)
      }
    },
    [setEngineBusy, setEngineStatus],
  )

  return { call }
}
