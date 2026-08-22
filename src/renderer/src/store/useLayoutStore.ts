import { create } from 'zustand'

// Shell-chrome state for the four-module layout (Ticket UI-02): currently
// just the sidebar's collapsed/expanded flag. Kept out of useAppStore so
// "which page am I on / what is the engine doing" (app state) stays separate
// from "how is the shell arranged" (view state) — the latter is the only
// part that persists across restarts.
const SIDEBAR_COLLAPSED_KEY = 'ruanjian.sidebarCollapsed'

// Best-effort persistence, matching useSettingsStore's helpers: a private
// profile or a full quota shouldn't stop the toggle from working for the
// rest of the session, it just won't survive a restart.
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

function persistCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
  } catch {
    /* best-effort */
  }
}

interface LayoutState {
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  sidebarCollapsed: readCollapsed(),
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed
      persistCollapsed(next)
      return { sidebarCollapsed: next }
    }),
  setSidebarCollapsed: (collapsed) => {
    persistCollapsed(collapsed)
    set({ sidebarCollapsed: collapsed })
  },
}))
